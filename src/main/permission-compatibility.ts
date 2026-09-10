import type {
  ApkDeclaredPermission,
  DeviceDetails,
  PermissionAvailability,
  PermissionCheck,
  PermissionCheckSummary,
  PermissionCompatibilityReport,
  PermissionPreparation,
  PermissionPreparationMethod,
  PermissionPreparationPlan,
  PlatformPermissionApiRange,
  SystemModificationCapability
} from '../shared/contracts'
import { platformPermissionApiRange } from './android-permission-api-levels'

export interface DevicePermissionDefinition {
  name: string
  sourcePackage: string | null
  protectionLevel: string[]
  permissionFlags: string[]
  definedByApk?: boolean
}

type PermissionWithPlatformApiRange = ApkDeclaredPermission & {
  platformApiRange: PlatformPermissionApiRange | null
}

const SPECIAL_ACCESS = new Map<string, { label: string; solution: string }>([
  [
    'android.permission.WRITE_SETTINGS',
    {
      label: '修改系统设置',
      solution:
        '也可在设备“设置 → 特殊应用访问权限 → 修改系统设置”中允许该应用；应用应通过 ACTION_MANAGE_WRITE_SETTINGS 引导用户确认。'
    }
  ],
  [
    'android.permission.SYSTEM_ALERT_WINDOW',
    {
      label: '显示在其他应用上层',
      solution:
        '也可在设备“设置 → 特殊应用访问权限 → 显示在其他应用上层”中允许该应用；应用应通过 ACTION_MANAGE_OVERLAY_PERMISSION 引导用户确认。'
    }
  ],
  [
    'android.permission.REQUEST_INSTALL_PACKAGES',
    {
      label: '安装未知应用',
      solution:
        '也可在设备“设置 → 特殊应用访问权限 → 安装未知应用”中允许该应用；应用应通过 ACTION_MANAGE_UNKNOWN_APP_SOURCES 引导用户确认。'
    }
  ],
  [
    'android.permission.MANAGE_EXTERNAL_STORAGE',
    {
      label: '所有文件访问权',
      solution:
        '也可在设备“设置 → 特殊应用访问权限 → 所有文件访问权限”中允许该应用，并确认该能力符合设备系统版本和应用发布策略。'
    }
  ],
  [
    'android.permission.PACKAGE_USAGE_STATS',
    {
      label: '使用情况访问权',
      solution:
        '也可在设备“设置 → 特殊应用访问权限 → 使用情况访问权限”中允许该应用。'
    }
  ],
  [
    'android.permission.ACCESS_NOTIFICATION_POLICY',
    {
      label: '勿扰模式访问权',
      solution:
        '需要用户在设备“设置 → 特殊应用访问权限 → 勿扰模式访问权限”中允许该应用。'
    }
  ],
  [
    'android.permission.SCHEDULE_EXACT_ALARM',
    {
      label: '闹钟和提醒',
      solution:
        '也可在设备“设置 → 特殊应用访问权限 → 闹钟和提醒”中允许该应用，并在运行时检查 canScheduleExactAlarms()。'
    }
  ]
])

const AUTOMATABLE_APP_OPS = new Map<string, string>([
  ['android.permission.WRITE_SETTINGS', 'WRITE_SETTINGS'],
  ['android.permission.SYSTEM_ALERT_WINDOW', 'SYSTEM_ALERT_WINDOW'],
  ['android.permission.REQUEST_INSTALL_PACKAGES', 'REQUEST_INSTALL_PACKAGES'],
  ['android.permission.MANAGE_EXTERNAL_STORAGE', 'MANAGE_EXTERNAL_STORAGE'],
  ['android.permission.PACKAGE_USAGE_STATS', 'GET_USAGE_STATS'],
  ['android.permission.SCHEDULE_EXACT_ALARM', 'SCHEDULE_EXACT_ALARM']
])

const SYSTEM_ROLE_FLAGS = new Set([
  'installer',
  'verifier',
  'setup',
  'role',
  'recents',
  'companion',
  'documenter',
  'configurator',
  'incidentReportApprover',
  'oem'
])

const UNKNOWN_SYSTEM_MODIFICATION: SystemModificationCapability = {
  state: 'unknown',
  reason: '尚未读取到足够的设备构建信息，不能判断系统分区是否可由 ADB 安全调整。'
}

