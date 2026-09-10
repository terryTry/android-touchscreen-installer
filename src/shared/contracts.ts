import type { TerminalApi } from './terminal'

export const COMMAND_IDS = [
  'nav.back',
  'nav.home',
  'nav.recents',
  'app.install',
  'app.replace',
  'app.deploySystem',
  'app.rollbackSystem',
  'app.launch',
  'app.stop',
  'app.restart',
  'app.uninstall',
  'app.clearData',
  'launcher.set',
  'launcher.verify',
  'launcher.rebootVerify',
  'launcher.restore',
  'device.reboot',
  'device.rootAccess',
  'system.settings',
  'system.developerSettings'
] as const

export type CommandId = (typeof COMMAND_IDS)[number]
export type CommandType = 'adb' | 'shell' | 'workflow'
export type RiskLevel = 'safe' | 'confirm' | 'danger'
export type ResultParser =
  | 'exit-code'
  | 'success-token'
  | 'installed-version'
  | 'launcher-match'
  | 'device-reconnect'
export type ConnectionMode = 'usb' | 'tcp'
export type DeviceState = 'device' | 'unauthorized' | 'offline' | 'no-permissions' | 'unknown'
export type RootAccessMode = 'none' | 'adbd' | 'su'
export type SystemDeploymentMode = 'system' | 'privileged'

export interface CommandCatalogEntry {
  id: CommandId
  displayName: string
  type: CommandType
  argumentTemplate: string[]
  resultParser: ResultParser
  risk: RiskLevel
  timeoutMs: number
  requiresDevice: boolean
  requiresApk: boolean
  requiresPackage: boolean
}

export interface AdbStatus {
  state: 'checking' | 'ready' | 'error'
  executablePath: string
  version: string | null
  serverPort: number
  message: string
}

export interface DriverStatus {
  state: 'not-applicable' | 'not-bundled' | 'package-detected'
  message: string
}

export interface DeviceSummary {
  serial: string
  state: DeviceState
  product: string | null
  model: string | null
  deviceName: string | null
  transport: ConnectionMode
}

export interface DisplayResolution {
  width: number
  height: number
}

export interface DeviceDetails extends DeviceSummary {
  manufacturer: string | null
  androidVersion: string | null
  apiLevel: number | null
  abis: string[]
  buildType: string | null
  debuggable: boolean | null
  verifiedBootState: string | null
  bootloaderUnlocked: boolean | null
  adbUid: number | null
  suPath: string | null
  rootAccessMode: RootAccessMode
  physicalResolution: DisplayResolution | null
  logicalResolution: DisplayResolution | null
}

export interface ApkActivity {
  name: string
  component: string
  exported: boolean
}

export interface ApkDeclaredPermission {
  name: string
  maxSdkVersion: number | null
}

export interface ApkDefinedPermission {
  name: string
  protectionLevel: string[]
}

export interface ApkInfo {
  token: string
  fileName: string
  fileSize: number
  appName: string
  applicationClassName: string | null
  iconDataUrl: string | null
  packageName: string
  versionName: string
  versionCode: number
  minSdk: number
  targetSdk: number | null
  abis: string[]
  debuggable: boolean
  declaredPermissions: ApkDeclaredPermission[]
  definedPermissions: ApkDefinedPermission[]
  homeActivities: ApkActivity[]
  selectedHomeComponent: string | null
  launchActivity: ApkActivity | null
  warnings: string[]
}

export interface InstalledPackageInfo {
  installed: boolean
  versionName: string | null
  versionCode: number | null
}

export interface DeviceApplicationInfo {
  serial: string
  packageName: string
  versionName: string | null
  versionCode: number | null
  declaredPermissions: ApkDeclaredPermission[]
  permissionInspectionError: string | null
  launchActivity: ApkActivity | null
  homeActivities: ApkActivity[]
  selectedHomeComponent: string | null
}

