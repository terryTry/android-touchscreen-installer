import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ApkInfo,
  DriverStatus,
  InstalledPackageInfo,
  OperationHistoryDetail,
  SystemDeploymentMode,
  SystemDeploymentRecord
} from '../shared/contracts'
import type {
  AdbExecution,
  AdbGateway,
  AdbInitialization,
  AdbRunOptions,
  TcpEndpointProbe
} from './adb-client'
import type { ApkInspector } from './apk-inspector'
import { AppController } from './controller'
import type { SettingsGateway } from './settings-store'

vi.mock('./file-hash', () => ({ hashFile: vi.fn(async () => 'a'.repeat(64)) }))

vi.mock('./logger', () => ({
  writeApplicationError: vi.fn(),
  writeTechnicalLog: vi.fn()
}))

const DEVICE_SERIAL = 'ABC123'
const SYSTEM_HOME = 'com.android.launcher3/.Launcher'
const TARGET_HOME = 'com.example.touchscreen/com.example.touchscreen.MainActivity'

const apkInfo: ApkInfo = {
  token: 'fixture-token-1234',
  fileName: 'touchscreen.apk',
  fileSize: 1024,
  appName: '示例触摸屏应用',
  applicationClassName: 'android.app.Application',
  iconDataUrl: null,
  packageName: 'com.example.touchscreen',
  versionName: '1.3.2',
  versionCode: 10302,
  minSdk: 26,
  targetSdk: 35,
  abis: [],
  debuggable: true,
  declaredPermissions: [
    {
      name: 'android.permission.INTERNET',
      maxSdkVersion: null
    },
    {
      name: 'android.permission.CAMERA',
      maxSdkVersion: null
    }
  ],
  definedPermissions: [],
  homeActivities: [
    {
      name: 'com.example.touchscreen.MainActivity',
      component: TARGET_HOME,
      exported: true
    }
  ],
  selectedHomeComponent: TARGET_HOME,
  launchActivity: {
    name: 'com.example.touchscreen.MainActivity',
    component: TARGET_HOME,
    exported: true
  },
  warnings: []
}

class FakeSettings implements SettingsGateway {
  private original: string | null = null
  private recentTcp = { host: '', port: 5555 }
  private readonly managedPackages = new Map<string, string>()
  private readonly systemDeployments = new Map<string, SystemDeploymentRecord>()
  private operationHistory: OperationHistoryDetail[] = []

  getRecentTcp(): { host: string; port: number } {
    return this.recentTcp
  }

  setRecentTcp(host: string, port: number): void {
    this.recentTcp = { host, port }
  }

  getOriginalLauncher(_serial: string, _userId = 0): string | null {
    return this.original
  }

  saveOriginalLauncher(_serial: string, component: string, _userId = 0): void {
    this.original ??= component
  }

  getManagedPackage(serial: string, userId = 0): string | null {
    return this.managedPackages.get(`${serial}::${userId}`) ?? null
  }

  saveManagedPackage(serial: string, packageName: string, userId = 0): void {
    this.managedPackages.set(`${serial}::${userId}`, packageName)
  }

  getSystemDeployment(serial: string, packageName: string): SystemDeploymentRecord | null {
    return this.systemDeployments.get(`${serial}::${packageName}`) ?? null
  }

  saveSystemDeployment(record: SystemDeploymentRecord): void {
    this.systemDeployments.set(`${record.serial}::${record.packageName}`, record)
  }

  removeSystemDeployment(serial: string, packageName: string): void {
    this.systemDeployments.delete(`${serial}::${packageName}`)
  }

  getOperationHistory(): OperationHistoryDetail[] {
    return this.operationHistory
  }

  saveOperationHistory(history: OperationHistoryDetail[]): void {
    this.operationHistory = history
  }

}

class FakeAdb implements AdbGateway {
  readonly executablePath = '/fake/adb'
  readonly serverPort = 5038
  readonly version = 'Version 37.0.0'
  readonly calls: Array<{ args: string[]; options: AdbRunOptions }> = []
  installedPackage: InstalledPackageInfo = {
    installed: true,
    versionName: '1.3.1',
    versionCode: 10301
  }
  currentHome = SYSTEM_HOME
  foregroundComponent = apkInfo.launchActivity?.component ?? TARGET_HOME
  listedLaunchComponents = [
    apkInfo.launchActivity?.component ?? TARGET_HOME,
    'com.example.utility/.MainActivity'
  ]
  listedHomeComponents = [TARGET_HOME, SYSTEM_HOME]
  launchError = false
  commandFailureOutput: string | null = null
  tcpConnectOutput = 'connected to 192.168.1.20:5555\n'
  tcpConnectError = ''
  tcpConnectExitCode = 0
  tcpEndpoint: string | null = null
  tcpDeviceState: 'device' | 'unauthorized' | 'offline' = 'device'
  tcpProbe: TcpEndpointProbe = {
    status: 'open',
    detail: '测试端口可达。'
  }
  restartServerCalls = 0
  installFailure: string | null = null
  pushFailure: string | null = null
  pushFailuresRemaining = Infinity
  remoteHash = 'a'.repeat(64)
  connectionRecoveryFails = false
  installResponseLost = false
  streamTransferFailure: string | null = null
  streamedFileSize: number | null = null
  developmentSettingsEnabled = '1'
  unsupportedSettingsActions = new Set<string>()
  grantedPermissions = new Set(['android.permission.INTERNET'])
  appOps = new Map<string, string>()
  notificationPolicyPackages = new Set<string>()
  buildType = 'userdebug'
  debuggable = '1'
  adbRoot = false
  adbRootEffective = true
  suPath: string | null = null
  overlayRebootRequired = false
  overlayPrepared = false
  vendorRemountWorks = true
  systemWritable = false
  deployedMode: SystemDeploymentMode | null = null
  preinstalledSystemDirectory: string | null = null
  dataUpdateInstalled = false
  preinstalledVersionCode = apkInfo.versionCode
  preinstalledVersionName = apkInfo.versionName
  systemWriteFailure = false
  rebootChecks = -1
  readonly includeSetTime: boolean
  readonly includeNotificationPolicy: boolean
  readonly includeReadCallLog: boolean

  constructor(
    includeSetTime = false,
    includeNotificationPolicy = false,
    includeReadCallLog = false
  ) {
    this.includeSetTime = includeSetTime
    this.includeNotificationPolicy = includeNotificationPolicy
    this.includeReadCallLog = includeReadCallLog
  }

  async initialize(): Promise<AdbInitialization> {
    return {
      ok: true,
      version: this.version,
      message: 'ADB 已就绪'
    }
  }

  async dispose(): Promise<void> {}

  async probeTcpEndpoint(
    _host: string,
    _port: number,
    _timeoutMs?: number
  ): Promise<TcpEndpointProbe> {
    return this.tcpProbe
  }

  async restartServer() {
    this.restartServerCalls += 1
    const kill = await this.run(['kill-server'])
    const start = await this.run(['start-server'])
    return {
      ok: true,
      serverPort: this.serverPort,
      message: '测试 ADB Server 已重启。',
      kill,
      start
    }
  }