function preparation(
  method: PermissionPreparationMethod,
  label: string,
  options: Partial<
    Pick<PermissionPreparation, 'requiresApk' | 'requiresRoot' | 'requiresReboot' | 'blocker'>
  > = {}
): PermissionPreparation {
  return {
    method,
    label,
    requiresApk: options.requiresApk ?? false,
    requiresRoot: options.requiresRoot ?? false,
    requiresReboot: options.requiresReboot ?? false,
    blocker: options.blocker ?? null
  }
}

function noPreparation(label = '无可执行路径'): PermissionPreparation {
  return preparation('none', label)
}

function withAvailability(
  permission: Omit<PermissionCheck, 'availability' | 'accessPath'>,
  availability: PermissionAvailability
): PermissionCheck {
  return {
    ...permission,
    availability,
    accessPath: availability
  }
}

export function appOpForPermission(permissionName: string): string | null {
  return AUTOMATABLE_APP_OPS.get(permissionName) ?? null
}

export function inferSystemModificationCapability(
  device: DeviceDetails | null
): SystemModificationCapability {
  if (!device) return UNKNOWN_SYSTEM_MODIFICATION
  if (device.rootAccessMode === 'adbd' || device.rootAccessMode === 'su') {
    return {
      state: 'possible',
      reason: 'Root 通道已经回读验证；执行系统级准备前仍会单独验证系统分区可写性。'
    }
  }
  if (
    device.debuggable === true &&
    (device.buildType === 'userdebug' || device.buildType === 'eng')
  ) {
    return {
      state: 'possible',
      reason: '当前固件支持标准 adb root；需要系统级权限时会自动验证 Root、Remount 和写入结果。'
    }
  }
  if (device.suPath) {
    return {
      state: 'possible',
      reason: `设备存在 ${device.suPath}；需要系统级权限时会自动回读验证 su 0 和系统分区可写性。`
    }
  }
  if (device.buildType === 'user' && device.debuggable === false) {
    return {
      state: 'unavailable',
      reason:
        '当前为不可调试的 user 固件，且没有可供 ADB shell 使用的 su；工具无法写入系统应用目录或特权白名单。'
    }
  }
  return {
    state: 'unknown',
    reason: '设备没有暴露已验证的 Root 通道，现有构建信息也不足以确认系统分区调整能力。'
  }
}

export function parsePackagePermissionGrants(output: string): Map<string, boolean> {
  const grants = new Map<string, boolean>()
  for (const match of output.matchAll(/^\s*([A-Za-z0-9_.]+): granted=(true|false)\b/gm)) {
    const name = match[1]
    const granted = match[2]
    if (name && granted) grants.set(name, granted === 'true')
  }
  return grants
}

export function parseRequestedPermissions(output: string): ApkDeclaredPermission[] {
  const permissions = new Map<string, ApkDeclaredPermission>()
  let readingRequestedPermissions = false

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === 'requested permissions:') {
      readingRequestedPermissions = true
      continue
    }
    if (!readingRequestedPermissions || !line) continue
    if (/^[A-Za-z][A-Za-z0-9 _/-]*:$/.test(line)) break
    if (!/^[A-Za-z][A-Za-z0-9_.]+$/.test(line)) continue
    permissions.set(line, {
      name: line,
      // dumpsys 不提供原 Manifest 的 maxSdkVersion，只能明确标记为未知上限。
      maxSdkVersion: null
    })
  }

  return [...permissions.values()]
}

export function parseAppOpsModes(output: string): Map<string, string> {
  const modes = new Map<string, string>()
  for (const match of output.matchAll(/^\s*([A-Z][A-Z0-9_]+):\s+([a-z_]+)\b/gm)) {
    const name = match[1]
    const mode = match[2]
    if (name && mode) modes.set(name, mode)
  }
  return modes
}

export function parseColonSeparatedPackages(output: string): Set<string> {
  const value = output.trim()
  if (!value || value === 'null') return new Set()
  return new Set(
    value
      .split(/[:\r\n]+/)
      .map((item) => item.trim())
      .filter((item) => /^[A-Za-z][A-Za-z0-9_.]+$/.test(item))
  )
}

function splitProtectionLevel(value: string): string[] {
  return [...new Set(value.split('|').map((item) => item.trim()).filter(Boolean))]
}