export interface DeviceApplicationCandidate {
  packageName: string
  launchActivity: ApkActivity | null
  homeActivities: ApkActivity[]
  isCurrentHome: boolean
}

export interface DeviceApplicationCatalog {
  serial: string | null
  applications: DeviceApplicationCandidate[]
}

export type VersionRelation = 'not-installed' | 'upgrade' | 'same' | 'downgrade' | 'unknown'

export interface CompatibilityReport {
  ok: boolean
  errors: string[]
  warnings: string[]
  installedPackage: InstalledPackageInfo
  versionRelation: VersionRelation
}

export type PermissionAvailability =
  | 'ready'
  | 'user-action'
  | 'adb-action'
  | 'unavailable'
  | 'not-applicable'
  | 'unknown'

export type PermissionPreparationMethod =
  | 'automatic'
  | 'user-settings'
  | 'pm-grant'
  | 'appops'
  | 'notification-policy'
  | 'system-app'
  | 'restricted-system-grant'
  | 'privileged-allowlist'
  | 'none'

export type SystemModificationCapabilityState =
  | 'verified'
  | 'possible'
  | 'unavailable'
  | 'unknown'

export interface SystemModificationCapability {
  state: SystemModificationCapabilityState
  reason: string
}

export interface PermissionPreparation {
  method: PermissionPreparationMethod
  label: string
  requiresApk: boolean
  requiresRoot: boolean
  requiresReboot: boolean
  blocker: string | null
}

export interface PlatformPermissionApiRange {
  introducedApiLevel: number
  removedApiLevel: number | null
}

export interface PermissionCheck {
  name: string
  maxSdkVersion: number | null
  platformApiRange: PlatformPermissionApiRange | null
  sourcePackage: string | null
  protectionLevel: string[]
  permissionFlags: string[]
  availability: PermissionAvailability
  accessPath: PermissionAvailability
  preparation: PermissionPreparation
  authorization?: 'granted' | 'denied' | 'not-required' | 'not-installed' | 'unknown'
  reason: string
  solution: string | null
}

export interface PermissionCheckSummary {
  total: number
  ready: number
  userAction: number
  adbAction: number
  unavailable: number
  notApplicable: number
  unknown: number
}

export interface PermissionPreparationPlan {
  total: number
  pmGrant: number
  appOps: number
  serviceCommand: number
  systemApp: number
  privilegedAllowlist: number
  requiresApk: boolean
  requiresRoot: boolean
  requiresReboot: boolean
}

export interface PermissionCompatibilityReport {
  state: 'ready' | 'waiting-for-device' | 'inspection-failed'
  serial: string | null
  deviceApiLevel: number | null
  permissions: PermissionCheck[]
  summary: PermissionCheckSummary
  plan: PermissionPreparationPlan
  systemModification: SystemModificationCapability
  inspectionError: string | null
}

export interface SystemDeploymentRecord {
  serial: string
  packageName: string
  versionCode: number
  deploymentMode: SystemDeploymentMode
  appDirectory: string
  apkPath: string
  allowlistPath: string | null
  createdAt: string
}

export interface LauncherState {
  currentComponent: string | null
  currentPackage: string | null
  originalComponent: string | null
  canRestore: boolean
  verification: 'unknown' | 'matched' | 'mismatched'
}

export type OperationStatus = 'idle' | 'running' | 'success' | 'warning' | 'error'

export interface OperationRecovery {
  kind: 'signature-conflict'
  commandId: 'app.replace'
  serial: string
  apkToken: string
  packageName: string
}

export interface OperationState {
  id: string
  commandId: CommandId | null
  status: OperationStatus
  title: string
  summary: string
  suggestion: string | null
  stage: string | null
  progress: number
  startedAt: string | null
  finishedAt: string | null
  durationMs: number | null
  recovery: OperationRecovery | null
}

