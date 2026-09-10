import type {
  CompatibilityReport,
  DisplayResolution,
  DeviceDetails,
  DeviceState,
  DeviceSummary,
  InstalledPackageInfo
} from '../shared/contracts'

const DEVICE_LINE = /^([^\s]+)\s+(.+)$/
const PROPERTY_LINE = /^\[([^\]]+)]: \[(.*)]$/
const COMPONENT = /^([A-Za-z0-9_][A-Za-z0-9_.]*)\/([A-Za-z0-9_.$][A-Za-z0-9_.$]*)$/
const COMPONENT_IN_TEXT =
  /[A-Za-z0-9_][A-Za-z0-9_.]*\/[A-Za-z0-9_.$][A-Za-z0-9_.$]*/g
const DISPLAY_SIZE_LINE = /^\s*(Physical|Override)\s+size:\s*(\d+)\s*x\s*(\d+)\s*$/i

export interface DisplayResolutionResult {
  physicalResolution: DisplayResolution | null
  logicalResolution: DisplayResolution | null
}

export interface PackageInstallationDetails {
  installedPackage: InstalledPackageInfo
  packagePaths: string[]
  codePaths: string[]
  activeCodePath: string | null
  isSystem: boolean
  isPrivileged: boolean
}

function normalizeDeviceState(value: string): DeviceState {
  if (value === 'device' || value === 'unauthorized' || value === 'offline') {
    return value
  }
  if (value === 'no permissions') {
    return 'no-permissions'
  }
  return 'unknown'
}

export function parseDevices(output: string): DeviceSummary[] {
  return output
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = DEVICE_LINE.exec(line)
      if (!match) return null
      const serial = match[1]
      const stateAndAttributes = match[2]?.trim()
      if (!serial || !stateAndAttributes || serial.startsWith('*')) return null

      const noPermissions = stateAndAttributes.startsWith('no permissions')
      const rawState = noPermissions
        ? 'no permissions'
        : stateAndAttributes.split(/\s+/, 1)[0]
      const attributesText = noPermissions
        ? stateAndAttributes.slice('no permissions'.length).trim()
        : stateAndAttributes.slice(rawState?.length ?? 0).trim()
      if (!rawState) return null

      const attributes = new Map<string, string>()
      for (const token of attributesText.split(/\s+/)) {
        const separator = token.indexOf(':')
        if (separator > 0) {
          attributes.set(token.slice(0, separator), token.slice(separator + 1).replaceAll('_', ' '))
        }
      }

      return {
        serial,
        state: normalizeDeviceState(rawState),
        product: attributes.get('product') ?? null,
        model: attributes.get('model') ?? null,
        deviceName: attributes.get('device') ?? null,
        transport: serial.includes(':') ? 'tcp' : 'usb'
      } satisfies DeviceSummary
    })
    .filter((device): device is DeviceSummary => device !== null)
}

export function parseGetProp(device: DeviceSummary, output: string): DeviceDetails {
  const properties = new Map<string, string>()
  for (const line of output.split(/\r?\n/)) {
    const match = PROPERTY_LINE.exec(line.trim())
    if (match?.[1] && match[2] !== undefined) {
      properties.set(match[1], match[2])
    }
  }

  const sdkValue = Number.parseInt(properties.get('ro.build.version.sdk') ?? '', 10)
  const abiList =
    properties.get('ro.product.cpu.abilist') ??
    properties.get('ro.product.cpu.abi') ??
    ''

  return {
    ...device,
    manufacturer: properties.get('ro.product.manufacturer') ?? null,
    model: properties.get('ro.product.model') ?? device.model,
    deviceName: properties.get('ro.product.device') ?? device.deviceName,
    androidVersion: properties.get('ro.build.version.release') ?? null,
    apiLevel: Number.isFinite(sdkValue) ? sdkValue : null,
    buildType: properties.get('ro.build.type') ?? null,
    debuggable:
      properties.get('ro.debuggable') === '1'
        ? true
        : properties.get('ro.debuggable') === '0'
          ? false
          : null,
    verifiedBootState: properties.get('ro.boot.verifiedbootstate') ?? null,
    bootloaderUnlocked:
      properties.get('ro.boot.flash.locked') === '0'
        ? true
        : properties.get('ro.boot.flash.locked') === '1'
          ? false
          : null,
    adbUid: null,
    suPath: null,
    rootAccessMode: 'none',
    physicalResolution: null,
    logicalResolution: null,
    abis: abiList
      .split(',')
      .map((abi) => abi.trim())
      .filter(Boolean)
  }
}

export function parseDisplayResolution(output: string): DisplayResolutionResult {
  let physicalResolution: DisplayResolution | null = null
  let overrideResolution: DisplayResolution | null = null

  for (const line of output.split(/\r?\n/)) {
    const match = DISPLAY_SIZE_LINE.exec(line)
    if (!match) continue
    const width = Number.parseInt(match[2] ?? '', 10)
    const height = Number.parseInt(match[3] ?? '', 10)
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width <= 0 ||
      height <= 0
    ) {
      continue
    }
    const resolution = { width, height }
    if (match[1]?.toLowerCase() === 'physical') {
      physicalResolution = resolution
    } else {
      overrideResolution = resolution
    }
  }

  return {
    physicalResolution,
    logicalResolution: overrideResolution ?? physicalResolution
  }
}