function decodePermissionFlags(value: string | undefined): string[] {
  if (!value) return []
  const flags = Number.parseInt(value, 16)
  if (!Number.isFinite(flags)) return []
  return [
    ...(flags & 0x4 ? ['hardRestricted'] : []),
    ...(flags & 0x8 ? ['softRestricted'] : []),
    ...(flags & 0x10 ? ['immutablyRestricted'] : [])
  ]
}

export function parseDevicePermissionDefinitions(
  output: string
): Map<string, DevicePermissionDefinition> {
  const headers = [...output.matchAll(/^\s*Permission \[([^\]]+)](?:\s+\([^)]+\))?:\s*$/gm)]
  const definitions = new Map<string, DevicePermissionDefinition>()

  headers.forEach((header, index) => {
    const name = header[1]?.trim()
    if (!name || header.index === undefined) return
    const start = header.index + header[0].length
    const end = headers[index + 1]?.index ?? output.length
    const block = output.slice(start, end)
    const sourcePackage = /^\s*sourcePackage=([^\s\r\n]+)/m.exec(block)?.[1] ?? null
    const protectionText = /^\s*uid=.*\bprot=([^\r\n]+)/m.exec(block)?.[1]?.trim() ?? ''
    const permissionFlags = /^\s*flags=0x([0-9a-f]+)\s*$/im.exec(block)?.[1]
    definitions.set(name, {
      name,
      sourcePackage,
      protectionLevel: splitProtectionLevel(protectionText),
      permissionFlags: decodePermissionFlags(permissionFlags)
    })
  })

  return definitions
}

function systemAccessPath(
  capability: SystemModificationCapability
): PermissionAvailability {
  if (capability.state === 'verified' || capability.state === 'possible') return 'adb-action'
  if (capability.state === 'unavailable') return 'unavailable'
  return 'unknown'
}

function systemPreparation(
  method: 'system-app' | 'restricted-system-grant' | 'privileged-allowlist',
  capability: SystemModificationCapability
): PermissionPreparation {
  return preparation(
    method,
    method === 'privileged-allowlist'
      ? 'ADB 特权应用 + 最小权限白名单'
      : method === 'restricted-system-grant'
        ? 'ADB 系统应用 + pm grant'
        : 'ADB 系统应用部署',
    {
      requiresApk: true,
      requiresRoot: true,
      requiresReboot: true,
      blocker:
        capability.state === 'unavailable' || capability.state === 'unknown'
          ? capability.reason
          : null
    }
  )
}

function checkSpecialAccess(
  permission: PermissionWithPlatformApiRange,
  definition: DevicePermissionDefinition,
  special: { label: string; solution: string }
): PermissionCheck {
  if (permission.name === 'android.permission.ACCESS_NOTIFICATION_POLICY') {
    return withAvailability(
      {
        ...permission,
        sourcePackage: definition.sourcePackage,
        protectionLevel: definition.protectionLevel,
        permissionFlags: definition.permissionFlags,
        preparation: preparation(
          'notification-policy',
          'ADB cmd notification allow_dnd'
        ),
        reason:
          '当前设备通过通知策略访问名单控制此能力；Android 系统服务提供受控 shell 命令，工具可设置后回读 secure 名单验证。',
        solution: special.solution
      },
      'adb-action'
    )
  }
  const appOp = appOpForPermission(permission.name)
  if (appOp) {
    return withAvailability(
      {
        ...permission,
        sourcePackage: definition.sourcePackage,
        protectionLevel: definition.protectionLevel,
        permissionFlags: definition.permissionFlags,
        preparation: preparation('appops', `ADB AppOps · ${appOp}`),
        reason: `当前设备通过“${special.label}”特殊访问控制此能力；工具可设置对应 AppOps，并在设置后回读验证。`,
        solution: special.solution
      },
      'adb-action'
    )
  }
  return withAvailability(
    {
      ...permission,
      sourcePackage: definition.sourcePackage,
      protectionLevel: definition.protectionLevel,
      permissionFlags: definition.permissionFlags,
      preparation: preparation('user-settings', `设备设置 · ${special.label}`),
      reason: `当前设备通过“${special.label}”控制此能力，没有已验证的非交互式 ADB 授权路径。`,
      solution: special.solution
    },
    'user-action'
  )
}