  async run(args: string[], options: AdbRunOptions = {}): Promise<AdbExecution> {
    this.calls.push({ args, options })
    const isSuCommand =
      this.suPath !== null &&
      args[0] === 'shell' &&
      args[1] === this.suPath &&
      args[2] === '0'
    const effectiveArgs = isSuCommand ? ['shell', ...args.slice(3)] : args
    const command = effectiveArgs.join(' ')
    let stdout = ''
    let stderr = ''
    let exitCode = 0
    const managedSystemDirectory =
      this.deployedMode === 'privileged'
        ? '/system/priv-app/AdbTool_com_example_touchscreen'
        : this.deployedMode === 'system'
          ? '/system/app/AdbTool_com_example_touchscreen'
          : null
    const systemDirectories = [
      ...new Set(
        [this.preinstalledSystemDirectory, managedSystemDirectory].filter(
          (path): path is string => path !== null
        )
      )
    ]

    if (command === 'kill-server' || command === 'start-server') {
      stdout = command === 'start-server' ? 'daemon started successfully\n' : ''
    } else if (command.startsWith('connect ')) {
      stdout = this.tcpConnectOutput
      stderr = this.tcpConnectError
      exitCode = this.tcpConnectExitCode
      if (exitCode === 0 && /(?:already )?connected to\s+/i.test(`${stdout}\n${stderr}`)) {
        this.tcpEndpoint = args[1] ?? null
      }
    } else if (command.startsWith('disconnect ')) {
      this.tcpEndpoint = null
    } else if (command === 'root') {
      this.adbRoot = this.adbRootEffective
      stdout = 'restarting adbd as root\n'
    } else if (command === 'remount') {
      this.systemWritable = this.adbRoot
      stdout = this.systemWritable ? 'remount succeeded\n' : 'remount failed: permission denied\n'
      exitCode = this.systemWritable ? 0 : 1
    } else if (command === 'shell /system/bin/remount') {
      if (!isSuCommand) {
        stderr = 'permission denied\n'
        exitCode = 1
      } else if (!this.vendorRemountWorks) {
        stderr = 'remount failed: read-only file system\n'
        exitCode = 1
      } else if (this.overlayRebootRequired && !this.overlayPrepared) {
        this.overlayPrepared = true
        stdout = 'Using overlayfs for /system\nNow reboot your device for settings to take effect\nremount succeeded\n'
      } else {
        this.systemWritable = true
        stdout = 'remount succeeded\n'
      }
    } else if (command === 'shell /system/bin/remount system') {
      this.systemWritable =
        isSuCommand && this.overlayPrepared && this.vendorRemountWorks
      stdout = this.systemWritable ? 'remount succeeded\n' : 'remount failed\n'
      exitCode = this.systemWritable ? 0 : 1
    } else if (command === 'shell mount -o remount,rw /system') {
      this.systemWritable = this.adbRoot || isSuCommand
      stdout = this.systemWritable ? '' : 'mount: permission denied\n'
      exitCode = this.systemWritable ? 0 : 1
    } else if (command === 'devices -l') {
      stdout = `List of devices attached
${DEVICE_SERIAL}\tdevice product:panel model:Touch_Panel device:panel transport_id:1
${this.tcpEndpoint ? `${this.tcpEndpoint}\t${this.tcpDeviceState} product:panel model:Touch_Panel device:panel transport_id:2\n` : ''}
`
    } else if (command === 'shell getprop') {
      stdout = `[ro.product.manufacturer]: [Example Devices]
[ro.product.model]: [Touch Panel]
[ro.build.version.release]: [12]
[ro.build.version.sdk]: [31]
[ro.product.cpu.abilist]: [arm64-v8a,armeabi-v7a]
[ro.build.type]: [${this.buildType}]
[ro.debuggable]: [${this.debuggable}]
[ro.boot.verifiedbootstate]: [orange]
[ro.boot.flash.locked]: [0]
`
    } else if (command === 'shell wm size') {
      stdout = 'Physical size: 1920x1080\nOverride size: 1280x720\n'
    } else if (command === 'shell id') {
      stdout = this.adbRoot || isSuCommand
        ? 'uid=0(root) gid=0(root) groups=0(root)\n'
        : 'uid=2000(shell) gid=2000(shell) groups=2000(shell)\n'
    } else if (command === 'shell command -v su') {
      if (this.suPath) {
        stdout = `${this.suPath}\n`
      } else {
        exitCode = 1
      }
    } else if (command === 'shell dumpsys activity activities') {
      stdout = `topResumedActivity=ActivityRecord{91f2 u0 ${this.foregroundComponent} t42}\n`
    } else if (command === 'shell dumpsys package permissions') {
      stdout = `Permissions:
  Permission [android.permission.INTERNET] (123):
    sourcePackage=android
    uid=1000 gids=null type=0 prot=normal|instant
    perm=Permission{123 android.permission.INTERNET}
  Permission [android.permission.CAMERA] (456):
    sourcePackage=android
    uid=1000 gids=null type=0 prot=dangerous|instant
    perm=Permission{456 android.permission.CAMERA}
  Permission [android.permission.WRITE_SETTINGS] (789):
    sourcePackage=android
    uid=1000 gids=null type=0 prot=signature|appop|pre23|preinstalled
    perm=Permission{789 android.permission.WRITE_SETTINGS}
  Permission [android.permission.SET_TIME] (abc):
    sourcePackage=android
    uid=1000 gids=null type=0 prot=signature|privileged
    perm=Permission{abc android.permission.SET_TIME}
  Permission [android.permission.ACCESS_NOTIFICATION_POLICY] (def):
    sourcePackage=android
    uid=1000 gids=null type=0 prot=normal
    perm=Permission{def android.permission.ACCESS_NOTIFICATION_POLICY}
  Permission [android.permission.READ_CALL_LOG] (fed):
    sourcePackage=android
    uid=1000 gids=null type=0 prot=dangerous
    perm=Permission{fed android.permission.READ_CALL_LOG}
    flags=0x40000004
`
    } else if (
      command.includes('query-activities') &&
      command.includes('android.intent.category.LAUNCHER') &&
      !command.includes(' -p ')
    ) {
      stdout = `${this.listedLaunchComponents.join('\n')}\n`
    } else if (
      command.includes('query-activities') &&
      command.includes('android.intent.category.HOME') &&
      !command.includes(' -p ')
    ) {
      stdout = `${this.listedHomeComponents.join('\n')}\n`
    } else if (command.includes('android.intent.category.LAUNCHER')) {
      stdout = `${apkInfo.launchActivity?.component ?? ''}\n`
    } else if (command.includes('query-activities')) {
      stdout = `${apkInfo.selectedHomeComponent ?? ''}\n`
    } else if (command.includes('resolve-activity')) {
      stdout = `${this.currentHome}\n`
    } else if (command === `shell pm path ${apkInfo.packageName}`) {
      const activeSystemDirectory = systemDirectories.at(-1) ?? null
      const activeDataPackage =
        systemDirectories.length === 0 || this.dataUpdateInstalled
      stdout = this.installedPackage.installed
        ? activeDataPackage
          ? `package:/data/app/${apkInfo.packageName}/base.apk\n`
          : `package:${activeSystemDirectory}/base.apk\n`
        : ''
    } else if (command === `shell dumpsys package ${apkInfo.packageName}`) {
      const activeSystemDirectory = systemDirectories.at(-1) ?? null
      const activeDataPackage =
        systemDirectories.length === 0 || this.dataUpdateInstalled
      const activeCodePath = activeDataPackage
        ? `/data/app/${apkInfo.packageName}`
        : activeSystemDirectory
      const hiddenSystemPaths = systemDirectories.filter(
        (path) => path !== activeCodePath
      )
      stdout = `${activeCodePath ? `    codePath=${activeCodePath}\n` : ''}versionCode=${this.installedPackage.versionCode ?? 0} minSdk=26 targetSdk=35
    versionName=${this.installedPackage.versionName ?? ''}
    pkgFlags=[ HAS_CODE${systemDirectories.length > 0 ? ' SYSTEM' : ''}${systemDirectories.length > 0 && activeDataPackage ? ' UPDATED_SYSTEM_APP' : ''} ]
    privateFlags=[ ALLOW_AUDIO_PLAYBACK_CAPTURE${this.deployedMode === 'privileged' ? ' PRIVILEGED' : ''} ]
    requested permissions:
      android.permission.INTERNET
      android.permission.CAMERA
${this.includeSetTime ? '      android.permission.SET_TIME\n' : ''}
${this.includeNotificationPolicy ? '      android.permission.ACCESS_NOTIFICATION_POLICY\n' : ''}
${this.includeReadCallLog ? '      android.permission.READ_CALL_LOG\n' : ''}
    install permissions:
      android.permission.INTERNET: granted=${this.grantedPermissions.has('android.permission.INTERNET')}
${this.includeSetTime ? `      android.permission.SET_TIME: granted=${this.deployedMode === 'privileged'}\n` : ''}
    runtime permissions:
      android.permission.CAMERA: granted=${this.grantedPermissions.has('android.permission.CAMERA')}
${this.includeReadCallLog ? `      android.permission.READ_CALL_LOG: granted=${this.grantedPermissions.has('android.permission.READ_CALL_LOG')}\n` : ''}
${hiddenSystemPaths.map((path) => `  Hidden system package:\n    codePath=${path}\n    pkgFlags=[ SYSTEM HAS_CODE ]`).join('\n')}
`
    } else if (command === `shell appops get ${apkInfo.packageName}`) {
      stdout =
        this.appOps.size > 0
          ? `${[...this.appOps].map(([name, mode]) => `${name}: ${mode}`).join('\n')}\n`
          : 'No operations.\nDefault mode: default\n'
    } else if (
      command ===
      'shell settings get secure enabled_notification_policy_access_packages'
    ) {
      stdout =
        this.notificationPolicyPackages.size > 0
          ? `${[...this.notificationPolicyPackages].join(':')}\n`
          : 'null\n'
    } else if (
      command ===
      `shell cmd notification allow_dnd ${apkInfo.packageName} 0`
    ) {
      this.notificationPolicyPackages.add(apkInfo.packageName)
    } else if (command.startsWith(`shell pm grant ${apkInfo.packageName} `)) {
      this.grantedPermissions.add(args.at(-1) ?? '')
    } else if (command.startsWith(`shell appops set ${apkInfo.packageName} `)) {
      this.appOps.set(args.at(-2) ?? '', args.at(-1) ?? '')
    } else if (command.startsWith('shell sha256sum ')) {
      stdout = `${this.remoteHash}  ${args.at(-1)}\n`
    } else if (command.startsWith('shell stat -c %s ')) {
      stdout = `${this.streamedFileSize ?? apkInfo.fileSize}\n`
    } else if (command.startsWith('shell dd of=')) {
      if (this.streamTransferFailure) {
        stderr = this.streamTransferFailure
        exitCode = 1
      } else {
        this.streamedFileSize = apkInfo.fileSize
      }
    } else if (args[0] === 'push') {
      options.onOutput?.('[ 50%] pushing APK')
      options.onOutput?.('[100%] pushing APK')
      if (this.pushFailure && this.pushFailuresRemaining-- > 0) {
        stderr = this.pushFailure
        exitCode = 1
      } else {
        stdout = '1 file pushed'
      }
    } else if (command.startsWith('shell pm install ')) {
      if (this.installFailure) {
        stderr = `Failure [${this.installFailure}]\n`
        exitCode = 1
      } else {
        this.installedPackage = {
          installed: true,
          versionName: apkInfo.versionName,
          versionCode: apkInfo.versionCode
        }
        stdout = this.installResponseLost ? '' : 'Success\n'
        if (this.installResponseLost) { stderr = 'adb: device offline'; exitCode = 1 }
      }
    } else if (command.startsWith('shell cmd package set-home-activity')) {
      this.currentHome = args.at(-1) ?? this.currentHome
      stdout = 'Success\n'
    } else if (command === `uninstall ${apkInfo.packageName}`) {
      if (systemDirectories.length > 0 && this.dataUpdateInstalled) {
        this.dataUpdateInstalled = false
        this.installedPackage = {
          installed: true,
          versionName: this.preinstalledSystemDirectory
            ? this.preinstalledVersionName
            : apkInfo.versionName,
          versionCode: this.preinstalledSystemDirectory
            ? this.preinstalledVersionCode
            : apkInfo.versionCode
        }
        stdout = 'Success\n'
      } else if (systemDirectories.length > 0) {
        stderr = 'Failure [DELETE_FAILED_INTERNAL_ERROR]\n'
        exitCode = 1
      } else {
        this.installedPackage = {
          installed: false,
          versionName: null,
          versionCode: null
        }
        stdout = 'Success\n'
      }
    } else if (
      command === `shell pm uninstall --user 0 ${apkInfo.packageName}`
    ) {
      this.installedPackage = {
        installed: false,
        versionName: this.installedPackage.versionName,
        versionCode: this.installedPackage.versionCode
      }
      stdout = 'Success\n'
    } else if (command === `shell pm clear ${apkInfo.packageName}`) {
      stdout = 'Success\n'
    } else if (
      command === `shell pm list packages -u ${apkInfo.packageName}`
    ) {
      stdout =
        this.installedPackage.installed || systemDirectories.length > 0
          ? `package:${apkInfo.packageName}\n`
          : ''
    } else if (command === 'shell settings get global development_settings_enabled') {
      stdout = `${this.developmentSettingsEnabled}\n`
    } else if (command.startsWith('shell am start')) {
      const action = args.at(-1) ?? ''
      if (this.unsupportedSettingsActions.has(action)) {
        stdout = `Error: Activity not started, unable to resolve Intent { act=${action} }\n`
      } else if (this.launchError) {
        stderr = 'Error: Activity class does not exist'
        exitCode = 1
      } else {
        stdout = 'Starting: Intent\n'
      }
    } else if (command.startsWith('shell am force-stop')) {
      stdout = ''
    } else if (command === 'reboot') {
      this.rebootChecks = 0
      this.adbRoot = false
      this.systemWritable = false
    } else if (command === 'get-state') {
      if (this.connectionRecoveryFails) {
        stderr = 'device offline'
        exitCode = 1
      } else if (this.rebootChecks === 0) {
        this.rebootChecks = 1
        stderr = 'device offline'
        exitCode = 1
      } else {
        stdout = 'device\n'
      }
    } else if (command === 'shell getprop sys.boot_completed') {
      stdout = '1\n'
    } else if (command === 'shell test -w /system') {
      exitCode = this.systemWritable ? 0 : 1
    } else if (command.startsWith('shell test -e /system/')) {
      const target = effectiveArgs.at(-1) ?? ''
      exitCode = systemDirectories.includes(target) ? 0 : 1
    } else if (command.startsWith('shell test ! -e /system/')) {
      const target = effectiveArgs.at(-1) ?? ''
      exitCode = systemDirectories.includes(target) ? 1 : 0
    } else if (command.startsWith('shell cp ') && command.endsWith('/base.apk')) {
      if (this.systemWriteFailure) {
        stderr = 'cp: write error: No space left on device'
        exitCode = 1
      } else {
        this.dataUpdateInstalled = this.installedPackage.installed
        this.deployedMode = command.includes('/system/priv-app/') ? 'privileged' : 'system'
        this.installedPackage = {
          installed: true,
          versionName: apkInfo.versionName,
          versionCode: apkInfo.versionCode
        }
      }
    } else if (
      command.startsWith('shell cp ') &&
      command.includes('/system/etc/permissions/privapp-permissions-adbtool-')
    ) {
      stdout = ''
    } else if (command.startsWith('shell rm -rf /system/')) {
      const target = effectiveArgs.at(-1) ?? ''
      if (target === this.preinstalledSystemDirectory) {
        this.preinstalledSystemDirectory = null
      }
      if (target === managedSystemDirectory) {
        this.deployedMode = null
      }
    } else if (
      command.startsWith('shell mkdir -p /system/app/AdbTool_') ||
      command.startsWith('shell mkdir -p /system/priv-app/AdbTool_') ||
      command.startsWith('shell chown ') ||
      command.startsWith('shell chmod ') ||
      command.startsWith('shell restorecon ')
    ) {
      stdout = ''
    } else if (command.startsWith('shell input keyevent')) {
      if (this.commandFailureOutput) {
        stdout = this.commandFailureOutput
      } else {
        stdout = ''
      }
    } else if (command === 'shell sync') {
      stdout = ''
    } else if (command.startsWith('shell rm -f')) {
      stdout = ''
    } else {
      stderr = `未配置的测试命令：${command}`
      exitCode = 1
    }

    return {
      args: ['-P', String(this.serverPort), ...(options.serial ? ['-s', options.serial] : []), ...args],
      stdout,
      stderr,
      exitCode,
      durationMs: 1,
      timedOut: false
    }
  }
}

