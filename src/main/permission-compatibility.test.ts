import { describe, expect, it } from 'vitest'
import {
  applyPermissionAuthorization,
  evaluatePermissionCompatibility,
  parseAppOpsModes,
  parseColonSeparatedPackages,
  parseDevicePermissionDefinitions,
  parsePackagePermissionGrants,
  parseRequestedPermissions
} from './permission-compatibility'

const DEVICE_OUTPUT = `Permissions:
  Permission [android.permission.INTERNET] (123):
    sourcePackage=android
    uid=1000 gids=null type=0 prot=normal|instant
    perm=Permission{123 android.permission.INTERNET}
  Permission [android.permission.CAMERA] (456):
    sourcePackage=android
    uid=1000 gids=null type=0 prot=dangerous|instant
    perm=Permission{456 android.permission.CAMERA}
  Permission [android.permission.SET_TIME] (789):
    sourcePackage=android
    uid=1000 gids=null type=0 prot=signature|privileged
    perm=Permission{789 android.permission.SET_TIME}
  Permission [android.permission.DUMP] (abc):
    sourcePackage=android
    uid=1000 gids=null type=0 prot=signature|privileged|development
    perm=Permission{abc android.permission.DUMP}
  Permission [android.permission.WRITE_SETTINGS] (def):
    sourcePackage=android
    uid=1000 gids=null type=0 prot=signature|appop|pre23|preinstalled
    perm=Permission{def android.permission.WRITE_SETTINGS}
  Permission [android.permission.READ_CALL_LOG] (fed):
    sourcePackage=android
    uid=1000 gids=null type=0 prot=dangerous
    perm=Permission{fed android.permission.READ_CALL_LOG}
    flags=0x40000004

AppOp Permissions:
  AppOp Permission android.permission.WRITE_SETTINGS:
`

