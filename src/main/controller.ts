import { LanDiscovery } from './lan-discovery'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import PQueue from 'p-queue'
import type {
  AdbStatus,
  ApkInfo,
  AppSnapshot,
  CommandId,
  CompatibilityReport,
  ConnectionMode,
  DeviceApplicationCandidate,
  DeviceApplicationInfo,
  DeviceDetails,
  DeviceSummary,
  DriverStatus,
  ExecuteCommandRequest,
  InstalledPackageInfo,
  LauncherState,
  OperationHistoryDetail,
  OperationHistoryEntry,
  OperationRecovery,
  OperationState,
  PermissionCompatibilityReport,
  RootAccessMode,
  SystemModificationCapability,
  SystemDeploymentMode,
  TcpRepairFailureKind,
  TcpRepairState,
  TcpConnectRequest,
  TechnicalLogEntry
} from '../shared/contracts'
import type {
  AdbExecution,
  AdbGateway,
  AdbRunOptions,
  TcpEndpointProbe
} from './adb-client'
import { AppError } from './app-error'
import { hashFile } from './file-hash'
import type { ApkInspector, InspectedApk } from './apk-inspector'
import { COMMAND_BY_ID, COMMAND_CATALOG } from './command-catalog'
import { mapAdbError } from './errors'
import { writeApplicationError, writeTechnicalLog } from './logger'
import {
  applyPermissionAuthorization,
  applySystemModificationCapability,
  evaluatePermissionCompatibility,
  inferSystemModificationCapability,
  parseAppOpsModes,
  parseColonSeparatedPackages,
  parseDevicePermissionDefinitions,
  parsePackagePermissionGrants,
  parseRequestedPermissions
} from './permission-compatibility'
import {
  evaluateCompatibility,
  packageFromComponent,
  parseComponents,
  parseAdbUid,
  parseDevices,
  parseDisplayResolution,
  parseForegroundComponent,
  parseGetProp,
  parseHomeComponent,
  parsePackageInstallation,
  parsePushProgress
} from './parsers'
import type { PackageInstallationDetails } from './parsers'
import type { SettingsGateway } from './settings-store'

interface ControllerOptions {
  adb: AdbGateway
  settings: SettingsGateway
  apkInspector: ApkInspector
  driverStatus: DriverStatus
  clientVersion: string
  monitorIntervalMs?: number
}

interface WorkflowResult {
  summary: string
  suggestion?: string
  status?: 'success' | 'warning'
}

type FileTransferStreamMode =
  | { mode: 'shell' }
  | { mode: 'adbd' }
  | { mode: 'su'; suPath: string }

type SnapshotListener = (snapshot: AppSnapshot) => void

const HOME_RESOLVE_ARGS = [
  'cmd',
  'package',
  'resolve-activity',
  '--brief',
  '--user',
  '0',
  '-a',
  'android.intent.action.MAIN',
  '-c',
  'android.intent.category.HOME'
]

const DEVELOPMENT_SETTINGS_ACTION = 'android.settings.APPLICATION_DEVELOPMENT_SETTINGS'
const DEVICE_INFO_SETTINGS_ACTION = 'android.settings.DEVICE_INFO_SETTINGS'
const SYSTEM_SETTINGS_ACTION = 'android.settings.SETTINGS'
const OPERATION_HISTORY_LIMIT = 100
const OPERATION_HISTORY_LOG_LIMIT = 25
const OPERATION_HISTORY_OUTPUT_LIMIT = 1_000
const SESSION_LOG_LIMIT = 250

function idleTcpRepairState(): TcpRepairState {
  return {
    endpoint: null,
    phase: 'idle',
    probe: 'not-run',
    failureKind: null,
    message: null,
    detail: null,
    serverPort: null
  }
}

function tcpFailureKind(output: string): TcpRepairFailureKind {
  if (/unauthorized/i.test(output)) return 'unauthorized'
  if (/device\s+offline/i.test(output)) return 'offline'
  if (/protocol fault|connection reset|reset by peer/i.test(output)) return 'protocol'
  if (/connection refused/i.test(output)) return 'refused'
  if (/no route to host|network is unreachable|unable to connect|failed to connect/i.test(output)) {
    return 'network'
  }
  return 'unknown'
}

const EMPTY_LAUNCHER: LauncherState = {
  currentComponent: null,
  currentPackage: null,
  originalComponent: null,
  canRestore: false,
  verification: 'unknown'
}