function checkSystemPermission(
  permission: PermissionWithPlatformApiRange,
  definition: DevicePermissionDefinition,
  capability: SystemModificationCapability,
  method: 'system-app' | 'privileged-allowlist'
): PermissionCheck {
  const path = systemAccessPath(capability)
  const isPrivileged = method === 'privileged-allowlist'
  return withAvailability(
    {
      ...permission,
      sourcePackage: definition.sourcePackage,
      protectionLevel: definition.protectionLevel,
      permissionFlags: definition.permissionFlags,
      preparation: systemPreparation(method, capability),
      reason: isPrivileged
        ? '此权限要求应用位于系统镜像的 priv-app 目录；平台定义的 privileged 权限还必须在同一分区的 privapp-permissions 白名单中显式放行。'
        : '此权限要求应用作为预装系统应用存在，普通 /data/app 安装身份不能获得。',
      solution:
        path === 'adb-action'
          ? isPrivileged
            ? '“准备应用权限”会验证 Root 与系统分区可写性，将所选 APK 部署为特权应用，仅为实际请求的 privileged 权限生成白名单，重启后逐项回读。'
            : '“准备应用权限”会验证 Root 与系统分区可写性，将所选 APK 部署为系统应用，重启后回读验证。'
          : capability.reason
    },
    path
  )
}

function checkDefinedPermission(
  permission: PermissionWithPlatformApiRange,
  definition: DevicePermissionDefinition,
  capability: SystemModificationCapability
): PermissionCheck {
  const special = SPECIAL_ACCESS.get(permission.name)
  if (special) return checkSpecialAccess(permission, definition, special)

  const levels = new Set(definition.protectionLevel)
  const common = {
    ...permission,
    sourcePackage: definition.sourcePackage,
    protectionLevel: definition.protectionLevel,
    permissionFlags: definition.permissionFlags
  }

  if (definition.definedByApk && levels.has('signature')) {
    return withAvailability(
      {
        ...common,
        preparation: preparation('automatic', '安装时自动获得'),
        reason: '此自定义签名权限由当前 APK 自己定义并请求，应用自身签名满足授权条件。',
        solution: null
      },
      'ready'
    )
  }

  if (levels.has('dangerous') && definition.permissionFlags.includes('hardRestricted')) {
    const path = systemAccessPath(capability)
    return withAvailability(
      {
        ...common,
        preparation: systemPreparation('restricted-system-grant', capability),
        reason:
          '当前固件将此运行时权限标记为 hardRestricted；单独执行 pm grant 不足，但系统分区预装应用可以满足受限权限资格。',
        solution:
          path === 'adb-action'
            ? '“准备应用权限”会先验证 Root 和系统分区可写性，将 APK 部署为系统应用，重启后执行 pm grant 并回读。'
            : capability.reason
      },
      path
    )
  }

  if (levels.has('dangerous')) {
    return withAvailability(
      {
        ...common,
        preparation: preparation('pm-grant', 'ADB pm grant'),
        reason: '当前设备支持此运行时权限；目标应用未获授权时，工具可通过 Package Manager 授予并回读。',
        solution: '也可由应用在使用对应功能时发起系统权限请求，让用户在设备端确认。'
      },
      'adb-action'
    )
  }

  if (levels.has('development')) {
    return withAvailability(
      {
        ...common,
        preparation: preparation('pm-grant', 'ADB pm grant · development'),
        reason: '当前设备将此权限标记为 development，允许受控调试流程在安装后通过 Package Manager 授予。',
        solution: '“准备应用权限”会执行 pm grant，并通过 dumpsys package 回读实际结果。'
      },
      'adb-action'
    )
  }

  if (levels.has('vendorPrivileged')) {
    const path = capability.state === 'unavailable' ? 'unavailable' : 'unknown'
    return withAvailability(
      {
        ...common,
        preparation: noPreparation('需要 vendor 分区特权部署'),
        reason:
          '此权限带有 vendorPrivileged 标志，只允许 vendor 分区上的特权应用获得；当前工具尚未验证这台设备的 vendor 分区写入路径。',
        solution:
          path === 'unavailable'
            ? capability.reason
            : '需要验证 /vendor 的 Root、Remount、同分区特权应用与白名单路径；在完成设备级验证前不能误标为不可用，也不会盲目写入。'
      },
      path
    )
  }

  if (levels.has('privileged')) {
    return checkSystemPermission(
      permission,
      definition,
      capability,
      'privileged-allowlist'
    )
  }

  if (levels.has('preinstalled')) {
    return checkSystemPermission(permission, definition, capability, 'system-app')
  }

  const roleFlag = definition.protectionLevel.find((level) => SYSTEM_ROLE_FLAGS.has(level))
  if (roleFlag) {
    if (roleFlag === 'role') {
      return withAvailability(
        {
          ...common,
          preparation: preparation('user-settings', '设备默认应用 / 系统角色'),
          reason: '此权限由系统角色授予，需要用户在设备端选择符合条件的默认应用或角色持有者。',
          solution:
            '请在设备默认应用或对应角色页面选择目标应用；角色与权限的映射由当前固件决定，工具不会猜测角色名。'
        },
        'user-action'
      )
    }
    return withAvailability(
      {
        ...common,
        preparation: noPreparation(`需要系统角色 · ${roleFlag}`),
        reason: `此权限要求固件指定的系统组件身份（${roleFlag}），并非仅把 APK 放入系统目录即可获得；当前设备输出不足以证明该身份不可调整。`,
        solution:
          '需要结合当前固件的默认组件或 SystemConfig 映射确认具体 ADB 路径；在映射未知时保持“未知”，不会误标为不可用。'
      },
      'unknown'
    )
  }

  if (levels.has('signature') || levels.has('knownSigner')) {
    return withAvailability(
      {
        ...common,
        preparation: noPreparation('需要匹配签名'),
        reason: levels.has('knownSigner')
          ? `此权限只授予 ${definition.sourcePackage ?? '权限定义方'} 认可的签名证书。`
          : `此权限只授予与 ${definition.sourcePackage ?? '权限定义方'} 使用相同签名的应用。`,
        solution:
          '必须使用权限定义方认可的证书重新签名，或由固件厂商调整权限定义；pm grant、Root、系统应用身份和特权白名单都不能替代签名校验。'
      },
      'unavailable'
    )
  }

  if (levels.has('appop')) {
    return withAvailability(
      {
        ...common,
        preparation: preparation('user-settings', '设备特殊访问设置'),
        reason: '当前设备通过 AppOps 控制此权限，但工具没有该权限对应的已验证操作码，不能安全地自动设置。',
        solution: '请在设备的特殊应用访问设置中授权，并在应用内回读对应能力；如有厂商文档，可补充受控 AppOps 映射。'
      },
      'user-action'
    )
  }

  if (levels.has('normal')) {
    return withAvailability(
      {
        ...common,
        preparation: preparation('automatic', '安装时自动获得'),
        reason: '当前设备定义了此普通权限，系统会在安装时按规则自动授予。',
        solution: null
      },
      'ready'
    )
  }

  return withAvailability(
    {
      ...common,
      preparation: noPreparation('保护级别无法归类'),
      reason: `设备返回了无法可靠归类的保护级别：${definition.protectionLevel.join('|') || '未提供'}。`,
      solution: '请结合该设备系统源码或权限定义方文档确认授权条件，并在安装后回读实际授权状态。'
    },
    'unknown'
  )
}

