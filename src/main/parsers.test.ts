import { describe, expect, it } from 'vitest'
import {
  evaluateCompatibility,
  parseAdbUid,
  packageFromComponent,
  parseDevices,
  parseComponents,
  parseDisplayResolution,
  parseForegroundComponent,
  parseGetProp,
  parseHomeComponent,
  parseInstalledPackage,
  parsePackageInstallation,
  parsePushProgress
} from './parsers'

describe('ADB 输出解析', () => {
  it('解析 USB、未授权和 TCP/IP 设备', () => {
    const devices = parseDevices(`List of devices attached
ABC123\tdevice product:panel_x1 model:Touch_Panel device:panel transport_id:1
USB999\tunauthorized usb:2-1 transport_id:2
192.168.1.20:5555\tdevice product:panel model:Wall_Panel device:wall transport_id:3
`)

    expect(devices).toHaveLength(3)
    expect(devices[0]).toMatchObject({
      serial: 'ABC123',
      state: 'device',
      model: 'Touch Panel',
      transport: 'usb'
    })
    expect(devices[1]?.state).toBe('unauthorized')
    expect(devices[2]).toMatchObject({
      serial: '192.168.1.20:5555',
      transport: 'tcp'
    })
  })

  it('将 ADB 的 no permissions 状态识别为驱动问题', () => {
    const devices = parseDevices(`List of devices attached
USB-NO-DRIVER\tno permissions (missing udev rules?); see [http://developer.android.com/tools/device.html]
`)

    expect(devices).toEqual([
      {
        serial: 'USB-NO-DRIVER',
        state: 'no-permissions',
        product: null,
        model: null,
        deviceName: null,
        transport: 'usb'
      }
    ])
  })

  it('合并 getprop 设备信息', () => {
    const summary = parseDevices(`List of devices attached
ABC123\tdevice model:Touch_Panel device:panel
`)[0]!
    const details = parseGetProp(
      summary,
      `[ro.product.manufacturer]: [Example Devices]
[ro.product.model]: [Touch Panel Pro]
[ro.build.version.release]: [12]
[ro.build.version.sdk]: [31]
[ro.product.cpu.abilist]: [arm64-v8a,armeabi-v7a]
[ro.build.type]: [userdebug]
[ro.debuggable]: [1]
[ro.boot.verifiedbootstate]: [orange]
[ro.boot.flash.locked]: [0]
`
    )

    expect(details).toMatchObject({
      manufacturer: 'Example Devices',
      model: 'Touch Panel Pro',
      androidVersion: '12',
      apiLevel: 31,
      abis: ['arm64-v8a', 'armeabi-v7a'],
      buildType: 'userdebug',
      debuggable: true,
      verifiedBootState: 'orange',
      bootloaderUnlocked: true,
      adbUid: null,
      suPath: null,
      rootAccessMode: 'none'
    })
    expect(parseAdbUid('uid=0(root) gid=0(root) groups=0(root)')).toBe(0)
    expect(parseAdbUid('uid=2000(shell) gid=2000(shell)')).toBe(2000)
  })

  it('解析 wm size 的物理与逻辑分辨率', () => {
    expect(
      parseDisplayResolution(`Physical size: 1920x1080
Override size: 1280x720
`)
    ).toEqual({
      physicalResolution: { width: 1920, height: 1080 },
      logicalResolution: { width: 1280, height: 720 }
    })
    expect(parseDisplayResolution('Physical size: 800x480\nOverride size: reset')).toEqual({
      physicalResolution: { width: 800, height: 480 },
      logicalResolution: { width: 800, height: 480 }
    })
    expect(parseDisplayResolution('')).toEqual({
      physicalResolution: null,
      logicalResolution: null
    })
  })

  it('解析包版本、HOME 组件和传输进度', () => {
    expect(
      parseInstalledPackage(
        'package:/data/app/com.example/base.apk',
        'versionCode=10302 minSdk=26 targetSdk=35\nversionName=1.3.2'
      )
    ).toEqual({
      installed: true,
      versionName: '1.3.2',
      versionCode: 10302
    })
    expect(parseHomeComponent('priority=0\ncom.android.launcher3/.Launcher\n')).toBe(
      'com.android.launcher3/.Launcher'
    )
    expect(
      parseComponents(
        'com.example.launcher/.PrimaryHome\ncom.example.launcher/.SecondaryHome\n'
      )
    ).toEqual([
      'com.example.launcher/.PrimaryHome',
      'com.example.launcher/.SecondaryHome'
    ])
    expect(packageFromComponent('com.android.launcher3/.Launcher')).toBe(
      'com.android.launcher3'
    )
    expect(parsePushProgress('[ 72%] /data/local/tmp/app.apk')).toBe(72)
  })

  it('区分活动更新包、固件系统副本和特权身份', () => {
    expect(
      parsePackageInstallation(
        'package:/data/app/com.example.panel/base.apk\n',
        `  Package [com.example.panel] (123):
    codePath=/data/app/com.example.panel
    pkgFlags=[ SYSTEM UPDATED_SYSTEM_APP HAS_CODE ]
    privateFlags=[ PRIVILEGED ]
  Hidden system packages:
    codePath=/system/app/Panel
    pkgFlags=[ SYSTEM HAS_CODE ]`
      )
    ).toEqual({
      installedPackage: {
        installed: true,
        versionName: null,
        versionCode: null
      },
      packagePaths: ['/data/app/com.example.panel/base.apk'],
      codePaths: ['/data/app/com.example.panel', '/system/app/Panel'],
      activeCodePath: '/data/app/com.example.panel',
      isSystem: true,
      isPrivileged: true
    })
  })

  it('兼容解析不同 Android 版本的当前前台 Activity', () => {
    expect(
      parseForegroundComponent(
        'topResumedActivity=ActivityRecord{91f2 u0 com.example.panel/.MainActivity t42}'
      )
    ).toBe('com.example.panel/.MainActivity')
    expect(
      parseForegroundComponent(
        'mCurrentFocus=Window{67ad u0 com.vendor.settings/com.vendor.settings.Settings}'
      )
    ).toBe('com.vendor.settings/com.vendor.settings.Settings')
    expect(
      parseForegroundComponent(
        'mResumedActivity: ActivityRecord{88e4114 u0 com.example.launcher/com.example.home.activity.FamilyHomeActivity t90}'
      )
    ).toBe(
      'com.example.launcher/com.example.home.activity.FamilyHomeActivity'
    )
    expect(parseForegroundComponent('mResumedActivity: null')).toBeNull()
  })
})