const driverStatus: DriverStatus = {
  state: 'not-applicable',
  message: '测试环境'
}

function createController(
  info: ApkInfo = apkInfo,
  settings = new FakeSettings()
): {
  controller: AppController
  adb: FakeAdb
  settings: FakeSettings
} {
  const adb = new FakeAdb(
    info.declaredPermissions.some(
      ({ name }) => name === 'android.permission.SET_TIME'
    ),
    info.declaredPermissions.some(
      ({ name }) => name === 'android.permission.ACCESS_NOTIFICATION_POLICY'
    ),
    info.declaredPermissions.some(
      ({ name }) => name === 'android.permission.READ_CALL_LOG'
    )
  )
  const apkInspector = {
    inspect: vi.fn(async (path: string) => ({
      path,
      info
    }))
  } as unknown as ApkInspector
  return {
    controller: new AppController({
      adb,
      settings,
      apkInspector,
      driverStatus,
      clientVersion: '0.1.0',
      monitorIntervalMs: 1_000_000
    }),
    adb,
    settings
  }
}

const activeControllers: AppController[] = []

afterEach(async () => {
  await Promise.all(activeControllers.splice(0).map((controller) => controller.dispose()))
})

describe('主流程控制器', () => {
  it('手动查询更新 USB 列表并清除已经断开的选择', async () => {
    const { controller, adb } = createController()
    activeControllers.push(controller)
    await controller.initialize()
    const run = adb.run.bind(adb)
    vi.spyOn(adb, 'run').mockImplementation(async (args, options) => {
      const result = await run(args, options)
      return args[0] === 'devices' ? { ...result, stdout: 'List of devices attached\n' } : result
    })
    await controller.refreshUsbDevices()
    expect(controller.getSnapshot()).toMatchObject({
      devices: [], selectedSerial: null, selectedDevice: null, busy: false,
      operation: { status: 'success', summary: '查询完成，未检测到 USB ADB 设备。' }
    })
  })

  it('手动查询失败保留原列表并展示错误', async () => {
    const { controller, adb } = createController()
    activeControllers.push(controller)
    await controller.initialize()
    const devices = controller.getSnapshot().devices
    const run = adb.run.bind(adb)
    vi.spyOn(adb, 'run').mockImplementation(async (args, options) => {
      const result = await run(args, options)
      return args[0] === 'devices' ? { ...result, exitCode: 1, stderr: 'server unavailable' } : result
    })
    await controller.refreshUsbDevices()
    expect(controller.getSnapshot().devices).toEqual(devices)
    expect(controller.getSnapshot()).toMatchObject({
      busy: false, operation: { status: 'error', summary: 'USB ADB 设备列表查询失败。' }
    })
  })

  it('手动查询等待正在执行的设备发现后重新查询，重复点击不会并发执行', async () => {
    const { controller, adb } = createController()
    activeControllers.push(controller)
    const run = adb.run.bind(adb)
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    let count = 0
    vi.spyOn(adb, 'run').mockImplementation(async (args, options) => {
      if (args[0] === 'devices' && ++count === 1) await pending
      return run(args, options)
    })
    const initialization = controller.initialize()
    await vi.waitFor(() => expect(count).toBe(1))
    const refresh = controller.refreshUsbDevices()
    await controller.refreshUsbDevices()
    expect(count).toBe(1)
    release()
    await Promise.all([initialization, refresh])
    expect(count).toBe(2)
    expect(controller.getSnapshot().operation.status).toBe('success')
  })

  it.each([1, 2])('首次连接失败 %i 次后自动恢复，只生成一条成功记录', async (failures) => {
    const { controller, adb } = createController()
    activeControllers.push(controller)
    await controller.initialize()
    const run = adb.run.bind(adb)
    let connects = 0
    vi.spyOn(adb, 'run').mockImplementation(async (args, options) => {
      if (args[0] === 'connect') {
        adb.tcpConnectOutput = ++connects <= failures
          ? 'failed to connect: No route to host'
          : 'connected to 192.168.1.20:5555'
      }
      return run(args, options)
    })
    await controller.connectTcp({ host: '192.168.1.20', port: 5555 })
    expect(connects).toBe(failures + 1)
    expect(adb.restartServerCalls).toBe(failures === 2 ? 1 : 0)
    expect(controller.getSnapshot()).toMatchObject({
      busy: false, selectedSerial: '192.168.1.20:5555', operation: { status: 'success' }
    })
    expect(controller.getSnapshot().operationHistory).toHaveLength(1)
  })

  it('首次连接时端口不可达即停止，保留手动恢复入口', async () => {
    const { controller, adb } = createController()
    activeControllers.push(controller)
    adb.tcpConnectOutput = 'failed to connect: No route to host'
    adb.tcpProbe = { status: 'timeout', detail: '端口探测超时' }
    await controller.initialize()
    await controller.connectTcp({ host: '192.168.1.20', port: 5555 })
    expect(adb.calls.filter(({ args }) => args[0] === 'connect')).toHaveLength(1)
    expect(adb.restartServerCalls).toBe(0)
    expect(controller.getSnapshot().operation.status).toBe('error')
    expect(controller.getSnapshot().busy).toBe(false)
    expect(controller.getSnapshot().tcpRepair.phase).toBe('error')
  })

  it.each(['unauthorized', 'protocol fault', 'Connection refused'])('首次连接遇到 %s 不自动重启', async (output) => {
    const { controller, adb } = createController()
    activeControllers.push(controller)
    adb.tcpConnectOutput = output
    await controller.initialize()
    await controller.connectTcp({ host: '192.168.1.20', port: 5555 })
    expect(adb.calls.filter(({ args }) => args[0] === 'connect')).toHaveLength(1)
    expect(adb.restartServerCalls).toBe(0)
    expect(controller.getSnapshot().operation.status).toBe('error')
  })

  it('不会把 adb connect 的失败文本误记为成功', async () => {
    const { controller, adb } = createController()
    activeControllers.push(controller)
    adb.tcpConnectOutput = "failed to connect to '192.168.1.20:5555': No route to host\n"

    await controller.initialize()
    await controller.connectTcp({ host: '192.168.1.20', port: 5555 })

    expect(adb.calls.filter(({ args }) => args[0] === 'connect')).toHaveLength(3)
    expect(adb.restartServerCalls).toBe(1)
    expect(controller.getSnapshot().operation).toMatchObject({
      status: 'error',
      summary: 'TCP/IP 连接失败。',
      suggestion: expect.stringContaining('网络')
    })
    expect(controller.getSnapshot().operationHistory[0]).toMatchObject({
      title: '建立 TCP/IP 连接',
      status: 'error'
    })
  })

  it('目标端口可达时重启应用内 ADB Server 并重新连接', async () => {
    const { controller, adb } = createController()
    activeControllers.push(controller)
    adb.tcpConnectOutput = "failed to connect to '192.168.1.20:5555': No route to host\n"

    await controller.initialize()
    await controller.connectTcp({ host: '192.168.1.20', port: 5555 })
    expect(controller.getSnapshot().tcpRepair).toMatchObject({
      phase: 'error',
      failureKind: 'network',
      probe: 'not-run'
    })

    adb.tcpConnectOutput = 'connected to 192.168.1.20:5555\n'
    await controller.repairTcpConnection()

    expect(adb.restartServerCalls).toBe(2)
    expect(controller.getSnapshot().tcpRepair).toMatchObject({
      phase: 'success',
      probe: 'open',
      endpoint: { host: '192.168.1.20', port: 5555 }
    })
    expect(controller.getSnapshot().operation).toMatchObject({
      status: 'success',
      summary: expect.stringContaining('修复并通过 TCP/IP 连接')
    })
    expect(adb.calls.map(({ args }) => args[0])).toContain('kill-server')
    expect(adb.calls.map(({ args }) => args[0])).toContain('start-server')
  })

  it('目标端口未监听时不重启 ADB Server，并给出端口建议', async () => {
    const { controller, adb } = createController()
    activeControllers.push(controller)
    adb.tcpConnectOutput = "failed to connect to '192.168.1.20:5555': Connection refused\n"
    adb.tcpProbe = {
      status: 'closed',
      detail: '192.168.1.20:5555 可达，但目标端口拒绝连接。'
    }

    await controller.initialize()
    await controller.connectTcp({ host: '192.168.1.20', port: 5555 })
    await controller.repairTcpConnection()

    expect(adb.restartServerCalls).toBe(0)
    expect(controller.getSnapshot().tcpRepair).toMatchObject({
      phase: 'error',
      probe: 'closed'
    })
    expect(controller.getSnapshot().operation).toMatchObject({
      status: 'error',
      summary: '目标 TCP/IP 端口未监听。'
    })
  })

  it('设备 offline 时先断开旧端点再重新连接，不重启外部服务', async () => {
    const { controller, adb } = createController()
    activeControllers.push(controller)
    adb.tcpDeviceState = 'offline'

    await controller.initialize()
    await controller.connectTcp({ host: '192.168.1.20', port: 5555 })
    expect(controller.getSnapshot().tcpRepair.failureKind).toBe('offline')

    adb.tcpDeviceState = 'device'
    await controller.repairTcpConnection()

    expect(adb.restartServerCalls).toBe(0)
    expect(adb.calls.map(({ args }) => args[0])).toContain('disconnect')
    expect(controller.getSnapshot().tcpRepair.phase).toBe('success')
    expect(controller.getSnapshot().operation.status).toBe('success')
  })

  it('不会把其他 ADB 指令的错误输出误记为成功', async () => {
    const { controller, adb } = createController()
    activeControllers.push(controller)
    adb.commandFailureOutput = 'Error: failed to inject key event\n'

    await controller.initialize()
    await controller.executeCommand({ commandId: 'nav.back' })

    expect(controller.getSnapshot().operation).toMatchObject({
      status: 'error',
      summary: expect.stringContaining('返回失败')
    })
  })

  it('识别带 adb 前缀的失败输出并标记为错误', async () => {
    const { controller, adb } = createController()
    activeControllers.push(controller)
    adb.commandFailureOutput = 'adb: error: failed to inject key event\n'

    await controller.initialize()
    await controller.executeCommand({ commandId: 'nav.back' })

    expect(controller.getSnapshot().operation.status).toBe('error')
  })

  it('自动锁定单个设备并用 -s 串行完成安装和版本验收', async () => {
    const { controller, adb } = createController()
    activeControllers.push(controller)
    await controller.initialize()
    await controller.loadApk('/tmp/touchscreen.apk')
    await controller.executeCommand({ commandId: 'app.install' })

    const snapshot = controller.getSnapshot()
    expect(snapshot.selectedSerial).toBe(DEVICE_SERIAL)
    expect(snapshot.operation.status).toBe('success')
    expect(snapshot.operation.summary).toContain('10302')
    expect(snapshot.compatibility?.installedPackage.versionCode).toBe(10302)
    expect(snapshot.permissionCompatibility?.summary).toMatchObject({
      ready: 1,
      adbAction: 1,
      unavailable: 0
    })

    const installCall = adb.calls.find(({ args }) => args.join(' ').startsWith('shell pm install'))
    expect(installCall?.args).toEqual(
      expect.arrayContaining(['shell', 'pm', 'install', '-r'])
    )
    expect(installCall?.args).not.toContain('-g')
    const deviceCalls = adb.calls.filter(({ args }) => args[0] !== 'devices')
    expect(deviceCalls.every(({ options }) => options.serial === DEVICE_SERIAL)).toBe(true)
  })

  it.each([
    ['已完整接收', 'a'.repeat(64), 1],
    ['校验不一致', 'b'.repeat(64), 2]
  ])('断线恢复后%s时按校验结果决定是否重传', async (_, hash, pushes) => {
    const { controller, adb } = createController()
    activeControllers.push(controller)
    await controller.initialize()
    await controller.connectTcp({ host: '192.168.1.20', port: 5555 })
    await controller.loadApk('/tmp/touchscreen.apk')
    adb.pushFailure = 'adb: error: failed to read copy response'
    adb.pushFailuresRemaining = 1
    adb.remoteHash = String(hash)
    await controller.executeCommand({ commandId: 'app.install' })
    expect(controller.getSnapshot().operation.status).toBe('success')
    expect(adb.calls.filter(({ args }) => args[0] === 'push')).toHaveLength(Number(pushes))
    expect(adb.calls.some(({ args }) => args.join(' ').startsWith('shell dd'))).toBe(false)
    expect(adb.calls.some(({ args }) => args[0] === 'disconnect')).toBe(true)
    expect(adb.restartServerCalls).toBe(0)
  })

  it('持续传输断连最多尝试三次，不继续安装', async () => {
    const { controller, adb } = createController()
    activeControllers.push(controller)
    await controller.initialize()
    await controller.connectTcp({ host: '192.168.1.20', port: 5555 })
    await controller.loadApk('/tmp/touchscreen.apk')
    adb.pushFailure = 'adb: device offline'
    adb.remoteHash = 'b'.repeat(64)
    await controller.executeCommand({ commandId: 'app.install' })
    expect(adb.calls.filter(({ args }) => args[0] === 'push')).toHaveLength(3)
    expect(adb.calls.some(({ args }) => args.join(' ').startsWith('shell pm install'))).toBe(false)
    expect(controller.getSnapshot().operation.status).toBe('error')
  })

  it('重连失败时停止，不走备用通道或执行安装', async () => {
    const { controller, adb } = createController()
    activeControllers.push(controller)
    await controller.initialize()
    await controller.connectTcp({ host: '192.168.1.20', port: 5555 })
    await controller.loadApk('/tmp/touchscreen.apk')
    adb.pushFailure = 'adb: device offline'
    adb.connectionRecoveryFails = true
    await controller.executeCommand({ commandId: 'app.install' })
    expect(controller.getSnapshot().operation.summary).toContain('未能恢复')
    expect(adb.calls.filter(({ args }) => args[0] === 'push')).toHaveLength(1)
    expect(adb.calls.some(({ args }) => args.join(' ').startsWith('shell dd'))).toBe(false)
    expect(adb.calls.some(({ args }) => args.join(' ').startsWith('shell pm install'))).toBe(false)
  })

  it.each([['a'.repeat(64), 'success'], ['b'.repeat(64), 'error']])('安装响应丢失只回读实际 APK，不重复安装 (%s)', async (hash, status) => {
    const { controller, adb } = createController()
    activeControllers.push(controller)
    await controller.initialize()
    await controller.connectTcp({ host: '192.168.1.20', port: 5555 })
    await controller.loadApk('/tmp/touchscreen.apk')
    adb.installResponseLost = true
    adb.remoteHash = hash
    await controller.executeCommand({ commandId: 'app.install' })
    expect(controller.getSnapshot().operation.status).toBe(status)
    expect(adb.calls.filter(({ args }) => args.join(' ').startsWith('shell pm install'))).toHaveLength(1)
  })

  it('设备拒绝标准 adb push 时使用已确认的 su 0 流式传输 APK', async () => {
    const { controller, adb } = createController()
    activeControllers.push(controller)
    adb.suPath = '/system/xbin/su'
    adb.pushFailure = 'adb: error: reject push\n'

    await controller.initialize()
    await controller.loadApk('/tmp/touchscreen.apk')
    await controller.executeCommand({ commandId: 'device.rootAccess' })
    expect(controller.getSnapshot().selectedDevice).toMatchObject({
      rootAccessMode: 'su',
      suPath: '/system/xbin/su'
    })

    await controller.executeCommand({ commandId: 'app.install' })

    const snapshot = controller.getSnapshot()
    expect(snapshot.operation.status).toBe('warning')
    const streamIndex = adb.calls.findIndex(({ args }) =>
      args.join(' ').startsWith('shell /system/xbin/su 0 dd of=')
    )
    const installIndex = adb.calls.findIndex(({ args }) =>
      args.join(' ').startsWith('shell pm install -r /data/local/tmp/')
    )
    expect(streamIndex).toBeGreaterThanOrEqual(0)
    expect(installIndex).toBeGreaterThan(streamIndex)
    expect(adb.calls[streamIndex]?.options.inputFile).toBe('/tmp/touchscreen.apk')
    expect(
      adb.calls.some(({ args }) => args[0] === 'root')
    ).toBe(false)
  })

  it('设备拒绝标准 adb push 且 Root 未确认时改用非 Root shell 流式传输', async () => {
    const { controller, adb } = createController()
    activeControllers.push(controller)
    adb.suPath = '/system/xbin/su'
    adb.pushFailure = 'adb: error: reject push\n'

    await controller.initialize()
    await controller.loadApk('/tmp/touchscreen.apk')
    await controller.executeCommand({ commandId: 'app.install' })

    const operation = controller.getSnapshot().operation
    expect(operation.status).toBe('warning')
    expect(operation.summary).toContain('安装成功')
    expect(
      adb.calls.some(({ args }) => args.join(' ').startsWith('shell dd of='))
    ).toBe(true)
    expect(
      adb.calls.some(({ args }) => args.join(' ').includes('/system/xbin/su 0 dd'))
    ).toBe(false)
    expect(adb.calls.some(({ args }) => args[0] === 'root')).toBe(false)
  })

  it('建立 ADB 连接后自动读取物理与逻辑分辨率', async () => {
    const { controller, adb } = createController()
    activeControllers.push(controller)

    await controller.initialize()

    expect(controller.getSnapshot().selectedDevice).toMatchObject({
      physicalResolution: { width: 1920, height: 1080 },
      logicalResolution: { width: 1280, height: 720 }
    })
    expect(
      adb.calls.some(({ args }) => args.join(' ') === 'shell wm size')
    ).toBe(true)
  })

  it('按用户操作持久化历史，并区分可读摘要与技术诊断复制内容', async () => {
    const { controller, settings } = createController()
    activeControllers.push(controller)
    await controller.initialize()
    await controller.executeCommand({ commandId: 'nav.back' })

    const [history] = controller.getSnapshot().operationHistory
    expect(history).toMatchObject({
      title: '返回',
      status: 'success',
      serial: DEVICE_SERIAL,
      connection: 'usb',
      logCount: 1
    })
    const detail = controller.getOperationHistoryDetail(history!.id)
    expect(detail.logs).toHaveLength(1)
    expect(detail.logs[0]?.operationId).toBe(history?.id)
    expect(settings.getOperationHistory()[0]?.id).toBe(history?.id)

    const summary = controller.formatOperationSummary(history!.id)
    expect(summary).toContain('操作摘要')
    expect(summary).toContain('用途：说明做了什么、结果如何以及建议的下一步')
    expect(summary).toContain('操作：返回')
    expect(summary).toContain('结果：成功')
    expect(summary).not.toContain('ADB 参数')

    const diagnostics = controller.formatOperationDiagnostics(history!.id)
    expect(diagnostics).toContain('技术诊断详情')
    expect(diagnostics).toContain('提交给开发或技术支持人员')
    expect(diagnostics).toContain('ADB 参数：')
    expect(diagnostics).toContain('KEYCODE_BACK')

    const restored = createController(apkInfo, settings).controller
    activeControllers.push(restored)
    expect(restored.getSnapshot().operationHistory[0]).toMatchObject({
      id: history?.id,
      title: '返回',
      logCount: 1
    })
    expect(restored.getOperationHistoryDetail(history!.id).logs).toHaveLength(1)
  })

  it('设置前保存原 Launcher，并可恢复和逐步验证', async () => {
    const { controller, adb, settings } = createController()
    activeControllers.push(controller)
    await controller.initialize()
    await controller.loadApk('/tmp/touchscreen.apk')

    await controller.executeCommand({ commandId: 'launcher.set' })
    expect(controller.getSnapshot().operation.status).toBe('success')
    expect(adb.currentHome).toBe(TARGET_HOME)
    expect(settings.getOriginalLauncher(DEVICE_SERIAL)).toBe(SYSTEM_HOME)
    expect(controller.getSnapshot().launcher.verification).toBe('matched')

    await controller.executeCommand({ commandId: 'launcher.restore' })
    expect(controller.getSnapshot().operation.status).toBe('success')
    expect(adb.currentHome).toBe(SYSTEM_HOME)
    expect(controller.getSnapshot().launcher.canRestore).toBe(false)
  })

  it('通过标准 adb root 完成系统应用部署与托管回滚', async () => {
    const { controller, adb, settings } = createController()
    activeControllers.push(controller)
    await controller.initialize()
    await controller.loadApk('/tmp/touchscreen.apk')

    expect(controller.getSnapshot().selectedDevice?.adbUid).toBe(2000)
    await controller.executeCommand({ commandId: 'device.rootAccess' })
    expect(controller.getSnapshot().operation.status).toBe('success')
    expect(controller.getSnapshot().selectedDevice?.adbUid).toBe(0)
    expect(controller.getSnapshot().selectedDevice?.rootAccessMode).toBe('adbd')

    await controller.executeCommand({ commandId: 'app.deploySystem' })
    expect(controller.getSnapshot().operation.status).toBe('success')
    expect(adb.deployedMode).toBe('system')
    expect(settings.getSystemDeployment(DEVICE_SERIAL, apkInfo.packageName)).toMatchObject({
      deploymentMode: 'system',
      appDirectory: '/system/app/AdbTool_com_example_touchscreen'
    })

    await controller.executeCommand({ commandId: 'device.rootAccess' })
    await controller.executeCommand({ commandId: 'app.rollbackSystem' })
    expect(controller.getSnapshot().operation.status).toBe('success')
    expect(adb.deployedMode).toBeNull()
    expect(settings.getSystemDeployment(DEVICE_SERIAL, apkInfo.packageName)).toBeNull()
  }, 20_000)

  it('普通 user 构建且没有 su 时拒绝获取 Root 权限', async () => {
    const { controller, adb } = createController()
    activeControllers.push(controller)
    adb.buildType = 'user'
    adb.debuggable = '0'
    await controller.initialize()

    await controller.executeCommand({ commandId: 'device.rootAccess' })

    expect(controller.getSnapshot().operation.status).toBe('error')
    expect(controller.getSnapshot().operation.summary).toContain('没有可用的 Root 通道')
    expect(adb.calls.some(({ args }) => args[0] === 'root')).toBe(false)
  })

  it('特权部署写入中途失败时保留确定路径的托管回滚记录', async () => {
    const { controller, adb, settings } = createController()
    activeControllers.push(controller)
    adb.systemWriteFailure = true
    await controller.initialize()
    await controller.loadApk('/tmp/touchscreen.apk')
    await controller.executeCommand({ commandId: 'device.rootAccess' })

    await controller.executeCommand({
      commandId: 'app.deploySystem',
      systemDeploymentMode: 'privileged'
    })

    expect(controller.getSnapshot().operation.status).toBe('error')
    expect(settings.getSystemDeployment(DEVICE_SERIAL, apkInfo.packageName)).toMatchObject({
      deploymentMode: 'privileged',
      appDirectory: '/system/priv-app/AdbTool_com_example_touchscreen',
      apkPath: '/system/priv-app/AdbTool_com_example_touchscreen/base.apk'
    })
    expect(controller.getSnapshot().systemDeployment).not.toBeNull()
  })

  it('adb root 仍为 shell 时改用 su 0，并按两阶段 OverlayFS 流程部署系统应用', async () => {
    const { controller, adb } = createController()
    activeControllers.push(controller)
    adb.adbRootEffective = false
    adb.suPath = '/system/xbin/su'
    adb.overlayRebootRequired = true
    await controller.initialize()
    await controller.loadApk('/tmp/touchscreen.apk')

    await controller.executeCommand({ commandId: 'device.rootAccess' })

    expect(controller.getSnapshot().operation.status).toBe('warning')
    expect(controller.getSnapshot().selectedDevice).toMatchObject({
      adbUid: 2000,
      suPath: '/system/xbin/su',
      rootAccessMode: 'su'
    })

    await controller.executeCommand({ commandId: 'app.deploySystem' })

    expect(controller.getSnapshot().operation.status).toBe('warning')
    expect(adb.deployedMode).toBe('system')
    expect(
      adb.calls.some(
        ({ args }) =>
          args.join(' ') === 'shell /system/xbin/su 0 /system/bin/remount'
      )
    ).toBe(true)
    expect(
      adb.calls.some(
        ({ args }) =>
          args.join(' ') === 'shell /system/xbin/su 0 /system/bin/remount system'
      )
    ).toBe(true)
    expect(
      adb.calls.some(
        ({ args }) =>
          args.join(' ').startsWith(
            'shell /system/xbin/su 0 cp /data/local/tmp/adb-tool-'
          ) && args.join(' ').includes('/system/app/AdbTool_com_example_touchscreen/base.apk')
      )
    ).toBe(true)
  }, 20_000)

  it('厂商 remount 未使 system 可写时通过 su mount 回退完成系统部署', async () => {
    const { controller, adb } = createController({
      ...apkInfo,
      declaredPermissions: [
        ...apkInfo.declaredPermissions,
        {
          name: 'android.permission.READ_CALL_LOG',
          maxSdkVersion: null
        }
      ]
    })
    activeControllers.push(controller)
    adb.adbRootEffective = false
    adb.suPath = '/system/xbin/su'
    adb.vendorRemountWorks = false
    await controller.initialize()
    await controller.loadApk('/tmp/touchscreen.apk')

    await controller.executeCommand({ commandId: 'app.deploySystem' })

    expect(controller.getSnapshot().operation.status).toBe('warning')
    expect(
      adb.calls.some(
        ({ args }) =>
          args.join(' ') ===
          'shell /system/xbin/su 0 mount -o remount,rw /system'
      )
    ).toBe(true)
    expect(adb.deployedMode).toBe('system')
  }, 20_000)

  it('系统部署在写入前阻止较低版本 APK 覆盖活动更新包', async () => {
    const { controller, adb } = createController({
      ...apkInfo,
      declaredPermissions: [
        ...apkInfo.declaredPermissions,
        {
          name: 'android.permission.SET_TIME',
          maxSdkVersion: null
        }
      ]
    })
    activeControllers.push(controller)
    adb.preinstalledSystemDirectory = '/system/app/Touchscreen'
    adb.dataUpdateInstalled = true
    adb.installedPackage = {
      installed: true,
      versionName: '1.3.9',
      versionCode: 10309
    }
    await controller.initialize()
    await controller.loadApk('/tmp/touchscreen.apk')

    await controller.executeCommand({ commandId: 'app.deploySystem' })

    expect(controller.getSnapshot().operation.status).toBe('error')
    expect(controller.getSnapshot().operation.summary).toContain(
      '活动版本高于所选 APK'
    )
    expect(controller.getSnapshot().operation.suggestion).toContain(
      'versionCode=10309'
    )
    expect(adb.calls.some(({ args }) => args[0] === 'root')).toBe(false)
    expect(
      adb.calls.some(({ args }) => args.join(' ').includes('mkdir -p /system/'))
    ).toBe(false)
  })

  it('系统部署拒绝为同包名固件系统应用创建第二个系统副本', async () => {
    const { controller, adb } = createController({
      ...apkInfo,
      declaredPermissions: [
        ...apkInfo.declaredPermissions,
        {
          name: 'android.permission.SET_TIME',
          maxSdkVersion: null
        }
      ]
    })
    activeControllers.push(controller)
    adb.preinstalledSystemDirectory = '/system/app/Touchscreen'
    adb.installedPackage = {
      installed: true,
      versionName: apkInfo.versionName,
      versionCode: apkInfo.versionCode
    }
    await controller.initialize()
    await controller.loadApk('/tmp/touchscreen.apk')

    await controller.executeCommand({ commandId: 'app.deploySystem' })

    expect(controller.getSnapshot().operation.status).toBe('error')
    expect(controller.getSnapshot().operation.summary).toContain(
      '同包名的非托管系统副本'
    )
    expect(controller.getSnapshot().operation.suggestion).toContain(
      '/system/app/Touchscreen'
    )
    expect(adb.calls.some(({ args }) => args[0] === 'root')).toBe(false)
  })

  it('回滚托管部署时允许固件原有系统副本继续保留 SYSTEM 身份', async () => {
    const settings = new FakeSettings()
    settings.saveSystemDeployment({
      serial: DEVICE_SERIAL,
      packageName: apkInfo.packageName,
      versionCode: apkInfo.versionCode,
      deploymentMode: 'privileged',
      appDirectory: '/system/priv-app/AdbTool_com_example_touchscreen',
      apkPath: '/system/priv-app/AdbTool_com_example_touchscreen/base.apk',
      allowlistPath:
        '/system/etc/permissions/privapp-permissions-adbtool-com_example_touchscreen.xml',
      createdAt: '2026-08-03T06:42:27.852Z'
    })
    const { controller, adb } = createController(apkInfo, settings)
    activeControllers.push(controller)
    adb.deployedMode = 'privileged'
    adb.preinstalledSystemDirectory = '/system/app/Touchscreen'
    adb.dataUpdateInstalled = true
    await controller.initialize()
    await controller.loadApk('/tmp/touchscreen.apk')

    await controller.executeCommand({ commandId: 'app.rollbackSystem' })

    expect(controller.getSnapshot().operation.status).toBe('success')
    expect(controller.getSnapshot().operation.suggestion).toContain(
      '仍有其他系统副本'
    )
    expect(settings.getSystemDeployment(DEVICE_SERIAL, apkInfo.packageName)).toBeNull()
    expect(adb.preinstalledSystemDirectory).toBe('/system/app/Touchscreen')
  }, 20_000)

  it('彻底卸载直接预装的 system app 并在重启后验证包记录消失', async () => {
    const { controller, adb } = createController()
    activeControllers.push(controller)
    adb.adbRootEffective = false
    adb.suPath = '/system/xbin/su'
    adb.vendorRemountWorks = false
    adb.preinstalledSystemDirectory = '/system/app/Touchscreen'
    await controller.initialize()
    await controller.loadDeviceApplication(apkInfo.packageName)

    await controller.executeCommand({ commandId: 'app.uninstall' })

    expect(controller.getSnapshot().operation.status).toBe('warning')
    expect(controller.getSnapshot().operation.summary).toContain('永久删除系统应用')
    expect(adb.preinstalledSystemDirectory).toBeNull()
    expect(adb.installedPackage.installed).toBe(false)
    expect(
      adb.calls.some(
        ({ args }) =>
          args.join(' ') ===
          `shell /system/xbin/su 0 rm -rf /system/app/Touchscreen`
      )
    ).toBe(true)
    expect(
      adb.calls.some(
        ({ args }) =>
          args.join(' ') ===
          `shell pm list packages -u ${apkInfo.packageName}`
      )
    ).toBe(true)
    expect(
      adb.calls.some(
        ({ args }) => args.join(' ') === `uninstall ${apkInfo.packageName}`
      )
    ).toBe(false)
  }, 20_000)

  it('系统应用缺少 Root 通道时在清数据和用户卸载前停止', async () => {
    const { controller, adb } = createController()
    activeControllers.push(controller)
    adb.adbRootEffective = false
    adb.preinstalledSystemDirectory = '/system/app/Touchscreen'
    await controller.initialize()
    await controller.loadDeviceApplication(apkInfo.packageName)

    await controller.executeCommand({ commandId: 'app.uninstall' })

    expect(controller.getSnapshot().operation.status).toBe('error')
    expect(adb.preinstalledSystemDirectory).toBe('/system/app/Touchscreen')
    expect(adb.installedPackage.installed).toBe(true)
    expect(
      adb.calls.some(
        ({ args }) => args.join(' ') === `shell pm clear ${apkInfo.packageName}`
      )
    ).toBe(false)
    expect(
      adb.calls.some(
        ({ args }) =>
          args.join(' ') ===
          `shell pm uninstall --user 0 ${apkInfo.packageName}`
      )
    ).toBe(false)
  })

  it('updated system app 缺少 Root 通道时不先移除 data 更新', async () => {
    const { controller, adb } = createController()
    activeControllers.push(controller)
    adb.adbRootEffective = false
    adb.preinstalledSystemDirectory = '/system/app/Touchscreen'
    adb.dataUpdateInstalled = true
    adb.installedPackage = {
      installed: true,
      versionName: '1.3.9',
      versionCode: 10309
    }
    await controller.initialize()
    await controller.loadDeviceApplication(apkInfo.packageName)

    await controller.executeCommand({ commandId: 'app.uninstall' })

    expect(controller.getSnapshot().operation.status).toBe('error')
    expect(adb.dataUpdateInstalled).toBe(true)
    expect(adb.installedPackage.versionCode).toBe(10309)
    expect(
      adb.calls.some(
        ({ args }) => args.join(' ') === `uninstall ${apkInfo.packageName}`
      )
    ).toBe(false)
  })

  it('卸载 updated system app 时先移除 data 更新，再删除固件副本', async () => {
    const { controller, adb } = createController()
    activeControllers.push(controller)
    adb.suPath = '/system/xbin/su'
    adb.preinstalledSystemDirectory = '/system/app/Touchscreen'
    adb.dataUpdateInstalled = true
    adb.installedPackage = {
      installed: true,
      versionName: '1.3.9',
      versionCode: 10309
    }
    await controller.initialize()
    await controller.loadDeviceApplication(apkInfo.packageName)

    await controller.executeCommand({ commandId: 'app.uninstall' })

    expect(controller.getSnapshot().operation.status).toBe('warning')
    const commands = adb.calls.map(({ args }) => args.join(' '))
    const removeUpdate = commands.indexOf(`uninstall ${apkInfo.packageName}`)
    const removeForUser = commands.indexOf(
      `shell pm uninstall --user 0 ${apkInfo.packageName}`
    )
    const removeSystemDirectory = commands.findIndex((command) =>
      command.endsWith('rm -rf /system/app/Touchscreen')
    )
    expect(removeUpdate).toBeGreaterThanOrEqual(0)
    expect(removeForUser).toBeGreaterThan(removeUpdate)
    expect(removeSystemDirectory).toBeGreaterThan(removeForUser)
  }, 20_000)

  it('降级未显式开启时拒绝执行安装', async () => {
    const { controller, adb } = createController()
    activeControllers.push(controller)
    adb.installedPackage = {
      installed: true,
      versionName: '2.0.0',
      versionCode: 20000
    }
    await controller.initialize()
    await controller.loadApk('/tmp/touchscreen.apk')
    await controller.executeCommand({ commandId: 'app.install' })

    expect(controller.getSnapshot().operation.status).toBe('error')
    expect(controller.getSnapshot().operation.summary).toContain('版本低于')
    expect(adb.calls.some(({ args }) => args[0] === 'push')).toBe(false)
  })

  it('即使请求允许降级，也拒绝对非 debuggable APK 使用 -d', async () => {
    const { controller, adb } = createController({
      ...apkInfo,
      debuggable: false
    })
    activeControllers.push(controller)
    adb.installedPackage = {
      installed: true,
      versionName: '2.0.0',
      versionCode: 20000
    }
    await controller.initialize()
    await controller.loadApk('/tmp/touchscreen-release.apk')
    await controller.executeCommand({
      commandId: 'app.install',
      allowDowngrade: true
    })

    expect(controller.getSnapshot().operation.status).toBe('error')
    expect(controller.getSnapshot().operation.summary).toContain('不是可调试版本')
    expect(adb.calls.some(({ args }) => args[0] === 'push')).toBe(false)
  })

  it('启动失败时同时返回包名、组件和可读原因', async () => {
    const { controller, adb } = createController()
    activeControllers.push(controller)
    adb.launchError = true
    await controller.initialize()
    await controller.loadApk('/tmp/touchscreen.apk')
    await controller.executeCommand({ commandId: 'app.launch' })

    const operation = controller.getSnapshot().operation
    expect(operation.status).toBe('error')
    expect(operation.summary).toContain(apkInfo.packageName)
    expect(operation.suggestion).toContain(TARGET_HOME)
  })

  it('不选择 APK 时可按包名读取设备应用并执行应用与 Launcher 操作', async () => {
    const { controller, adb, settings } = createController()
    activeControllers.push(controller)
    await controller.initialize()

    await controller.loadDeviceApplication(apkInfo.packageName)

    const loaded = controller.getSnapshot()
    expect(loaded.selectedApk).toBeNull()
    expect(loaded.selectedDeviceApplication).toMatchObject({
      serial: DEVICE_SERIAL,
      packageName: apkInfo.packageName,
      versionCode: adb.installedPackage.versionCode,
      declaredPermissions: [
        { name: 'android.permission.INTERNET', maxSdkVersion: null },
        { name: 'android.permission.CAMERA', maxSdkVersion: null }
      ],
      launchActivity: {
        component: apkInfo.launchActivity?.component
      },
      selectedHomeComponent: TARGET_HOME
    })
    expect(settings.getManagedPackage(DEVICE_SERIAL)).toBe(apkInfo.packageName)
    expect(loaded.permissionCompatibility).toMatchObject({
      state: 'ready',
      summary: {
        total: 2,
        ready: 1,
        adbAction: 1
      }
    })
    expect(
      loaded.permissionCompatibility?.permissions.find(
        ({ name }) => name === 'android.permission.CAMERA'
      )?.authorization
    ).toBe('denied')

    await controller.executeCommand({ commandId: 'app.launch' })
    expect(controller.getSnapshot().operation.status).toBe('success')
    expect(
      adb.calls.some(
        ({ args }) =>
          args.join(' ') === `shell am start -n ${apkInfo.launchActivity?.component}`
      )
    ).toBe(true)

    await controller.executeCommand({ commandId: 'launcher.set' })
    expect(controller.getSnapshot().operation.status).toBe('success')
    expect(adb.currentHome).toBe(TARGET_HOME)
  })

  it('可读取当前前台应用作为目标应用', async () => {
    const { controller, adb } = createController()
    activeControllers.push(controller)
    await controller.initialize()

    await controller.loadForegroundApplication()

    expect(controller.getSnapshot().selectedDeviceApplication).toMatchObject({
      packageName: apkInfo.packageName,
      launchActivity: {
        component: adb.foregroundComponent
      }
    })
    expect(controller.getSnapshot().operation.summary).toContain('当前前台应用')
  })

  it('设备应用列表合并可启动与 HOME 应用并标记当前桌面', async () => {
    const { controller } = createController()
    activeControllers.push(controller)
    await controller.initialize()

    await controller.refreshDeviceApplications()

    const catalog = controller.getSnapshot().deviceApplicationCatalog
    expect(catalog.serial).toBe(DEVICE_SERIAL)
    expect(catalog.applications).toHaveLength(3)
    expect(catalog.applications[0]).toMatchObject({
      packageName: 'com.android.launcher3',
      isCurrentHome: true
    })
    expect(
      catalog.applications.find(({ packageName }) => packageName === apkInfo.packageName)
    ).toMatchObject({
      launchActivity: {
        component: apkInfo.launchActivity?.component
      },
      homeActivities: [
        {
          component: TARGET_HOME
        }
      ]
    })
  })

  it('选择 APK 后自动识别设备中的同包名应用，无需先安装当前版本', async () => {
    const { controller, adb } = createController()
    activeControllers.push(controller)
    await controller.initialize()

    await controller.loadApk('/tmp/touchscreen.apk')

    const loaded = controller.getSnapshot()
    expect(loaded.selectedApk?.versionCode).toBe(apkInfo.versionCode)
    expect(loaded.selectedDeviceApplication).toMatchObject({
      packageName: apkInfo.packageName,
      versionCode: adb.installedPackage.versionCode
    })
    expect(loaded.operation.summary).toContain('可直接操作')

    await controller.executeCommand({ commandId: 'app.launch' })
    expect(controller.getSnapshot().operation.status).toBe('success')
  })

  it('重新连接已记忆设备时自动恢复用户指定的应用', async () => {
    const { controller, settings } = createController()
    activeControllers.push(controller)
    settings.saveManagedPackage(DEVICE_SERIAL, apkInfo.packageName)

    await controller.initialize()

    expect(controller.getSnapshot().selectedDeviceApplication).toMatchObject({
      packageName: apkInfo.packageName,
      serial: DEVICE_SERIAL
    })
  })

  it('签名冲突时提供卸载重装恢复动作，并在确认后完成替换安装', async () => {
    const { controller, adb } = createController()
    activeControllers.push(controller)
    adb.installFailure = 'INSTALL_FAILED_UPDATE_INCOMPATIBLE'
    await controller.initialize()
    await controller.loadApk('/tmp/touchscreen.apk')

    await controller.executeCommand({ commandId: 'app.install' })

    const failedOperation = controller.getSnapshot().operation
    expect(failedOperation.status).toBe('error')
    expect(failedOperation.recovery).toMatchObject({
      kind: 'signature-conflict',
      commandId: 'app.replace',
      serial: DEVICE_SERIAL,
      apkToken: apkInfo.token,
      packageName: apkInfo.packageName
    })

    const replacementCallStart = adb.calls.length
    adb.installFailure = null
    await controller.executeCommand({ commandId: 'app.replace' })

    const snapshot = controller.getSnapshot()
    expect(snapshot.operation.status).toBe('success')
    expect(snapshot.operation.summary).toContain('替换安装成功')
    expect(snapshot.operation.recovery).toBeNull()
    expect(snapshot.compatibility?.installedPackage.versionCode).toBe(apkInfo.versionCode)
    const replacementCommands = adb.calls
      .slice(replacementCallStart)
      .map(({ args }) => args.join(' '))
    const uninstallIndex = replacementCommands.indexOf(`uninstall ${apkInfo.packageName}`)
    const installIndex = replacementCommands.findIndex((command) =>
      command.startsWith('shell pm install /data/local/tmp/')
    )
    expect(uninstallIndex).toBeGreaterThanOrEqual(0)
    expect(installIndex).toBeGreaterThan(uninstallIndex)
  })

  it('卸载旧应用后新 APK 仍安装失败时回读为未安装并停止工作流', async () => {
    const { controller, adb } = createController()
    activeControllers.push(controller)
    adb.installFailure = 'INSTALL_FAILED_INSUFFICIENT_STORAGE'
    await controller.initialize()
    await controller.loadApk('/tmp/touchscreen.apk')

    await controller.executeCommand({ commandId: 'app.replace' })

    const snapshot = controller.getSnapshot()
    expect(snapshot.operation.status).toBe('error')
    expect(snapshot.operation.summary).toContain('旧应用及其数据已清除')
    expect(snapshot.operation.suggestion).toContain('存储空间不足')
    expect(snapshot.compatibility?.installedPackage.installed).toBe(false)
    expect(snapshot.operation.recovery).toBeNull()
  })

  it('目标应用是当前默认桌面时拒绝执行卸载重装', async () => {
    const { controller, adb } = createController()
    activeControllers.push(controller)
    adb.currentHome = TARGET_HOME
    await controller.initialize()
    await controller.loadApk('/tmp/touchscreen.apk')

    await controller.executeCommand({ commandId: 'app.replace' })

    const operation = controller.getSnapshot().operation
    expect(operation.status).toBe('error')
    expect(operation.summary).toContain('当前是设备的默认桌面')
    expect(operation.suggestion).toContain('在设备系统设置中选择其他默认桌面')
    expect(
      adb.calls.some(({ args }) => args.join(' ') === `uninstall ${apkInfo.packageName}`)
    ).toBe(false)
  })

  it('开发者选项未启用时打开关于设备并给出人工启用指引', async () => {
    const { controller, adb } = createController()
    activeControllers.push(controller)
    adb.developmentSettingsEnabled = '0'
    await controller.initialize()

    await controller.executeCommand({ commandId: 'system.developerSettings' })

    const operation = controller.getSnapshot().operation
    expect(operation.status).toBe('warning')
    expect(operation.summary).toContain('尚未启用')
    expect(operation.suggestion).toContain('连续点击 7 次')
    expect(
      adb.calls.some(
        ({ args }) =>
          args.join(' ') ===
          'shell am start -a android.settings.APPLICATION_DEVELOPMENT_SETTINGS'
      )
    ).toBe(false)
    expect(
      adb.calls.some(
        ({ args }) =>
          args.join(' ') === 'shell am start -a android.settings.DEVICE_INFO_SETTINGS'
      )
    ).toBe(true)
  })

  it('开发者选项已启用时直接打开标准开发者设置页面', async () => {
    const { controller, adb } = createController()
    activeControllers.push(controller)
    await controller.initialize()

    await controller.executeCommand({ commandId: 'system.developerSettings' })

    const operation = controller.getSnapshot().operation
    expect(operation.status).toBe('success')
    expect(operation.summary).toContain('打开开发者选项请求')
    expect(operation.suggestion).toBeNull()
    expect(
      adb.calls.some(
        ({ args }) =>
          args.join(' ') ===
          'shell am start -a android.settings.APPLICATION_DEVELOPMENT_SETTINGS'
      )
    ).toBe(true)
  })

  it('厂商系统不支持开发者选项 Intent 时降级打开关于设备', async () => {
    const { controller, adb } = createController()
    activeControllers.push(controller)
    adb.unsupportedSettingsActions.add(
      'android.settings.APPLICATION_DEVELOPMENT_SETTINGS'
    )
    await controller.initialize()

    await controller.executeCommand({ commandId: 'system.developerSettings' })

    const operation = controller.getSnapshot().operation
    expect(operation.status).toBe('warning')
    expect(operation.summary).toContain('无法直接打开')
    expect(operation.suggestion).toContain('Build number')
    expect(
      adb.calls.some(
        ({ args }) =>
          args.join(' ') === 'shell am start -a android.settings.DEVICE_INFO_SETTINGS'
      )
    ).toBe(true)
  })

  it('开发者选项和关于设备 Intent 均不可用时降级打开系统设置', async () => {
    const { controller, adb } = createController()
    activeControllers.push(controller)
    adb.unsupportedSettingsActions.add(
      'android.settings.APPLICATION_DEVELOPMENT_SETTINGS'
    )
    adb.unsupportedSettingsActions.add('android.settings.DEVICE_INFO_SETTINGS')
    await controller.initialize()

    await controller.executeCommand({ commandId: 'system.developerSettings' })

    const operation = controller.getSnapshot().operation
    expect(operation.status).toBe('warning')
    expect(operation.summary).toContain('已打开系统设置')
    expect(operation.suggestion).toContain('不同厂商')
    expect(
      adb.calls.some(
        ({ args }) => args.join(' ') === 'shell am start -a android.settings.SETTINGS'
      )
    ).toBe(true)
  })
})