function createSummary(permissions: PermissionCheck[]): PermissionCheckSummary {
  return {
    total: permissions.length,
    ready: permissions.filter(({ availability }) => availability === 'ready').length,
    userAction: permissions.filter(({ availability }) => availability === 'user-action').length,
    adbAction: permissions.filter(({ availability }) => availability === 'adb-action').length,
    unavailable: permissions.filter(({ availability }) => availability === 'unavailable').length,
    notApplicable: permissions.filter(({ availability }) => availability === 'not-applicable').length,
    unknown: permissions.filter(({ availability }) => availability === 'unknown').length
  }
}

function createPlan(permissions: PermissionCheck[]): PermissionPreparationPlan {
  const pending = permissions.filter(({ availability }) => availability === 'adb-action')
  const count = (method: PermissionPreparationMethod): number =>
    pending.filter(({ preparation: current }) => current.method === method).length
  return {
    total: pending.length,
    pmGrant: count('pm-grant'),
    appOps: count('appops'),
    serviceCommand: count('notification-policy'),
    systemApp: count('system-app') + count('restricted-system-grant'),
    privilegedAllowlist: count('privileged-allowlist'),
    requiresApk: pending.some(({ preparation: current }) => current.requiresApk),
    requiresRoot: pending.some(({ preparation: current }) => current.requiresRoot),
    requiresReboot: pending.some(({ preparation: current }) => current.requiresReboot)
  }
}