export interface TechnicalLogEntry {
  id: string
  operationId: string
  time: string
  clientVersion: string
  adbVersion: string | null
  serial: string | null
  connection: ConnectionMode | null
  operation: string
  arguments: string[]
  stdout: string
  stderr: string
  exitCode: number
  durationMs: number
}

export interface OperationHistoryEntry {
  id: string
  commandId: CommandId | null
  status: 'success' | 'warning' | 'error'
  title: string
  summary: string
  suggestion: string | null
  serial: string | null
  connection: ConnectionMode | null
  packageName: string | null
  clientVersion: string
  adbVersion: string | null
  startedAt: string
  finishedAt: string
  durationMs: number | null
  logCount: number
}

export interface OperationHistoryDetail extends OperationHistoryEntry {
  logs: TechnicalLogEntry[]
}

export interface RecentTcpEndpoint {
  host: string
  port: number
}

export type TcpProbeStatus =
  | 'not-run'
  | 'open'
  | 'closed'
  | 'timeout'
  | 'unreachable'
  | 'unknown'

export type TcpRepairPhase =
  | 'idle'
  | 'available'
  | 'probing'
  | 'restarting'
  | 'connecting'
  | 'success'
  | 'error'

export type TcpRepairFailureKind =
  | 'network'
  | 'refused'
  | 'unauthorized'
  | 'offline'
  | 'protocol'
  | 'unknown'

export interface TcpRepairState {
  endpoint: RecentTcpEndpoint | null
  phase: TcpRepairPhase
  probe: TcpProbeStatus
  failureKind: TcpRepairFailureKind | null
  message: string | null
  detail: string | null
  serverPort: number | null
}

export interface AppSnapshot {
  revision: number
  adb: AdbStatus
  driver: DriverStatus
  connectionMode: ConnectionMode
  devices: DeviceSummary[]
  selectedSerial: string | null
  selectedDevice: DeviceDetails | null
  selectedApk: ApkInfo | null
  selectedDeviceApplication: DeviceApplicationInfo | null
  deviceApplicationCatalog: DeviceApplicationCatalog
  compatibility: CompatibilityReport | null
  permissionCompatibility: PermissionCompatibilityReport | null
  systemDeployment: SystemDeploymentRecord | null
  launcher: LauncherState
  operation: OperationState
  operationHistory: OperationHistoryEntry[]
  logs: TechnicalLogEntry[]
  recentTcp: RecentTcpEndpoint
  tcpRepair: TcpRepairState
  busy: boolean
  commandCatalog: CommandCatalogEntry[]
}

export interface TcpConnectRequest {
  host: string
  port: number
}

export interface ExecuteCommandRequest {
  commandId: CommandId
  allowDowngrade?: boolean
  systemDeploymentMode?: SystemDeploymentMode
}

export interface AdbToolApi extends TerminalApi {
  getSnapshot: () => Promise<AppSnapshot>
  onSnapshot: (listener: (snapshot: AppSnapshot) => void) => () => void
  setConnectionMode: (mode: ConnectionMode) => Promise<AppSnapshot>
  selectDevice: (serial: string | null) => Promise<AppSnapshot>
  connectTcp: (request: TcpConnectRequest) => Promise<AppSnapshot>
  repairTcpConnection: () => Promise<AppSnapshot>
  chooseApk: () => Promise<AppSnapshot>
  parseDroppedApk: (file: File) => Promise<AppSnapshot>
  loadDeviceApplication: (packageName: string) => Promise<AppSnapshot>
  loadForegroundApplication: () => Promise<AppSnapshot>
  refreshDeviceApplications: () => Promise<AppSnapshot>
  selectHomeActivity: (component: string) => Promise<AppSnapshot>
  executeCommand: (request: ExecuteCommandRequest) => Promise<AppSnapshot>
  getOperationHistoryDetail: (operationId: string) => Promise<OperationHistoryDetail>
  copyOperationSummary: (operationId: string) => Promise<boolean>
  copyOperationDiagnostics: (operationId: string) => Promise<boolean>
}