describe('手动 ADB 终端与设备工作流互斥', () => {
  it('会话绑定设备，阻止按钮操作和设备切换，退出后重新读取状态', async () => {
    const { controller, adb } = createController()
    activeControllers.push(controller)
    await controller.initialize()
    const context = await controller.acquireTerminal('terminal-one', DEVICE_SERIAL, true)
    expect(context).toMatchObject({ serial: DEVICE_SERIAL, serverPort: adb.serverPort })
    expect(controller.getSnapshot().busy).toBe(true)
    await expect(controller.acquireTerminal('terminal-two', DEVICE_SERIAL, true)).rejects.toThrow('等待')
    const run = vi.spyOn(adb, 'run')
    await controller.executeCommand({ commandId: 'device.reboot' })
    await controller.selectDevice(null)
    expect(controller.getSnapshot().selectedSerial).toBe(DEVICE_SERIAL)
    expect(run).not.toHaveBeenCalled()
    await controller.releaseTerminal('stale')
    expect(controller.getSnapshot().busy).toBe(true)
    await controller.releaseTerminal('terminal-one')
    expect(controller.getSnapshot().busy).toBe(false)
    expect(run.mock.calls.some(([args]) => args.join(' ') === 'shell getprop')).toBe(true)
  })

  it('拒绝过期设备选择和未连接设备，查询命令允许没有设备', async () => {
    const { controller } = createController()
    activeControllers.push(controller)
    await controller.initialize()
    await expect(controller.acquireTerminal('one', 'OTHER', true)).rejects.toThrow('目标设备已变化')
    expect(controller.getSnapshot().busy).toBe(false)
    await controller.selectDevice(null)
    await expect(controller.acquireTerminal('two', null, true)).rejects.toThrow('先选择')
    expect(controller.getSnapshot().busy).toBe(false)
    await expect(controller.acquireTerminal('three', null, false)).resolves.toMatchObject({ serial: null })
    await controller.releaseTerminal('three')
    expect(controller.getSnapshot().busy).toBe(false)
  })
})