function refreshAggregates(
  report: Omit<PermissionCompatibilityReport, 'summary' | 'plan'>
): PermissionCompatibilityReport {
  return {
    ...report,
    summary: createSummary(report.permissions),
    plan: createPlan(report.permissions)
  }
}

function availabilityAfterAuthorization(
  permission: PermissionCheck,
  authorization: NonNullable<PermissionCheck['authorization']>
): PermissionAvailability {
  if (authorization === 'granted') return 'ready'
  if (authorization === 'not-required') return 'not-applicable'
  if (
    authorization !== 'not-installed' &&
    permission.preparation.method === 'automatic'
  ) {
    return 'unknown'
  }
  return permission.accessPath
}

export function applyPermissionAuthorization(
  report: PermissionCompatibilityReport,
  options: {
    installed: boolean
    grants: ReadonlyMap<string, boolean>
    appOps: ReadonlyMap<string, string>
    notificationPolicyAccess: boolean | null
  }
): PermissionCompatibilityReport {
  const permissions = report.permissions.map((permission): PermissionCheck => {
    let authorization: NonNullable<PermissionCheck['authorization']>
    if (!options.installed) {
      authorization = 'not-installed'
    } else if (permission.accessPath === 'not-applicable') {
      authorization = 'not-required'
    } else if (permission.preparation.method === 'appops') {
      const appOp = appOpForPermission(permission.name)
      const mode = appOp ? options.appOps.get(appOp) : undefined
      authorization =
        mode === 'allow'
          ? 'granted'
          : mode === 'deny' || mode === 'ignore' || mode === 'errored'
            ? 'denied'
            : 'unknown'
    } else if (permission.preparation.method === 'notification-policy') {
      authorization =
        options.notificationPolicyAccess === true
          ? 'granted'
          : options.notificationPolicyAccess === false
            ? 'denied'
            : 'unknown'
    } else {
      const granted = options.grants.get(permission.name)
      authorization =
        granted === true ? 'granted' : granted === false ? 'denied' : 'unknown'
    }
    return {
      ...permission,
      authorization,
      availability: availabilityAfterAuthorization(permission, authorization)
    }
  })
  return refreshAggregates({
    ...report,
    permissions
  })
}

export function applySystemModificationCapability(
  report: PermissionCompatibilityReport,
  capability: SystemModificationCapability
): PermissionCompatibilityReport {
  const permissions = report.permissions.map((permission): PermissionCheck => {
    if (
      permission.preparation.method !== 'system-app' &&
      permission.preparation.method !== 'restricted-system-grant' &&
      permission.preparation.method !== 'privileged-allowlist'
    ) {
      return permission
    }
    const accessPath = systemAccessPath(capability)
    const preparationState = systemPreparation(permission.preparation.method, capability)
    return {
      ...permission,
      accessPath,
      availability:
        permission.authorization === 'granted' ? 'ready' : accessPath,
      preparation: preparationState,
      solution:
        accessPath === 'adb-action'
          ? permission.preparation.method === 'privileged-allowlist'
            ? '“准备应用权限”会验证 Root 与系统分区可写性，将所选 APK 部署为特权应用，仅为实际请求的 privileged 权限生成白名单，重启后逐项回读。'
            : permission.preparation.method === 'restricted-system-grant'
              ? '“准备应用权限”会验证 Root 与系统分区可写性，将所选 APK 部署为系统应用，重启后执行 pm grant 并逐项回读。'
            : '“准备应用权限”会验证 Root 与系统分区可写性，将所选 APK 部署为系统应用，重启后回读验证。'
          : capability.reason
    }
  })
  return refreshAggregates({
    ...report,
    permissions,
    systemModification: capability
  })
}