export function parseAdbUid(output: string): number | null {
  const match = /\buid=(\d+)(?:\([^)]+\))?/.exec(output)
  return match?.[1] ? Number.parseInt(match[1], 10) : null
}

export function parseInstalledPackage(
  pathOutput: string,
  dumpsysOutput: string
): InstalledPackageInfo {
  if (!/^package:/m.test(pathOutput)) {
    return {
      installed: false,
      versionName: null,
      versionCode: null
    }
  }

  const versionCodeMatch = /\bversionCode=(\d+)/.exec(dumpsysOutput)
  const versionNameMatch = /\bversionName=([^\r\n]+)/.exec(dumpsysOutput)

  return {
    installed: true,
    versionName: versionNameMatch?.[1]?.trim() ?? null,
    versionCode: versionCodeMatch?.[1] ? Number.parseInt(versionCodeMatch[1], 10) : null
  }
}

export function parsePackageInstallation(
  pathOutput: string,
  dumpsysOutput: string
): PackageInstallationDetails {
  const packagePaths = [
    ...pathOutput.matchAll(/^package:(\/[^\r\n]+)$/gm)
  ]
    .map((match) => match[1]?.trim() ?? '')
    .filter(Boolean)
  const codePaths = [
    ...dumpsysOutput.matchAll(/^\s*codePath=(\/\S+)\s*$/gm)
  ]
    .map((match) => match[1]?.trim() ?? '')
    .filter(Boolean)
  const packageFlags = [
    ...dumpsysOutput.matchAll(/^\s*pkgFlags=\[([^\]]*)]/gm)
  ].flatMap((match) => (match[1] ?? '').split(/\s+/).filter(Boolean))
  const privateFlags = [
    ...dumpsysOutput.matchAll(/^\s*privateFlags=\[([^\]]*)]/gm)
  ].flatMap((match) => (match[1] ?? '').split(/\s+/).filter(Boolean))

  return {
    installedPackage: parseInstalledPackage(pathOutput, dumpsysOutput),
    packagePaths: [...new Set(packagePaths)],
    codePaths: [...new Set(codePaths)],
    activeCodePath: codePaths[0] ?? null,
    isSystem:
      packageFlags.includes('SYSTEM') ||
      packageFlags.includes('UPDATED_SYSTEM_APP'),
    isPrivileged: privateFlags.includes('PRIVILEGED')
  }
}

export function parseHomeComponent(output: string): string | null {
  return parseComponents(output).at(-1) ?? null
}

export function parseComponents(output: string): string[] {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  return [...new Set(lines.filter((candidate) => COMPONENT.test(candidate)))]
}

export function packageFromComponent(component: string | null): string | null {
  if (!component) return null
  return COMPONENT.exec(component)?.[1] ?? null
}

export function parseForegroundComponent(output: string): string | null {
  const lines = output.split(/\r?\n/)
  const markers = [
    'topResumedActivity',
    'mResumedActivity',
    'ResumedActivity',
    'Resumed:',
    'mFocusedApp',
    'mCurrentFocus'
  ]

  for (const marker of markers) {
    const line = lines.find((candidate) => candidate.includes(marker))
    const component = line?.match(COMPONENT_IN_TEXT)?.at(-1)
    if (component && COMPONENT.test(component)) return component
  }
  return null
}

export function parsePushProgress(output: string): number | null {
  const matches = [...output.matchAll(/(?:^|\s)(\d{1,3})%/g)]
  const last = matches.at(-1)?.[1]
  if (!last) return null
  return Math.min(100, Number.parseInt(last, 10))
}

export function evaluateCompatibility(
  apk: {
    minSdk: number
    abis: string[]
    versionCode: number
  },
  device: DeviceDetails,
  installedPackage: InstalledPackageInfo
): CompatibilityReport {
  const errors: string[] = []
  const warnings: string[] = []

  if (device.apiLevel === null) {
    errors.push('无法读取设备 API Level，不能完成 Android 版本兼容性检查。')
  } else if (apk.minSdk > device.apiLevel) {
    errors.push(`APK 要求 Android API ${apk.minSdk}，当前设备仅为 API ${device.apiLevel}。`)
  }

  if (apk.abis.length > 0) {
    if (device.abis.length === 0) {
      errors.push('无法读取设备 ABI，不能完成 CPU 架构兼容性检查。')
    } else if (!apk.abis.some((abi) => device.abis.includes(abi))) {
      errors.push(`APK 架构（${apk.abis.join('、')}）与设备架构（${device.abis.join('、')}）不兼容。`)
    }
  } else {
    warnings.push('APK 未包含原生库，将按通用 APK 处理。')
  }

  let versionRelation: CompatibilityReport['versionRelation'] = 'not-installed'
  if (installedPackage.installed) {
    if (installedPackage.versionCode === null) {
      versionRelation = 'unknown'
      warnings.push('设备已安装同包名应用，但无法读取当前 versionCode。')
    } else if (apk.versionCode > installedPackage.versionCode) {
      versionRelation = 'upgrade'
    } else if (apk.versionCode === installedPackage.versionCode) {
      versionRelation = 'same'
    } else {
      versionRelation = 'downgrade'
      warnings.push('待安装 APK 版本低于设备版本，只有可调试应用通常允许使用降级安装。')
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    installedPackage,
    versionRelation
  }
}
