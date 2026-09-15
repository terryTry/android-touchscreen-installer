import { LanSearch } from './LanSearch'
import {
  AlertCircle,
  ArrowLeft,
  Cable,
  Check,
  ChevronDown,
  CircleStop,
  Clipboard,
  CodeXml,
  Download,
  FolderOpen,
  History,
  Home,
  House,
  LoaderCircle,
  MonitorSmartphone,
  Package,
  PanelsTopLeft,
  Play,
  RefreshCw,
  Rocket,
  RotateCw,
  Search,
  Settings,
  TerminalSquare,
  ShieldAlert,
  Usb,
  Wifi,
  Wrench,
  X
} from 'lucide-react'
import {
  type DragEvent,
  type FormEvent,
  type ReactNode,
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import type {
  AppSnapshot,
  CommandId,
  ConnectionMode,
  DeviceSummary,
  DisplayResolution,
  OperationHistoryDetail,
  OperationHistoryEntry,
  RiskLevel,
  SystemDeploymentMode
} from '../../shared/contracts'
import { OperationProgress } from './OperationProgress'
import { version as appVersion } from '../../../package.json'

const TerminalPanel = lazy(() => import('./TerminalPanel'))

interface PendingConfirmation {
  commandId: CommandId
  message: string
  danger: boolean
  requiresAcknowledgement: boolean
  acknowledgementText: string | null
  systemDeploymentMode: SystemDeploymentMode
}

interface ActionButtonProps {
  children: ReactNode
  onClick: () => void
  disabled?: boolean
  primary?: boolean
  danger?: boolean
  title?: string | undefined
}

function ActionButton({
  children,
  onClick,
  disabled = false,
  primary = false,
  danger = false,
  title
}: ActionButtonProps): React.JSX.Element {
  const classes = ['button', primary ? 'button-primary' : '', danger ? 'button-danger' : '']
    .filter(Boolean)
    .join(' ')
  return (
    <button className={classes} type="button" onClick={onClick} disabled={disabled} title={title}>
      {children}
    </button>
  )
}

function StatusBadge({
  tone,
  children
}: {
  tone: 'success' | 'warning' | 'neutral' | 'danger'
  children: ReactNode
}): React.JSX.Element {
  return <span className={`badge badge-${tone}`}>{children}</span>
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function deviceLabel(device: DeviceSummary): string {
  return `${device.model ?? device.deviceName ?? 'Android 设备'} · ${device.serial}`
}

function operationStatusText(status: OperationHistoryEntry['status']): string {
  return status === 'success' ? '成功' : status === 'warning' ? '警告' : '失败'
}

function operationStatusTone(
  status: OperationHistoryEntry['status']
): 'success' | 'warning' | 'danger' {
  return status === 'success' ? 'success' : status === 'warning' ? 'warning' : 'danger'
}

function formatOperationListTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN', {
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function formatOperationDetailTime(value: string): string {
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

function usbAdbStatus(devices: DeviceSummary[]): {
  tone: 'success' | 'warning' | 'neutral' | 'danger'
  message: string
} {
  const usbDevices = devices.filter(({ transport }) => transport === 'usb')
  const readyCount = usbDevices.filter(({ state }) => state === 'device').length
  if (readyCount > 0) {
    return {
      tone: 'success',
      message: `USB ADB 可用（已识别 ${readyCount} 台）`
    }
  }
  if (usbDevices.some(({ state }) => state === 'unauthorized')) {
    return {
      tone: 'warning',
      message: '已识别 USB ADB 设备，等待在设备端授权'
    }
  }
  if (usbDevices.some(({ state }) => state === 'offline')) {
    return {
      tone: 'warning',
      message: '已识别 USB ADB 设备，但设备当前离线'
    }
  }
  if (usbDevices.some(({ state }) => state === 'no-permissions')) {
    return {
      tone: 'danger',
      message: 'USB ADB 访问受限，请检查 Windows 驱动或设备权限'
    }
  }
  if (usbDevices.length > 0) {
    return {
      tone: 'warning',
      message: '检测到 USB ADB 设备，但设备状态异常'
    }
  }
  return {
    tone: 'neutral',
    message: '未检测到 USB ADB 设备'
  }
}

function statusText(snapshot: AppSnapshot): string {
  if (snapshot.adb.state !== 'ready') return snapshot.adb.message
  const selected = snapshot.devices.find(({ serial }) => serial === snapshot.selectedSerial)
  if (!selected) {
    return snapshot.devices.length > 1 ? '请选择目标设备' : '未连接设备'
  }
  if (selected.state === 'unauthorized') return '等待设备授权'
  if (selected.state === 'offline') return '设备离线'
  if (selected.state === 'no-permissions') return 'USB ADB 访问受限'
  if (selected.state !== 'device') return '设备不可用'
  return `已连接 · ${selected.transport === 'usb' ? 'USB' : 'TCP/IP'}`
}

function statusTone(snapshot: AppSnapshot): 'success' | 'warning' | 'danger' {
  if (snapshot.adb.state === 'error') return 'danger'
  const selected = snapshot.devices.find(({ serial }) => serial === snapshot.selectedSerial)
  if (selected?.state === 'device') return 'success'
  return 'warning'
}

function displayResolutionText(resolution: DisplayResolution | null): string {
  return resolution ? `${resolution.width} × ${resolution.height}` : '未读取'
}

function confirmationText(
  commandId: CommandId,
  snapshot: AppSnapshot,
  systemDeploymentMode: SystemDeploymentMode
): string {
  const apk = snapshot.selectedApk
  const deviceApplication = snapshot.selectedDeviceApplication
  const targetPackageName = apk?.packageName ?? deviceApplication?.packageName
  const targetDisplayName = apk?.appName ?? targetPackageName
  const deviceName = snapshot.selectedDevice?.model ?? snapshot.selectedSerial ?? '当前设备'
  const messages: Record<CommandId, string> = {
    'nav.back': '',
    'nav.home': '',
    'nav.recents': '',
    'app.install': `确认向 ${deviceName} 安装 ${apk?.appName ?? '所选应用'} ${apk?.versionName ?? ''}（${apk?.versionCode ?? '-'}）？`,
    'app.replace': `确认在 ${deviceName} 上卸载 ${apk?.packageName ?? '旧应用'} 并安装当前 APK？旧应用及其本地数据将被永久删除；如果新 APK 仍然安装失败，设备上将不再保留旧应用。`,
    'app.deploySystem':
      systemDeploymentMode === 'privileged'
        ? `确认将 ${apk?.packageName ?? '当前 APK'} 写入目标设备的 /system/priv-app，并按 APK 声明生成最小化 privileged 权限白名单后重启设备？`
        : `确认将 ${apk?.packageName ?? '当前 APK'} 写入目标设备的 /system/app 后重启设备？此模式只提供 SYSTEM 身份，不授予 PRIVILEGED 或平台签名权限。`,
    'app.rollbackSystem': `确认删除工具为 ${targetPackageName ?? '目标应用'} 创建的系统应用部署文件并重启设备？只会删除已记录的工具托管路径。`,
    'app.launch': '',
    'app.stop': `确认停止 ${targetDisplayName ?? '目标应用'}？`,
    'app.restart': `确认停止后重新启动 ${targetDisplayName ?? '目标应用'}？`,
    'app.uninstall': `确认卸载 ${targetPackageName ?? '目标应用'}？普通应用将删除 APK 与数据；如果检测到 /data/app 更新覆盖了系统应用，工具会先移除更新，再验证固件副本；如果最终确认是 /system/app 或 /system/priv-app 系统应用，工具将验证 Root、重挂 /system、只删除 Package Manager 回读到的同包名系统目录，并重启设备验收。系统应用删除后只能通过重新安装或刷写固件恢复。`,
    'app.clearData': `确认清除 ${targetPackageName ?? '目标应用'} 的全部数据？此操作不可恢复。`,
    'launcher.set': `确认将 ${targetDisplayName ?? '目标应用'} 设为默认桌面？开机后和按 Home 键都会进入该应用。`,
    'launcher.verify': '',
    'launcher.rebootVerify': '确认重启当前设备并在重新连接后验证开机应用？',
    'launcher.restore': `确认恢复原系统桌面 ${snapshot.launcher.originalComponent ?? ''}？`,
    'device.reboot': `确认重启 ${deviceName}？设备会短暂断开，工具将等待其重新连接。`,
    'device.rootAccess': `确认验证 ${deviceName} 的 Root 通道？如果设备已暴露可用 su，工具会优先验证 su 0，避免触发该固件可能不兼容的标准 adb root；否则才尝试标准 adb root。`,
    'system.settings': '',
    'system.developerSettings': ''
  }
  return messages[commandId]
}

function App(): React.JSX.Element {
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [terminalMounted, setTerminalMounted] = useState(false)
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null)
  const [clientError, setClientError] = useState<string | null>(null)
  const [tcpHost, setTcpHost] = useState('')
  const [tcpPort, setTcpPort] = useState('5555')
  const [packageNameInput, setPackageNameInput] = useState('')
  const [applicationPickerOpen, setApplicationPickerOpen] = useState(false)
  const [applicationSearch, setApplicationSearch] = useState('')
  const [allowDowngrade, setAllowDowngrade] = useState(false)
  const [pending, setPending] = useState<PendingConfirmation | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const [operationHistoryOpen, setOperationHistoryOpen] = useState(false)
  const [operationHistoryFilter, setOperationHistoryFilter] =
    useState<'all' | 'error'>('all')
  const [selectedOperationId, setSelectedOperationId] = useState<string | null>(
    null
  )
  const [selectedOperationDetail, setSelectedOperationDetail] =
    useState<OperationHistoryDetail | null>(null)
  const [operationDetailLoading, setOperationDetailLoading] = useState(false)
  const [copiedOperationAction, setCopiedOperationAction] = useState<
    string | null
  >(null)
  const [systemDeploymentMode, setSystemDeploymentMode] =
    useState<SystemDeploymentMode>('system')
  const operationDetailRequest = useRef(0)

  useEffect(() => {
    let active = true
    const unsubscribe = window.adbTool.onSnapshot((next) => {
      if (active) setSnapshot(next)
    })
    void window.adbTool
      .getSnapshot()
      .then((next) => {
        if (active) setSnapshot(next)
      })
      .catch((error: unknown) => {
        if (active) setClientError(error instanceof Error ? error.message : String(error))
      })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (!snapshot) return
    setTcpHost((current) => current || snapshot.recentTcp.host)
    setTcpPort((current) => (current === '5555' ? String(snapshot.recentTcp.port) : current))
  }, [snapshot?.recentTcp.host, snapshot?.recentTcp.port])

  useEffect(() => {
    const packageName =
      snapshot?.selectedDeviceApplication?.packageName ?? snapshot?.selectedApk?.packageName
    if (packageName) setPackageNameInput(packageName)
  }, [
    snapshot?.selectedDeviceApplication?.packageName,
    snapshot?.selectedApk?.packageName
  ])

  useEffect(() => {
    if (!pending) return
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setPending(null)
        setAcknowledged(false)
      }
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [pending])

  useEffect(() => {
    if (!applicationPickerOpen) return
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setApplicationPickerOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [applicationPickerOpen])

  useEffect(() => {
    if (!operationHistoryOpen) return
    const previousBodyOverflow = document.body.style.overflow
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOperationHistoryOpen(false)
    }
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.body.style.overflow = previousBodyOverflow
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [operationHistoryOpen])

  const visibleDevices = useMemo(
    () => snapshot?.devices.filter(({ transport }) => transport === snapshot.connectionMode) ?? [],
    [snapshot?.devices, snapshot?.connectionMode]
  )

  const filteredDeviceApplications = useMemo(() => {
    const applications = snapshot?.deviceApplicationCatalog.applications ?? []
    const query = applicationSearch.trim().toLocaleLowerCase('en')
    if (!query) return applications
    return applications.filter(
      ({ packageName, launchActivity, homeActivities }) =>
        packageName.toLocaleLowerCase('en').includes(query) ||
        launchActivity?.name.toLocaleLowerCase('en').includes(query) ||
        homeActivities.some(({ name }) => name.toLocaleLowerCase('en').includes(query))
    )
  }, [applicationSearch, snapshot?.deviceApplicationCatalog.applications])

  const filteredOperationHistory = useMemo(() => {
    const history = snapshot?.operationHistory ?? []
    return operationHistoryFilter === 'error'
      ? history.filter(({ status }) => status === 'error')
      : history
  }, [operationHistoryFilter, snapshot?.operationHistory])

  if (!snapshot) {
    return (
      <main className="loading-screen">
        <LoaderCircle className="spin" aria-hidden="true" />
        <span>正在启动安卓触摸屏安装助手…</span>
      </main>
    )
  }

  const selectedDeviceSummary = snapshot.devices.find(
    ({ serial }) => serial === snapshot.selectedSerial
  )
  const deviceReady = selectedDeviceSummary?.state === 'device'
  const currentUsbAdbStatus = usbAdbStatus(snapshot.devices)
  const apk = snapshot.selectedApk
  const deviceApplication = snapshot.selectedDeviceApplication
  const compatibility = snapshot.compatibility
  const permissionCompatibility = snapshot.permissionCompatibility
  const tcpRepair = snapshot.tcpRepair
  const apkPackageInstalled = compatibility?.installedPackage.installed === true
  const isDowngrade = compatibility?.versionRelation === 'downgrade'
  const signatureConflictRecovery =
    snapshot.operation.recovery?.kind === 'signature-conflict' &&
    snapshot.operation.recovery.serial === snapshot.selectedSerial &&
    snapshot.operation.recovery.apkToken === apk?.token &&
    snapshot.operation.recovery.packageName === apk?.packageName
      ? snapshot.operation.recovery
      : null
  const replacementBlockedByLauncher =
    signatureConflictRecovery !== null &&
    snapshot.launcher.currentPackage === signatureConflictRecovery.packageName
  const targetLaunchComponent =
    deviceApplication?.launchActivity?.component ??
    deviceApplication?.selectedHomeComponent ??
    apk?.launchActivity?.component ??
    apk?.selectedHomeComponent ??
    null
  const targetHomeActivities =
    deviceApplication?.homeActivities ?? apk?.homeActivities ?? []
  const targetHomeComponent =
    deviceApplication?.selectedHomeComponent ?? apk?.selectedHomeComponent ?? null
  const targetInstalled = deviceApplication !== null || apkPackageInstalled
  const targetOperational = deviceApplication !== null || apkPackageInstalled
  const exportedHomeActivities = targetHomeActivities.filter(({ exported }) => exported)
  const apkExportedHomeActivities = apk?.homeActivities.filter(({ exported }) => exported) ?? []
  const launcherReady =
    targetOperational &&
    targetHomeComponent !== null &&
    exportedHomeActivities.length > 0
  const rootAccessEligible =
    Boolean(snapshot.selectedDevice?.suPath) ||
    (snapshot.selectedDevice?.debuggable === true &&
      (snapshot.selectedDevice.buildType === 'userdebug' ||
        snapshot.selectedDevice.buildType === 'eng'))
  const rootAccessActive =
    snapshot.selectedDevice?.rootAccessMode === 'adbd' ||
    snapshot.selectedDevice?.rootAccessMode === 'su'
  const privilegedPermissionCount =
    permissionCompatibility?.permissions.filter(({ protectionLevel }) =>
      protectionLevel.includes('privileged')
    ).length ?? 0
  const selectedHistoryOperation =
    filteredOperationHistory.find(({ id }) => id === selectedOperationId) ??
    filteredOperationHistory[0] ??
    null
  const selectedHistoryDetail =
    selectedOperationDetail?.id === selectedHistoryOperation?.id
      ? selectedOperationDetail
      : null
  const latestHistoryOperation = snapshot.operationHistory[0] ?? null
  const displayedOperationStatus =
    snapshot.operation.status === 'idle'
      ? latestHistoryOperation?.status ?? 'idle'
      : snapshot.operation.status
  const displayedOperationSummary =
    snapshot.operation.status === 'idle'
      ? latestHistoryOperation?.summary ?? '尚无操作记录'
      : snapshot.operation.summary
  const failedOperationCount = snapshot.operationHistory.filter(
    ({ status }) => status === 'error'
  ).length

  const applySnapshot = (promise: Promise<AppSnapshot>): void => {
    setClientError(null)
    void promise
      .then(setSnapshot)
      .catch((error: unknown) =>
        setClientError(error instanceof Error ? error.message : String(error))
      )
  }

  const runCommand = (
    commandId: CommandId,
    deploymentMode: SystemDeploymentMode = systemDeploymentMode
  ): void => {
    const catalog = snapshot.commandCatalog.find(({ id }) => id === commandId)
    const risk: RiskLevel = catalog?.risk ?? 'confirm'
    if (risk === 'safe') {
      applySnapshot(window.adbTool.executeCommand({ commandId }))
      return
    }
    setAcknowledged(false)
    setPending({
      commandId,
      message: confirmationText(commandId, snapshot, deploymentMode),
      danger: risk === 'danger',
      requiresAcknowledgement:
        commandId === 'app.replace' ||
        commandId === 'app.uninstall' ||
        commandId === 'app.deploySystem' ||
        commandId === 'app.rollbackSystem',
      acknowledgementText:
        commandId === 'app.replace'
          ? '我已确认旧应用数据可以删除，并接受新 APK 可能仍安装失败。'
          : commandId === 'app.uninstall'
            ? '我已确认应用数据可以删除；若目标是系统应用，我接受修改系统分区、自动重启以及需要重新安装或刷机才能恢复的风险。'
            : commandId === 'app.deploySystem'
              ? '我已确认设备具备刷机恢复手段，并接受系统分区修改可能导致设备无法启动。'
              : commandId === 'app.rollbackSystem'
                ? '我已确认回滚会删除工具记录的系统文件并重启设备。'
                : null,
      systemDeploymentMode: deploymentMode
    })
  }

  const confirmCommand = (): void => {
    if (!pending) return
    if (pending.requiresAcknowledgement && !acknowledged) return
    const commandId = pending.commandId
    setPending(null)
    setAcknowledged(false)
    applySnapshot(
      window.adbTool.executeCommand({
        commandId,
        ...(commandId === 'app.install' ? { allowDowngrade } : {}),
        ...(commandId === 'app.deploySystem'
          ? { systemDeploymentMode: pending.systemDeploymentMode }
          : {})
      })
    )
  }

  const switchMode = (mode: ConnectionMode): void => {
    if (mode === snapshot.connectionMode) return
    applySnapshot(window.adbTool.setConnectionMode(mode))
  }

  const connectTcp = (event: FormEvent): void => {
    event.preventDefault()
    applySnapshot(
      window.adbTool.connectTcp({
        host: tcpHost.trim(),
        port: Number.parseInt(tcpPort, 10)
      })
    )
  }

  const repairTcpConnection = (): void => {
    applySnapshot(window.adbTool.repairTcpConnection())
  }

  const loadDeviceApplication = (event: FormEvent): void => {
    event.preventDefault()
    const packageName = packageNameInput.trim()
    if (!packageName) return
    applySnapshot(window.adbTool.loadDeviceApplication(packageName))
  }

  const loadCurrentLauncherApplication = (): void => {
    const packageName = snapshot.launcher.currentPackage
    if (!packageName) return
    setPackageNameInput(packageName)
    applySnapshot(window.adbTool.loadDeviceApplication(packageName))
  }

  const loadForegroundApplication = (): void => {
    applySnapshot(window.adbTool.loadForegroundApplication())
  }

  const openDeviceApplicationPicker = (): void => {
    setApplicationSearch('')
    setApplicationPickerOpen(true)
    applySnapshot(window.adbTool.refreshDeviceApplications())
  }

  const selectDeviceApplication = (packageName: string): void => {
    setApplicationPickerOpen(false)
    setPackageNameInput(packageName)
    applySnapshot(window.adbTool.loadDeviceApplication(packageName))
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    setDragActive(false)
    const file = event.dataTransfer.files[0]
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.apk')) {
      setClientError('只支持拖入 .apk 文件。')
      return
    }
    applySnapshot(window.adbTool.parseDroppedApk(file))
  }

  const loadOperationHistoryDetail = (operationId: string): void => {
    const requestId = operationDetailRequest.current + 1
    operationDetailRequest.current = requestId
    setSelectedOperationDetail(null)
    setOperationDetailLoading(true)
    void window.adbTool
      .getOperationHistoryDetail(operationId)
      .then((detail) => {
        if (operationDetailRequest.current === requestId) {
          setSelectedOperationDetail(detail)
          setOperationDetailLoading(false)
        }
      })
      .catch((error: unknown) => {
        if (operationDetailRequest.current === requestId) {
          setOperationDetailLoading(false)
          setClientError(error instanceof Error ? error.message : String(error))
        }
      })
  }

  const selectHistoryOperation = (operationId: string): void => {
    setSelectedOperationId(operationId)
    loadOperationHistoryDetail(operationId)
  }

  const applyOperationHistoryFilter = (filter: 'all' | 'error'): void => {
    setOperationHistoryFilter(filter)
    const operation =
      filter === 'error'
        ? snapshot.operationHistory.find(({ status }) => status === 'error')
        : snapshot.operationHistory[0]
    setSelectedOperationId(operation?.id ?? null)
    setSelectedOperationDetail(null)
    if (operation) {
      loadOperationHistoryDetail(operation.id)
    } else {
      operationDetailRequest.current += 1
      setOperationDetailLoading(false)
    }
  }

  const openOperationHistory = (): void => {
    setOperationHistoryFilter('all')
    const operationId = snapshot.operationHistory[0]?.id ?? null
    setSelectedOperationId(operationId)
    setSelectedOperationDetail(null)
    if (operationId) {
      loadOperationHistoryDetail(operationId)
    } else {
      operationDetailRequest.current += 1
      setOperationDetailLoading(false)
    }
    setOperationHistoryOpen(true)
  }

  const copyOperation = (
    operationId: string,
    kind: 'summary' | 'diagnostics'
  ): void => {
    const actionId = `${operationId}:${kind}`
    const request =
      kind === 'summary'
        ? window.adbTool.copyOperationSummary(operationId)
        : window.adbTool.copyOperationDiagnostics(operationId)
    void request
      .then(() => {
        setCopiedOperationAction(actionId)
        window.setTimeout(() => {
          setCopiedOperationAction((current) =>
            current === actionId ? null : current
          )
        }, 1_500)
      })
      .catch((error: unknown) =>
        setClientError(error instanceof Error ? error.message : String(error))
      )
  }

  const installDisabled =
    !deviceReady ||
    !apk ||
    !compatibility?.ok ||
    Boolean(signatureConflictRecovery) ||
    (isDowngrade && (!allowDowngrade || !apk.debuggable)) ||
    snapshot.busy

  return (
    <div className="app-shell">
      <header className="titlebar">
        <div className="brand">
          <span className="brand-icon">
            <MonitorSmartphone aria-hidden="true" />
          </span>
          <div>
            <h1>安卓触摸屏安装助手</h1>
            <p>内置 ADB · Windows x64 · V{appVersion}</p>
          </div>
        </div>
        <div className="titlebar-actions">
          <button type="button" className="button" aria-expanded={terminalOpen}
            onClick={() => { setTerminalMounted(true); setTerminalOpen((value) => !value) }}>
            <TerminalSquare size={16} />ADB 终端
          </button>
          <div
            className={`device-status device-status-${statusTone(snapshot)}`}
            aria-live="polite"
          >
            <span className="status-dot" aria-hidden="true" />
            {statusText(snapshot)}
          </div>
          <button
            type="button"
            className={`operation-history-trigger operation-history-trigger-${displayedOperationStatus}`}
            aria-label={`打开操作记录，共 ${snapshot.operationHistory.length} 条`}
            onClick={openOperationHistory}
          >
            <span className="operation-history-trigger-icon" aria-hidden="true">
              {displayedOperationStatus === 'running' ? (
                <LoaderCircle className="spin" />
              ) : displayedOperationStatus === 'error' ? (
                <AlertCircle />
              ) : displayedOperationStatus === 'warning' ? (
                <AlertCircle />
              ) : displayedOperationStatus === 'success' ? (
                <Check />
              ) : (
                <History />
              )}
            </span>
            <span className="operation-history-trigger-copy">
              <small>
                {displayedOperationStatus === 'running'
                  ? '当前操作'
                  : '最近操作'}
              </small>
              <strong>{displayedOperationSummary}</strong>
            </span>
            <span className="operation-history-trigger-count">
              <History aria-hidden="true" />
              {snapshot.operationHistory.length}
            </span>
          </button>
        </div>
      </header>

      {terminalMounted && <Suspense fallback={<div className="terminal-loading">正在加载终端…</div>}>
        <TerminalPanel snapshot={snapshot} open={terminalOpen} onClose={() => setTerminalOpen(false)} />
      </Suspense>}

      {clientError && (
        <div className="client-error" role="alert">
          <AlertCircle aria-hidden="true" />
          <span>{clientError}</span>
          <button type="button" aria-label="关闭错误提示" onClick={() => setClientError(null)}>
            <X aria-hidden="true" />
          </button>
        </div>
      )}

      <section className="connection-panel" aria-labelledby="connection-title">
        <div className="connection-main">
          <div className="section-title-row">
            <h2 id="connection-title">
              <Cable aria-hidden="true" />
              目标设备
            </h2>
            {selectedDeviceSummary && (
              <StatusBadge tone={deviceReady ? 'success' : 'warning'}>
                {selectedDeviceSummary.transport === 'usb' ? 'USB' : 'TCP/IP'}
              </StatusBadge>
            )}
            {snapshot.selectedDevice?.androidVersion && (
              <StatusBadge tone="neutral">
                Android {snapshot.selectedDevice.androidVersion}
                {snapshot.selectedDevice.apiLevel !== null
                  ? ` · API ${snapshot.selectedDevice.apiLevel}`
                  : ''}
              </StatusBadge>
            )}
          </div>

          <div className="device-picker-row">
            <label className="field grow-field">
              <span>当前设备</span>
              <select
                value={snapshot.selectedSerial ?? ''}
                disabled={snapshot.busy || visibleDevices.length === 0}
                onChange={(event) =>
                  applySnapshot(window.adbTool.selectDevice(event.target.value || null))
                }
              >
                <option value="">
                  {visibleDevices.length === 0 ? '未检测到设备' : '请选择目标设备'}
                </option>
                {visibleDevices.map((device) => (
                  <option key={device.serial} value={device.serial}>
                    {deviceLabel(device)} · {device.state}
                  </option>
                ))}
              </select>
            </label>
            <div className="mode-switch" aria-label="连接方式">
              <button
                type="button"
                className={snapshot.connectionMode === 'usb' ? 'active' : ''}
                aria-pressed={snapshot.connectionMode === 'usb'}
                disabled={snapshot.busy}
                onClick={() => switchMode('usb')}
              >
                <Usb aria-hidden="true" />
                USB
              </button>
              <button
                type="button"
                className={snapshot.connectionMode === 'tcp' ? 'active' : ''}
                aria-pressed={snapshot.connectionMode === 'tcp'}
                disabled={snapshot.busy}
                onClick={() => switchMode('tcp')}
              >
                <Wifi aria-hidden="true" />
                TCP/IP
              </button>
            </div>
          </div>

          <p className="device-detail">
            {snapshot.selectedDevice
              ? [
                  snapshot.selectedDevice.manufacturer,
                  snapshot.selectedDevice.model,
                  snapshot.selectedDevice.androidVersion
                    ? `Android ${snapshot.selectedDevice.androidVersion}`
                    : null,
                  snapshot.selectedDevice.apiLevel
                    ? `API ${snapshot.selectedDevice.apiLevel}`
                    : null,
                  snapshot.selectedDevice.abis.join(' / '),
                  snapshot.selectedDevice.serial
                ]
                  .filter(Boolean)
                  .join(' · ')
              : snapshot.operation.status === 'idle'
                ? snapshot.operation.summary
                : snapshot.driver.message}
          </p>

          {snapshot.selectedDevice && (
            <dl className="device-resolution" aria-label="设备显示分辨率">
              <div>
                <dt>物理分辨率</dt>
                <dd>{displayResolutionText(snapshot.selectedDevice.physicalResolution)}</dd>
              </div>
              <div>
                <dt>逻辑分辨率</dt>
                <dd>{displayResolutionText(snapshot.selectedDevice.logicalResolution)}</dd>
              </div>
            </dl>
          )}

          {snapshot.connectionMode === 'tcp' && (
            <form className="tcp-form" onSubmit={connectTcp}>
              <label className="field">
                <span>设备 IP</span>
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder="192.168.1.100"
                  value={tcpHost}
                  disabled={snapshot.busy}
                  onChange={(event) => setTcpHost(event.target.value)}
                  required
                />
              </label>
              <label className="field port-field">
                <span>端口</span>
                <input
                  type="number"
                  min="1"
                  max="65535"
                  value={tcpPort}
                  disabled={snapshot.busy}
                  onChange={(event) => setTcpPort(event.target.value)}
                  required
                />
              </label>
              <button
                className="button button-primary"
                type="submit"
                disabled={snapshot.busy || tcpHost.trim().length === 0}
              >
                <Wifi aria-hidden="true" />
                连接
              </button>
            </form>
          )}
          {snapshot.connectionMode === 'tcp' && (
            <LanSearch
              disabled={snapshot.busy || snapshot.adb.state !== 'ready'}
              connectedEndpoint={snapshot.devices.some((device) => device.serial === snapshot.selectedSerial && device.state === 'device') ? snapshot.selectedSerial : null}
              onConnect={async (host, port) => {
                setTcpHost(host)
                setTcpPort(String(port))
                setClientError(null)
                const next = await window.adbTool.connectTcp({ host, port })
                setSnapshot(next)
                if (next.selectedSerial !== `${host}:${port}` || !next.devices.some((device) => device.serial === next.selectedSerial && device.state === 'device')) {
                  throw new Error(next.tcpRepair.message ?? '连接未成功，请检查设备授权或查看下方连接修复提示。')
                }
              }}
            />
          )}
          {snapshot.connectionMode === 'tcp' && tcpRepair.endpoint && tcpRepair.phase !== 'idle' && (
            <section
              className={`tcp-repair-card tcp-repair-card-${tcpRepair.phase}`}
              aria-label="TCP/IP 连接修复"
              role="status"
            >
              <div className="tcp-repair-header">
                <div>
                  <strong>TCP/IP 连接修复</strong>
                  <small className="mono">
                    {tcpRepair.endpoint.host}:{tcpRepair.endpoint.port}
                  </small>
                </div>
                <StatusBadge
                  tone={
                    tcpRepair.phase === 'success'
                      ? 'success'
                      : tcpRepair.phase === 'error'
                        ? 'danger'
                        : 'warning'
                  }
                >
                  {tcpRepair.phase === 'success'
                    ? '已修复'
                    : tcpRepair.phase === 'error'
                      ? '未完成'
                      : tcpRepair.phase === 'available'
                        ? '可排查'
                        : '处理中'}
                </StatusBadge>
              </div>
              <p>{tcpRepair.message ?? '连接失败后可执行只读端口探测和应用内 ADB Server 修复。'}</p>
              {tcpRepair.detail && <small>{tcpRepair.detail}</small>}
              {tcpRepair.serverPort !== null && (
                <small>应用内 ADB Server：127.0.0.1:{tcpRepair.serverPort}</small>
              )}
              {tcpRepair.probe !== 'not-run' && (
                <small>
                  端口探测：
                  {tcpRepair.probe === 'open'
                    ? '可达'
                    : tcpRepair.probe === 'closed'
                      ? '未监听'
                      : tcpRepair.probe === 'timeout'
                        ? '超时'
                        : tcpRepair.probe === 'unreachable'
                          ? '不可达'
                          : '状态未知'}
                </small>
              )}
              {(tcpRepair.phase === 'available' || tcpRepair.phase === 'error') && (
                <ActionButton
                  primary
                  onClick={repairTcpConnection}
                  disabled={snapshot.busy}
                >
                  <Wrench aria-hidden="true" />
                  修复 TCP/IP 连接
                </ActionButton>
              )}
            </section>
          )}
          {snapshot.connectionMode === 'tcp' && (
            <p className="tcp-form-hint">
              Android 11 及以上请填写设备“开发者选项 → 无线调试”页面当前显示的调试端口；5555
              仅适用于设备确实通过 USB 开启 adb tcpip 5555 的场景。
            </p>
          )}
        </div>
      </section>

      <nav className="navigation-bar" aria-label="设备导航">
        <div className="section-title-row">
          <h2>
            <PanelsTopLeft aria-hidden="true" />
            设备导航
          </h2>
        </div>
        <div className="button-row">
          <ActionButton
            onClick={() => runCommand('nav.back')}
            disabled={!deviceReady || snapshot.busy}
          >
            <ArrowLeft aria-hidden="true" />
            返回
          </ActionButton>
          <ActionButton
            onClick={() => runCommand('nav.home')}
            disabled={!deviceReady || snapshot.busy}
          >
            <Home aria-hidden="true" />
            Home
          </ActionButton>
          <ActionButton
            onClick={() => runCommand('nav.recents')}
            disabled={!deviceReady || snapshot.busy}
          >
            <PanelsTopLeft aria-hidden="true" />
            最近任务
          </ActionButton>
        </div>
      </nav>

      <main className="workspace">
        <section className="primary-column" aria-labelledby="install-title">
          <div className="section-title-row">
            <h2 id="install-title">
              <Package aria-hidden="true" />
              应用管理与安装
            </h2>
          </div>

          <div
            className={`drop-zone ${dragActive ? 'drop-zone-active' : ''}`}
            onDragEnter={(event) => {
              event.preventDefault()
              setDragActive(true)
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={(event) => {
              if (event.currentTarget === event.target) setDragActive(false)
            }}
            onDrop={handleDrop}
          >
            <FolderOpen aria-hidden="true" />
            <div>
              <strong>{apk ? '更换 APK' : '选择 APK（自动识别）'}</strong>
              <span>点击或拖入，解析包名并匹配设备中已安装的应用</span>
            </div>
            <ActionButton
              onClick={() => applySnapshot(window.adbTool.chooseApk())}
              disabled={snapshot.busy}
            >
              浏览文件
            </ActionButton>
          </div>

          <div className="device-app-reader">
            <div>
              <strong>选择设备上的目标应用</strong>
              <span>可从应用列表、当前前台、当前桌面或完整包名指定。</span>
            </div>
            <form onSubmit={loadDeviceApplication}>
              <input
                type="text"
                value={packageNameInput}
                placeholder="com.example.application"
                aria-label="目标应用包名"
                spellCheck={false}
                disabled={!deviceReady || snapshot.busy}
                onChange={(event) => setPackageNameInput(event.target.value)}
                required
              />
              <button
                className="button"
                type="submit"
                disabled={!deviceReady || !packageNameInput.trim() || snapshot.busy}
              >
                读取应用
              </button>
            </form>
            <div className="device-app-shortcuts">
              <ActionButton
                onClick={openDeviceApplicationPicker}
                disabled={!deviceReady || snapshot.busy}
              >
                <PanelsTopLeft aria-hidden="true" />
                选择设备应用
              </ActionButton>
              <ActionButton
                onClick={loadForegroundApplication}
                disabled={!deviceReady || snapshot.busy}
              >
                <MonitorSmartphone aria-hidden="true" />
                使用当前前台
              </ActionButton>
              <ActionButton
                onClick={loadCurrentLauncherApplication}
                disabled={!deviceReady || !snapshot.launcher.currentPackage || snapshot.busy}
              >
                <House aria-hidden="true" />
                使用当前桌面
              </ActionButton>
            </div>
          </div>

          {apk ? (
            <div className="apk-summary">
              <div className="apk-heading">
                <div className="app-identity">
                  <span className="app-icon">
                    {apk.iconDataUrl ? (
                      <img src={apk.iconDataUrl} alt="" />
                    ) : (
                      <Package aria-hidden="true" />
                    )}
                  </span>
                  <div>
                    <strong>{apk.appName}</strong>
                    <span>
                      {apk.fileName} · {formatBytes(apk.fileSize)}
                    </span>
                  </div>
                </div>
                <StatusBadge
                  tone={
                    apkExportedHomeActivities.length > 0
                      ? 'success'
                      : apk.homeActivities.length > 0
                        ? 'danger'
                        : 'warning'
                  }
                >
                  {apkExportedHomeActivities.length > 0
                    ? '支持开机桌面'
                    : apk.homeActivities.length > 0
                      ? 'HOME 未导出'
                      : '无 HOME 能力'}
                </StatusBadge>
              </div>

              <dl className="metadata-grid">
                <dt>版本</dt>
                <dd>
                  {apk.versionName}（{apk.versionCode}）
                </dd>
                <dt>包名</dt>
                <dd className="mono">{apk.packageName}</dd>
                <dt>系统要求</dt>
                <dd>
                  API {apk.minSdk}+
                  {apk.targetSdk ? ` · Target ${apk.targetSdk}` : ''}
                </dd>
                <dt>CPU 架构</dt>
                <dd>{apk.abis.length > 0 ? apk.abis.join(' / ') : '通用（无原生库）'}</dd>
                <dt>启动组件</dt>
                <dd className="mono">{apk.launchActivity?.component ?? '未识别'}</dd>
                <dt>HOME</dt>
                <dd>
                  {apkExportedHomeActivities.length > 1 ? (
                    <select
                      value={apk.selectedHomeComponent ?? ''}
                      disabled={snapshot.busy}
                      onChange={(event) =>
                        applySnapshot(window.adbTool.selectHomeActivity(event.target.value))
                      }
                    >
                      <option value="">请选择 HOME Activity</option>
                      {apkExportedHomeActivities.map((activity) => (
                        <option key={activity.component} value={activity.component}>
                          {activity.component}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="mono">
                      {apk.selectedHomeComponent ??
                        apk.homeActivities[0]?.component ??
                        '未检测到'}
                    </span>
                  )}
                </dd>
              </dl>

              {compatibility && (
                <div
                  className={`precheck ${compatibility.ok ? 'precheck-ok' : 'precheck-error'}`}
                >
                  {compatibility.ok ? (
                    <Check aria-hidden="true" />
                  ) : (
                    <AlertCircle aria-hidden="true" />
                  )}
                  <div>
                    <strong>{compatibility.ok ? '兼容性预检通过' : '兼容性预检未通过'}</strong>
                    {[...compatibility.errors, ...compatibility.warnings].map((message) => (
                      <span key={message}>{message}</span>
                    ))}
                    {deviceApplication && (
                      <span>
                        已匹配设备中的 {deviceApplication.versionName ?? '未知版本'}（
                        {deviceApplication.versionCode ?? '-'}），无需先安装当前 APK
                        即可操作现有应用。
                      </span>
                    )}
                  </div>
                </div>
              )}

              <div className="install-row">
                <ActionButton
                  primary
                  onClick={() => runCommand('app.install')}
                  disabled={installDisabled}
                  title={
                    signatureConflictRecovery
                      ? '签名冲突无法覆盖，请使用下方“卸载旧版并重装”'
                      : isDowngrade && !allowDowngrade
                      ? '请在高级操作中允许调试版降级'
                      : undefined
                  }
                >
                  <Download aria-hidden="true" />
                  {isDowngrade && allowDowngrade ? '降级安装' : '安装 / 更新'}
                </ActionButton>
                <span>
                  设备版本：
                  {apkPackageInstalled
                    ? `${compatibility?.installedPackage.versionName ?? '-'}（${compatibility?.installedPackage.versionCode ?? '-'}）`
                    : '未安装'}
                </span>
              </div>
              <div className="progress-row" aria-live="polite">
                <OperationProgress operation={snapshot.operation} />
              </div>

              {signatureConflictRecovery && (
                <div className="recovery-card" role="alert">
                  <ShieldAlert aria-hidden="true" />
                  <div>
                    <strong>检测到应用签名冲突</strong>
                    <span>
                      设备中的同包名应用不能被当前 APK 覆盖。旧应用仍保留，但当前 APK
                      尚未安装；如无法取得与旧应用相同签名的 APK，只能清除旧应用后重新安装。
                    </span>
                    <small>
                      {replacementBlockedByLauncher
                        ? '该应用当前是默认桌面，请先在设备系统设置中选择其他默认桌面。'
                        : '该操作会永久删除旧应用的本地数据，且无法自动回滚。'}
                    </small>
                  </div>
                  <ActionButton
                    danger
                    onClick={() => runCommand(signatureConflictRecovery.commandId)}
                    disabled={!deviceReady || replacementBlockedByLauncher || snapshot.busy}
                    title={
                      replacementBlockedByLauncher
                        ? '请先在设备系统设置中切换默认桌面，再执行卸载重装'
                        : undefined
                    }
                  >
                    卸载旧版并重装
                  </ActionButton>
                </div>
              )}

              <div className="button-row action-row">
                <ActionButton
                  onClick={() => runCommand('app.launch')}
                  disabled={
                    !deviceReady ||
                    !targetOperational ||
                    !targetLaunchComponent ||
                    snapshot.busy
                  }
                  title={
                    !targetOperational
                      ? '设备中尚未安装该包名对应的应用'
                      : undefined
                  }
                >
                  <Play aria-hidden="true" />
                  启动应用
                </ActionButton>
                <ActionButton
                  onClick={() => runCommand('app.stop')}
                  disabled={!deviceReady || !targetInstalled || snapshot.busy}
                >
                  <CircleStop aria-hidden="true" />
                  停止应用
                </ActionButton>
                <ActionButton
                  onClick={() => runCommand('app.restart')}
                  disabled={
                    !deviceReady ||
                    !targetOperational ||
                    !targetLaunchComponent ||
                    snapshot.busy
                  }
                  title={
                    !targetOperational
                      ? '设备中尚未安装该包名对应的应用'
                      : undefined
                  }
                >
                  <RefreshCw aria-hidden="true" />
                  重启应用
                </ActionButton>
              </div>

            </div>
          ) : deviceApplication ? (
            <div className="apk-summary device-application-summary">
              <div className="apk-heading">
                <div className="app-identity">
                  <span className="app-icon">
                    <Package aria-hidden="true" />
                  </span>
                  <div>
                    <strong>{deviceApplication.packageName}</strong>
                    <span>从目标设备读取 · 无需上传 APK</span>
                  </div>
                </div>
                <StatusBadge
                  tone={exportedHomeActivities.length > 0 ? 'success' : 'neutral'}
                >
                  {exportedHomeActivities.length > 0 ? '支持开机桌面' : '普通应用'}
                </StatusBadge>
              </div>

              <dl className="metadata-grid">
                <dt>版本</dt>
                <dd>
                  {deviceApplication.versionName ?? '-'}（
                  {deviceApplication.versionCode ?? '-'}）
                </dd>
                <dt>包名</dt>
                <dd className="mono">{deviceApplication.packageName}</dd>
                <dt>来源</dt>
                <dd>设备用户 0 中已安装的应用</dd>
                <dt>启动组件</dt>
                <dd className="mono">
                  {deviceApplication.launchActivity?.component ?? '未识别'}
                </dd>
                <dt>HOME</dt>
                <dd>
                  {exportedHomeActivities.length > 1 ? (
                    <select
                      value={targetHomeComponent ?? ''}
                      disabled={snapshot.busy}
                      onChange={(event) =>
                        applySnapshot(window.adbTool.selectHomeActivity(event.target.value))
                      }
                    >
                      <option value="">请选择 HOME Activity</option>
                      {exportedHomeActivities.map((activity) => (
                        <option key={activity.component} value={activity.component}>
                          {activity.component}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="mono">{targetHomeComponent ?? '未检测到'}</span>
                  )}
                </dd>
              </dl>

              <div className="precheck precheck-ok">
                <Check aria-hidden="true" />
                <div>
                  <strong>已读取设备应用</strong>
                  <span>应用控制将直接作用于上述包名，不需要本地 APK。</span>
                </div>
              </div>

              <div className="button-row action-row">
                <ActionButton
                  onClick={() => runCommand('app.launch')}
                  disabled={!deviceReady || !targetLaunchComponent || snapshot.busy}
                  title={!targetLaunchComponent ? '未读取到可启动 Activity' : undefined}
                >
                  <Play aria-hidden="true" />
                  启动应用
                </ActionButton>
                <ActionButton
                  onClick={() => runCommand('app.stop')}
                  disabled={!deviceReady || snapshot.busy}
                >
                  <CircleStop aria-hidden="true" />
                  停止应用
                </ActionButton>
                <ActionButton
                  onClick={() => runCommand('app.restart')}
                  disabled={!deviceReady || !targetLaunchComponent || snapshot.busy}
                  title={!targetLaunchComponent ? '未读取到可启动 Activity' : undefined}
                >
                  <RefreshCw aria-hidden="true" />
                  重启应用
                </ActionButton>
              </div>

            </div>
          ) : (
            <div className="empty-state">
              <Package aria-hidden="true" />
              <strong>尚未指定目标应用</strong>
              <span>选择 APK，或通过应用列表、当前前台、当前桌面、完整包名指定。</span>
            </div>
          )}

          {(apk || deviceApplication) && (
            <details className="advanced advanced-risk-panel">
              <summary>
                <span className="advanced-risk-icon">
                  <ShieldAlert aria-hidden="true" />
                </span>
                <span className="advanced-risk-copy">
                  <strong>高级操作</strong>
                  <small>以下功能可能改变安装策略或造成应用数据丢失。</small>
                </span>
                <span className="advanced-risk-label">谨慎操作</span>
                <ChevronDown className="advanced-risk-chevron" aria-hidden="true" />
              </summary>
              <div className="advanced-content">
                {apk && (
                  <div className="advanced-option">
                    <label
                      className={`check-row ${!isDowngrade || !apk.debuggable ? 'disabled-row' : ''}`}
                    >
                      <input
                        type="checkbox"
                        checked={allowDowngrade}
                        disabled={!isDowngrade || !apk.debuggable || snapshot.busy}
                        onChange={(event) => setAllowDowngrade(event.target.checked)}
                      />
                      <span>
                        允许调试版 APK 降级安装
                        <small>
                          {isDowngrade && !apk.debuggable
                            ? '当前 APK 不是 debuggable 版本，不能使用 ADB -d。'
                            : 'ADB -d 只适用于 debuggable APK；版本不构成降级时保持禁用。'}
                        </small>
                      </span>
                    </label>
                  </div>
                )}
                {(apk || snapshot.systemDeployment) && (
                  <div className="system-deployment-card">
                    <ShieldAlert aria-hidden="true" />
                    <div>
                      <strong>手动系统应用部署</strong>
                      <span>
                        {snapshot.systemDeployment
                          ? `已记录${snapshot.systemDeployment.deploymentMode === 'privileged' ? '特权' : '系统应用'}部署：${snapshot.systemDeployment.appDirectory}`
                          : systemDeploymentMode === 'system'
                            ? '仅供开发/支持人员手动部署；权限准备主流程会按实际权限自动选择模式。'
                            : `手动写入 /system/priv-app，并为 ${privilegedPermissionCount} 项 privileged 权限生成最小白名单。`}
                      </span>
                      {!snapshot.systemDeployment && (
                        <div
                          className="deployment-mode-selector"
                          role="radiogroup"
                          aria-label="系统应用部署模式"
                        >
                          <label>
                            <input
                              type="radio"
                              name="system-deployment-mode"
                              value="system"
                              checked={systemDeploymentMode === 'system'}
                              disabled={snapshot.busy}
                              onChange={() => setSystemDeploymentMode('system')}
                            />
                            <span>
                              <strong>系统应用</strong>
                              <small>/system/app · 不提供 PRIVILEGED 身份</small>
                            </span>
                          </label>
                          <label>
                            <input
                              type="radio"
                              name="system-deployment-mode"
                              value="privileged"
                              checked={systemDeploymentMode === 'privileged'}
                              disabled={snapshot.busy}
                              onChange={() => setSystemDeploymentMode('privileged')}
                            />
                            <span>
                              <strong>特权应用</strong>
                              <small>/system/priv-app · 生成最小权限白名单</small>
                            </span>
                          </label>
                        </div>
                      )}
                    </div>
                    <div className="button-row">
                      <ActionButton
                        danger
                        onClick={() =>
                          runCommand('app.deploySystem', systemDeploymentMode)
                        }
                        disabled={
                          !deviceReady ||
                          !apk ||
                          !rootAccessActive ||
                          (systemDeploymentMode === 'privileged' &&
                            permissionCompatibility?.state !== 'ready') ||
                          snapshot.systemDeployment !== null ||
                          snapshot.busy
                        }
                        title={
                          !apk
                            ? '部署需要重新选择并解析原 APK'
                            : !rootAccessActive
                              ? '请先在右侧获取并验证 Root 权限'
                              : systemDeploymentMode === 'privileged' &&
                                  permissionCompatibility?.state !== 'ready'
                                ? '特权模式要求当前设备权限定义已可靠读取'
                                : snapshot.systemDeployment
                                  ? '已有托管部署，请先回滚'
                                  : undefined
                        }
                      >
                        {systemDeploymentMode === 'privileged'
                          ? '部署为特权应用'
                          : '部署为系统应用'}
                      </ActionButton>
                      <ActionButton
                        danger
                        onClick={() => runCommand('app.rollbackSystem')}
                        disabled={
                          !deviceReady ||
                          !rootAccessActive ||
                          snapshot.systemDeployment === null ||
                          snapshot.busy
                        }
                        title={
                          !rootAccessActive
                            ? '请先重新获取并验证 Root 权限'
                            : undefined
                        }
                      >
                        回滚系统应用部署
                      </ActionButton>
                    </div>
                  </div>
                )}
                <div className="danger-zone">
                  <ShieldAlert aria-hidden="true" />
                  <div>
                    <strong>破坏性数据操作</strong>
                    <span>卸载会删除应用及其数据；系统应用还会在严格路径校验后修改 /system 并重启，均不可自动恢复。</span>
                  </div>
                  <div className="button-row">
                    <ActionButton
                      danger
                      onClick={() => runCommand('app.uninstall')}
                      disabled={!targetInstalled || snapshot.busy}
                    >
                      卸载应用
                    </ActionButton>
                    <ActionButton
                      danger
                      onClick={() => runCommand('app.clearData')}
                      disabled={!targetInstalled || snapshot.busy}
                    >
                      清除应用数据
                    </ActionButton>
                  </div>
                </div>
              </div>
            </details>
          )}

        </section>

        <aside className="side-column">
          <section className="side-section" aria-labelledby="launcher-title">
            <div className="section-title-row">
              <h2 id="launcher-title">
                <Rocket aria-hidden="true" />
                开机应用
              </h2>
            </div>
            <div className="home-state">
              <span>当前桌面</span>
              <strong className="mono">
                {snapshot.launcher.currentComponent ?? '尚未读取'}
              </strong>
            </div>
            <div className="launcher-actions">
              <ActionButton
                primary
                onClick={() => runCommand('launcher.set')}
                disabled={!deviceReady || !launcherReady || snapshot.busy}
              >
                <Rocket aria-hidden="true" />
                设为开机应用
              </ActionButton>
              <ActionButton
                onClick={() => runCommand('launcher.verify')}
                disabled={
                  !deviceReady ||
                  !targetOperational ||
                  !targetHomeComponent ||
                  snapshot.busy
                }
              >
                <Check aria-hidden="true" />
                验证开机应用
              </ActionButton>
              <ActionButton
                onClick={() => runCommand('launcher.rebootVerify')}
                disabled={
                  !deviceReady ||
                  !targetOperational ||
                  !targetHomeComponent ||
                  snapshot.busy
                }
              >
                <RotateCw aria-hidden="true" />
                重启并验证
              </ActionButton>
            </div>
            {!targetHomeComponent && (
              <p className="section-hint">
                选择支持 HOME 的 APK，或按包名读取设备上的 Launcher 应用后可设置。
              </p>
            )}
          </section>

          <section className="side-section" aria-labelledby="system-title">
            <div className="section-title-row">
              <h2 id="system-title">
                <MonitorSmartphone aria-hidden="true" />
                设备与系统
              </h2>
            </div>
            <div className="system-actions">
              <ActionButton
                onClick={() => runCommand('device.reboot')}
                disabled={!deviceReady || snapshot.busy}
              >
                <RotateCw aria-hidden="true" />
                重启设备
              </ActionButton>
              <ActionButton
                onClick={() => runCommand('system.settings')}
                disabled={!deviceReady || snapshot.busy}
              >
                <Settings aria-hidden="true" />
                系统设置
              </ActionButton>
              <ActionButton
                onClick={() => runCommand('system.developerSettings')}
                disabled={!deviceReady || snapshot.busy}
              >
                <Wrench aria-hidden="true" />
                开发者选项
              </ActionButton>
              <ActionButton
                danger
                onClick={() => runCommand('device.rootAccess')}
                disabled={
                  !deviceReady ||
                  !rootAccessEligible ||
                  rootAccessActive ||
                  snapshot.busy
                }
                title={
                  rootAccessActive
                    ? `已验证 ${snapshot.selectedDevice?.rootAccessMode === 'su' ? 'su 0' : 'adbd'} Root 通道`
                    : !rootAccessEligible
                      ? '既不支持标准 adb root，也未检测到设备 su'
                      : undefined
                }
              >
                <ShieldAlert aria-hidden="true" />
                {rootAccessActive ? 'Root 权限已验证' : '获取 Root 权限'}
              </ActionButton>
            </div>
          </section>

          <section className="side-section diagnostics" aria-labelledby="diagnostics-title">
            <div className="section-title-row">
              <h2 id="diagnostics-title">
                <CodeXml aria-hidden="true" />
                环境状态
              </h2>
            </div>
            <dl>
              <dt>ADB 客户端</dt>
              <dd>
                {snapshot.adb.state === 'ready'
                  ? snapshot.adb.version ?? '版本未知'
                  : snapshot.adb.message}
              </dd>
              <dt>ADB Server</dt>
              <dd>
                <span>127.0.0.1:{snapshot.adb.serverPort}（独立）</span>
                <small>{snapshot.adb.message}</small>
              </dd>
              <dt>USB ADB</dt>
              <dd>
                <StatusBadge tone={currentUsbAdbStatus.tone}>
                  {currentUsbAdbStatus.message}
                </StatusBadge>
              </dd>
              <dt>内置 OEM 驱动包</dt>
              <dd>
                <span>{snapshot.driver.message}</span>
                {snapshot.driver.state === 'not-bundled' && (
                  <small>
                    这不代表当前 USB ADB 不可用；实际识别状态以上方“USB ADB”为准。只有设备未被识别时，
                    才需要在 Windows 设备管理器中检查驱动并记录 VID/PID/MI。
                  </small>
                )}
              </dd>
              <dt>目标序列号</dt>
              <dd className="mono">{snapshot.selectedSerial ?? '未选择'}</dd>
              <dt>系统构建</dt>
              <dd>
                {snapshot.selectedDevice
                  ? `${snapshot.selectedDevice.buildType ?? '-'} · ro.debuggable=${snapshot.selectedDevice.debuggable === null ? '-' : Number(snapshot.selectedDevice.debuggable)}`
                  : '尚未读取'}
              </dd>
              <dt>Verified Boot</dt>
              <dd>
                {snapshot.selectedDevice
                  ? `${snapshot.selectedDevice.verifiedBootState ?? '-'} · Bootloader ${snapshot.selectedDevice.bootloaderUnlocked === true ? '已解锁' : snapshot.selectedDevice.bootloaderUnlocked === false ? '已锁定' : '未知'}`
                  : '尚未读取'}
              </dd>
              <dt>ADB 身份</dt>
              <dd>
                {snapshot.selectedDevice?.adbUid === 0
                  ? 'root（uid=0）'
                  : snapshot.selectedDevice?.adbUid
                    ? `shell（uid=${snapshot.selectedDevice.adbUid}）`
                    : '未知'}
              </dd>
              <dt>Root 通道</dt>
              <dd>
                {snapshot.selectedDevice?.rootAccessMode === 'adbd'
                  ? 'adbd（uid=0）'
                  : snapshot.selectedDevice?.rootAccessMode === 'su'
                    ? `su 0（${snapshot.selectedDevice.suPath ?? 'su'}）`
                    : snapshot.selectedDevice?.suPath
                      ? `可尝试 su 0（${snapshot.selectedDevice.suPath}）`
                      : '未验证'}
              </dd>
            </dl>
          </section>
        </aside>
      </main>

      {operationHistoryOpen && (
        <div
          className="operation-history-backdrop"
          role="presentation"
          onMouseDown={() => setOperationHistoryOpen(false)}
        >
          <aside
            className="operation-history-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="operation-history-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="operation-history-header">
              <div>
                <h2 id="operation-history-title">
                  <History aria-hidden="true" />
                  操作记录
                </h2>
                <p>
                  保留最近 100 次操作并跨重启保存；选择记录可查看结果和诊断步骤。
                </p>
              </div>
              <ActionButton
                onClick={() => setOperationHistoryOpen(false)}
                title="关闭操作记录"
              >
                <X aria-hidden="true" />
                <span className="sr-only">关闭</span>
              </ActionButton>
            </header>

            {snapshot.operation.status === 'running' && (
              <section className="operation-running-card" aria-live="polite">
                <LoaderCircle className="spin" aria-hidden="true" />
                <div>
                  <strong>{snapshot.operation.title}</strong>
                  <OperationProgress operation={snapshot.operation} />
                </div>
              </section>
            )}

            <div className="operation-history-toolbar">
              <div
                className="operation-history-filter"
                role="group"
                aria-label="筛选操作记录"
              >
                <button
                  type="button"
                  className={
                    operationHistoryFilter === 'all' ? 'active' : undefined
                  }
                  aria-pressed={operationHistoryFilter === 'all'}
                  onClick={() => applyOperationHistoryFilter('all')}
                >
                  全部 {snapshot.operationHistory.length}
                </button>
                <button
                  type="button"
                  className={
                    operationHistoryFilter === 'error' ? 'active' : undefined
                  }
                  aria-pressed={operationHistoryFilter === 'error'}
                  onClick={() => applyOperationHistoryFilter('error')}
                >
                  失败 {failedOperationCount}
                </button>
              </div>
              <span>最新记录在前</span>
            </div>

            <div className="operation-history-body">
              <nav className="operation-history-list" aria-label="历史操作列表">
                {filteredOperationHistory.length > 0 ? (
                  filteredOperationHistory.map((operation) => (
                    <button
                      type="button"
                      key={operation.id}
                      className={
                        selectedHistoryOperation?.id === operation.id
                          ? 'active'
                          : undefined
                      }
                      aria-current={
                        selectedHistoryOperation?.id === operation.id
                          ? 'true'
                          : undefined
                      }
                      onClick={() => selectHistoryOperation(operation.id)}
                    >
                      <span
                        className={`operation-history-list-icon operation-history-list-icon-${operation.status}`}
                        aria-hidden="true"
                      >
                        {operation.status === 'success' ? (
                          <Check />
                        ) : (
                          <AlertCircle />
                        )}
                      </span>
                      <span className="operation-history-list-copy">
                        <span>
                          <strong>{operation.title}</strong>
                          <time>{formatOperationListTime(operation.finishedAt)}</time>
                        </span>
                        <small>{operation.summary}</small>
                      </span>
                    </button>
                  ))
                ) : (
                  <div className="operation-history-empty">
                    <History aria-hidden="true" />
                    <strong>
                      {operationHistoryFilter === 'error'
                        ? '没有失败记录'
                        : '尚无操作记录'}
                    </strong>
                    <span>
                      {operationHistoryFilter === 'error'
                        ? '当前保留范围内的操作均已成功。'
                        : '完成一次连接、安装或设备操作后会显示在这里。'}
                    </span>
                  </div>
                )}
              </nav>

              <section
                className="operation-history-detail"
                aria-label="所选操作详情"
              >
                {selectedHistoryOperation ? (
                  <>
                    <header className="operation-history-detail-header">
                      <div>
                        <StatusBadge
                          tone={operationStatusTone(
                            selectedHistoryOperation.status
                          )}
                        >
                          {operationStatusText(selectedHistoryOperation.status)}
                        </StatusBadge>
                        <h3>{selectedHistoryOperation.title}</h3>
                      </div>
                      <time>
                        {formatOperationDetailTime(
                          selectedHistoryOperation.finishedAt
                        )}
                      </time>
                    </header>

                    <div className="operation-history-outcome">
                      <strong>{selectedHistoryOperation.summary}</strong>
                      {selectedHistoryOperation.suggestion && (
                        <p>
                          <span>下一步建议</span>
                          {selectedHistoryOperation.suggestion}
                        </p>
                      )}
                    </div>

                    <dl className="operation-history-metadata">
                      <div>
                        <dt>目标设备</dt>
                        <dd className="mono">
                          {selectedHistoryOperation.serial ?? '未指定'}
                        </dd>
                      </div>
                      <div>
                        <dt>连接方式</dt>
                        <dd>
                          {selectedHistoryOperation.connection === 'tcp'
                            ? 'TCP/IP'
                            : selectedHistoryOperation.connection === 'usb'
                              ? 'USB'
                              : '未记录'}
                        </dd>
                      </div>
                      <div>
                        <dt>目标应用</dt>
                        <dd className="mono">
                          {selectedHistoryOperation.packageName ?? '未指定'}
                        </dd>
                      </div>
                      <div>
                        <dt>耗时</dt>
                        <dd>
                          {formatOperationDuration(
                            selectedHistoryOperation.durationMs
                          )}
                        </dd>
                      </div>
                    </dl>

                    <section className="operation-copy-card">
                      <div>
                        <strong>复制什么？</strong>
                        <span>
                          操作摘要适合说明结果；诊断详情包含设备序列号、ADB
                          参数及输出，仅在排查问题时提供给技术支持。
                        </span>
                      </div>
                      <div className="button-row">
                        <ActionButton
                          onClick={() =>
                            copyOperation(
                              selectedHistoryOperation.id,
                              'summary'
                            )
                          }
                        >
                          {copiedOperationAction ===
                          `${selectedHistoryOperation.id}:summary` ? (
                            <Check aria-hidden="true" />
                          ) : (
                            <Clipboard aria-hidden="true" />
                          )}
                          {copiedOperationAction ===
                          `${selectedHistoryOperation.id}:summary`
                            ? '摘要已复制'
                            : '复制操作摘要'}
                        </ActionButton>
                        <ActionButton
                          onClick={() =>
                            copyOperation(
                              selectedHistoryOperation.id,
                              'diagnostics'
                            )
                          }
                        >
                          {copiedOperationAction ===
                          `${selectedHistoryOperation.id}:diagnostics` ? (
                            <Check aria-hidden="true" />
                          ) : (
                            <CodeXml aria-hidden="true" />
                          )}
                          {copiedOperationAction ===
                          `${selectedHistoryOperation.id}:diagnostics`
                            ? '详情已复制'
                            : '复制诊断详情'}
                        </ActionButton>
                      </div>
                    </section>

                    <section className="operation-technical-history">
                      <header>
                        <div>
                          <strong>ADB 诊断步骤</strong>
                          <span>
                            此操作保留 {selectedHistoryOperation.logCount}{' '}
                            条技术步骤。
                          </span>
                        </div>
                        <StatusBadge tone="neutral">
                          {selectedHistoryOperation.logCount} 条
                        </StatusBadge>
                      </header>
                      {operationDetailLoading && !selectedHistoryDetail ? (
                        <div className="operation-technical-empty">
                          正在读取诊断步骤…
                        </div>
                      ) : selectedHistoryDetail &&
                        selectedHistoryDetail.logs.length > 0 ? (
                        <div className="operation-technical-list">
                          {selectedHistoryDetail.logs.map((entry, index) => (
                            <details key={entry.id}>
                              <summary>
                                <span>{index + 1}</span>
                                <strong>{entry.operation}</strong>
                                <time>
                                  {new Date(entry.time).toLocaleTimeString(
                                    'zh-CN',
                                    { hour12: false }
                                  )}
                                </time>
                                <code>
                                  {entry.exitCode === 0
                                    ? '完成'
                                    : `退出码 ${entry.exitCode}`}
                                </code>
                                <ChevronDown aria-hidden="true" />
                              </summary>
                              <div>
                                <dl>
                                  <dt>ADB 参数</dt>
                                  <dd>
                                    <code>
                                      {entry.arguments.join(' ') || '无'}
                                    </code>
                                  </dd>
                                  <dt>耗时</dt>
                                  <dd>
                                    {formatOperationDuration(entry.durationMs)}
                                  </dd>
                                </dl>
                                {entry.stdout.trim() && (
                                  <div>
                                    <strong>标准输出</strong>
                                    <pre>{entry.stdout.trim()}</pre>
                                  </div>
                                )}
                                {entry.stderr.trim() && (
                                  <div>
                                    <strong>标准错误</strong>
                                    <pre>{entry.stderr.trim()}</pre>
                                  </div>
                                )}
                              </div>
                            </details>
                          ))}
                        </div>
                      ) : (
                        <div className="operation-technical-empty">
                          此操作没有执行 ADB 命令，或未产生可记录的技术步骤。
                        </div>
                      )}
                    </section>
                  </>
                ) : (
                  <div className="operation-history-detail-empty">
                    <History aria-hidden="true" />
                    <strong>选择一条操作记录</strong>
                    <span>这里会显示结果、下一步建议和对应的 ADB 诊断步骤。</span>
                  </div>
                )}
              </section>
            </div>
          </aside>
        </div>
      )}

      {applicationPickerOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={() => setApplicationPickerOpen(false)}
        >
          <section
            className="application-picker-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="application-picker-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="application-picker-header">
              <div>
                <h2 id="application-picker-title">选择设备应用</h2>
                <p>仅显示具有启动入口或 HOME 能力的用户 0 应用。</p>
              </div>
              <ActionButton
                onClick={() => setApplicationPickerOpen(false)}
                title="关闭"
              >
                <X aria-hidden="true" />
                <span className="sr-only">关闭</span>
              </ActionButton>
            </header>

            <label className="application-picker-search">
              <Search aria-hidden="true" />
              <input
                type="search"
                value={applicationSearch}
                placeholder="搜索包名或 Activity"
                aria-label="搜索设备应用"
                onChange={(event) => setApplicationSearch(event.target.value)}
              />
            </label>

            <div className="application-picker-list" aria-live="polite">
              {snapshot.busy &&
              snapshot.operation.stage === '读取设备应用列表' &&
              snapshot.deviceApplicationCatalog.applications.length === 0 ? (
                <div className="application-picker-empty">
                  <LoaderCircle className="spin" aria-hidden="true" />
                  <span>正在读取设备应用…</span>
                </div>
              ) : filteredDeviceApplications.length > 0 ? (
                filteredDeviceApplications.map((application) => (
                  <button
                    key={application.packageName}
                    className="application-picker-item"
                    type="button"
                    disabled={snapshot.busy}
                    onClick={() => selectDeviceApplication(application.packageName)}
                  >
                    <span className="application-picker-icon">
                      {application.homeActivities.length > 0 ? (
                        <House aria-hidden="true" />
                      ) : (
                        <Package aria-hidden="true" />
                      )}
                    </span>
                    <span className="application-picker-copy">
                      <strong>{application.packageName}</strong>
                      <small>
                        {application.launchActivity?.name ??
                          application.homeActivities[0]?.name ??
                          '未识别 Activity'}
                      </small>
                    </span>
                    <span className="application-picker-badges">
                      {application.isCurrentHome && (
                        <StatusBadge tone="success">当前桌面</StatusBadge>
                      )}
                      {application.launchActivity && (
                        <StatusBadge tone="neutral">可启动</StatusBadge>
                      )}
                      {application.homeActivities.length > 0 && (
                        <StatusBadge tone="warning">HOME</StatusBadge>
                      )}
                    </span>
                  </button>
                ))
              ) : (
                <div className="application-picker-empty">
                  <Package aria-hidden="true" />
                  <strong>
                    {applicationSearch.trim() ? '没有匹配的应用' : '未查询到可选择应用'}
                  </strong>
                  <span>
                    {applicationSearch.trim()
                      ? '请调整搜索关键字。'
                      : '没有界面入口的应用仍可通过完整包名指定。'}
                  </span>
                </div>
              )}
            </div>

            <footer className="application-picker-actions">
              <span>共 {snapshot.deviceApplicationCatalog.applications.length} 个应用</span>
              <ActionButton
                onClick={() => applySnapshot(window.adbTool.refreshDeviceApplications())}
                disabled={!deviceReady || snapshot.busy}
              >
                <RefreshCw aria-hidden="true" />
                重新读取
              </ActionButton>
            </footer>
          </section>
        </div>
      )}

      {pending && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={() => {
            setPending(null)
            setAcknowledged(false)
          }}
        >
          <section
            className="confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            aria-describedby="confirm-message"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <span className={`confirm-icon ${pending.danger ? 'confirm-icon-danger' : ''}`}>
              {pending.danger ? <ShieldAlert aria-hidden="true" /> : <AlertCircle aria-hidden="true" />}
            </span>
            <div className="confirm-copy">
              <h2 id="confirm-title">{pending.danger ? '确认危险操作' : '确认执行操作'}</h2>
              <p id="confirm-message">{pending.message}</p>
            </div>
            {pending.requiresAcknowledgement && (
              <label className="confirm-acknowledgement">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                />
                <span>{pending.acknowledgementText}</span>
              </label>
            )}
            <div className="confirm-actions">
              <ActionButton
                onClick={() => {
                  setPending(null)
                  setAcknowledged(false)
                }}
              >
                取消
              </ActionButton>
              <ActionButton
                danger={pending.danger}
                primary={!pending.danger}
                disabled={pending.requiresAcknowledgement && !acknowledged}
                onClick={confirmCommand}
              >
                确认执行
              </ActionButton>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

export default App