export function evaluatePermissionCompatibility(
  declaredPermissions: ApkDeclaredPermission[],
  options: {
    serial: string | null
    deviceApiLevel: number | null
    definitions?: ReadonlyMap<string, DevicePermissionDefinition>
    inspectionError?: string | null
    systemModification?: SystemModificationCapability
  }
): PermissionCompatibilityReport {
  const inspectionError = options.inspectionError ?? null
  const systemModification =
    options.systemModification ?? UNKNOWN_SYSTEM_MODIFICATION
  const permissions = declaredPermissions.map((permission): PermissionCheck => {
    const enrichedPermission: PermissionWithPlatformApiRange = {
      ...permission,
      platformApiRange: platformPermissionApiRange(permission.name)
    }
    const definition = options.definitions?.get(permission.name)

    if (
      options.deviceApiLevel !== null &&
      permission.maxSdkVersion !== null &&
      options.deviceApiLevel > permission.maxSdkVersion
    ) {
      return withAvailability(
        {
          ...enrichedPermission,
          sourcePackage: null,
          protectionLevel: [],
          permissionFlags: [],
          preparation: noPreparation('当前版本不生效'),
          reason: `该声明限定 maxSdkVersion=${permission.maxSdkVersion}，当前设备 API ${options.deviceApiLevel} 已超过上限，系统会忽略这条声明。`,
          solution:
            '如果较新系统仍需要对应能力，应调整或移除 maxSdkVersion，并按新系统的权限模型重新实现和测试。'
        },
        'not-applicable'
      )
    }

    if (
      options.deviceApiLevel !== null &&
      !definition &&
      enrichedPermission.platformApiRange &&
      options.deviceApiLevel < enrichedPermission.platformApiRange.introducedApiLevel
    ) {
      const introducedApiLevel =
        enrichedPermission.platformApiRange.introducedApiLevel
      return withAvailability(
        {
          ...enrichedPermission,
          sourcePackage: null,
          protectionLevel: [],
          permissionFlags: [],
          preparation: noPreparation(`Android API ${introducedApiLevel}+ 才适用`),
          reason: `Android 平台从 API ${introducedApiLevel} 才引入此权限，当前设备为 API ${options.deviceApiLevel}；系统不定义它属于正常版本差异，无需用户授权或 ADB 处理。`,
          solution:
            '应用应仅在 Android API 达到该版本时请求并使用对应能力；较低版本继续使用该版本适用的权限模型。'
        },
        'not-applicable'
      )
    }

    if (
      options.deviceApiLevel !== null &&
      !definition &&
      enrichedPermission.platformApiRange?.removedApiLevel !== null &&
      enrichedPermission.platformApiRange?.removedApiLevel !== undefined &&
      options.deviceApiLevel >= enrichedPermission.platformApiRange.removedApiLevel
    ) {
      const removedApiLevel = enrichedPermission.platformApiRange.removedApiLevel
      return withAvailability(
        {
          ...enrichedPermission,
          sourcePackage: null,
          protectionLevel: [],
          permissionFlags: [],
          preparation: noPreparation(`Android API ${removedApiLevel} 起不再适用`),
          reason: `Android 平台从 API ${removedApiLevel} 起移除此权限，当前设备为 API ${options.deviceApiLevel}；系统不定义它属于正常版本差异，无需用户授权或 ADB 处理。`,
          solution:
            '应用应移除对该旧权限的依赖，并按当前 Android 版本的权限模型实现对应能力。'
        },
        'not-applicable'
      )
    }

    if (!options.serial || !options.definitions) {
      return withAvailability(
        {
          ...enrichedPermission,
          sourcePackage: null,
          protectionLevel: [],
          permissionFlags: [],
          preparation: noPreparation('等待设备检测'),
          reason: inspectionError
            ? `无法读取当前设备权限定义：${inspectionError}`
            : '尚未连接已授权设备，或当前设备的权限定义尚未读取完成，暂时不能判断实际授权路径。',
          solution: '连接并选择状态为 device 的目标设备后重新选择 APK 或切换设备，工具会自动检测。'
        },
        'unknown'
      )
    }

    if (!definition) {
      return withAvailability(
        {
          ...enrichedPermission,
          sourcePackage: null,
          protectionLevel: [],
          permissionFlags: [],
          preparation: noPreparation('当前固件未定义'),
          reason: '当前固件没有定义此权限；Package Manager 无法授予一个不存在的权限。',
          solution:
            '核对权限名和设备 Android 版本；必要时升级设备固件或安装定义该权限的可信系统组件，否则应移除声明并禁用依赖功能。'
        },
        'unavailable'
      )
    }

    return checkDefinedPermission(enrichedPermission, definition, systemModification)
  })

  return refreshAggregates({
    state: inspectionError
      ? 'inspection-failed'
      : options.serial && options.definitions
        ? 'ready'
        : 'waiting-for-device',
    serial: options.serial,
    deviceApiLevel: options.deviceApiLevel,
    permissions,
    systemModification,
    inspectionError
  })
}
