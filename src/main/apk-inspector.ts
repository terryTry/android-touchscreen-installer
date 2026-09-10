import { randomUUID } from 'node:crypto'
import { open, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import ApkReader from '@devicefarmer/adbkit-apkreader'
import { AppInfoParser, isAndroidInfo } from '@h-t-m/app-inspect'
import type {
  ApkActivity,
  ApkDeclaredPermission,
  ApkDefinedPermission,
  ApkInfo
} from '../shared/contracts'
import { AppError } from './app-error'

const MAIN_ACTION = 'android.intent.action.MAIN'
const HOME_CATEGORY = 'android.intent.category.HOME'
const DEFAULT_CATEGORY = 'android.intent.category.DEFAULT'
const LAUNCHER_CATEGORY = 'android.intent.category.LAUNCHER'
const MAX_APK_BYTES = 4 * 1024 * 1024 * 1024
const MAX_ICON_DATA_URL_LENGTH = 2_500_000

interface ManifestActivity {
  name: string
  exported?: boolean
  intentFilters?: Array<{
    actions?: Array<{ name: string }>
    categories?: Array<{ name: string }>
  }>
}

export interface InspectedApk {
  path: string
  info: ApkInfo
}

function resolveClassName(packageName: string, className: string): string {
  if (className.startsWith('.')) return `${packageName}${className}`
  if (!className.includes('.')) return `${packageName}.${className}`
  return className
}

function toComponent(packageName: string, className: string): string {
  return `${packageName}/${resolveClassName(packageName, className)}`
}

function hasIntent(
  activity: ManifestActivity,
  requiredAction: string,
  requiredCategories: string[]
): boolean {
  return (
    activity.intentFilters?.some((filter) => {
      const actions = new Set(filter.actions?.map(({ name }) => name) ?? [])
      const categories = new Set(filter.categories?.map(({ name }) => name) ?? [])
      return actions.has(requiredAction) && requiredCategories.every((category) => categories.has(category))
    }) ?? false
  )
}

function convertActivity(packageName: string, activity: ManifestActivity): ApkActivity {
  const fullName = resolveClassName(packageName, activity.name)
  return {
    name: fullName,
    component: toComponent(packageName, activity.name),
    exported: activity.exported === true
  }
}

function stringValue(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return null
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : null
}

export function extractDeclaredPermissions(
  values: Array<{ name?: unknown; maxSdkVersion?: unknown }> | undefined
): ApkDeclaredPermission[] {
  const permissions = new Map<string, number | null>()
  for (const value of values ?? []) {
    const name = stringValue(value.name)
    if (!name) continue
    const maxSdkVersion = numberValue(value.maxSdkVersion)
    const existing = permissions.get(name)
    if (existing === undefined) {
      permissions.set(name, maxSdkVersion)
    } else if (existing === null || maxSdkVersion === null) {
      permissions.set(name, null)
    } else {
      permissions.set(name, Math.max(existing, maxSdkVersion))
    }
  }
  return [...permissions.entries()].map(([name, maxSdkVersion]) => ({
    name,
    maxSdkVersion
  }))
}

function protectionLevelValues(value: unknown): string[] {
  if (typeof value === 'string') {
    return [...new Set(value.split('|').map((item) => item.trim()).filter(Boolean))]
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return []

  const baseLevels = ['normal', 'dangerous', 'signature', 'signatureOrSystem']
  const flags = [
    [0x10, 'privileged'],
    [0x20, 'development'],
    [0x40, 'appop'],
    [0x80, 'pre23'],
    [0x400, 'preinstalled'],
    [0x1000, 'instant'],
    [0x2000, 'runtime'],
    [0x8000, 'vendorPrivileged'],
    [0x800000, 'role'],
    [0x1000000, 'knownSigner']
  ] as const
  const levels = [baseLevels[value & 0xf] ?? `base:${value & 0xf}`]
  for (const [mask, label] of flags) {
    if ((value & mask) !== 0) levels.push(label)
  }
  return levels
}

export function extractDefinedPermissions(
  values: Array<{ name?: unknown; protectionLevel?: unknown }> | undefined
): ApkDefinedPermission[] {
  return (values ?? [])
    .map((value): ApkDefinedPermission | null => {
      const name = stringValue(value.name)
      if (!name) return null
      return {
        name,
        protectionLevel: protectionLevelValues(value.protectionLevel)
      }
    })
    .filter((permission): permission is ApkDefinedPermission => permission !== null)
}

async function assertApkFile(filePath: string): Promise<number> {
  if (extname(filePath).toLowerCase() !== '.apk') {
    throw new AppError('只支持选择 .apk 文件。', '请重新选择 Android APK 安装包。')
  }

  const fileStat = await stat(filePath).catch(() => null)
  if (!fileStat?.isFile()) {
    throw new AppError('所选 APK 文件不存在或无法读取。', '请确认文件仍在本机，然后重新选择。')
  }
  if (fileStat.size <= 0 || fileStat.size > MAX_APK_BYTES) {
    throw new AppError('APK 文件大小无效。', '请确认文件完整且不超过 4 GB。')
  }

  const handle = await open(filePath, 'r')
  try {
    const magic = Buffer.alloc(4)
    await handle.read(magic, 0, magic.length, 0)
    const isZip =
      magic[0] === 0x50 &&
      magic[1] === 0x4b &&
      (magic[2] === 0x03 || magic[2] === 0x05 || magic[2] === 0x07) &&
      (magic[3] === 0x04 || magic[3] === 0x06 || magic[3] === 0x08)
    if (!isZip) {
      throw new AppError('文件扩展名为 APK，但内容不是有效的 APK/ZIP。', '请重新导出或重新传输 APK。')
    }
  } finally {
    await handle.close()
  }

  return fileStat.size
}

export class ApkInspector {
  async inspect(filePath: string): Promise<InspectedApk> {
    const fileSize = await assertApkFile(filePath)

    try {
      const [manifestReader, richResult] = await Promise.all([
        ApkReader.open(filePath).then((reader) => reader.readManifest()),
        new AppInfoParser(filePath).parse({
          signing: false,
          resources: true,
          icons: true,
          nativeAbi: true,
          resolveRefs: true
        })
      ])

      if (!isAndroidInfo(richResult.data.platformInfo)) {
        throw new Error('解析结果不是 Android 应用')
      }

      const packageName = stringValue(manifestReader.package)
      const versionCode = numberValue(manifestReader.versionCode)
      if (!packageName || versionCode === null) {
        throw new Error('Manifest 缺少 package 或 versionCode')
      }

      const application = manifestReader.application
      const activities = [
        ...(application?.activities ?? []),
        ...(application?.activityAliases ?? [])
      ]
      const homeActivities = activities
        .filter((activity) => hasIntent(activity, MAIN_ACTION, [HOME_CATEGORY, DEFAULT_CATEGORY]))
        .map((activity) => convertActivity(packageName, activity))
      const launchActivity =
        activities
          .filter((activity) => hasIntent(activity, MAIN_ACTION, [LAUNCHER_CATEGORY]))
          .map((activity) => convertActivity(packageName, activity))
          .find(({ exported }) => exported) ??
        homeActivities.find(({ exported }) => exported) ??
        null

      const richManifest = richResult.data.platformInfo.manifest
      const resolvedLabel =
        stringValue(richManifest.label) ??
        stringValue(application?.label)?.replace(/^resourceId:.+$/, '') ??
        packageName
      const iconCandidate = richResult.data.icon
      const iconDataUrl =
        typeof iconCandidate === 'string' && iconCandidate.length <= MAX_ICON_DATA_URL_LENGTH
          ? iconCandidate
          : null
      const warnings = richResult.warnings.map(({ message }) => message)

      if (homeActivities.length === 0) {
        warnings.push('未检测到同时声明 MAIN、HOME 和 DEFAULT 的 Activity。')
      } else if (homeActivities.some(({ exported }) => !exported)) {
        warnings.push('检测到 HOME Activity 的 exported 不是 true，不能安全设为系统桌面。')
      }
      if (!iconDataUrl) {
        warnings.push('未能从 APK 中解析应用图标，将显示默认图标。')
      }

      const exportedHomes = homeActivities.filter(({ exported }) => exported)
      const declaredPermissions = extractDeclaredPermissions([
        ...(manifestReader.usesPermissions ?? []),
        ...(richResult.data.platformInfo.usesPermissions ?? [])
      ])
      return {
        path: filePath,
        info: {
          token: randomUUID(),
          fileName: basename(filePath),
          fileSize,
          appName: resolvedLabel || packageName,
          applicationClassName: application?.name
            ? resolveClassName(packageName, application.name)
            : 'android.app.Application',
          iconDataUrl,
          packageName,
          versionName: stringValue(manifestReader.versionName) ?? String(versionCode),
          versionCode,
          minSdk: numberValue(manifestReader.usesSdk?.minSdkVersion) ?? 1,
          targetSdk: numberValue(manifestReader.usesSdk?.targetSdkVersion),
          abis: richResult.data.platformInfo.nativeAbi ?? [],
          debuggable: application?.debuggable === true,
          declaredPermissions,
          definedPermissions: extractDefinedPermissions(manifestReader.permissions),
          homeActivities,
          selectedHomeComponent: exportedHomes.length === 1 ? exportedHomes[0]?.component ?? null : null,
          launchActivity,
          warnings: [...new Set(warnings)]
        }
      }
    } catch (error) {
      if (error instanceof AppError) throw error
      throw new AppError(
        'APK Manifest 解析失败。',
        `请确认这是完整的最终 APK，而不是拆分 APK 或损坏文件。技术信息：${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
}