function idleOperation(): OperationState {
  return {
    id: randomUUID(),
    commandId: null,
    status: 'idle',
    title: '等待操作',
    summary: '准备就绪',
    suggestion: null,
    stage: null,
    progress: 0,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    recovery: null
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function truncateLogOutput(output: string, limit: number | null): string {
  if (limit === null || output.length <= limit) return output
  return `${output.slice(0, limit)}\n…日志已截断，原始输出共 ${output.length} 个字符。`
}

function historyLog(entry: TechnicalLogEntry): TechnicalLogEntry {
  return {
    ...entry,
    stdout: truncateLogOutput(entry.stdout, OPERATION_HISTORY_OUTPUT_LIMIT),
    stderr: truncateLogOutput(entry.stderr, OPERATION_HISTORY_OUTPUT_LIMIT)
  }
}

function historyEntry(detail: OperationHistoryDetail): OperationHistoryEntry {
  const { logs: _logs, ...entry } = detail
  return entry
}

function formatOperationTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN', {
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

function formatOperationDuration(durationMs: number | null): string {
  if (durationMs === null) return '未记录'
  if (durationMs < 1_000) return `${durationMs} ms`
  return `${(durationMs / 1_000).toFixed(1)} 秒`
}

function managedSystemPaths(packageName: string, deploymentMode: SystemDeploymentMode): {
  appDirectory: string
  apkPath: string
  allowlistPath: string | null
} {
  if (!/^[A-Za-z][A-Za-z0-9_.]+$/.test(packageName)) {
    throw new AppError('APK 包名不符合系统应用部署安全规则。', '请修正 applicationId 后重新打包。')
  }
  const safeName = packageName.replaceAll('.', '_')
  const appDirectory =
    deploymentMode === 'privileged'
      ? `/system/priv-app/AdbTool_${safeName}`
      : `/system/app/AdbTool_${safeName}`
  return {
    appDirectory,
    apkPath: `${appDirectory}/base.apk`,
    allowlistPath:
      deploymentMode === 'privileged'
        ? `/system/etc/permissions/privapp-permissions-adbtool-${safeName}.xml`
        : null
  }
}

function systemAppDirectoryForPath(path: string): string | null {
  const directory =
    /^(\/system\/(?:app|priv-app)\/[A-Za-z0-9][A-Za-z0-9._+-]*)$/.exec(path)?.[1] ??
    /^(\/system\/(?:app|priv-app)\/[A-Za-z0-9][A-Za-z0-9._+-]*)\/[^/]+\.apk$/.exec(
      path
    )?.[1] ??
    null
  return directory ?? null
}

function systemAppDirectories(
  installation: PackageInstallationDetails
): string[] {
  return [
    ...new Set(
      [...installation.packagePaths, ...installation.codePaths]
        .map(systemAppDirectoryForPath)
        .filter((path): path is string => path !== null)
    )
  ]
}

function activeSystemAppDirectory(
  installation: PackageInstallationDetails
): string | null {
  const activePaths =
    installation.packagePaths.length > 0
      ? installation.packagePaths
      : installation.activeCodePath
        ? [installation.activeCodePath]
        : []
  return (
    activePaths
      .map(systemAppDirectoryForPath)
      .find((path): path is string => path !== null) ?? null
  )
}

function parseSuPath(output: string): string | null {
  const candidate = output.split(/\r?\n/, 1)[0]?.trim() ?? ''
  if (candidate === 'su' || /^\/[A-Za-z0-9_./-]*\/su$/.test(candidate)) {
    return candidate
  }
  return null
}

class TransferConnectionError extends AppError {
  constructor(message: string) { super(message, '请恢复设备连接后重试。') }
}

function isConnectionFailure(result: AdbExecution): boolean {
  return result.timedOut || /device offline|device .*not found|no devices|failed to read copy response|protocol fault|connection reset|reset by peer|closed|broken pipe|timed out/i.test(`${result.stdout}\n${result.stderr}`)
}

function isPushChannelRejection(result: AdbExecution): boolean {
  const output = `${result.stdout}\n${result.stderr}`
  return /not a right of root|reject push|segmentation fault|signal 11|sigsegv/i.test(
    output
  )
}

function privilegedAllowlistXml(packageName: string, permissions: string[]): string {
  const invalidPermission = permissions.find(
    (permission) => !/^[A-Za-z][A-Za-z0-9_.]+$/.test(permission)
  )
  if (invalidPermission) {
    throw new AppError(
      `权限名 ${invalidPermission} 不符合特权白名单安全规则。`,
      '请修正 APK Manifest 中的权限声明后重新打包。'
    )
  }
  const body = permissions
    .map((permission) => `    <permission name="${permission}"/>`)
    .join('\n')
  return `<?xml version="1.0" encoding="utf-8"?>\n<permissions>\n  <privapp-permissions package="${packageName}">\n${body}\n  </privapp-permissions>\n</permissions>\n`
}

function normalizedComponent(component: string | null): string | null {
  if (!component) return null
  const separator = component.indexOf('/')
  if (separator < 1) return null
  const packageName = component.slice(0, separator)
  const activity = component.slice(separator + 1)
  if (!activity) return null
  return `${packageName}/${activity.startsWith('.') ? `${packageName}${activity}` : activity}`
}

function componentsEqual(left: string | null, right: string | null): boolean {
  return normalizedComponent(left) === normalizedComponent(right)
}

function activityFromComponent(component: string): ApkInfo['homeActivities'][number] {
  const separator = component.indexOf('/')
  const packageName = component.slice(0, separator)
  const rawName = component.slice(separator + 1)
  return {
    name: rawName.startsWith('.') ? `${packageName}${rawName}` : rawName,
    component,
    exported: true
  }
}

function deviceMessage(devices: DeviceSummary[], mode: ConnectionMode): string {
  const candidates = devices.filter(({ transport }) => transport === mode)
  if (candidates.length === 0) {
    return mode === 'usb'
      ? '未检测到 USB 设备，请检查 USB 调试、数据线和 Windows 驱动。'
      : '尚未连接 TCP/IP 设备。'
  }
  if (candidates.length > 1) {
    return '检测到多个设备，请明确选择目标触摸屏。'
  }
  const state = candidates[0]?.state
  if (state === 'unauthorized') {
    return '请在触摸屏上勾选“始终允许”并点击允许。'
  }
  if (state === 'offline') {
    return '设备处于离线状态，请重新插拔 USB 或重新连接。'
  }
  if (state === 'no-permissions') {
    return 'Windows 无权访问该设备，请检查 USB 驱动。'
  }
  return '设备已连接，可以执行操作。'
}

export class AppController {
  private readonly adb: AdbGateway
  private readonly settings: SettingsGateway
  private readonly apkInspector: ApkInspector
  private readonly clientVersion: string
  private readonly monitorIntervalMs: number
  private readonly listeners = new Set<SnapshotListener>()
  private readonly deviceDetailsCache = new Map<string, DeviceDetails>()
  private readonly deviceQueues = new Map<string, PQueue>()
  private readonly systemModificationCapabilities = new Map<
    string,
    SystemModificationCapability
  >()
  private operationHistoryDetails: OperationHistoryDetail[]
  private selectedApkFile: InspectedApk | null = null
  private monitor: NodeJS.Timeout | null = null
  private refreshInFlight: Promise<void> | null = null
  private terminalId: string | null = null
  private disposed = false
  private operationWarnings: string[] = []
  private snapshot: AppSnapshot

  constructor(options: ControllerOptions) {
    this.adb = options.adb
    this.settings = options.settings
    this.apkInspector = options.apkInspector
    this.clientVersion = options.clientVersion
    this.monitorIntervalMs = options.monitorIntervalMs ?? 2_000
    const recentTcp = this.settings.getRecentTcp()
    this.operationHistoryDetails = this.settings
      .getOperationHistory()
      .slice(0, OPERATION_HISTORY_LIMIT)
    this.snapshot = {
      revision: 0,
      adb: {
        state: 'checking',
        executablePath: this.adb.executablePath,
        version: null,
        serverPort: this.adb.serverPort,
        message: '正在检查 ADB…'
      },
      driver: options.driverStatus,
      connectionMode: 'usb',
      devices: [],
      selectedSerial: null,
      selectedDevice: null,
      selectedApk: null,
      selectedDeviceApplication: null,
      deviceApplicationCatalog: {
        serial: null,
        applications: []
      },
      compatibility: null,
      permissionCompatibility: null,
      systemDeployment: null,
      launcher: EMPTY_LAUNCHER,
      operation: idleOperation(),
      operationHistory: this.operationHistoryDetails.map(historyEntry),
      logs: [],
      recentTcp,
      tcpRepair: idleTcpRepairState(),
      busy: false,
      commandCatalog: COMMAND_CATALOG
    }
  }

  getSnapshot(): AppSnapshot {
    return this.snapshot
  }

  async acquireTerminal(id: string, serial: string | null, requiresDevice: boolean): Promise<{
    executablePath: string; serverPort: number; serial: string | null
  }> {
    if (this.disposed || this.snapshot.adb.state !== 'ready') throw new Error('ADB 尚未就绪。')
    if (this.snapshot.busy || this.terminalId) throw new Error('请等待当前操作完成。')
    if (serial !== this.snapshot.selectedSerial) throw new Error('目标设备已变化，请重新执行命令。')
    this.terminalId = id
    this.patch({ busy: true })
    try {
      // 先占用操作入口，再等待已经开始的设备读取结束。
      await this.refreshInFlight
      if (this.disposed) throw new Error('应用正在退出。')
      if (serial !== this.snapshot.selectedSerial) throw new Error('目标设备已变化，请重新执行命令。')
      if (requiresDevice && (!serial || !this.snapshot.devices.some((device) => device.serial === serial && device.state === 'device'))) {
        throw new Error('请先选择一台已连接并授权的设备。')
      }
      return { executablePath: this.adb.executablePath, serverPort: this.adb.serverPort, serial: requiresDevice ? serial : null }
    } catch (error) {
      this.terminalId = null
      this.patch({ busy: false })
      throw error
    }
  }

  async releaseTerminal(id: string, refresh = true): Promise<void> {
    if (this.terminalId !== id) return
    try {
      if (!refresh || this.disposed) return
      const serial = this.snapshot.selectedSerial
      if (serial) {
        this.deviceDetailsCache.delete(serial)
        this.systemModificationCapabilities.delete(serial)
      }
      this.patch({
        selectedDevice: null,
        selectedDeviceApplication: null,
        deviceApplicationCatalog: { serial, applications: [] },
        compatibility: null,
        permissionCompatibility: null,
        launcher: this.launcherState(serial, null)
      })
      await this.refreshDevices(true)
    } finally {
      this.terminalId = null
      this.patch({ busy: false })
    }
  }

  getOperationHistoryDetail(operationId: string): OperationHistoryDetail {
    return this.requireHistoryOperation(operationId)
  }

  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async initialize(): Promise<void> {
    const initialization = await this.adb.initialize()
    const adbStatus: AdbStatus = {
      state: initialization.ok ? 'ready' : 'error',
      executablePath: this.adb.executablePath,
      version: initialization.version,
      serverPort: this.adb.serverPort,
      message: initialization.message
    }
    this.patch({ adb: adbStatus })

    if (!initialization.ok) {
      this.failOperation(
        initialization.message,
        '请检查内置 ADB 文件是否完整，或联系技术支持。',
        null,
        '初始化 ADB'
      )
      return
    }

    await this.refreshDevices()
    if (!this.disposed) {
      this.monitor = setInterval(() => void this.refreshDevices().catch(writeApplicationError), this.monitorIntervalMs)
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.cancelLanSearch()
    if (this.monitor) {
      clearInterval(this.monitor)
      this.monitor = null
    }
    await this.adb.dispose()
  }

  async refreshUsbDevices(): Promise<AppSnapshot> {
    if (this.disposed || this.snapshot.busy || this.snapshot.adb.state !== 'ready') {
      return this.snapshot
    }
    this.beginOperation(null, '正在重新查询 USB ADB 设备列表…', '查询 USB ADB 设备', 10)
    this.patch({ busy: true })
    try {
      await this.refreshDevices(true, true)
      const count = this.snapshot.devices.filter(({ transport }) => transport === 'usb').length
      this.completeOperation(
        count > 0 ? `USB ADB 设备列表已更新，共发现 ${count} 台设备。` : '查询完成，未检测到 USB ADB 设备。',
        count > 0 ? '未授权或离线的设备也会显示在设备列表中。' : '请检查 USB 调试、数据线和驱动后重新查询。'
      )
    } catch (error) {
      this.handleOperationError(error)
    } finally {
      this.patch({ busy: false })
    }
    return this.snapshot
  }

  async setConnectionMode(mode: ConnectionMode): Promise<AppSnapshot> {
    if (this.snapshot.busy) return this.snapshot
    const current = this.snapshot.devices.find(({ serial }) => serial === this.snapshot.selectedSerial)
    const keepSelection = current?.transport === mode
    const candidates = this.snapshot.devices.filter(({ transport }) => transport === mode)
    const selectedSerial = keepSelection ? current?.serial ?? null : candidates.length === 1 ? candidates[0]?.serial ?? null : null

    this.patch({
      connectionMode: mode,
      selectedSerial,
      selectedDevice: null,
      selectedDeviceApplication:
        this.snapshot.selectedDeviceApplication?.serial === selectedSerial
          ? this.snapshot.selectedDeviceApplication
          : null,
      deviceApplicationCatalog:
        this.snapshot.deviceApplicationCatalog.serial === selectedSerial
          ? this.snapshot.deviceApplicationCatalog
          : { serial: selectedSerial, applications: [] },
      compatibility: null,
      permissionCompatibility: this.waitingPermissionCompatibility(selectedSerial),
      launcher: EMPTY_LAUNCHER,
      tcpRepair: idleTcpRepairState(),
      operation: {
        ...this.snapshot.operation,
        summary: deviceMessage(this.snapshot.devices, mode)
      }
    })
    if (selectedSerial) await this.hydrateSelectedDevice(selectedSerial)
    return this.snapshot
  }

  async selectDevice(serial: string | null): Promise<AppSnapshot> {
    if (this.snapshot.busy) return this.snapshot
    if (serial !== null && !this.snapshot.devices.some((device) => device.serial === serial)) {
      throw new AppError('所选设备已断开。', '请重新连接设备后再选择。')
    }

    this.patch({
      selectedSerial: serial,
      selectedDevice: null,
      selectedDeviceApplication:
        this.snapshot.selectedDeviceApplication?.serial === serial
          ? this.snapshot.selectedDeviceApplication
          : null,
      deviceApplicationCatalog:
        this.snapshot.deviceApplicationCatalog.serial === serial
          ? this.snapshot.deviceApplicationCatalog
          : { serial, applications: [] },
      compatibility: null,
      permissionCompatibility: this.waitingPermissionCompatibility(serial),
      launcher: EMPTY_LAUNCHER,
      tcpRepair: idleTcpRepairState()
    })
    if (serial) await this.hydrateSelectedDevice(serial)
    return this.snapshot
  }

  private lanDiscovery: LanDiscovery | null = null

  private getLanDiscovery(): LanDiscovery {
    return this.lanDiscovery ??= new LanDiscovery(this.adb)
  }

  listLanNetworks() { return this.getLanDiscovery().networks() }
  searchLan(id: string, port: number) {
    if (this.disposed || this.snapshot.adb.state !== 'ready' || this.snapshot.busy) {
      throw new Error('请等待 ADB 就绪及当前操作完成。')
    }
    return this.getLanDiscovery().search(id, port)
  }
  cancelLanSearch() { this.lanDiscovery?.cancel() }

  async connectTcp(request: TcpConnectRequest): Promise<AppSnapshot> {
    if (this.snapshot.busy) return this.snapshot
    const endpoint = `${request.host}:${request.port}`
    this.beginOperation(null, `正在连接 ${endpoint}`, '建立 TCP/IP 连接', 10)
    this.patch({
      busy: true,
      connectionMode: 'tcp',
      selectedSerial: null,
      selectedDevice: null,
      selectedDeviceApplication: null,
      deviceApplicationCatalog: { serial: null, applications: [] },
      compatibility: null,
      permissionCompatibility: null,
      launcher: EMPTY_LAUNCHER,
      tcpRepair: {
        endpoint: request,
        phase: 'available',
        probe: 'not-run',
        failureKind: null,
        message: null,
        detail: null,
        serverPort: this.adb.serverPort
      }
    })

    try {
      await this.connectTcpWithRecovery(request)
      this.patch({ tcpRepair: idleTcpRepairState() })
      this.completeOperation(`已通过 TCP/IP 连接 ${endpoint}。`)
    } catch (error) {
      this.patch({ tcpRepair: {
        ...this.snapshot.tcpRepair,
        phase: 'error',
        message: error instanceof Error ? error.message : 'TCP/IP 连接未完成。',
        detail: error instanceof AppError ? error.suggestion : '请查看操作记录。',
        serverPort: this.adb.serverPort
      } })
      this.handleOperationError(error)
    } finally {
      this.patch({ busy: false })
    }
    return this.snapshot
  }

  async repairTcpConnection(): Promise<AppSnapshot> {
    if (this.snapshot.busy) return this.snapshot
    const repair = this.snapshot.tcpRepair
    const endpoint = repair.endpoint
    if (!endpoint) {
      this.failOperation(
        '当前没有可修复的 TCP/IP 连接。',
        '请先输入设备 IP 和实际调试端口，执行一次连接。',
        null,
        '修复 TCP/IP 连接'
      )
      return this.snapshot
    }

    const endpointLabel = `${endpoint.host}:${endpoint.port}`
    this.beginOperation(
      null,
      `正在排查 ${endpointLabel} 的 TCP/IP 连接…`,
      '修复 TCP/IP 连接',
      5
    )
    this.patch({
      busy: true,
      connectionMode: 'tcp',
      tcpRepair: {
        ...repair,
        phase: 'probing',
        probe: 'not-run',
        message: '正在执行只读 TCP 端口探测…',
        detail: null,
        serverPort: this.adb.serverPort
      }
    })

    try {
      const probe = await this.adb.probeTcpEndpoint(endpoint.host, endpoint.port)
      this.patch({
        tcpRepair: {
          ...this.snapshot.tcpRepair,
          phase: 'probing',
          probe: probe.status,
          message: probe.detail,
          detail: 'TCP 探测只验证网络握手，不会发送 ADB 命令。'
        }
      })
      if (probe.status !== 'open') {
        throw this.tcpProbeError(endpoint, probe)
      }

      if (repair.failureKind === 'unauthorized') {
        throw new AppError(
          '设备尚未授权当前电脑。',
          '网络端口已经可达，请在设备端确认 ADB 授权后重新连接；无需重启 ADB Server。'
        )
      }
      if (repair.failureKind === 'protocol') {
        throw new AppError(
          '目标端口已打开，但没有确认是正常的 ADB 服务。',
          '请以设备“无线调试”页面显示的实际调试端口为准；若端口仍返回 protocol fault 或被重置，请检查端口是否被其他服务占用。'
        )
      }
      if (repair.failureKind === 'refused') {
        throw new AppError(
          '目标端口没有可用的 ADB 监听服务。',
          '请在设备端开启网络 ADB；Android 11 及以上请使用“无线调试”页面当前显示的调试端口，不要固定使用 5555。'
        )
      }

      if (repair.failureKind === 'offline') {
        const disconnect = await this.runStep(
          '断开异常 TCP/IP 连接',
          ['disconnect', endpointLabel],
          { timeoutMs: 10_000 }
        )
        if (this.adbExecutionFailed(disconnect)) {
          this.noteOperationWarning('断开旧 TCP/IP 连接的 ADB 命令未成功，已继续执行重新连接。')
        }
      } else {
        this.patch({
          tcpRepair: {
            ...this.snapshot.tcpRepair,
            phase: 'restarting',
            message: `端口已可达，正在重启应用内 ADB Server（127.0.0.1:${this.adb.serverPort}）…`
          }
        })
        await this.restartTcpServer()
      }

      this.patch({
        tcpRepair: {
          ...this.snapshot.tcpRepair,
          phase: 'connecting',
          message: `正在重新连接 ${endpointLabel}…`
        }
      })
      await this.connectTcpEndpoint(endpoint)
      this.patch({
        tcpRepair: {
          endpoint,
          phase: 'success',
          probe: 'open',
          failureKind: null,
          message: `已重新连接 ${endpointLabel}。`,
          detail:
            repair.serverPort !== null && repair.serverPort !== this.adb.serverPort
              ? `网络端口可达，外部 Server 未被终止，应用已切换到独立备用 Server 127.0.0.1:${this.adb.serverPort} 并通过设备列表回读。`
              : '网络端口可达，应用内 ADB Server 已完成修复并通过设备列表回读。',
          serverPort: this.adb.serverPort
        }
      })
      this.completeOperation(
        `已修复并通过 TCP/IP 连接 ${endpointLabel}。`,
        repair.failureKind === 'offline'
          ? '已先断开旧连接，再重新建立 ADB 连接。'
          : repair.serverPort !== null && repair.serverPort !== this.adb.serverPort
            ? `未终止外部 Server，已切换到应用内独立 Server（端口 ${this.adb.serverPort}）后重新连接。`
            : `已重启应用内 ADB Server（端口 ${this.adb.serverPort}）后重新连接。`
      )
    } catch (error) {
      this.patch({
        tcpRepair: {
          ...this.snapshot.tcpRepair,
          phase: 'error',
          message: error instanceof AppError ? error.message : 'TCP/IP 修复未完成。',
          detail:
            error instanceof AppError
              ? error.suggestion
              : '请查看操作记录中的 ADB 输出和端口探测结果。'
        }
      })
      this.handleOperationError(error)
    } finally {
      this.patch({ busy: false })
    }
    return this.snapshot
  }

  private async connectTcpWithRecovery(request: TcpConnectRequest): Promise<void> {
    const endpoint = `${request.host}:${request.port}`
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.connectTcpEndpoint(request)
        return
      } catch (error) {
        const kind = this.snapshot.tcpRepair.failureKind
        // 授权、端口协议和拒绝监听需要设备端处理，不用重启掩盖这些错误。
        if (attempt === 2 || !['network', 'unknown', 'offline'].includes(kind ?? '') ||
            (attempt === 1 && kind === 'offline')) throw error
        this.updateOperation('连接暂未建立，正在检查设备端口并自动恢复，请稍候。', '自动恢复 TCP/IP 连接', null)
        const probe = await this.adb.probeTcpEndpoint(request.host, request.port)
        this.patch({ tcpRepair: {
          ...this.snapshot.tcpRepair, phase: 'probing', probe: probe.status,
          message: probe.detail, detail: probe.detail
        } })
        if (probe.status !== 'open') throw this.tcpProbeError(request, probe)
        if (attempt === 0) {
          if (kind === 'offline') {
            const disconnect = await this.runStep('断开异常 TCP/IP 连接', ['disconnect', endpoint], { timeoutMs: 5_000 })
            this.assertSuccess(disconnect, '无法断开失效连接。')
          }
          this.updateOperation('设备端口可达，正在重新连接（2/3）…', '重试 TCP/IP 连接', null)
        } else {
          this.updateOperation('设备端口可达，正在恢复应用 ADB Server 后连接（3/3）…', '恢复 ADB Server', null)
          await this.restartTcpServer()
        }
      }
    }
  }

  private async restartTcpServer(): Promise<void> {
    const restarted = await this.adb.restartServer()
    // 外部 Server 只做备用端口切换，不记录未实际执行的 kill-server。
    if (restarted.kill.args.includes('-P')) {
      this.recordTechnicalExecution('停止应用内 ADB Server', restarted.kill)
    }
    if (restarted.start.args.includes('-P')) {
      this.recordTechnicalExecution('启动应用内 ADB Server', restarted.start)
    }
    this.patch({
      adb: {
        ...this.snapshot.adb,
        serverPort: restarted.serverPort,
        message: restarted.ok
          ? `ADB 已就绪，当前 Server 端口 ${restarted.serverPort}`
          : restarted.message
      }
    })
    if (!restarted.ok) {
      throw new AppError(
        '应用内 ADB Server 未能重启。',
        `${restarted.message} 请确认没有其他 ADB 工具占用该 Server，或重启安装助手后再试。`
      )
    }
  }

  private async connectTcpEndpoint(request: TcpConnectRequest): Promise<void> {
    const endpoint = `${request.host}:${request.port}`
    const result = await this.runStep('连接 TCP/IP', ['connect', endpoint], {
      timeoutMs: 20_000
    })
    const output = `${result.stdout}\n${result.stderr}`
    const connectSucceeded =
      !this.adbExecutionFailed(result) &&
      /(?:^|\s)(?:already )?connected to\s+/i.test(output)
    if (!connectSucceeded) {
      // adb connect 在部分版本中会把失败文本写到 stdout 且返回 0，不能只看 exitCode。
      const kind = tcpFailureKind(output)
      const friendly = result.timedOut
        ? {
            summary: 'TCP/IP 连接操作已超时。',
            suggestion: '请确认设备仍在线、端口为设备当前显示的调试端口，然后重试。'
          }
        : mapAdbError(output, `无法连接 ${endpoint}。`)
      this.setTcpRepairFailure(request, kind, friendly.summary, friendly.suggestion)
      throw new AppError(friendly.summary, friendly.suggestion)
    }

    this.settings.setRecentTcp(request.host, request.port)
    this.patch({ recentTcp: request })
    await this.refreshDevices(true)
    const connected = this.snapshot.devices.find(({ serial }) => serial === endpoint)
    if (!connected) {
      const message = 'ADB 返回已连接，但设备列表中没有目标 TCP/IP 端点。'
      const suggestion =
        '请确认 IP 和端口与设备端显示一致；Android 11 及以上请使用“无线调试”的实际调试端口，再执行修复流程。'
      this.setTcpRepairFailure(request, 'unknown', message, suggestion)
      throw new AppError(message, suggestion)
    }

    if (connected.state !== 'device') {
      const outputForMapping = connected.state === 'unauthorized' ? 'unauthorized' : connected.state
      const friendly = mapAdbError(
        outputForMapping,
        connected.state === 'offline' ? '设备连接已中断。' : 'TCP/IP 设备当前不可用。'
      )
      this.setTcpRepairFailure(
        request,
        connected.state === 'unauthorized'
          ? 'unauthorized'
          : connected.state === 'offline'
            ? 'offline'
            : 'unknown',
        friendly.summary,
        friendly.suggestion
      )
      throw new AppError(friendly.summary, friendly.suggestion)
    }

    this.patch({ selectedSerial: connected.serial })
    await this.hydrateSelectedDevice(connected.serial)
  }

  private setTcpRepairFailure(
    endpoint: TcpConnectRequest,
    failureKind: TcpRepairFailureKind,
    message: string,
    detail: string
  ): void {
    this.patch({
      tcpRepair: {
        endpoint,
        phase: 'available',
        probe: 'not-run',
        failureKind,
        message,
        detail,
        serverPort: this.adb.serverPort
      }
    })
  }

  private tcpProbeError(
    endpoint: TcpConnectRequest,
    probe: TcpEndpointProbe
  ): AppError {
    const endpointLabel = `${endpoint.host}:${endpoint.port}`
    if (probe.status === 'closed') {
      return new AppError(
        '目标 TCP/IP 端口未监听。',
        `${probe.detail} 如果设备尚未开启开发者选项或无线调试，请先通过 USB 在设备端开启；Android 11 及以上请使用无线调试页面当前显示的实际调试端口。`
      )
    }
    if (probe.status === 'unreachable') {
      return new AppError(
        `无法到达 ${endpointLabel}。`,
        `${probe.detail} 请检查 IP、路由、VPN、VLAN 和 Wi-Fi 客户端隔离。`
      )
    }
    if (probe.status === 'timeout') {
      return new AppError(
        `探测 ${endpointLabel} 超时。`,
        `${probe.detail} 请确认设备在线、网络可达，并核对设备当前的无线调试端口。`
      )
    }
    return new AppError(
      `无法确认 ${endpointLabel} 的 TCP 状态。`,
      `${probe.detail} 请检查网络路径和设备端无线调试状态。`
    )
  }

  async loadApk(filePath: string): Promise<AppSnapshot> {
    if (this.snapshot.busy) return this.snapshot
    this.beginOperation(null, '正在解析 APK Manifest…', '解析 APK', 15)
    this.patch({ busy: true })
    try {
      const inspected = await this.apkInspector.inspect(filePath)
      this.selectedApkFile = inspected
      this.patch({
        selectedApk: inspected.info,
        selectedDeviceApplication: null,
        compatibility: null,
        permissionCompatibility: evaluatePermissionCompatibility(
          inspected.info.declaredPermissions,
          {
            serial: null,
            deviceApiLevel: null
          }
        )
      })
      const serial = this.snapshot.selectedSerial
      if (serial) {
        this.settings.saveManagedPackage(serial, inspected.info.packageName)
      }
      this.updateOperation('正在检查设备兼容性…', '兼容性预检', 70)
      if (this.readyDevice()) {
        await this.refreshSelectedContext(true)
        this.updateOperation('正在核对 APK 声明权限…', '权限兼容性', 82)
        await this.refreshPermissionCompatibility(this.requireSerial(), true)
      }
      const existingApplication =
        this.snapshot.selectedDeviceApplication?.packageName === inspected.info.packageName
      this.completeOperation(
        existingApplication
          ? `已从 APK 识别包名 ${inspected.info.packageName}，设备中已安装该应用，可直接操作或继续安装更新。`
          : inspected.info.homeActivities.length > 0
            ? `已解析 ${inspected.info.fileName}，检测到 HOME Activity。`
            : `已解析 ${inspected.info.fileName}，但该 APK 不具备 HOME 桌面能力。`
      )
    } catch (error) {
      this.handleOperationError(error)
    } finally {
      this.patch({ busy: false })
    }
    return this.snapshot
  }

  async loadDeviceApplication(packageName: string): Promise<AppSnapshot> {
    if (this.snapshot.busy) return this.snapshot
    if (!this.readyDevice()) {
      this.failOperation(
        '当前没有可读取应用的已授权设备。',
        deviceMessage(this.snapshot.devices, this.snapshot.connectionMode),
        null,
        '读取设备应用'
      )
      return this.snapshot
    }

    const serial = this.requireSerial()
    this.beginOperation(null, `正在读取设备应用 ${packageName}…`, '读取设备应用', 15)
    this.patch({ busy: true })
    try {
      const application = await this.queryDeviceApplication(serial, packageName, true)
      if (!application) {
        throw new AppError(
          `设备中未安装 ${packageName}。`,
          '请核对完整包名，或从设备应用列表中重新选择。'
        )
      }
      this.activateDeviceApplication(serial, application)
      await this.refreshSelectedContext(false)
      await this.refreshPermissionCompatibility(serial, true)
      this.completeOperation(
        `已读取设备应用 ${packageName}，版本 ${application.versionName ?? '-'}（${application.versionCode ?? '-'}）。`,
        application.permissionInspectionError
          ? application.permissionInspectionError
          : application.launchActivity
            ? `已读取并检测 ${application.declaredPermissions.length} 项应用请求权限。`
            : '未解析到可启动 Activity，停止、卸载和清除数据仍可使用。'
      )
    } catch (error) {
      this.handleOperationError(error)
    } finally {
      this.patch({ busy: false })
    }
    return this.snapshot
  }

  async loadForegroundApplication(): Promise<AppSnapshot> {
    if (this.snapshot.busy) return this.snapshot
    if (!this.readyDevice()) {
      this.failOperation(
        '当前没有可读取前台应用的已授权设备。',
        deviceMessage(this.snapshot.devices, this.snapshot.connectionMode),
        null,
        '读取当前前台应用'
      )
      return this.snapshot
    }

    const serial = this.requireSerial()
    this.beginOperation(null, '正在识别设备当前前台应用…', '读取当前前台应用', 15)
    this.patch({ busy: true })
    try {
      const component = await this.queryForegroundComponent(serial, true)
      const packageName = packageFromComponent(component)
      if (!packageName) {
        throw new AppError(
          '未识别到设备当前前台应用。',
          '请先在设备上打开目标应用并保持在前台，然后重试。锁屏、系统弹窗或厂商定制系统可能导致无法识别。'
        )
      }
      const application = await this.queryDeviceApplication(serial, packageName, true)
      if (!application) {
        throw new AppError(
          `前台组件属于 ${packageName}，但无法读取其安装信息。`,
          '请改用设备应用列表或完整包名指定目标应用。'
        )
      }
      this.activateDeviceApplication(serial, application)
      await this.refreshSelectedContext(false)
      await this.refreshPermissionCompatibility(serial, true)
      this.completeOperation(
        `已将当前前台应用 ${packageName} 设为目标应用。`,
        application.permissionInspectionError
          ? application.permissionInspectionError
          : application.launchActivity
            ? `已读取并检测 ${application.declaredPermissions.length} 项应用请求权限。`
            : '未解析到可启动 Activity，停止、卸载和清除数据仍可使用。'
      )
    } catch (error) {
      this.handleOperationError(error)
    } finally {
      this.patch({ busy: false })
    }
    return this.snapshot
  }

  async refreshDeviceApplications(): Promise<AppSnapshot> {
    if (this.snapshot.busy) return this.snapshot
    if (!this.readyDevice()) {
      this.failOperation(
        '当前没有可查询应用的已授权设备。',
        deviceMessage(this.snapshot.devices, this.snapshot.connectionMode),
        null,
        '读取设备应用列表'
      )
      return this.snapshot
    }

    const serial = this.requireSerial()
    this.beginOperation(null, '正在读取设备可选择应用…', '读取设备应用列表', 15)
    this.patch({ busy: true })
    try {
      const applications = await this.queryDeviceApplicationCandidates(serial, true)
      if (this.snapshot.selectedSerial !== serial) return this.snapshot
      this.patch({
        deviceApplicationCatalog: {
          serial,
          applications
        }
      })
      this.completeOperation(
        applications.length > 0
          ? `已读取 ${applications.length} 个可启动或可作为桌面的应用。`
          : '设备中没有查询到可启动或可作为桌面的应用。',
        applications.length > 0
          ? undefined
          : '仍可通过完整包名指定没有桌面入口的应用。'
      )
    } catch (error) {
      this.handleOperationError(error)
    } finally {
      this.patch({ busy: false })
    }
    return this.snapshot
  }

  async selectHomeActivity(component: string): Promise<AppSnapshot> {
    if (this.snapshot.busy) return this.snapshot
    const apk = this.snapshot.selectedApk
    const deviceApplication = this.snapshot.selectedDeviceApplication
    const activities = apk?.homeActivities ?? deviceApplication?.homeActivities ?? []
    const activity = activities.find((candidate) => candidate.component === component)
    if (!activity?.exported) {
      throw new AppError(
        '所选 HOME Activity 无效或未导出。',
        apk ? '请修正应用 Manifest 后重新打包。' : '请重新读取目标应用。'
      )
    }
    if (apk) {
      const selectedApk: ApkInfo = {
        ...apk,
        selectedHomeComponent: component
      }
      if (this.selectedApkFile) {
        this.selectedApkFile = {
          ...this.selectedApkFile,
          info: selectedApk
        }
      }
      this.patch({ selectedApk })
    } else if (deviceApplication) {
      this.patch({
        selectedDeviceApplication: {
          ...deviceApplication,
          selectedHomeComponent: component
        }
      })
    } else {
      throw new AppError(
        '尚未指定目标应用。',
        '请输入包名读取设备应用，或选择并解析 APK。'
      )
    }
    this.patch({ busy: true })
    try {
      await this.refreshSelectedContext(false)
    } finally {
      this.patch({ busy: false })
    }
    return this.snapshot
  }

  async executeCommand(request: ExecuteCommandRequest): Promise<AppSnapshot> {
    const definition = COMMAND_BY_ID.get(request.commandId)
    if (!definition) {
      throw new AppError('未知的内置操作。', '请升级或重新安装客户端。')
    }
    if (this.snapshot.busy) {
      return this.snapshot
    }
    if (definition.requiresDevice && !this.readyDevice()) {
      this.failOperation(
        '当前没有可操作的已授权设备。',
        deviceMessage(this.snapshot.devices, this.snapshot.connectionMode),
        null,
        definition.displayName
      )
      return this.snapshot
    }
    if (definition.requiresApk && !this.selectedApkFile) {
      this.failOperation(
        '该操作需要先选择 APK。',
        '请选择并解析目标 APK。',
        null,
        definition.displayName
      )
      return this.snapshot
    }
    if (definition.requiresPackage && !this.targetPackageName()) {
      this.failOperation(
        '该操作需要先指定目标应用。',
        '请输入包名读取设备中的已安装应用，或选择并解析 APK。',
        null,
        definition.displayName
      )
      return this.snapshot
    }

    const serial = this.snapshot.selectedSerial
    if (!serial) {
      this.failOperation(
        '尚未锁定目标设备。',
        '请明确选择要操作的触摸屏。',
        null,
        definition.displayName
      )
      return this.snapshot
    }

    const queue = this.queueFor(serial)
    this.patch({ busy: true })
    await queue.add(async () => {
      this.beginOperation(
        request.commandId,
        `正在执行：${definition.displayName}`,
        definition.displayName,
        5
      )
      try {
        const result = await this.executeCommandNow(
          request.commandId,
          request.allowDowngrade === true,
          request.systemDeploymentMode ?? 'system'
        )
        this.completeOperation(result.summary, result.suggestion, result.status)
      } catch (error) {
        this.handleOperationError(error)
      }
    })
    this.patch({ busy: false })
    await this.refreshDevices(true)
    return this.snapshot
  }

  formatOperationSummary(operationId: string): string {
    const operation = this.requireHistoryOperation(operationId)
    return [
      '安卓触摸屏安装助手 · 操作摘要',
      '用途：说明做了什么、结果如何以及建议的下一步。',
      '',
      ...this.operationSummaryLines(operation)
    ].join('\n')
  }

  formatOperationDiagnostics(operationId: string): string {
    const operation = this.requireHistoryOperation(operationId)
    const technicalLines =
      operation.logs.length > 0
        ? operation.logs.flatMap((entry, index) => [
            `${index + 1}. [${formatOperationTime(entry.time)}] ${entry.operation}`,
            `   ADB 参数：${entry.arguments.join(' ') || '无'}`,
            `   退出码：${entry.exitCode}；耗时：${formatOperationDuration(entry.durationMs)}`,
            entry.stdout.trim() ? `   标准输出：${entry.stdout.trim()}` : null,
            entry.stderr.trim() ? `   标准错误：${entry.stderr.trim()}` : null
          ])
        : ['没有记录到 ADB 技术步骤。']

    return [
      '安卓触摸屏安装助手 · 技术诊断详情',
      '用途：提交给开发或技术支持人员排查问题。',
      '',
      ...this.operationSummaryLines(operation),
      '',
      `技术步骤（${operation.logs.length}）：`,
      ...technicalLines
    ]
      .filter((line): line is string => line !== null)
      .join('\n')
  }

  private requireHistoryOperation(operationId: string): OperationHistoryDetail {
    const operation = this.operationHistoryDetails.find(
      ({ id }) => id === operationId
    )
    if (!operation) {
      throw new AppError(
        '所选操作记录已经不存在。',
        '请重新打开操作记录并选择仍在保留范围内的项目。'
      )
    }
    return operation
  }

  private operationSummaryLines(operation: OperationHistoryEntry): string[] {
    return [
      `操作：${operation.title}`,
      `结果：${operation.status === 'success' ? '成功' : operation.status === 'warning' ? '警告' : '失败'}`,
      `结果说明：${operation.summary}`,
      ...(operation.suggestion ? [`下一步建议：${operation.suggestion}`] : []),
      `设备：${operation.serial ?? '未指定'}`,
      ...(operation.packageName ? [`目标应用：${operation.packageName}`] : []),
      `连接方式：${operation.connection === 'tcp' ? 'TCP/IP' : operation.connection === 'usb' ? 'USB' : '未记录'}`,
      `开始时间：${formatOperationTime(operation.startedAt)}`,
      `结束时间：${formatOperationTime(operation.finishedAt)}`,
      `耗时：${formatOperationDuration(operation.durationMs)}`,
      `客户端版本：${operation.clientVersion}`,
      `ADB 版本：${operation.adbVersion ?? '未记录'}`
    ]
  }

  private operationHistoryWith(
    operation: OperationState & { status: 'success' | 'warning' | 'error' }
  ): OperationHistoryEntry[] {
    const finishedAt = operation.finishedAt ?? new Date().toISOString()
    const logs = this.snapshot.logs
      .filter(({ operationId }) => operationId === operation.id)
      .slice(-OPERATION_HISTORY_LOG_LIMIT)
      .map(historyLog)
    const detail: OperationHistoryDetail = {
      id: operation.id,
      commandId: operation.commandId,
      status: operation.status,
      title: operation.title,
      summary: operation.summary,
      suggestion: operation.suggestion,
      serial: this.snapshot.selectedSerial,
      connection: this.snapshot.selectedSerial
        ? this.snapshot.connectionMode
        : null,
      packageName: this.targetPackageName(),
      clientVersion: this.clientVersion,
      adbVersion: this.snapshot.adb.version,
      startedAt: operation.startedAt ?? finishedAt,
      finishedAt,
      durationMs: operation.durationMs,
      logCount: logs.length,
      logs
    }
    this.operationHistoryDetails = [
      detail,
      ...this.operationHistoryDetails.filter(({ id }) => id !== operation.id)
    ].slice(0, OPERATION_HISTORY_LIMIT)
    this.settings.saveOperationHistory(this.operationHistoryDetails)
    return this.operationHistoryDetails.map(historyEntry)
  }

  private async refreshDevices(force = false, manual = false): Promise<void> {
    if (this.disposed || this.snapshot.adb.state !== 'ready') return
    if (this.snapshot.busy && !force) return
    if (this.refreshInFlight) {
      if (!force) return
      await this.refreshInFlight
      return this.refreshDevices(force, manual)
    }
    this.refreshInFlight = this.queryDevices(manual)
    try {
      await this.refreshInFlight
    } finally {
      this.refreshInFlight = null
    }
  }

  private async queryDevices(manual: boolean): Promise<void> {
    const result = manual
      ? await this.runStep('查询 USB ADB 设备', ['devices', '-l'], { timeoutMs: 8_000 })
      : await this.adb.run(['devices', '-l'], { timeoutMs: 8_000 })
    if (this.adbExecutionFailed(result)) {
      if (manual) {
        throw new AppError('USB ADB 设备列表查询失败。', '请检查 ADB 状态后重试，详细输出见操作记录。')
      }
      return
    }
    const devices = parseDevices(result.stdout)
    const currentSerial = this.snapshot.selectedSerial
    const currentStillExists = currentSerial
      ? devices.some(({ serial }) => serial === currentSerial)
      : false
    const candidates = devices.filter(({ transport }) => transport === this.snapshot.connectionMode)
    const selectedSerial = currentStillExists
      ? currentSerial
      : this.snapshot.busy && !manual
        ? currentSerial
        : candidates.length === 1
          ? candidates[0]?.serial ?? null
          : null

    this.patch({
      devices,
      selectedSerial,
      selectedDeviceApplication:
        this.snapshot.selectedDeviceApplication?.serial === selectedSerial
          ? this.snapshot.selectedDeviceApplication
          : null,
      deviceApplicationCatalog:
        this.snapshot.deviceApplicationCatalog.serial === selectedSerial
          ? this.snapshot.deviceApplicationCatalog
          : { serial: selectedSerial, applications: [] },
      selectedDevice:
        selectedSerial && currentStillExists
          ? this.snapshot.selectedDevice
          : selectedSerial
            ? null
            : null,
      operation:
        this.snapshot.operation.status === 'idle'
          ? {
              ...this.snapshot.operation,
              summary: deviceMessage(devices, this.snapshot.connectionMode)
            }
          : this.snapshot.operation
    })

    const selected = devices.find(({ serial }) => serial === selectedSerial)
    if (selected?.state === 'device') {
      await this.hydrateSelectedDevice(selected.serial)
    } else if (!this.snapshot.busy || manual) {
      this.patch({
        selectedDevice: null,
        selectedDeviceApplication:
          this.snapshot.selectedDeviceApplication?.serial === selectedSerial
            ? this.snapshot.selectedDeviceApplication
            : null,
        compatibility: null,
        permissionCompatibility: this.waitingPermissionCompatibility(selectedSerial),
        launcher: this.launcherState(selectedSerial, null)
      })
    }
  }

  private async hydrateSelectedDevice(serial: string): Promise<void> {
    const summary = this.snapshot.devices.find((device) => device.serial === serial)
    if (!summary || summary.state !== 'device') {
      this.patch({
        selectedDevice: null,
        compatibility: null,
        permissionCompatibility: this.waitingPermissionCompatibility(serial)
      })
      return
    }

    const firstHydrationForSelection = this.snapshot.selectedDevice?.serial !== serial
    let details = this.deviceDetailsCache.get(serial)
    if (!details) {
      const [result, identity, suLookup, display] = await Promise.all([
        this.adb.run(['shell', 'getprop'], {
          serial,
          timeoutMs: 10_000
        }),
        this.adb.run(['shell', 'id'], {
          serial,
          timeoutMs: 10_000
        }),
        this.adb.run(['shell', 'command', '-v', 'su'], {
          serial,
          timeoutMs: 5_000
        }),
        this.adb.run(['shell', 'wm', 'size'], {
          serial,
          timeoutMs: 10_000
        })
      ])
      if (result.exitCode !== 0) return
      const adbUid = identity.exitCode === 0 ? parseAdbUid(identity.stdout) : null
      details = {
        ...parseGetProp(summary, result.stdout),
        ...(display.exitCode === 0
          ? parseDisplayResolution(`${display.stdout}\n${display.stderr}`)
          : {}),
        adbUid,
        suPath: suLookup.exitCode === 0 ? parseSuPath(suLookup.stdout) : null,
        rootAccessMode: adbUid === 0 ? 'adbd' : 'none'
      }
      this.deviceDetailsCache.set(serial, details)
    } else {
      details = { ...details, ...summary }
      if (firstHydrationForSelection) {
        const display = await this.adb.run(['shell', 'wm', 'size'], {
          serial,
          timeoutMs: 10_000
        })
        if (display.exitCode === 0) {
          details = {
            ...details,
            ...parseDisplayResolution(`${display.stdout}\n${display.stderr}`)
          }
          this.deviceDetailsCache.set(serial, details)
        }
      }
    }

    if (this.snapshot.selectedSerial !== serial) return
    this.patch({ selectedDevice: details })
    if (
      firstHydrationForSelection &&
      !this.snapshot.selectedApk &&
      !this.snapshot.selectedDeviceApplication
    ) {
      const rememberedPackage = this.settings.getManagedPackage(serial)
      if (rememberedPackage) {
        const rememberedApplication = await this.queryDeviceApplication(
          serial,
          rememberedPackage,
          false
        )
        if (rememberedApplication && this.snapshot.selectedSerial === serial) {
          this.patch({ selectedDeviceApplication: rememberedApplication })
        }
      }
    }
    await this.refreshSelectedContext(false)
    if (
      firstHydrationForSelection &&
      (this.snapshot.selectedApk || this.snapshot.selectedDeviceApplication)
    ) {
      await this.refreshPermissionCompatibility(serial, false)
    }
  }

  private waitingPermissionCompatibility(
    serial: string | null
  ): PermissionCompatibilityReport | null {
    const apk = this.snapshot.selectedApk
    const deviceApplication = apk ? null : this.snapshot.selectedDeviceApplication
    const declaredPermissions =
      apk?.declaredPermissions ?? deviceApplication?.declaredPermissions ?? null
    if (!declaredPermissions) return null
    const device =
      this.snapshot.selectedDevice?.serial === serial ? this.snapshot.selectedDevice : null
    return evaluatePermissionCompatibility(declaredPermissions, {
      serial,
      deviceApiLevel: device?.apiLevel ?? null,
      ...(serial
        ? { systemModification: this.systemModificationCapability(serial, device) }
        : {}),
      inspectionError: deviceApplication?.permissionInspectionError ?? null
    })
  }

  private systemModificationCapability(
    serial: string,
    device: DeviceDetails | null = this.snapshot.selectedDevice
  ): SystemModificationCapability {
    return (
      this.systemModificationCapabilities.get(serial) ??
      inferSystemModificationCapability(
        device?.serial === serial ? device : null
      )
    )
  }

  private updateSystemModificationCapability(
    serial: string,
    capability: SystemModificationCapability
  ): void {
    this.systemModificationCapabilities.set(serial, capability)
    if (this.snapshot.selectedSerial !== serial) return
    const report = this.snapshot.permissionCompatibility
    if (!report) return
    this.patch({
      permissionCompatibility: applySystemModificationCapability(report, capability)
    })
  }

  private async refreshPermissionCompatibility(
    serial: string,
    recordLogs: boolean
  ): Promise<void> {
    const apk = this.snapshot.selectedApk
    const deviceApplication = apk ? null : this.snapshot.selectedDeviceApplication
    const device = this.snapshot.selectedDevice
    const declaredPermissions =
      apk?.declaredPermissions ?? deviceApplication?.declaredPermissions ?? null
    const targetPackageName = apk?.packageName ?? deviceApplication?.packageName ?? null
    if (
      !declaredPermissions ||
      !targetPackageName ||
      !device ||
      device.serial !== serial ||
      !this.readyDevice()
    ) {
      this.patch({
        permissionCompatibility: this.waitingPermissionCompatibility(serial)
      })
      return
    }

    const targetIdentity = apk
      ? `apk:${apk.token}`
      : `device:${deviceApplication?.packageName}:${deviceApplication?.versionCode ?? '-'}`
    const result = await this.runStep(
      '读取设备权限定义',
      ['shell', 'dumpsys', 'package', 'permissions'],
      { serial, timeoutMs: 30_000 },
      undefined,
      recordLogs,
      8_000
    )
    const output = `${result.stdout}\n${result.stderr}`.trim()
    if (this.adbExecutionFailed(result)) {
      this.noteOperationWarning('读取设备权限定义的 ADB 命令未成功，权限结果只能作为不完整的诊断信息。')
    }
    const definitions =
      result.exitCode === 0 && !result.timedOut
        ? parseDevicePermissionDefinitions(result.stdout)
        : undefined
    const deviceDefinitionsValid = Boolean(definitions && definitions.size > 0)
    if (deviceDefinitionsValid && apk) {
      for (const permission of apk.definedPermissions) {
        const existing = definitions?.get(permission.name)
        if (
          definitions &&
          (!existing || existing.sourcePackage === apk.packageName)
        ) {
          definitions.set(permission.name, {
            name: permission.name,
            sourcePackage: apk.packageName,
            protectionLevel: existing?.protectionLevel ?? permission.protectionLevel,
            permissionFlags: existing?.permissionFlags ?? [],
            definedByApk: true
          })
        }
      }
    }
    if (deviceDefinitionsValid && deviceApplication && definitions) {
      for (const [name, definition] of definitions) {
        if (definition.sourcePackage === deviceApplication.packageName) {
          definitions.set(name, {
            ...definition,
            definedByApk: true
          })
        }
      }
    }
    const declarationInspectionError =
      deviceApplication?.permissionInspectionError ?? null
    const inspectionError =
      declarationInspectionError
        ? declarationInspectionError
        : deviceDefinitionsValid
        ? null
        : result.timedOut
          ? '读取设备权限定义超时。'
          : output || '设备没有返回可解析的权限定义。'
    let report = evaluatePermissionCompatibility(declaredPermissions, {
      serial,
      deviceApiLevel: device.apiLevel,
      ...(deviceDefinitionsValid && definitions ? { definitions } : {}),
      systemModification: this.systemModificationCapability(serial, device),
      inspectionError
    })
    const installed =
      deviceApplication !== null ||
      (this.snapshot.compatibility?.installedPackage.installed === true &&
        this.snapshot.selectedApk?.packageName === targetPackageName)
    if (installed && report.state === 'ready') {
      const [packageResult, appOpsResult, notificationPolicyResult] = await Promise.all([
        this.runStep(
          '回读应用权限状态',
          ['shell', 'dumpsys', 'package', targetPackageName],
          { serial, timeoutMs: 20_000 },
          undefined,
          recordLogs,
          8_000
        ),
        this.runStep(
          '回读应用 AppOps',
          ['shell', 'appops', 'get', targetPackageName],
          { serial, timeoutMs: 20_000 },
          undefined,
          recordLogs,
          8_000
        ),
        this.runStep(
          '回读通知策略访问名单',
          [
            'shell',
            'settings',
            'get',
            'secure',
            'enabled_notification_policy_access_packages'
          ],
          { serial, timeoutMs: 20_000 },
          undefined,
          recordLogs,
          8_000
        )
      ])
      if (this.adbExecutionFailed(packageResult)) {
        this.noteOperationWarning('回读应用权限状态的 ADB 命令未成功。')
      }
      if (this.adbExecutionFailed(appOpsResult)) {
        this.noteOperationWarning('回读应用 AppOps 的 ADB 命令未成功。')
      }
      if (this.adbExecutionFailed(notificationPolicyResult)) {
        this.noteOperationWarning('回读通知策略访问名单的 ADB 命令未成功。')
      }
      report = applyPermissionAuthorization(report, {
        installed: true,
        grants:
          packageResult.exitCode === 0
            ? parsePackagePermissionGrants(packageResult.stdout)
            : new Map(),
        appOps:
          appOpsResult.exitCode === 0
            ? parseAppOpsModes(appOpsResult.stdout)
            : new Map(),
        notificationPolicyAccess:
          notificationPolicyResult.exitCode === 0
            ? parseColonSeparatedPackages(notificationPolicyResult.stdout).has(
                targetPackageName
              )
            : null
      })
    } else {
      report = applyPermissionAuthorization(report, {
        installed: false,
        grants: new Map(),
        appOps: new Map(),
        notificationPolicyAccess: null
      })
    }

    if (
      this.snapshot.selectedSerial === serial &&
      (this.snapshot.selectedApk
        ? `apk:${this.snapshot.selectedApk.token}`
        : `device:${this.snapshot.selectedDeviceApplication?.packageName}:${this.snapshot.selectedDeviceApplication?.versionCode ?? '-'}`) ===
        targetIdentity
    ) {
      this.patch({ permissionCompatibility: report })
    }
  }

  private async refreshSelectedContext(recordLogs: boolean): Promise<void> {
    const serial = this.snapshot.selectedSerial
    const apk = this.snapshot.selectedApk
    const deviceApplication = this.snapshot.selectedDeviceApplication
    if (!serial || !this.readyDevice()) return

    const targetPackageName = apk?.packageName ?? deviceApplication?.packageName ?? null
    const [home, installed] = await Promise.all([
      this.queryCurrentHome(serial, recordLogs),
      targetPackageName
        ? this.queryInstalledPackage(serial, targetPackageName, recordLogs)
        : Promise.resolve<InstalledPackageInfo>({
            installed: false,
            versionName: null,
            versionCode: null
          })
    ])

    if (this.snapshot.selectedSerial !== serial) return
    const compatibility =
      apk && this.snapshot.selectedDevice
        ? evaluateCompatibility(apk, this.snapshot.selectedDevice, installed)
        : null
    let refreshedDeviceApplication: DeviceApplicationInfo | null = null
    if (targetPackageName && installed.installed) {
      const shouldReloadComponents =
        !deviceApplication ||
        deviceApplication.packageName !== targetPackageName ||
        deviceApplication.versionCode !== installed.versionCode
      refreshedDeviceApplication = shouldReloadComponents
        ? await this.queryDeviceApplication(
            serial,
            targetPackageName,
            recordLogs,
            installed
          )
        : {
            ...deviceApplication,
            versionName: installed.versionName,
            versionCode: installed.versionCode
          }
    }
    if (this.snapshot.selectedSerial !== serial) return
    this.patch({
      selectedDeviceApplication: refreshedDeviceApplication,
      compatibility,
      systemDeployment: targetPackageName
        ? this.settings.getSystemDeployment(serial, targetPackageName)
        : null,
      launcher: this.launcherState(serial, home)
    })
  }

  private launcherState(serial: string | null, currentComponent: string | null): LauncherState {
    const originalComponent = serial ? this.settings.getOriginalLauncher(serial) : null
    const targetComponent = this.targetHomeComponent()
    const verification = targetComponent
      ? componentsEqual(currentComponent, targetComponent)
        ? 'matched'
        : 'mismatched'
      : 'unknown'

    return {
      currentComponent,
      currentPackage: packageFromComponent(currentComponent),
      originalComponent,
      canRestore: originalComponent !== null && !componentsEqual(currentComponent, originalComponent),
      verification
    }
  }

  private readyDevice(): boolean {
    const serial = this.snapshot.selectedSerial
    return (
      serial !== null &&
      this.snapshot.devices.some((device) => device.serial === serial && device.state === 'device')
    )
  }

  private queueFor(serial: string): PQueue {
    let queue = this.deviceQueues.get(serial)
    if (!queue) {
      queue = new PQueue({ concurrency: 1 })
      this.deviceQueues.set(serial, queue)
    }
    return queue
  }

  private async executeCommandNow(
    commandId: CommandId,
    allowDowngrade: boolean,
    systemDeploymentMode: SystemDeploymentMode
  ): Promise<WorkflowResult> {
    switch (commandId) {
      case 'nav.back':
        return this.executeShell('返回', ['input', 'keyevent', 'KEYCODE_BACK'], '已发送返回按键。')
      case 'nav.home':
        return this.executeShell('Home', ['input', 'keyevent', 'KEYCODE_HOME'], '已发送 Home 按键。')
      case 'nav.recents':
        return this.executeShell(
          '最近任务',
          ['input', 'keyevent', 'KEYCODE_APP_SWITCH'],
          '已发送最近任务按键。'
        )
      case 'app.install':
        return this.installApplication(allowDowngrade)
      case 'app.replace':
        return this.replaceApplication()
      case 'app.deploySystem':
        return this.deploySystemApplication(systemDeploymentMode)
      case 'app.rollbackSystem':
        return this.rollbackSystemApplication()
      case 'app.launch':
        return this.launchApplication()
      case 'app.stop':
        return this.stopApplication()
      case 'app.restart':
        return this.restartApplication()
      case 'app.uninstall':
        return this.uninstallApplication()
      case 'app.clearData':
        return this.clearApplicationData()
      case 'launcher.set':
        return this.setLauncher()
      case 'launcher.verify':
        return this.verifyLauncher()
      case 'launcher.rebootVerify':
        return this.rebootAndVerifyLauncher()
      case 'launcher.restore':
        return this.restoreLauncher()
      case 'device.reboot':
        return this.rebootDevice()
      case 'device.rootAccess':
        return this.enableRootAccess()
      case 'system.settings':
        return this.executeShell(
          '打开系统设置',
          ['am', 'start', '-a', 'android.settings.SETTINGS'],
          '已打开系统设置。'
        )
      case 'system.developerSettings':
        return this.openDeveloperSettings()
    }
  }

  private async openDeveloperSettings(): Promise<WorkflowResult> {
    const serial = this.requireSerial()
    const status = await this.runStep(
      '检查开发者选项状态',
      ['shell', 'settings', 'get', 'global', 'development_settings_enabled'],
      { serial, timeoutMs: 10_000 }
    )
    if (this.adbExecutionFailed(status)) {
      this.noteOperationWarning('读取开发者选项状态的 ADB 命令未成功，后续已改用兜底入口。')
    }
    const developmentSettingsEnabled =
      status.exitCode === 0 && !status.timedOut ? status.stdout.trim() : null

    if (developmentSettingsEnabled !== '0') {
      const developerSettings = await this.launchSettingsAction(
        serial,
        '打开开发者选项',
        DEVELOPMENT_SETTINGS_ACTION
      )
      if (this.activityLaunchSucceeded(developerSettings)) {
        return {
          summary: '已向设备发送打开开发者选项请求。'
        }
      }
      this.noteOperationWarning('直接打开开发者选项的 ADB 命令未成功，已改用“关于设备”入口。')
    }

    const deviceInfo = await this.launchSettingsAction(
      serial,
      '打开关于设备',
      DEVICE_INFO_SETTINGS_ACTION
    )
    if (this.activityLaunchSucceeded(deviceInfo)) {
      this.noteOperationWarning('打开开发者选项的直接入口不可用，已改用“关于设备”入口。')
      return {
        summary:
          developmentSettingsEnabled === '0'
            ? '开发者选项尚未启用，已打开“关于设备”。'
            : '当前厂商系统无法直接打开开发者选项，已打开“关于设备”。',
        suggestion:
          '请在设备上找到“版本号”或“Build number”并连续点击 7 次；启用后返回设置，再次点击“开发者选项”。'
      }
    }

    const systemSettings = await this.launchSettingsAction(
      serial,
      '打开系统设置',
      SYSTEM_SETTINGS_ACTION
    )
    if (this.adbExecutionFailed(systemSettings)) {
      this.noteOperationWarning('开发者选项和关于设备入口均不可用，已尝试系统设置兜底入口。')
    }
    this.assertActivityLaunch(systemSettings, '无法打开设备设置。')
    return {
      summary: '当前厂商系统不支持直接打开开发者选项，已打开系统设置。',
      suggestion:
        '请进入“关于设备”或“系统信息”，连续点击“版本号”或“Build number”7 次；不同厂商的入口名称可能不同。'
    }
  }

  private launchSettingsAction(
    serial: string,
    operation: string,
    action: string
  ): Promise<AdbExecution> {
    return this.runStep(operation, ['shell', 'am', 'start', '-a', action], {
      serial,
      timeoutMs: 20_000
    })
  }

  private activityLaunchSucceeded(result: AdbExecution): boolean {
    if (result.exitCode !== 0 || result.timedOut) return false
    const output = `${result.stdout}\n${result.stderr}`
    return !/Error:|unable to resolve Intent|Activity class .* does not exist|Permission Denial|SecurityException/i.test(
      output
    )
  }

  private assertActivityLaunch(result: AdbExecution, fallback: string): void {
    if (this.activityLaunchSucceeded(result)) return
    const output = `${result.stdout}\n${result.stderr}`
    const friendly = result.timedOut
      ? {
          summary: `${fallback}操作已超时。`,
          suggestion: '请确认设备仍在线，然后重试。'
        }
      : mapAdbError(output, fallback)
    throw new AppError(friendly.summary, friendly.suggestion)
  }

  private async executeShell(
    operation: string,
    shellArgs: string[],
    successMessage: string
  ): Promise<WorkflowResult> {
    const serial = this.requireSerial()
    const result = await this.runStep(operation, ['shell', ...shellArgs], {
      serial,
      timeoutMs: COMMAND_BY_ID.get(this.snapshot.operation.commandId ?? 'nav.back')?.timeoutMs ?? 20_000
    })
    this.assertSuccess(result, `${operation}失败。`)
    return { summary: successMessage }
  }

  private async installApplication(allowDowngrade: boolean): Promise<WorkflowResult> {
    const serial = this.requireSerial()
    const selected = this.requireApk()
    const installed = await this.queryInstalledPackage(serial, selected.info.packageName, true)
    const device = this.snapshot.selectedDevice
    if (!device) throw new AppError('无法读取目标设备信息。', '请重新连接设备后重试。')
    const compatibility = evaluateCompatibility(selected.info, device, installed)
    this.patch({ compatibility })
    if (!compatibility.ok) {
      throw new AppError('APK 兼容性预检未通过。', compatibility.errors.join(' '))
    }
    if (compatibility.versionRelation === 'downgrade' && !allowDowngrade) {
      throw new AppError(
        '待安装 APK 版本低于设备版本。',
        '请在高级操作中启用“允许调试版 APK 降级安装”，或取消本次安装。'
      )
    }
    if (
      compatibility.versionRelation === 'downgrade' &&
      allowDowngrade &&
      !selected.info.debuggable
    ) {
      throw new AppError(
        '当前 APK 不是可调试版本，不能使用 ADB 降级安装。',
        '请提供 debuggable=true 的调试 APK，或卸载旧版本后再安装；卸载会清除应用数据。'
      )
    }

    const remotePath = await this.transferApk(serial, selected)
    try {
      const verified = await this.installTransferredApk(
        serial,
        selected,
        device,
        remotePath,
        [
          '-r',
          ...(compatibility.versionRelation === 'downgrade' && allowDowngrade ? ['-d'] : [])
        ],
        installed.installed
      )
      return {
        summary: `安装成功，设备版本为 ${verified.versionName ?? selected.info.versionName}（${verified.versionCode}）。`
      }
    } finally {
      await this.cleanupTransferredApk(serial, remotePath)
    }
  }

  private async replaceApplication(): Promise<WorkflowResult> {
    const serial = this.requireSerial()
    const selected = this.requireApk()
    const device = this.snapshot.selectedDevice
    if (!device) throw new AppError('无法读取目标设备信息。', '请重新连接设备后重试。')

    const installed = await this.queryInstalledPackage(serial, selected.info.packageName, true)
    if (!installed.installed) {
      throw new AppError(
        '设备中的旧应用已不存在，无需执行卸载重装。',
        '请直接使用“安装 / 更新”安装当前 APK。'
      )
    }
    const compatibility = evaluateCompatibility(selected.info, device, installed)
    this.patch({ compatibility })
    if (!compatibility.ok) {
      throw new AppError('APK 兼容性预检未通过。', compatibility.errors.join(' '))
    }

    const currentHome = await this.queryCurrentHome(serial, true)
    if (!currentHome) {
      throw new AppError(
        '无法确认设备当前的默认桌面，已取消卸载重装。',
        '请确认设备在线并重新读取 Launcher 状态；为避免卸载当前桌面，工具不会继续执行。'
      )
    }
    if (packageFromComponent(currentHome) === selected.info.packageName) {
      throw new AppError(
        '目标应用当前是设备的默认桌面，不能直接卸载重装。',
        '请先在设备系统设置中选择其他默认桌面，并确认 Home 键可以进入该桌面，再重新安装。'
      )
    }

    const remotePath = await this.transferApk(serial, selected)
    let oldApplicationRemoved = false
    try {
      this.updateOperation('正在卸载签名冲突的旧应用…', '卸载旧应用', 72)
      const uninstallResult = await this.runStep(
        '卸载签名冲突的旧应用',
        ['uninstall', selected.info.packageName],
        { serial, timeoutMs: 120_000 }
      )
      const uninstallOutput = `${uninstallResult.stdout}\n${uninstallResult.stderr}`
      if (uninstallResult.exitCode !== 0 || !/\bSuccess\b/i.test(uninstallOutput)) {
        this.assertSuccess(
          { ...uninstallResult, exitCode: uninstallResult.exitCode || 1 },
          '旧应用卸载失败。'
        )
      }

      const afterUninstall = await this.queryInstalledPackage(
        serial,
        selected.info.packageName,
        true
      )
      this.patch({
        compatibility: evaluateCompatibility(selected.info, device, afterUninstall)
      })
      if (afterUninstall.installed) {
        throw new AppError(
          '卸载命令已完成，但设备仍保留同包名应用。',
          '该应用可能是系统应用或安装在其他 Android 用户中，工具不会继续删除；请联系设备厂商确认。'
        )
      }

      oldApplicationRemoved = true
      this.updateOperation('旧应用已卸载，正在安装新 APK…', '安装新应用', 78)
      const verified = await this.installTransferredApk(
        serial,
        selected,
        device,
        remotePath,
        [],
        false
      )
      return {
        summary: `替换安装成功，设备版本为 ${verified.versionName ?? selected.info.versionName}（${verified.versionCode}）。`,
        suggestion: '旧应用及其本地数据已清除。'
      }
    } catch (error) {
      if (oldApplicationRemoved && error instanceof AppError) {
        throw new AppError(
          '旧应用及其数据已清除，但新 APK 安装失败。',
          `${error.message} ${error.suggestion} 请修复问题后重新执行“安装 / 更新”。`
        )
      }
      throw error
    } finally {
      await this.cleanupTransferredApk(serial, remotePath)
    }
  }

  private async transferApk(
    serial: string,
    selected: InspectedApk
  ): Promise<string> {
    const remotePath = `/data/local/tmp/adb-tool-${selected.info.token.slice(0, 12)}.apk`
    // 最多传输三次；只恢复当前 TCP 端点，不重启其他工具使用的 Server。
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.transferFile(serial, selected.path, remotePath, '传输 APK',
          240_000, selected.path, selected.info.fileSize, true, true)
        return remotePath
      } catch (error) {
        if (!(error instanceof TransferConnectionError)) throw error
        if (attempt === 3 || !serial.includes(':')) {
          throw new AppError('APK 传输因连接中断而停止，本次未执行安装。',
            '自动恢复次数已用尽或当前为 USB 连接。请检查网络或 USB 连接后重试，请勿反复点击安装。')
        }
        this.updateOperation(`传输连接中断，正在恢复连接（${attempt}/2）。请保持设备联网。`, '恢复安装连接', null)
        await this.recoverInstallConnection(serial)
        this.updateOperation('连接已恢复，正在校验已传输的 APK，完整时无需重新发送。', '校验 APK', null)
        if (await this.remoteApkMatches(serial, remotePath, selected)) return remotePath
        this.updateOperation(`文件尚未完整传输，准备第 ${attempt + 1}/3 次传输。`, '重新传输 APK', null)
      }
    }
    return remotePath
  }

  private async recoverInstallConnection(serial: string): Promise<void> {
    if (!serial.includes(':')) {
      throw new AppError('设备连接中断。', '请恢复 USB 连接后重试。')
    }
    await this.runStep('断开失效安装连接', ['disconnect', serial], { timeoutMs: 5_000 })
    const connect = await this.runStep('恢复安装连接', ['connect', serial], { timeoutMs: 10_000 })
    const state = await this.runStep('确认安装连接', ['get-state'], { serial, timeoutMs: 5_000 })
    if (this.adbExecutionFailed(connect) || state.stdout.trim() !== 'device' || this.adbExecutionFailed(state)) {
      throw new AppError('未能恢复设备连接，安装流程已停止。', '请检查设备网络后重试；工具没有重启 ADB Server 或设备。')
    }
  }

  private async remoteApkMatches(serial: string, remotePath: string, selected: InspectedApk): Promise<boolean> {
    const size = await this.runStep('校验 APK 大小', ['shell', 'stat', '-c', '%s', remotePath], { serial, timeoutMs: 10_000 })
    if (this.adbExecutionFailed(size) || size.stdout.trim() !== String(selected.info.fileSize)) return false
    const digest = await this.runStep('校验 APK SHA-256', ['shell', 'sha256sum', remotePath], { serial, timeoutMs: 30_000 })
    if (this.adbExecutionFailed(digest)) return false
    const remoteHash = digest.stdout.trim().split(/\s+/)[0]
    return remoteHash === await hashFile(selected.path)
  }

  private async transferFile(
    serial: string,
    localPath: string,
    remotePath: string,
    operation: string,
    timeoutMs: number,
    privatePath: string,
    expectedSize: number,
    showPushProgress = false,
    allowShellStreamFallback = false
  ): Promise<void> {
    this.updateOperation(
      `正在${operation}（${(expectedSize / 1_000_000).toFixed(1)} MB）。等待设备接收完成，暂未提供传输百分比；请保持连接，无需重复操作。`,
      operation,
      null
    )
    let progressBuffer = ''
    const pushOptions: AdbRunOptions = { serial, timeoutMs }
    if (showPushProgress) {
      pushOptions.onOutput = (chunk) => {
        progressBuffer = `${progressBuffer}${chunk}`.slice(-1_000)
        const percentage = parsePushProgress(progressBuffer)
        if (percentage !== null) {
          this.updateOperation(
            `正在${operation}…`,
            `传输 ${percentage}%`,
            12 + Math.round(percentage * 0.58)
          )
        }
      }
    }
    const pushResult = await this.runStep(
      operation,
      ['push', localPath, remotePath],
      pushOptions,
      privatePath
    )
    if (!this.adbExecutionFailed(pushResult)) return
    if (isConnectionFailure(pushResult)) throw new TransferConnectionError('传输连接中断')

    if (!isPushChannelRejection(pushResult)) {
      this.assertSuccess(pushResult, `${operation}失败。`)
    }

    const privileged = this.privilegedTransferMode(serial)
    const streamMode: FileTransferStreamMode | null =
      privileged ?? (allowShellStreamFallback ? { mode: 'shell' } : null)
    if (!streamMode) {
      const device = this.snapshot.selectedDevice
      const suHint =
        device?.serial === serial && device.suPath
          ? `已检测到 ${device.suPath}，但尚未通过“获取 Root 权限”验证。`
          : '当前设备没有已验证的 Root 通道。'
      throw new AppError(
        '设备端 adbd 拒绝文件传输。',
        `${suHint} 请先在高风险确认后执行“获取 Root 权限”，然后重试；工具不会自动提权。`
      )
    }

    const channelLabel =
      streamMode.mode === 'shell'
        ? 'shell 流式传输'
        : streamMode.mode === 'su'
          ? '已验证的 su 0 授权流式传输'
          : '已验证的 adbd Root 授权流式传输'
    this.noteOperationWarning(
      `${operation}的标准 adb push 被设备拒绝，已改用${channelLabel}。`
    )
    this.updateOperation(
      `标准 adb push 被设备拒绝，正在使用${channelLabel}…`,
      `${operation}（备用通道）`,
      null
    )
    const streamArgs =
      streamMode.mode === 'su'
        ? [
            'shell',
            streamMode.suPath,
            '0',
            'dd',
            `of=${remotePath}`,
            'bs=1M',
            'status=none',
            'conv=fsync'
          ]
        : ['shell', 'dd', `of=${remotePath}`, 'bs=1M', 'status=none', 'conv=fsync']
    const streamOptions: AdbRunOptions = {
      serial,
      timeoutMs,
      inputFile: localPath
    }
    const streamResult = await this.runStep(
      `${operation}（备用通道）`,
      streamArgs,
      streamOptions,
      privatePath
    )
    if (isConnectionFailure(streamResult)) throw new TransferConnectionError('备用传输连接中断')
    this.assertSuccess(streamResult, `${operation}失败。`)
    await this.verifyTransferredFileSize(serial, remotePath, expectedSize, operation)
  }

  private privilegedTransferMode(
    serial: string
  ): { mode: 'adbd' } | { mode: 'su'; suPath: string } | null {
    const device = this.snapshot.selectedDevice
    if (!device || device.serial !== serial) return null
    if (device.rootAccessMode === 'adbd' && device.adbUid === 0) {
      return { mode: 'adbd' }
    }
    if (device.rootAccessMode === 'su' && device.suPath) {
      return { mode: 'su', suPath: device.suPath }
    }
    return null
  }

  private async verifyTransferredFileSize(
    serial: string,
    remotePath: string,
    expectedSize: number,
    operation: string
  ): Promise<void> {
    const result = await this.runStep(
      `${operation}回读`,
      ['shell', 'stat', '-c', '%s', remotePath],
      { serial, timeoutMs: 10_000 }
    )
    this.assertSuccess(result, `${operation}回读失败。`)
    const actualSize = Number.parseInt(result.stdout.trim().split(/\s+/)[0] ?? '', 10)
    if (!Number.isSafeInteger(actualSize) || actualSize !== expectedSize) {
      throw new AppError(
        `${operation}文件大小校验失败。`,
        `设备端回读 ${Number.isSafeInteger(actualSize) ? `${actualSize} 字节` : '未知大小'}，本地文件应为 ${expectedSize} 字节；未继续执行安装。`
      )
    }
  }

  private async installTransferredApk(
    serial: string,
    selected: InspectedApk,
    device: DeviceDetails,
    remotePath: string,
    installFlags: string[],
    offerSignatureConflictRecovery: boolean
  ): Promise<InstalledPackageInfo> {
    this.updateOperation('APK 已传输完成，正在等待设备安装结果。安装期间可能没有进度回报，请保持连接，无需重复安装。', '设备安装', null)
    const installResult = await this.runStep(
      '安装 APK',
      ['shell', 'pm', 'install', ...installFlags, remotePath],
      {
        serial,
        timeoutMs: 180_000
      }
    )
    const installOutput = `${installResult.stdout}\n${installResult.stderr}`
    if (isConnectionFailure(installResult) && !/INSTALL_FAILED_|Failure\s*\[/i.test(installOutput)) {
      this.updateOperation('安装响应中断，正在恢复连接并核对设备中的 APK；不会重复执行安装。', '核对安装结果', null)
      await this.recoverInstallConnection(serial)
      const installedPath = await this.runStep('读取已安装 APK 路径', ['shell', 'pm', 'path', selected.info.packageName], { serial, timeoutMs: 10_000 })
      const paths = installedPath.stdout.trim().split(/\r?\n/)
      const path = paths.length === 1 ? paths[0]?.replace(/^package:/, '') : null
      if (this.adbExecutionFailed(installedPath) || !path || !/^\/data\/app\/[A-Za-z0-9_./=+~-]+\.apk$/.test(path) ||
          !(await this.remoteApkMatches(serial, path, selected))) {
        throw new AppError('安装响应中断，无法确认本次安装结果。', '已停止自动安装；请恢复稳定连接并刷新设备应用状态后再决定是否重试。')
      }
    } else if (installResult.exitCode !== 0 || !/\bSuccess\b/i.test(installOutput)) {
      const failedResult = { ...installResult, exitCode: installResult.exitCode || 1 }
      if (
        offerSignatureConflictRecovery &&
        /INSTALL_FAILED_UPDATE_INCOMPATIBLE/i.test(installOutput)
      ) {
        const friendly = mapAdbError(installOutput, '设备拒绝覆盖安装 APK。')
        throw new AppError(friendly.summary, friendly.suggestion, {
          kind: 'signature-conflict',
          commandId: 'app.replace',
          serial,
          apkToken: selected.info.token,
          packageName: selected.info.packageName
        })
      }
      this.assertSuccess(failedResult, '设备拒绝安装 APK。')
    }

    this.updateOperation('正在验证设备中的实际版本…', '安装验收', 92)
    const verified = await this.queryInstalledPackage(serial, selected.info.packageName, true)
    if (!verified.installed || verified.versionCode !== selected.info.versionCode) {
      throw new AppError(
        'ADB 已返回安装完成，但设备实际版本验收未通过。',
        `期望 versionCode ${selected.info.versionCode}，实际为 ${verified.versionCode ?? '未读取到'}。`
      )
    }

    this.patch({
      selectedDeviceApplication: null,
      compatibility: evaluateCompatibility(selected.info, device, verified)
    })
    await this.refreshPermissionCompatibility(serial, false)
    this.updateOperation('安装和版本验收已完成。', '完成', 100)
    return verified
  }

  private updateRootAccess(
    serial: string,
    mode: RootAccessMode,
    adbUid: number | null,
    suPath?: string | null
  ): void {
    const current = this.snapshot.selectedDevice
    if (!current || current.serial !== serial) return
    const updated: DeviceDetails = {
      ...current,
      adbUid,
      suPath: suPath === undefined ? current.suPath : suPath,
      rootAccessMode: mode
    }
    this.deviceDetailsCache.set(serial, updated)
    this.patch({ selectedDevice: updated })
  }

  private async establishRootAccess(serial: string): Promise<RootAccessMode> {
    const device = this.snapshot.selectedDevice
    if (!device || device.serial !== serial) {
      throw new AppError('无法读取设备构建信息。', '请重新连接设备后重试。')
    }

    if (device.rootAccessMode === 'adbd') {
      const identity = await this.runStep(
        '验证 adbd Root 身份',
        ['shell', 'id'],
        { serial, timeoutMs: 8_000 }
      )
      if (identity.exitCode === 0 && parseAdbUid(identity.stdout) === 0) return 'adbd'
      this.updateRootAccess(serial, 'none', parseAdbUid(identity.stdout))
    }

    const current = this.snapshot.selectedDevice ?? device
    const rootCandidate = this.snapshot.selectedDevice ?? current
    const standardAdbRootEligible =
      rootCandidate.debuggable === true &&
      (rootCandidate.buildType === 'userdebug' || rootCandidate.buildType === 'eng')
    let suPath = current.suPath ?? null
    let suChecked = false
    if (current.rootAccessMode === 'su' && current.suPath) {
      const identity = await this.runStep(
        '验证 su Root 通道',
        ['shell', current.suPath, '0', 'id'],
        { serial, timeoutMs: 8_000 }
      )
      if (identity.exitCode === 0 && parseAdbUid(identity.stdout) === 0) return 'su'
      this.updateRootAccess(serial, 'none', current.adbUid)
      suChecked = true
    }

    if (suPath && !suChecked) {
      this.updateOperation('检测到设备 su，正在验证 su 0 通道…', '验证 Root 通道', 20)
      const identity = await this.runStep(
        '优先验证设备 su Root',
        ['shell', suPath, '0', 'id'],
        { serial, timeoutMs: 10_000 }
      )
      suChecked = true
      if (identity.exitCode === 0 && parseAdbUid(identity.stdout) === 0) {
        this.updateRootAccess(serial, 'su', current.adbUid ?? 2000, suPath)
        this.updateSystemModificationCapability(serial, {
          state: 'possible',
          reason: 'su 0 Root 通道已经回读验证；已跳过可能不兼容的 adb root，执行系统级准备前仍会验证系统分区可写性。'
        })
        if (standardAdbRootEligible) {
          this.noteOperationWarning('检测到可用 su 0，已跳过可能导致设备端 adbd 重启的标准 adb root。')
        }
        return 'su'
      }
    }

    let adbRootFailure = ''

    if (standardAdbRootEligible) {
      this.updateOperation('正在尝试标准 adb root…', '验证 Root 通道', 25)
      const root = await this.runStep('尝试标准 ADB Root', ['root'], {
        serial,
        timeoutMs: 20_000
      })
      adbRootFailure = `${root.stdout}\n${root.stderr}`.trim()

      if (
        root.exitCode === 0 &&
        !/cannot run as root|production builds|not allowed|error/i.test(adbRootFailure)
      ) {
        const reconnectDeadline = Date.now() + 20_000
        let identity: AdbExecution
        do {
          if (serial.includes(':')) {
            await this.adb.run(['connect', serial], { timeoutMs: 5_000 })
          }
          identity = await this.runStep(
            '回读 adbd 身份',
            ['shell', 'id'],
            { serial, timeoutMs: 8_000 }
          )
          if (identity.exitCode === 0) break
          await delay(1_000)
        } while (Date.now() < reconnectDeadline)
        const adbUid = identity.exitCode === 0 ? parseAdbUid(identity.stdout) : null
        if (adbUid === 0) {
          this.updateRootAccess(serial, 'adbd', 0)
          return 'adbd'
        }
        this.updateRootAccess(serial, 'none', adbUid)
        adbRootFailure = `adb root 返回成功，但回读身份为 uid=${adbUid ?? '未知'}。`
      }
    } else {
      adbRootFailure = `标准 adb root 不适用：buildType=${rootCandidate.buildType ?? '-'}，ro.debuggable=${rootCandidate.debuggable === null ? '-' : Number(rootCandidate.debuggable)}。`
    }

    suPath = this.snapshot.selectedDevice?.suPath ?? suPath
    if (!suPath) {
      const lookup = await this.runStep(
        '查找设备 su',
        ['shell', 'command', '-v', 'su'],
        { serial, timeoutMs: 5_000 }
      )
      suPath = lookup.exitCode === 0 ? parseSuPath(lookup.stdout) : null
      this.updateRootAccess(serial, 'none', this.snapshot.selectedDevice?.adbUid ?? null, suPath)
    }

    if (suPath) {
      this.updateOperation('标准 adb root 未生效，正在验证设备 su 0 通道…', '验证 Root 通道', 60)
      const identity = await this.runStep(
        '验证设备 su Root',
        ['shell', suPath, '0', 'id'],
        { serial, timeoutMs: 10_000 }
      )
      if (identity.exitCode === 0 && parseAdbUid(identity.stdout) === 0) {
        this.updateRootAccess(serial, 'su', this.snapshot.selectedDevice?.adbUid ?? 2000, suPath)
        this.updateSystemModificationCapability(serial, {
          state: 'possible',
          reason: 'su 0 Root 通道已经回读验证；执行系统级准备前仍会验证系统分区可写性。'
        })
        if (standardAdbRootEligible) {
          this.noteOperationWarning('标准 adb root 未成功，已改用并验证 su 0 Root 通道。')
        }
        return 'su'
      }
      this.updateSystemModificationCapability(serial, {
        state: 'unavailable',
        reason: '设备虽然存在 su，但 ADB shell 无法通过 su 0 获得 Root 身份。'
      })
      throw new AppError(
        '设备存在 su，但 su 0 未获得 Root 身份。',
        `${adbRootFailure} su 路径=${suPath}；请确认该固件允许 ADB shell 调用 su 0，且不会要求设备端交互授权。`
      )
    }

    this.updateSystemModificationCapability(serial, {
      state: 'unavailable',
      reason: '当前固件不允许标准 adb root，且没有可供 ADB shell 调用的 su。'
    })
    throw new AppError(
      '当前设备没有可用的 Root 通道。',
      `${adbRootFailure} 同时未找到可供 ADB shell 调用的 su。需要厂商调试固件或预置可用的 su；工具不会刷机或破解 Root。`
    )
  }

  private async enableRootAccess(): Promise<WorkflowResult> {
    const serial = this.requireSerial()
    const mode = await this.establishRootAccess(serial)
    this.updateSystemModificationCapability(serial, {
      state: 'possible',
      reason:
        mode === 'adbd'
          ? 'adbd Root 已回读为 uid=0；执行系统级准备前仍会验证 Remount 和 /system 可写性。'
          : 'su 0 Root 已回读为 uid=0；执行系统级准备前仍会验证 Remount 和 /system 可写性。'
    })
    return mode === 'adbd'
      ? { summary: '已通过 shell id 回读验证 adbd Root（uid=0）。' }
      : {
          summary: '已通过 su 0 id 回读验证设备 Root 通道。',
          suggestion: 'adbd 仍以 shell 身份运行；后续系统分区操作会逐条通过 su 0 执行。'
        }
  }

  private rootShellArgs(serial: string, command: string[]): string[] {
    const device = this.snapshot.selectedDevice
    if (!device || device.serial !== serial) {
      throw new AppError('设备状态已变化。', '请重新选择设备并验证 Root 权限。')
    }
    if (device.rootAccessMode === 'adbd') return ['shell', ...command]
    if (device.rootAccessMode === 'su' && device.suPath) {
      return ['shell', device.suPath, '0', ...command]
    }
    throw new AppError('Root 通道尚未通过验证。', '请先执行“获取 Root 权限”。')
  }

  private async runRootStep(
    operation: string,
    serial: string,
    command: string[],
    timeoutMs = 30_000
  ): Promise<AdbExecution> {
    return this.runStep(operation, this.rootShellArgs(serial, command), {
      serial,
      timeoutMs
    })
  }

  private async runSystemRemount(
    serial: string,
    mode: RootAccessMode,
    afterOverlayReboot: boolean
  ): Promise<AdbExecution> {
    if (mode === 'adbd') {
      return this.runStep('Remount 系统分区', ['remount'], {
        serial,
        timeoutMs: 45_000
      })
    }
    return this.runRootStep(
      '通过 su Remount 系统分区',
      serial,
      ['/system/bin/remount', ...(afterOverlayReboot ? ['system'] : [])],
      45_000
    )
  }

  private async systemIsWritable(serial: string): Promise<boolean> {
    const writable = await this.runRootStep(
      '验证系统分区可写',
      serial,
      ['test', '-w', '/system'],
      10_000
    )
    return writable.exitCode === 0
  }

  private async remountSystem(serial: string): Promise<void> {
    let mode = await this.establishRootAccess(serial)
    this.updateOperation('正在将系统分区切换为可写…', '系统分区 Remount', 20)
    let remount = await this.runSystemRemount(serial, mode, false)
    const firstOutput = `${remount.stdout}\n${remount.stderr}`
    const overlayRebootRequired =
      remount.exitCode === 0 &&
      /now reboot|reboot.*(?:required|take effect)|reboot your device/i.test(firstOutput)

    if (overlayRebootRequired) {
      this.updateOperation('OverlayFS 已准备，正在执行首次重启…', 'OverlayFS 重启', 28)
      await this.sendRebootAndWait(serial)
      mode = await this.establishRootAccess(serial)
      remount = await this.runSystemRemount(serial, mode, true)
    }
    let writable = await this.systemIsWritable(serial)
    let directRemount: AdbExecution | null = null
    if (!writable) {
      this.updateOperation(
        '厂商 Remount 未使 /system 可写，正在尝试标准 mount 回退…',
        '系统分区 Remount 回退',
        32
      )
      directRemount = await this.runRootStep(
        '通过 mount 重挂系统分区',
        serial,
        ['mount', '-o', 'remount,rw', '/system'],
        30_000
      )
      writable = await this.systemIsWritable(serial)
    }
    if (writable && this.adbExecutionFailed(remount)) {
      this.noteOperationWarning('厂商 Remount 命令返回失败，但后续回退已使 /system 可写。')
    }
    if (writable && directRemount && this.adbExecutionFailed(directRemount)) {
      this.noteOperationWarning('mount 回退命令返回失败，但最终回读确认 /system 已可写。')
    }
    if (!writable) {
      const primaryOutput = `${remount.stdout}\n${remount.stderr}`.trim()
      const fallbackOutput = directRemount
        ? `${directRemount.stdout}\n${directRemount.stderr}`.trim()
        : '未执行'
      this.updateSystemModificationCapability(serial, {
        state: 'unavailable',
        reason:
          '厂商 Remount 与 mount -o remount,rw 均未使 /system 可写，当前固件不能通过此 ADB 路径修改系统应用。'
      })
      throw new AppError(
        '系统分区 Remount 后仍不可写。',
        `厂商 Remount：${primaryOutput || '无输出'}；mount 回退：${fallbackOutput || '无输出'}。请检查 overlayfs、verity 和系统分区空间；工具不会自动关闭 Verified Boot。`
      )
    }
    this.updateSystemModificationCapability(serial, {
      state: 'verified',
      reason: '已通过 Root、Remount 与 /system 可写性回读验证当前固件的系统级准备通道。'
    })
  }

  private async deploySystemApplication(
    deploymentMode: SystemDeploymentMode
  ): Promise<WorkflowResult> {
    const serial = this.requireSerial()
    const selected = this.requireApk()
    const packageName = selected.info.packageName
    const permissionReport = this.snapshot.permissionCompatibility
    if (
      deploymentMode === 'privileged' &&
      (!permissionReport || permissionReport.state !== 'ready')
    ) {
      throw new AppError(
        '当前设备的权限定义尚未可靠读取，已阻止特权部署。',
        '请保持设备在线并重新选择 APK，待设备权限定义读取完成后再试。'
      )
    }
    if (this.settings.getSystemDeployment(serial, packageName)) {
      throw new AppError('该应用已有工具托管的系统部署记录。', '请先执行“回滚系统应用部署”，再重新部署。')
    }
    const paths = managedSystemPaths(packageName, deploymentMode)
    const installation = await this.queryPackageInstallation(
      serial,
      packageName,
      true
    )
    const installedVersionCode = installation.installedPackage.versionCode
    if (
      installation.installedPackage.installed &&
      installedVersionCode !== null &&
      installedVersionCode > selected.info.versionCode
    ) {
      throw new AppError(
        '设备活动版本高于所选 APK，无法准备系统级权限。',
        `设备 versionCode=${installedVersionCode}，所选 APK versionCode=${selected.info.versionCode}。Android 会继续使用 /data/app 中的较高版本，写入较低版本系统副本后重启也不会降级。请改选与设备活动版本相同或更高的 APK。`
      )
    }
    const existingSystemDirectories = systemAppDirectories(installation).filter(
      (path) => path !== paths.appDirectory
    )
    if (installation.isSystem || existingSystemDirectories.length > 0) {
      throw new AppError(
        '设备已存在同包名的非托管系统副本，已阻止重复部署。',
        `检测到：${existingSystemDirectories.length > 0 ? existingSystemDirectories.join('、') : 'Package Manager 已标记 SYSTEM/UPDATED_SYSTEM_APP，但未返回受支持的系统目录'}。不能再创建 ${paths.appDirectory}，否则重启后的扫描优先级和回滚结果不可确定。请先使用“卸载应用”在高风险确认后彻底移除旧系统副本，再安装当前 APK 并重新准备权限；量产设备应改由固件工程师调整原系统目录。`
      )
    }

    await this.remountSystem(serial)

    const exists = await this.runRootStep(
      '检查系统应用部署目标',
      serial,
      ['test', '-e', paths.appDirectory],
      10_000
    )
    if (exists.exitCode === 0) {
      throw new AppError(
        '目标系统目录已经存在，工具不会覆盖。',
        `${paths.appDirectory} 不是本次工作流创建的空路径，请由固件工程师确认后处理。`
      )
    }

    const privilegedPermissions =
      deploymentMode === 'privileged' && permissionReport
        ? permissionReport.permissions
            .filter(({ protectionLevel }) =>
              protectionLevel.includes('privileged')
            )
            .map(({ name }) => name)
        : []
    const remoteApk = await this.transferApk(serial, selected)
    const tempDirectory = await mkdtemp(join(tmpdir(), 'adb-tool-system-'))
    const localAllowlist = join(tempDirectory, 'privapp-permissions.xml')
    const remoteAllowlist = `/data/local/tmp/adb-tool-${selected.info.token.slice(0, 12)}.xml`
    let allowlistCreated = false

    try {
      if (deploymentMode === 'privileged' && privilegedPermissions.length > 0) {
        const allowlistXml = privilegedAllowlistXml(packageName, privilegedPermissions)
        await writeFile(
          localAllowlist,
          allowlistXml,
          'utf8'
        )
        await this.transferFile(
          serial,
          localAllowlist,
          remoteAllowlist,
          '传输特权权限白名单',
          30_000,
          localAllowlist,
          Buffer.byteLength(allowlistXml, 'utf8')
        )
        allowlistCreated = true
      }

      const steps: Array<{ operation: string; args: string[] }> = [
        { operation: '创建系统应用目录', args: ['mkdir', '-p', paths.appDirectory] },
        { operation: '设置系统应用目录所有者', args: ['chown', '0:0', paths.appDirectory] },
        { operation: '设置系统应用目录权限', args: ['chmod', '0755', paths.appDirectory] },
        { operation: '写入系统应用 APK', args: ['cp', remoteApk, paths.apkPath] },
        { operation: '设置 APK 所有者', args: ['chown', '0:0', paths.apkPath] },
        { operation: '设置 APK 权限', args: ['chmod', '0644', paths.apkPath] }
      ]
      if (allowlistCreated && paths.allowlistPath) {
        steps.push(
          { operation: '写入特权权限白名单', args: ['cp', remoteAllowlist, paths.allowlistPath] },
          { operation: '设置白名单所有者', args: ['chown', '0:0', paths.allowlistPath] },
          { operation: '设置白名单权限', args: ['chmod', '0644', paths.allowlistPath] }
        )
      }
      steps.push({
        operation: '恢复 SELinux 文件上下文',
        args: [
          'restorecon',
          '-RF',
          paths.appDirectory,
          ...(allowlistCreated && paths.allowlistPath ? [paths.allowlistPath] : [])
        ]
      })

      // 在第一次写入系统分区前保存确定路径。后续任一步失败时，用户仍可通过托管记录安全回滚。
      this.settings.saveSystemDeployment({
        serial,
        packageName,
        versionCode: selected.info.versionCode,
        deploymentMode,
        appDirectory: paths.appDirectory,
        apkPath: paths.apkPath,
        allowlistPath: allowlistCreated ? paths.allowlistPath : null,
        createdAt: new Date().toISOString()
      })
      this.patch({
        systemDeployment: this.settings.getSystemDeployment(serial, packageName)
      })

      for (const [index, step] of steps.entries()) {
        this.updateOperation(step.operation, '写入系统分区', 30 + Math.round((index / steps.length) * 35))
        const result = await this.runRootStep(step.operation, serial, step.args)
        this.assertSuccess(result, `${step.operation}失败。`)
      }

      this.updateOperation('系统文件已写入，正在重启并验收…', '重启验收', 72)
      await this.sendRebootAndWait(serial)
      const verification = await this.runStep(
        '验证系统应用状态',
        ['shell', 'dumpsys', 'package', packageName],
        { serial, timeoutMs: 20_000 }
      )
      this.assertSuccess(verification, '无法回读特权应用状态。')
      const verifiedVersionCode = Number(
        /\bversionCode=(\d+)/.exec(verification.stdout)?.[1] ?? Number.NaN
      )
      if (
        !/\bpkgFlags=\[[^\]]*\bSYSTEM\b/i.test(verification.stdout) ||
        (deploymentMode === 'privileged' &&
          !/\bprivateFlags=\[[^\]]*\bPRIVILEGED\b/i.test(verification.stdout)) ||
        verifiedVersionCode !== selected.info.versionCode
      ) {
        throw new AppError(
          `系统重启完成，但应用未通过${deploymentMode === 'privileged' ? '特权' : '系统'}状态验收。`,
          `期望 versionCode ${selected.info.versionCode} 且具备 ${deploymentMode === 'privileged' ? 'SYSTEM/PRIVILEGED' : 'SYSTEM'} 标志，实际 versionCode ${Number.isNaN(verifiedVersionCode) ? '未读取到' : verifiedVersionCode}。工具已保留部署记录，请重新验证 Root 后执行回滚。`
        )
      }

      if (deploymentMode === 'privileged') {
        await this.refreshPermissionCompatibility(serial, true)
        const unresolvedPrivilegedPermissions =
          this.snapshot.permissionCompatibility?.permissions.filter(
            ({ authorization, protectionLevel }) =>
              protectionLevel.includes('privileged') &&
              authorization !== 'granted'
          ) ?? []
        if (unresolvedPrivilegedPermissions.length > 0) {
          throw new AppError(
            `应用已成为特权系统应用，但仍有 ${unresolvedPrivilegedPermissions.length} 项 privileged 权限未通过授予验收。`,
            `未通过：${unresolvedPrivilegedPermissions.map(({ name }) => name).join('、')}。工具已保留部署记录；请检查权限定义所在分区、厂商白名单策略和平台签名要求，或重新验证 Root 后回滚。`
          )
        }
      }
      return deploymentMode === 'privileged'
        ? {
            summary: `已将 ${packageName} 部署为特权系统应用并通过重启验收。`,
            suggestion:
              privilegedPermissions.length > 0
                ? `已生成包含 ${privilegedPermissions.length} 项权限的最小化 privapp allowlist。`
                : 'APK 未请求 privileged 权限，因此未生成 allowlist。'
          }
        : {
            summary: `已将 ${packageName} 部署为系统应用并通过重启验收。`,
            suggestion:
              '已采用 /system/app 路径；应用数据未清除。此模式只提供 SYSTEM 身份，不授予 PRIVILEGED 或平台签名权限。'
          }
    } finally {
      await this.cleanupTransferredApk(serial, remoteApk)
      const cleanupAllowlist = await this.runStep(
        '清理白名单临时文件',
        ['shell', 'rm', '-f', remoteAllowlist],
        { serial, timeoutMs: 10_000 },
        undefined,
        false
      )
      if (this.adbExecutionFailed(cleanupAllowlist)) {
        this.noteOperationWarning('清理设备端白名单临时文件的 ADB 命令未成功，请由技术人员确认残留文件。')
      }
      await rm(tempDirectory, { recursive: true, force: true })
    }
  }

  private async rollbackSystemApplication(): Promise<WorkflowResult> {
    const serial = this.requireSerial()
    const packageName = this.requireTargetPackageName()
    const record = this.settings.getSystemDeployment(serial, packageName)
    if (!record) {
      throw new AppError('没有该应用的工具托管部署记录。', '工具不会删除来源不明的系统文件。')
    }
    const expected = managedSystemPaths(packageName, record.deploymentMode)
    if (
      record.appDirectory !== expected.appDirectory ||
      record.apkPath !== expected.apkPath ||
      record.allowlistPath !== expected.allowlistPath
    ) {
      throw new AppError('系统应用部署记录路径校验失败。', '为避免误删系统文件，已拒绝回滚。')
    }

    await this.remountSystem(serial)
    const targets = [
      record.appDirectory,
      ...(record.allowlistPath ? [record.allowlistPath] : [])
    ]
    for (const target of targets) {
      const result = await this.runRootStep(
        '删除工具托管的系统部署文件',
        serial,
        ['rm', '-rf', target]
      )
      this.assertSuccess(result, `无法删除 ${target}。`)
    }
    this.updateOperation('托管文件已删除，正在重启并验收…', '回滚重启', 70)
    await this.sendRebootAndWait(serial)
    const verification = await this.runStep(
      '验证系统部署文件已移除',
      ['shell', 'test', '!', '-e', record.appDirectory],
      { serial, timeoutMs: 10_000 }
    )
    this.assertSuccess(verification, '回滚后系统目录仍然存在。')
    const installationAfterRollback = await this.queryPackageInstallation(
      serial,
      packageName,
      true
    )
    const installedAfterRollback = installationAfterRollback.installedPackage
    const remainingSystemDirectories = systemAppDirectories(
      installationAfterRollback
    )
    const remainsSystem =
      installationAfterRollback.isSystem || remainingSystemDirectories.length > 0
    this.settings.removeSystemDeployment(serial, packageName)
    this.patch({ systemDeployment: null })
    return {
      summary: `已移除 ${packageName} 的工具托管${record.deploymentMode === 'privileged' ? '特权' : '系统应用'}部署并完成重启验收。`,
      suggestion:
        remainsSystem
          ? `工具托管路径已删除；设备仍有其他系统副本${remainingSystemDirectories.length > 0 ? `：${remainingSystemDirectories.join('、')}` : ''}，因此 SYSTEM 身份会保留。本次回滚不会删除来源不明的固件文件。`
          : installedAfterRollback.installed
            ? '设备中的 /data/app 版本仍保留，可继续作为普通应用使用。'
          : '设备中没有保留普通安装版本；如需继续使用，请重新安装 APK。'
    }
  }

  private async cleanupTransferredApk(serial: string, remotePath: string): Promise<void> {
    const result = await this.runStep(
      '清理安装临时文件',
      ['shell', 'rm', '-f', remotePath],
      { serial, timeoutMs: 15_000 },
      undefined,
      false
    )
    if (this.adbExecutionFailed(result)) {
      this.noteOperationWarning('清理设备端 APK 临时文件的 ADB 命令未成功，请由技术人员确认残留文件。')
    }
  }

  private async launchApplication(): Promise<WorkflowResult> {
    const packageName = this.requireTargetPackageName()
    const component = this.targetLaunchComponent() ?? this.targetHomeComponent()
    if (!component) {
      throw new AppError(
        '未识别到可启动 Activity。',
        '请确认应用声明了可导出的 MAIN/LAUNCHER 或 HOME Activity。'
      )
    }
    try {
      return await this.executeShell(
        '启动应用',
        ['am', 'start', '-n', component],
        '目标应用已启动。'
      )
    } catch (error) {
      if (error instanceof AppError) {
        throw new AppError(
          `${error.message}（包名：${packageName}）`,
          `启动组件：${component}。${error.suggestion}`
        )
      }
      throw error
    }
  }

  private async stopApplication(): Promise<WorkflowResult> {
    const packageName = this.requireTargetPackageName()
    return this.executeShell(
      '停止应用',
      ['am', 'force-stop', packageName],
      '目标应用已停止。'
    )
  }

  private async restartApplication(): Promise<WorkflowResult> {
    await this.stopApplication()
    this.updateOperation('正在重新启动应用…', '启动应用', 65)
    await this.launchApplication()
    return { summary: '目标应用已重启。' }
  }

  private async uninstallApplication(): Promise<WorkflowResult> {
    const serial = this.requireSerial()
    const packageName = this.requireTargetPackageName()
    let installation = await this.queryPackageInstallation(
      serial,
      packageName,
      true
    )
    if (!installation.installedPackage.installed) {
      throw new AppError(
        '目标应用已经不在当前用户的安装列表中。',
        '请重新读取设备应用状态；如它仍是固件系统包，需要从“显示已卸载包”的系统诊断入口处理。'
      )
    }

    const currentHome = await this.queryCurrentHome(serial, true)
    if (packageFromComponent(currentHome) === packageName) {
      throw new AppError(
        '目标应用当前是设备的默认桌面，不能直接卸载。',
        '请先在设备系统设置中选择其他默认桌面，并确认 Home 键可以进入该桌面，再重新卸载。'
      )
    }

    const directSystemDirectory = activeSystemAppDirectory(installation)
    if (directSystemDirectory) {
      return this.uninstallSystemApplication(serial, packageName, installation)
    }
    const activePath =
      installation.packagePaths[0] ?? installation.activeCodePath
    if (
      installation.isSystem &&
      (!activePath || !activePath.startsWith('/data/'))
    ) {
      throw new AppError(
        '检测到系统应用，但活动路径不在受支持的系统分区。',
        `活动路径：${activePath ?? '未读取到'}。工具只自动删除 /system/app 与 /system/priv-app 中经过包名复核的目录；/product、/vendor、/system_ext 等分区必须交由固件工程师处理。`
      )
    }
    let systemRemovalPrepared = false
    if (
      activePath?.startsWith('/data/') &&
      (installation.isSystem || systemAppDirectories(installation).length > 0)
    ) {
      await this.remountSystem(serial)
      systemRemovalPrepared = true
    }

    const result = await this.runStep(
      '卸载应用',
      ['uninstall', packageName],
      { serial, timeoutMs: 120_000 }
    )
    const output = `${result.stdout}\n${result.stderr}`
    if (result.exitCode !== 0 || !/\bSuccess\b/i.test(output)) {
      this.assertSuccess({ ...result, exitCode: result.exitCode || 1 }, '应用卸载失败。')
    }

    installation = await this.queryPackageInstallation(serial, packageName, true)
    if (installation.installedPackage.installed) {
      if (
        installation.isSystem ||
        systemAppDirectories(installation).length > 0
      ) {
        this.updateOperation(
          '已移除 /data/app 更新，检测到固件系统副本，正在继续彻底卸载…',
          '卸载系统应用',
          30
        )
        return this.uninstallSystemApplication(
          serial,
          packageName,
          installation,
          systemRemovalPrepared
        )
      }
      throw new AppError(
        '卸载命令返回成功，但目标应用仍然处于安装状态。',
        '设备可能存在其他 Android 用户或厂商包管理扩展；工具已停止，避免误删未知路径。'
      )
    }

    await this.refreshSelectedContext(false)
    await this.refreshPermissionCompatibility(serial, false)
    return { summary: '目标应用已卸载，应用数据已一并清除。' }
  }

  private async uninstallSystemApplication(
    serial: string,
    packageName: string,
    installation: PackageInstallationDetails,
    systemRemovalPrepared = false
  ): Promise<WorkflowResult> {
    const firmwareDirectories = systemAppDirectories(installation)
    if (firmwareDirectories.length === 0) {
      throw new AppError(
        '检测到系统应用身份，但无法验证可安全删除的系统目录。',
        '仅支持由 Package Manager 明确回读到 /system/app/<目录> 或 /system/priv-app/<目录> 的应用；其他分区请由固件工程师处理。'
      )
    }

    const managedRecord = this.settings.getSystemDeployment(serial, packageName)
    const managedDirectories: string[] = []
    let managedAllowlist: string | null = null
    if (managedRecord) {
      const expected = managedSystemPaths(
        packageName,
        managedRecord.deploymentMode
      )
      if (
        managedRecord.appDirectory !== expected.appDirectory ||
        managedRecord.apkPath !== expected.apkPath ||
        managedRecord.allowlistPath !== expected.allowlistPath
      ) {
        throw new AppError(
          '系统应用部署记录路径校验失败。',
          '为避免误删系统文件，已停止卸载。请先由技术支持核对工具托管记录。'
        )
      }
      managedDirectories.push(managedRecord.appDirectory)
      managedAllowlist = managedRecord.allowlistPath
    }
    const systemDirectories = [
      ...new Set([...firmwareDirectories, ...managedDirectories])
    ]

    if (!systemRemovalPrepared) {
      await this.remountSystem(serial)
    }
    const metadata = await this.runStep(
      '删除前复核系统应用路径',
      ['shell', 'dumpsys', 'package', packageName],
      { serial, timeoutMs: 20_000 }
    )
    this.assertSuccess(metadata, '无法在删除前复核系统应用路径。')
    const confirmedDirectories = new Set(
      systemAppDirectories(parsePackageInstallation('', metadata.stdout))
    )
    const unconfirmedFirmwareDirectory = firmwareDirectories.find(
      (path) => !confirmedDirectories.has(path)
    )
    if (unconfirmedFirmwareDirectory) {
      throw new AppError(
        '系统应用路径在删除前发生变化，已停止写入。',
        `Package Manager 不再确认 ${unconfirmedFirmwareDirectory} 属于 ${packageName}；尚未清除数据或删除系统文件。`
      )
    }

    this.updateOperation(
      '正在停止系统应用并清除当前用户数据…',
      '清除系统应用数据',
      40
    )
    const stop = await this.runStep(
      '停止系统应用',
      ['shell', 'am', 'force-stop', packageName],
      { serial, timeoutMs: 15_000 }
    )
    this.assertSuccess(stop, '无法停止系统应用。')

    const clear = await this.runStep(
      '清除系统应用数据',
      ['shell', 'pm', 'clear', packageName],
      { serial, timeoutMs: 30_000 }
    )
    if (
      clear.exitCode !== 0 ||
      !/\bSuccess\b/i.test(`${clear.stdout}\n${clear.stderr}`)
    ) {
      this.assertSuccess(
        { ...clear, exitCode: clear.exitCode || 1 },
        '系统应用数据清除失败。'
      )
    }

    const userUninstall = await this.runStep(
      '从用户 0 卸载系统应用',
      ['shell', 'pm', 'uninstall', '--user', '0', packageName],
      { serial, timeoutMs: 60_000 }
    )
    if (
      userUninstall.exitCode !== 0 ||
      !/\bSuccess\b/i.test(
        `${userUninstall.stdout}\n${userUninstall.stderr}`
      )
    ) {
      this.assertSuccess(
        { ...userUninstall, exitCode: userUninstall.exitCode || 1 },
        '无法从用户 0 卸载系统应用。'
      )
    }

    for (const directory of systemDirectories) {
      const remove = await this.runRootStep(
        '删除系统应用目录',
        serial,
        ['rm', '-rf', directory],
        60_000
      )
      this.assertSuccess(remove, `无法删除 ${directory}。`)
    }
    if (managedAllowlist) {
      const removeAllowlist = await this.runRootStep(
        '删除工具托管的特权白名单',
        serial,
        ['rm', '-f', managedAllowlist],
        30_000
      )
      this.assertSuccess(removeAllowlist, `无法删除 ${managedAllowlist}。`)
    }
    const sync = await this.runRootStep(
      '同步系统分区写入',
      serial,
      ['sync'],
      30_000
    )
    this.assertSuccess(sync, '系统应用删除结果无法同步到存储。')

    for (const directory of systemDirectories) {
      const removed = await this.runRootStep(
        '验证系统应用目录已删除',
        serial,
        ['test', '!', '-e', directory],
        10_000
      )
      this.assertSuccess(removed, `删除后 ${directory} 仍然存在。`)
    }

    this.updateOperation(
      '系统应用文件已删除，正在重启并核验包注册信息…',
      '重启验收',
      76
    )
    await this.sendRebootAndWait(serial)
    const packageList = await this.runStep(
      '验证系统应用包记录已移除',
      ['shell', 'pm', 'list', 'packages', '-u', packageName],
      { serial, timeoutMs: 20_000 }
    )
    this.assertSuccess(packageList, '无法验证系统应用包记录。')
    const packageStillKnown = packageList.stdout
      .split(/\r?\n/)
      .some((line) => line.trim() === `package:${packageName}`)
    if (packageStillKnown) {
      throw new AppError(
        '已删除确认过的系统目录，但 Package Manager 仍保留该应用。',
        '设备可能还存在 /product、/vendor 或 /system_ext 中的同包名副本。工具不会删除未验证分区，请交由固件工程师检查。'
      )
    }
    for (const directory of systemDirectories) {
      const removed = await this.runStep(
        '重启后验证系统应用目录',
        ['shell', 'test', '!', '-e', directory],
        { serial, timeoutMs: 10_000 }
      )
      this.assertSuccess(removed, `重启后 ${directory} 再次出现。`)
    }

    if (managedRecord) {
      this.settings.removeSystemDeployment(serial, packageName)
      this.patch({ systemDeployment: null })
    }
    await this.refreshSelectedContext(false)
    await this.refreshPermissionCompatibility(serial, false)
    return {
      summary: `已永久删除系统应用 ${packageName}，清除用户数据并完成重启验收。`,
      suggestion: `已删除：${systemDirectories.join('、')}。恢复该系统应用需要重新安装 APK 或刷入包含它的固件。`
    }
  }

  private async clearApplicationData(): Promise<WorkflowResult> {
    const serial = this.requireSerial()
    const packageName = this.requireTargetPackageName()
    const result = await this.runStep(
      '清除应用数据',
      ['shell', 'pm', 'clear', packageName],
      { serial, timeoutMs: 30_000 }
    )
    const output = `${result.stdout}\n${result.stderr}`
    if (result.exitCode !== 0 || !/\bSuccess\b/i.test(output)) {
      this.assertSuccess({ ...result, exitCode: result.exitCode || 1 }, '清除应用数据失败。')
    }
    await this.refreshSelectedContext(false)
    return { summary: '目标应用的全部数据已清除。' }
  }

  private async setLauncher(): Promise<WorkflowResult> {
    const serial = this.requireSerial()
    const packageName = this.requireTargetPackageName()
    const target = this.targetHomeComponent()
    const home = this.targetHomeActivities().find(({ component }) => component === target)
    if (!target || !home?.exported) {
      throw new AppError(
        '没有可用的 HOME Activity。',
        '目标应用必须声明 MAIN、HOME、DEFAULT，并将对应 Activity 的 exported 设为 true。'
      )
    }

    const installed = await this.queryInstalledPackage(serial, packageName, true)
    if (!installed.installed) {
      throw new AppError('目标应用尚未安装到设备。', '请先执行“安装 / 更新”。')
    }

    const current = await this.queryCurrentHome(serial, true)
    if (!current) {
      throw new AppError('无法读取当前系统桌面。', '为避免无法恢复，已取消 Launcher 设置。')
    }
    const storedOriginal = this.settings.getOriginalLauncher(serial)
    if (!componentsEqual(current, target) && !storedOriginal) {
      this.settings.saveOriginalLauncher(serial, current)
    }
    if (componentsEqual(current, target) && !storedOriginal) {
      throw new AppError(
        '目标应用已经是当前桌面，但没有原系统桌面记录。',
        '无法安全创建恢复点；请由技术支持确认原 Launcher 后再处理。'
      )
    }

    this.updateOperation('正在设置默认桌面…', '设置 Launcher', 45)
    const setResult = await this.runStep(
      '设置 Launcher',
      ['shell', 'cmd', 'package', 'set-home-activity', '--user', '0', target],
      { serial, timeoutMs: 30_000 }
    )
    this.assertSuccess(setResult, '系统拒绝设置默认 Launcher。')
    const homeKey = await this.runStep(
      '模拟 Home 验证',
      ['shell', 'input', 'keyevent', 'KEYCODE_HOME'],
      { serial, timeoutMs: 10_000 }
    )
    this.assertSuccess(homeKey, '模拟 Home 键失败。')
    await delay(500)
    const verified = await this.queryCurrentHome(serial, true)
    this.patch({ launcher: this.launcherState(serial, verified) })
    if (!componentsEqual(verified, target)) {
      throw new AppError(
        'Launcher 设置命令已执行，但当前 HOME 验证不一致。',
        `期望 ${target}，实际 ${verified ?? '未读取到'}。`
      )
    }
    return { summary: `已将 ${this.targetDisplayName()} 设为默认桌面和开机应用。` }
  }

  private async verifyLauncher(): Promise<WorkflowResult> {
    const serial = this.requireSerial()
    const target = this.targetHomeComponent()
    if (!target) {
      throw new AppError('未选择有效 HOME Activity。', '请先选择 APK 中可导出的 HOME Activity。')
    }
    const current = await this.queryCurrentHome(serial, true)
    this.patch({ launcher: this.launcherState(serial, current) })
    if (!componentsEqual(current, target)) {
      throw new AppError(
        '当前开机应用验证失败。',
        `期望 ${target}，实际 ${current ?? '未读取到 HOME'}。`
      )
    }
    return { summary: '开机应用验证通过，当前默认 HOME 与目标应用一致。' }
  }

  private async rebootAndVerifyLauncher(): Promise<WorkflowResult> {
    const serial = this.requireSerial()
    const target = this.targetHomeComponent()
    if (!target) {
      throw new AppError('未选择有效 HOME Activity。', '请先完成 Launcher 设置。')
    }
    await this.sendRebootAndWait(serial)
    this.updateOperation('设备已重连，正在验证默认桌面…', 'Launcher 验证', 92)
    const current = await this.queryCurrentHome(serial, true)
    this.patch({ launcher: this.launcherState(serial, current) })
    if (!componentsEqual(current, target)) {
      throw new AppError(
        '设备重启完成，但开机应用验证失败。',
        `期望 ${target}，实际 ${current ?? '未读取到 HOME'}。`
      )
    }
    return { summary: '设备已重启并重新连接，开机应用验证通过。' }
  }

  private async restoreLauncher(): Promise<WorkflowResult> {
    const serial = this.requireSerial()
    const original = this.settings.getOriginalLauncher(serial)
    if (!original) {
      throw new AppError('没有该设备的原系统桌面记录。', '为避免设备无桌面，已禁止盲目恢复。')
    }
    const result = await this.runStep(
      '恢复系统桌面',
      ['shell', 'cmd', 'package', 'set-home-activity', '--user', '0', original],
      { serial, timeoutMs: 30_000 }
    )
    this.assertSuccess(result, '系统拒绝恢复原 Launcher。')
    const homeKey = await this.runStep(
      '打开原系统桌面',
      ['shell', 'input', 'keyevent', 'KEYCODE_HOME'],
      { serial, timeoutMs: 10_000 }
    )
    this.assertSuccess(homeKey, '打开原系统桌面失败。')
    await delay(500)
    const current = await this.queryCurrentHome(serial, true)
    this.patch({ launcher: this.launcherState(serial, current) })
    if (!componentsEqual(current, original)) {
      throw new AppError(
        '恢复命令已执行，但当前 HOME 验证不一致。',
        `期望恢复 ${original}，实际 ${current ?? '未读取到 HOME'}。`
      )
    }
    return { summary: `已恢复原系统桌面 ${original}。` }
  }

  private async rebootDevice(): Promise<WorkflowResult> {
    const serial = this.requireSerial()
    await this.sendRebootAndWait(serial)
    await this.refreshSelectedContext(false)
    return { summary: '设备已重启并重新连接。' }
  }

  private async sendRebootAndWait(serial: string): Promise<void> {
    this.updateOperation('正在发送重启命令…', '重启设备', 15)
    const reboot = await this.runStep('重启设备', ['reboot'], {
      serial,
      timeoutMs: 15_000
    })
    this.assertSuccess(reboot, '设备重启命令执行失败。')

    const disconnectedDeadline = Date.now() + 30_000
    let sawDisconnect = false
    while (Date.now() < disconnectedDeadline) {
      await delay(1_500)
      const state = await this.adb.run(['get-state'], { serial, timeoutMs: 4_000 })
      if (state.exitCode !== 0 || state.stdout.trim() !== 'device') {
        sawDisconnect = true
        break
      }
    }
    if (!sawDisconnect) {
      throw new AppError('未检测到设备进入重启断开状态。', '请查看触摸屏是否实际开始重启。')
    }

    this.updateOperation('设备正在重启，等待重新连接…', '等待设备', 45)
    const reconnectDeadline = Date.now() + 150_000
    let connected = false
    while (Date.now() < reconnectDeadline) {
      if (serial.includes(':')) {
        await this.adb.run(['connect', serial], { timeoutMs: 5_000 })
      }
      const state = await this.adb.run(['get-state'], { serial, timeoutMs: 5_000 })
      if (state.exitCode === 0 && state.stdout.trim() === 'device') {
        connected = true
        break
      }
      await delay(2_000)
    }
    if (!connected) {
      throw new AppError(
        '设备重启后未在规定时间内重新连接。',
        serial.includes(':') ? '请确认设备 IP 未变化并重新建立 TCP/IP 连接。' : '请检查 USB 连接和调试授权。'
      )
    }

    this.updateOperation('设备已连接，等待系统启动完成…', '等待 Android 启动', 75)
    const bootDeadline = Date.now() + 90_000
    let bootCompleted = false
    while (Date.now() < bootDeadline) {
      const boot = await this.adb.run(['shell', 'getprop', 'sys.boot_completed'], {
        serial,
        timeoutMs: 5_000
      })
      if (boot.exitCode === 0 && boot.stdout.trim() === '1') {
        bootCompleted = true
        break
      }
      await delay(2_000)
    }
    if (!bootCompleted) {
      throw new AppError(
        '设备已重新连接，但 Android 系统未在规定时间内完成启动。',
        '请查看触摸屏启动画面，待系统稳定后再执行验证。'
      )
    }
    this.deviceDetailsCache.delete(serial)
    await this.refreshDevices(true)
  }

  private async queryInstalledPackage(
    serial: string,
    packageName: string,
    recordLogs: boolean
  ): Promise<InstalledPackageInfo> {
    return (
      await this.queryPackageInstallation(serial, packageName, recordLogs)
    ).installedPackage
  }

  private async queryPackageInstallation(
    serial: string,
    packageName: string,
    recordLogs: boolean
  ): Promise<PackageInstallationDetails> {
    const pathResult = await this.runStep(
      '查询应用安装状态',
      ['shell', 'pm', 'path', packageName],
      { serial, timeoutMs: 15_000 },
      undefined,
      recordLogs
    )
    const output = `${pathResult.stdout}\n${pathResult.stderr}`
    const packageMissing =
      output.trim() === '' ||
      /not found|unknown package|unable to find package|does not exist/i.test(output)
    if (this.adbExecutionFailed(pathResult) && !packageMissing) {
      this.assertSuccess(pathResult, '无法查询设备中的应用状态。')
    }
    const dumpsys = await this.runStep(
      '查询应用安装详情',
      ['shell', 'dumpsys', 'package', packageName],
      { serial, timeoutMs: 20_000 },
      undefined,
      recordLogs
    )
    if (this.adbExecutionFailed(dumpsys) && /^package:/m.test(pathResult.stdout)) {
      this.assertSuccess(dumpsys, '无法读取设备中的应用安装详情。')
    }
    return parsePackageInstallation(pathResult.stdout, dumpsys.stdout)
  }

  private async queryDeviceApplication(
    serial: string,
    packageName: string,
    recordLogs: boolean,
    knownInstalled?: InstalledPackageInfo
  ): Promise<DeviceApplicationInfo | null> {
    const installed =
      knownInstalled ?? await this.queryInstalledPackage(serial, packageName, recordLogs)
    if (!installed.installed) return null

    const launchResult = await this.runStep(
      '查询应用启动组件',
      [
        'shell',
        'cmd',
        'package',
        'resolve-activity',
        '--brief',
        '--components',
        '--user',
        '0',
        '-a',
        'android.intent.action.MAIN',
        '-c',
        'android.intent.category.LAUNCHER',
        '-p',
        packageName
      ],
      { serial, timeoutMs: 15_000 },
      undefined,
      recordLogs
    )
    const launchComponent =
      launchResult.exitCode === 0 ? parseComponents(launchResult.stdout).at(-1) ?? null : null
    if (this.adbExecutionFailed(launchResult)) {
      this.noteOperationWarning('查询应用启动组件的 ADB 命令未成功。')
    }

    const homeResult = await this.runStep(
      '查询应用 HOME 组件',
      [
        'shell',
        'cmd',
        'package',
        'query-activities',
        '--brief',
        '--components',
        '--user',
        '0',
        '-a',
        'android.intent.action.MAIN',
        '-c',
        'android.intent.category.HOME',
        '-p',
        packageName
      ],
      { serial, timeoutMs: 15_000 },
      undefined,
      recordLogs
    )
    const homeComponents =
      homeResult.exitCode === 0 ? parseComponents(homeResult.stdout) : []
    if (this.adbExecutionFailed(homeResult)) {
      this.noteOperationWarning('查询应用 HOME 组件的 ADB 命令未成功。')
    }
    const permissionsResult = await this.runStep(
      '读取应用请求权限',
      ['shell', 'dumpsys', 'package', packageName],
      { serial, timeoutMs: 20_000 },
      undefined,
      recordLogs,
      12_000
    )
    if (this.adbExecutionFailed(permissionsResult)) {
      this.noteOperationWarning('读取应用请求权限的 ADB 命令未成功。')
    }
    const homeActivities = homeComponents.map(activityFromComponent)
    const currentHome = this.snapshot.launcher.currentComponent
    const selectedHomeComponent =
      homeComponents.find((component) => componentsEqual(component, currentHome)) ??
      homeComponents[0] ??
      null

    return {
      serial,
      packageName,
      versionName: installed.versionName,
      versionCode: installed.versionCode,
      declaredPermissions:
        permissionsResult.exitCode === 0 && !permissionsResult.timedOut
          ? parseRequestedPermissions(permissionsResult.stdout)
          : [],
      permissionInspectionError:
        permissionsResult.exitCode === 0 && !permissionsResult.timedOut
          ? null
          : permissionsResult.timedOut
            ? '读取设备应用请求权限超时。'
            : `${permissionsResult.stdout}\n${permissionsResult.stderr}`.trim() ||
              '设备未返回应用请求权限。',
      launchActivity: launchComponent ? activityFromComponent(launchComponent) : null,
      homeActivities,
      selectedHomeComponent
    }
  }

  private async queryDeviceApplicationCandidates(
    serial: string,
    recordLogs: boolean
  ): Promise<DeviceApplicationCandidate[]> {
    const queryActivities = (
      label: string,
      category: 'android.intent.category.LAUNCHER' | 'android.intent.category.HOME'
    ): Promise<AdbExecution> =>
      this.runStep(
        label,
        [
          'shell',
          'cmd',
          'package',
          'query-activities',
          '--brief',
          '--components',
          '--user',
          '0',
          '-a',
          'android.intent.action.MAIN',
          '-c',
          category
        ],
        { serial, timeoutMs: 20_000 },
        undefined,
        recordLogs
      )

    const [launchResult, homeResult] = await Promise.all([
      queryActivities('查询可启动应用', 'android.intent.category.LAUNCHER'),
      queryActivities('查询桌面应用', 'android.intent.category.HOME')
    ])
    this.assertSuccess(launchResult, '无法读取设备可启动应用列表。')
    this.assertSuccess(homeResult, '无法读取设备桌面应用列表。')

    const applications = new Map<
      string,
      {
        launchActivities: ApkInfo['homeActivities']
        homeActivities: ApkInfo['homeActivities']
      }
    >()
    const getCandidate = (
      packageName: string
    ): {
      launchActivities: ApkInfo['homeActivities']
      homeActivities: ApkInfo['homeActivities']
    } => {
      const existing = applications.get(packageName)
      if (existing) return existing
      const created = { launchActivities: [], homeActivities: [] }
      applications.set(packageName, created)
      return created
    }

    for (const component of parseComponents(launchResult.stdout)) {
      const packageName = packageFromComponent(component)
      if (packageName) getCandidate(packageName).launchActivities.push(activityFromComponent(component))
    }
    for (const component of parseComponents(homeResult.stdout)) {
      const packageName = packageFromComponent(component)
      if (packageName) getCandidate(packageName).homeActivities.push(activityFromComponent(component))
    }

    const currentHome = this.snapshot.launcher.currentComponent
    return [...applications.entries()]
      .map(([packageName, activities]) => ({
        packageName,
        launchActivity: activities.launchActivities[0] ?? null,
        homeActivities: activities.homeActivities,
        isCurrentHome: activities.homeActivities.some(({ component }) =>
          componentsEqual(component, currentHome)
        )
      }))
      .sort((left, right) => {
        if (left.isCurrentHome !== right.isCurrentHome) return left.isCurrentHome ? -1 : 1
        if ((left.homeActivities.length > 0) !== (right.homeActivities.length > 0)) {
          return left.homeActivities.length > 0 ? -1 : 1
        }
        return left.packageName.localeCompare(right.packageName, 'en')
      })
  }

  private async queryForegroundComponent(
    serial: string,
    recordLogs: boolean
  ): Promise<string | null> {
    const activities = await this.runStep(
      '查询当前前台 Activity',
      ['shell', 'dumpsys', 'activity', 'activities'],
      { serial, timeoutMs: 20_000 },
      undefined,
      recordLogs
    )
    if (!this.adbExecutionFailed(activities)) {
      const component = parseForegroundComponent(activities.stdout)
      if (component) return component
    } else {
      this.noteOperationWarning('读取当前前台 Activity 的 ADB 命令未成功，已改用窗口信息回读。')
    }

    const windows = await this.runStep(
      '查询当前前台窗口',
      ['shell', 'dumpsys', 'window', 'windows'],
      { serial, timeoutMs: 20_000 },
      undefined,
      recordLogs
    )
    if (this.adbExecutionFailed(windows)) {
      this.assertSuccess(windows, '无法查询设备当前前台应用。')
    }
    return parseForegroundComponent(windows.stdout)
  }

  private async queryCurrentHome(serial: string, recordLogs: boolean): Promise<string | null> {
    const result = await this.runStep(
      '查询当前 Launcher',
      ['shell', ...HOME_RESOLVE_ARGS],
      { serial, timeoutMs: 15_000 },
      undefined,
      recordLogs
    )
    if (this.adbExecutionFailed(result)) {
      this.noteOperationWarning('查询当前 Launcher 的 ADB 命令未成功，当前桌面状态可能不完整。')
      return null
    }
    return parseHomeComponent(result.stdout)
  }

  private requireSerial(): string {
    const serial = this.snapshot.selectedSerial
    if (!serial) {
      throw new AppError('尚未锁定目标设备。', '请明确选择要操作的触摸屏。')
    }
    return serial
  }

  private activateDeviceApplication(
    serial: string,
    application: DeviceApplicationInfo
  ): void {
    this.selectedApkFile = null
    this.settings.saveManagedPackage(serial, application.packageName)
    this.patch({
      selectedApk: null,
      selectedDeviceApplication: application,
      compatibility: null,
      permissionCompatibility: evaluatePermissionCompatibility(
        application.declaredPermissions,
        {
          serial,
          deviceApiLevel:
            this.snapshot.selectedDevice?.serial === serial
              ? this.snapshot.selectedDevice.apiLevel
              : null,
          systemModification: this.systemModificationCapability(serial),
          inspectionError: application.permissionInspectionError
        }
      )
    })
  }

  private targetPackageName(): string | null {
    return (
      this.snapshot.selectedApk?.packageName ??
      this.snapshot.selectedDeviceApplication?.packageName ??
      null
    )
  }

  private requireTargetPackageName(): string {
    const packageName = this.targetPackageName()
    if (!packageName) {
      throw new AppError(
        '尚未指定目标应用。',
        '请输入包名读取设备中的已安装应用，或选择并解析 APK。'
      )
    }
    return packageName
  }

  private targetLaunchComponent(): string | null {
    return (
      this.snapshot.selectedDeviceApplication?.launchActivity?.component ??
      this.snapshot.selectedApk?.launchActivity?.component ??
      null
    )
  }

  private targetHomeActivities(): ApkInfo['homeActivities'] {
    return (
      this.snapshot.selectedDeviceApplication?.homeActivities ??
      this.snapshot.selectedApk?.homeActivities ??
      []
    )
  }

  private targetHomeComponent(): string | null {
    return (
      this.snapshot.selectedDeviceApplication?.selectedHomeComponent ??
      this.snapshot.selectedApk?.selectedHomeComponent ??
      null
    )
  }

  private targetDisplayName(): string {
    return (
      this.snapshot.selectedApk?.appName ??
      this.snapshot.selectedDeviceApplication?.packageName ??
      '目标应用'
    )
  }

  private requireApk(): InspectedApk {
    if (!this.selectedApkFile) {
      throw new AppError('尚未选择 APK。', '请先选择并解析目标 APK。')
    }
    return this.selectedApkFile
  }

  private assertSuccess(result: AdbExecution, fallback: string): void {
    if (!this.adbExecutionFailed(result)) return
    const output = `${result.stdout}\n${result.stderr}`
    const friendly = result.timedOut
      ? {
          summary: `${fallback}操作已超时。`,
          suggestion: '请确认设备仍在线，然后重试。'
        }
      : mapAdbError(output, fallback)
    throw new AppError(friendly.summary, friendly.suggestion)
  }

  private adbExecutionFailed(result: AdbExecution): boolean {
    if (result.exitCode !== 0 || result.timedOut) return true
    const output = `${result.stderr}\n${result.stdout}`
    return (
      /(?:^|\r?\n)\s*(?:adb(?:\.exe)?\s*:\s*)?(?:error(?:\b|:)|failure(?:\b|\s*\[)|failed(?:\b|:)|unable to\b|cannot\b|permission denied\b|securityexception\b|operation not allowed\b|not allowed\b)/im.test(
        output
      ) ||
      /\b(?:device offline|unauthorized|no route to host|connection refused|protocol fault|connection reset|reset by peer)\b/i.test(
        output
      )
    )
  }

  private async runStep(
    operation: string,
    args: string[],
    options: AdbRunOptions,
    privatePath?: string,
    recordLog = true,
    logOutputLimit: number | null = null
  ): Promise<AdbExecution> {
    const result = await this.adb.run(args, options)
    if (recordLog) {
      this.recordTechnicalExecution(operation, result, options, privatePath, logOutputLimit)
    }
    return result
  }

  private recordTechnicalExecution(
    operation: string,
    result: AdbExecution,
    options: AdbRunOptions = {},
    privatePath?: string,
    logOutputLimit: number | null = null
  ): void {
    const safeArgs = result.args.map((argument) =>
      privatePath && argument === privatePath ? `<APK:${basename(privatePath)}>` : argument
    )
    const entry: TechnicalLogEntry = {
      id: randomUUID(),
      operationId: this.snapshot.operation.id,
      time: new Date().toISOString(),
      clientVersion: this.clientVersion,
      adbVersion: this.snapshot.adb.version,
      serial: options.serial ?? null,
      connection: options.serial ? (options.serial.includes(':') ? 'tcp' : 'usb') : null,
      operation,
      arguments: safeArgs,
      stdout: truncateLogOutput(result.stdout, logOutputLimit),
      stderr: truncateLogOutput(result.stderr, logOutputLimit),
      exitCode: result.exitCode,
      durationMs: result.durationMs
    }
    writeTechnicalLog(entry)
    this.patch({ logs: [...this.snapshot.logs, entry].slice(-SESSION_LOG_LIMIT) })
  }

  private beginOperation(
    commandId: CommandId | null,
    summary: string,
    stage: string,
    progress: number
  ): void {
    this.operationWarnings = []
    this.patch({
      operation: {
        id: randomUUID(),
        commandId,
        status: 'running',
        title: stage,
        summary,
        suggestion: null,
        stage,
        progress,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        durationMs: null,
        recovery: null
      }
    })
  }

  private updateOperation(summary: string, stage: string, progress: number | null): void {
    this.patch({
      operation: {
        ...this.snapshot.operation,
        status: 'running',
        summary,
        stage,
        progress: progress === null ? null : Math.max(0, Math.min(100, progress))
      }
    })
  }

  private completeOperation(
    summary: string,
    suggestion?: string,
    status: 'success' | 'warning' = 'success'
  ): void {
    const warningSuggestions = this.operationWarnings
    const effectiveStatus = status === 'success' && warningSuggestions.length > 0
      ? 'warning'
      : status
    const effectiveSuggestion = [suggestion, ...warningSuggestions]
      .filter((value): value is string => Boolean(value))
      .join(' ') || null
    const finishedAt = new Date()
    const startedAt = this.snapshot.operation.startedAt
    const completedOperation: OperationState & { status: 'success' | 'warning' } = {
      ...this.snapshot.operation,
      status: effectiveStatus,
      summary,
      suggestion: effectiveSuggestion,
      stage: '完成',
      progress: 100,
      finishedAt: finishedAt.toISOString(),
      durationMs: startedAt ? finishedAt.getTime() - new Date(startedAt).getTime() : null,
      recovery: null
    }
    const operationHistory = this.operationHistoryWith(completedOperation)
    this.patch({
      operation: completedOperation,
      operationHistory
    })
    this.operationWarnings = []
  }

  private failOperation(
    summary: string,
    suggestion: string,
    recovery: OperationRecovery | null = null,
    title = '操作未执行'
  ): void {
    const finishedAt = new Date()
    const currentOperation =
      this.snapshot.operation.status === 'running'
        ? this.snapshot.operation
        : {
            ...idleOperation(),
            title,
            startedAt: finishedAt.toISOString()
          }
    const startedAt = currentOperation.startedAt
    const failedOperation: OperationState & { status: 'error' } = {
      ...currentOperation,
      status: 'error',
      summary,
      suggestion,
      stage: '失败',
      finishedAt: finishedAt.toISOString(),
      durationMs: startedAt
        ? finishedAt.getTime() - new Date(startedAt).getTime()
        : null,
      recovery
    }
    const operationHistory = this.operationHistoryWith(failedOperation)
    this.patch({
      operation: failedOperation,
      operationHistory
    })
    this.operationWarnings = []
  }

  private noteOperationWarning(message: string): void {
    if (
      this.snapshot.operation.status !== 'running' ||
      !message ||
      this.operationWarnings.includes(message)
    ) {
      return
    }
    this.operationWarnings.push(message)
  }

  private handleOperationError(error: unknown): void {
    writeApplicationError(error)
    if (error instanceof AppError) {
      this.failOperation(error.message, error.suggestion, error.recovery)
      return
    }
    this.failOperation(
      error instanceof Error ? error.message : String(error),
      '请复制执行结果并交给开发或技术支持人员进一步排查。'
    )
  }

  private patch(partial: Partial<AppSnapshot>): void {
    this.snapshot = {
      ...this.snapshot,
      ...partial,
      revision: this.snapshot.revision + 1
    }
    for (const listener of this.listeners) {
      listener(this.snapshot)
    }
  }
}