describe('设备权限兼容性', () => {
  it('从已安装应用 dumpsys 中读取并去重请求权限', () => {
    expect(
      parseRequestedPermissions(`Package [com.example]:
    requested permissions:
      android.permission.INTERNET
      android.permission.CAMERA
      android.permission.INTERNET
    install permissions:
      android.permission.INTERNET: granted=true
`)
    ).toEqual([
      { name: 'android.permission.INTERNET', maxSdkVersion: null },
      { name: 'android.permission.CAMERA', maxSdkVersion: null }
    ])
  })

  it('解析设备实际权限定义且不误读 AppOp 列表', () => {
    const definitions = parseDevicePermissionDefinitions(DEVICE_OUTPUT)

    expect(definitions).toHaveLength(6)
    expect(definitions.get('android.permission.SET_TIME')).toEqual({
      name: 'android.permission.SET_TIME',
      sourcePackage: 'android',
      protectionLevel: ['signature', 'privileged'],
      permissionFlags: []
    })
    expect(definitions.get('android.permission.READ_CALL_LOG')).toMatchObject({
      protectionLevel: ['dangerous'],
      permissionFlags: ['hardRestricted']
    })
  })

  it('按当前状态与实际获取路径区分权限', () => {
    const report = evaluatePermissionCompatibility(
      [
        { name: 'android.permission.INTERNET', maxSdkVersion: null },
        { name: 'android.permission.CAMERA', maxSdkVersion: null },
        { name: 'android.permission.WRITE_SETTINGS', maxSdkVersion: null },
        { name: 'android.permission.DUMP', maxSdkVersion: null },
        { name: 'android.permission.SET_TIME', maxSdkVersion: null }
      ],
      {
        serial: 'ABC123',
        deviceApiLevel: 30,
        definitions: parseDevicePermissionDefinitions(DEVICE_OUTPUT),
        systemModification: {
          state: 'possible',
          reason: '当前为 userdebug 固件'
        }
      }
    )

    expect(report.permissions.map(({ availability }) => availability)).toEqual([
      'ready',
      'adb-action',
      'adb-action',
      'adb-action',
      'adb-action'
    ])
    expect(report.permissions.map(({ preparation }) => preparation.method)).toEqual([
      'automatic',
      'pm-grant',
      'appops',
      'pm-grant',
      'privileged-allowlist'
    ])
    expect(report.summary).toMatchObject({
      ready: 1,
      adbAction: 4,
      unavailable: 0
    })
    expect(report.plan).toMatchObject({
      pmGrant: 2,
      appOps: 1,
      privilegedAllowlist: 1,
      requiresRoot: true,
      requiresReboot: true
    })
  })

  it('只有确认当前固件没有系统调整通道时才把特权权限标记为不可用', () => {
    const report = evaluatePermissionCompatibility(
      [{ name: 'android.permission.SET_TIME', maxSdkVersion: null }],
      {
        serial: 'ABC123',
        deviceApiLevel: 30,
        definitions: parseDevicePermissionDefinitions(DEVICE_OUTPUT),
        systemModification: {
          state: 'unavailable',
          reason: 'user 固件不允许 adb root 且没有 su'
        }
      }
    )

    expect(report.permissions[0]).toMatchObject({
      availability: 'unavailable',
      accessPath: 'unavailable',
      preparation: {
        method: 'privileged-allowlist',
        blocker: 'user 固件不允许 adb root 且没有 su'
      }
    })
    expect(report.summary.unavailable).toBe(1)
  })

  it('先排除 Manifest 上限与平台尚未引入的权限，再判断固件是否缺失定义', () => {
    const definitions = parseDevicePermissionDefinitions(DEVICE_OUTPUT)
    const report = evaluatePermissionCompatibility(
      [
        { name: 'android.permission.READ_EXTERNAL_STORAGE', maxSdkVersion: 28 },
        { name: 'android.permission.NEARBY_WIFI_DEVICES', maxSdkVersion: null }
      ],
      {
        serial: 'ABC123',
        deviceApiLevel: 30,
        definitions
      }
    )

    expect(report.permissions[0]?.availability).toBe('not-applicable')
    expect(report.permissions[1]).toMatchObject({
      availability: 'not-applicable',
      platformApiRange: {
        introducedApiLevel: 33,
        removedApiLevel: null
      },
      preparation: {
        method: 'none',
        label: 'Android API 33+ 才适用'
      }
    })
    expect(report.permissions[1]?.reason).toContain('当前设备为 API 30')
    expect(report.summary).toMatchObject({
      notApplicable: 2,
      unavailable: 0
    })
    expect(report.plan.total).toBe(0)

    const failed = evaluatePermissionCompatibility(
      [{ name: 'android.permission.CAMERA', maxSdkVersion: null }],
      {
        serial: 'ABC123',
        deviceApiLevel: 30,
        inspectionError: 'dumpsys 被设备拒绝'
      }
    )
    expect(failed.state).toBe('inspection-failed')
    expect(failed.permissions[0]?.reason).toContain('dumpsys 被设备拒绝')
  })

  it('设备达到权限引入版本后，缺少实际定义才标记为当前固件不可用', () => {
    const report = evaluatePermissionCompatibility(
      [{ name: 'android.permission.NEARBY_WIFI_DEVICES', maxSdkVersion: null }],
      {
        serial: 'ABC123',
        deviceApiLevel: 33,
        definitions: parseDevicePermissionDefinitions(DEVICE_OUTPUT)
      }
    )

    expect(report.permissions[0]).toMatchObject({
      availability: 'unavailable',
      platformApiRange: {
        introducedApiLevel: 33,
        removedApiLevel: null
      }
    })
    expect(report.permissions[0]?.reason).toContain('当前固件没有定义')
  })

  it('厂商在较低 API 固件回移权限定义时，以设备实际定义为准', () => {
    const definitions = parseDevicePermissionDefinitions(DEVICE_OUTPUT)
    definitions.set('android.permission.NEARBY_WIFI_DEVICES', {
      name: 'android.permission.NEARBY_WIFI_DEVICES',
      sourcePackage: 'android',
      protectionLevel: ['dangerous'],
      permissionFlags: []
    })

    const report = evaluatePermissionCompatibility(
      [{ name: 'android.permission.NEARBY_WIFI_DEVICES', maxSdkVersion: null }],
      {
        serial: 'ABC123',
        deviceApiLevel: 30,
        definitions
      }
    )

    expect(report.permissions[0]).toMatchObject({
      availability: 'adb-action',
      preparation: {
        method: 'pm-grant'
      },
      platformApiRange: {
        introducedApiLevel: 33,
        removedApiLevel: null
      }
    })
  })

  it('平台已移除且设备没有保留定义的旧权限在新系统上不适用', () => {
    const report = evaluatePermissionCompatibility(
      [{ name: 'android.permission.READ_HISTORY_BOOKMARKS', maxSdkVersion: null }],
      {
        serial: 'ABC123',
        deviceApiLevel: 30,
        definitions: parseDevicePermissionDefinitions(DEVICE_OUTPUT)
      }
    )

    expect(report.permissions[0]).toMatchObject({
      availability: 'not-applicable',
      platformApiRange: {
        introducedApiLevel: 4,
        removedApiLevel: 23
      },
      preparation: {
        label: 'Android API 23 起不再适用'
      }
    })
  })

  it('将 APK 自己定义并请求的签名权限识别为可用', () => {
    const definitions = parseDevicePermissionDefinitions(DEVICE_OUTPUT)
    definitions.set('com.example.SELF_PERMISSION', {
      name: 'com.example.SELF_PERMISSION',
      sourcePackage: 'com.example',
      protectionLevel: ['signature'],
      permissionFlags: [],
      definedByApk: true
    })

    const report = evaluatePermissionCompatibility(
      [{ name: 'com.example.SELF_PERMISSION', maxSdkVersion: null }],
      {
        serial: 'ABC123',
        deviceApiLevel: 30,
        definitions
      }
    )

    expect(report.permissions[0]).toMatchObject({
      availability: 'ready',
      preparation: {
        method: 'automatic'
      }
    })
  })

  it('通知策略访问使用系统服务命令，未知 AppOps 仍保留为用户授权', () => {
    const definitions = parseDevicePermissionDefinitions(DEVICE_OUTPUT)
    definitions.set('android.permission.ACCESS_NOTIFICATION_POLICY', {
      name: 'android.permission.ACCESS_NOTIFICATION_POLICY',
      sourcePackage: 'android',
      protectionLevel: ['signature', 'appop'],
      permissionFlags: []
    })
    definitions.set('com.example.UNKNOWN_SPECIAL_ACCESS', {
      name: 'com.example.UNKNOWN_SPECIAL_ACCESS',
      sourcePackage: 'com.example.system',
      protectionLevel: ['appop'],
      permissionFlags: []
    })

    const report = evaluatePermissionCompatibility(
      [
        {
          name: 'android.permission.ACCESS_NOTIFICATION_POLICY',
          maxSdkVersion: null
        },
        {
          name: 'com.example.UNKNOWN_SPECIAL_ACCESS',
          maxSdkVersion: null
        }
      ],
      {
        serial: 'ABC123',
        deviceApiLevel: 30,
        definitions
      }
    )

    expect(report.permissions[0]).toMatchObject({
      availability: 'adb-action',
      preparation: {
        method: 'notification-policy'
      }
    })
    expect(report.permissions[1]).toMatchObject({
      availability: 'user-action',
      preparation: {
        method: 'user-settings'
      }
    })
  })

  it('解析通知策略访问包名列表', () => {
    expect(
      parseColonSeparatedPackages(
        'com.example.first:com.example.second\n'
      )
    ).toEqual(new Set(['com.example.first', 'com.example.second']))
    expect(parseColonSeparatedPackages('null\n')).toEqual(new Set())
  })

  it('将 hardRestricted 权限编排为系统应用部署后再授予', () => {
    const definitions = parseDevicePermissionDefinitions(DEVICE_OUTPUT)
    const report = evaluatePermissionCompatibility(
      [{ name: 'android.permission.READ_CALL_LOG', maxSdkVersion: null }],
      {
        serial: 'ABC123',
        deviceApiLevel: 30,
        definitions,
        systemModification: {
          state: 'possible',
          reason: '当前为 userdebug 固件'
        }
      }
    )

    expect(report.permissions[0]).toMatchObject({
      availability: 'adb-action',
      permissionFlags: ['hardRestricted'],
      preparation: {
        method: 'restricted-system-grant',
        requiresRoot: true,
        requiresReboot: true
      }
    })
    expect(report.plan).toMatchObject({
      total: 1,
      systemApp: 1,
      requiresRoot: true
    })
  })

  it('回读 Package Manager 与 AppOps 的实际授权状态', () => {
    const report = evaluatePermissionCompatibility(
      [
        { name: 'android.permission.CAMERA', maxSdkVersion: null },
        { name: 'android.permission.WRITE_SETTINGS', maxSdkVersion: null }
      ],
      {
        serial: 'ABC123',
        deviceApiLevel: 30,
        definitions: parseDevicePermissionDefinitions(DEVICE_OUTPUT)
      }
    )
    const enriched = applyPermissionAuthorization(report, {
      installed: true,
      grants: parsePackagePermissionGrants(
        'android.permission.CAMERA: granted=true, flags=[ USER_SET]'
      ),
      appOps: parseAppOpsModes('WRITE_SETTINGS: allow; time=+2m'),
      notificationPolicyAccess: false
    })

    expect(enriched.permissions.map(({ authorization }) => authorization)).toEqual([
      'granted',
      'granted'
    ])
    expect(enriched.summary).toMatchObject({
      ready: 2,
      adbAction: 0
    })
    expect(enriched.plan.total).toBe(0)
  })
})