describe('兼容性预检', () => {
  const device = {
    serial: 'ABC123',
    state: 'device' as const,
    product: 'panel',
    model: 'Touch Panel',
    deviceName: 'panel',
    transport: 'usb' as const,
    manufacturer: 'Example Devices',
    androidVersion: '12',
    apiLevel: 31,
    abis: ['arm64-v8a', 'armeabi-v7a'],
    buildType: 'userdebug',
    debuggable: true,
    verifiedBootState: 'orange',
    bootloaderUnlocked: true,
    adbUid: 2000,
    suPath: null,
    rootAccessMode: 'none' as const,
    physicalResolution: null,
    logicalResolution: null
  }

  it('识别升级和通用 APK', () => {
    const report = evaluateCompatibility(
      { minSdk: 26, abis: [], versionCode: 20 },
      device,
      { installed: true, versionName: '1.0', versionCode: 10 }
    )
    expect(report.ok).toBe(true)
    expect(report.versionRelation).toBe('upgrade')
    expect(report.warnings).toContain('APK 未包含原生库，将按通用 APK 处理。')
  })

  it('阻止系统版本和 ABI 不兼容的 APK', () => {
    const report = evaluateCompatibility(
      { minSdk: 35, abis: ['x86_64'], versionCode: 1 },
      device,
      { installed: false, versionName: null, versionCode: null }
    )
    expect(report.ok).toBe(false)
    expect(report.errors.join(' ')).toContain('API 35')
    expect(report.errors.join(' ')).toContain('x86_64')
  })

  it('识别降级但不在预检阶段伪造可安装承诺', () => {
    const report = evaluateCompatibility(
      { minSdk: 26, abis: ['arm64-v8a'], versionCode: 9 },
      device,
      { installed: true, versionName: '2.0', versionCode: 10 }
    )
    expect(report.ok).toBe(true)
    expect(report.versionRelation).toBe('downgrade')
    expect(report.warnings.join(' ')).toContain('可调试应用')
  })
})
