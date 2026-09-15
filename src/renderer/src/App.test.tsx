// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AdbToolApi,
  AppSnapshot,
  OperationHistoryDetail,
  OperationHistoryEntry
} from '../../shared/contracts'
import App from './App'

const jsdomGetComputedStyle = window.getComputedStyle.bind(window)

const snapshot: AppSnapshot = {
  revision: 1,
  adb: {
    state: 'ready',
    executablePath: 'C:\\Program Files\\ADB Tool\\resources\\adb.exe',
    version: 'Version 37.0.0',
    serverPort: 5038,
    message: 'ADB 已就绪'
  },
  driver: {
    state: 'package-detected',
    message: 'OEM 驱动包已检测'
  },
  connectionMode: 'usb',
  devices: [
    {
      serial: 'ABC123',
      state: 'device',
      product: 'panel',
      model: 'Touch Panel',
      deviceName: 'panel',
      transport: 'usb'
    }
  ],
  selectedSerial: 'ABC123',
  selectedDevice: {
    serial: 'ABC123',
    state: 'device',
    product: 'panel',
    model: 'Touch Panel',
    deviceName: 'panel',
    transport: 'usb',
    manufacturer: 'Example Devices',
    androidVersion: '12',
    apiLevel: 31,
    abis: ['arm64-v8a'],
    buildType: 'userdebug',
    debuggable: true,
    verifiedBootState: 'orange',
    bootloaderUnlocked: true,
    adbUid: 0,
    suPath: null,
    rootAccessMode: 'adbd',
    physicalResolution: { width: 1920, height: 1080 },
    logicalResolution: { width: 1280, height: 720 }
  },
  selectedApk: {
    token: 'token',
    fileName: 'ExamplePanel.apk',
    fileSize: 1024,
    appName: 'ExamplePanel',
    applicationClassName: 'android.app.Application',
    iconDataUrl: null,
    packageName: 'com.example.touchscreen',
    versionName: '1.3.2',
    versionCode: 10302,
    minSdk: 26,
    targetSdk: 35,
    abis: ['arm64-v8a'],
    debuggable: true,
    declaredPermissions: [
      {
        name: 'android.permission.INTERNET',
        maxSdkVersion: null
      },
      {
        name: 'android.permission.CAMERA',
        maxSdkVersion: null
      },
      {
        name: 'android.permission.SET_TIME',
        maxSdkVersion: null
      }
    ],
    definedPermissions: [],
    homeActivities: [
      {
        name: 'com.example.touchscreen.MainActivity',
        component: 'com.example.touchscreen/com.example.touchscreen.MainActivity',
        exported: true
      }
    ],
    selectedHomeComponent:
      'com.example.touchscreen/com.example.touchscreen.MainActivity',
    launchActivity: {
      name: 'com.example.touchscreen.MainActivity',
      component: 'com.example.touchscreen/com.example.touchscreen.MainActivity',
      exported: true
    },
    warnings: []
  },
  selectedDeviceApplication: null,
  deviceApplicationCatalog: {
    serial: 'ABC123',
    applications: []
  },
  compatibility: {
    ok: true,
    errors: [],
    warnings: [],
    installedPackage: {
      installed: true,
      versionName: '1.3.1',
      versionCode: 10301
    },
    versionRelation: 'upgrade'
  },
  permissionCompatibility: {
    state: 'ready',
    serial: 'ABC123',
    deviceApiLevel: 31,
    permissions: [
      {
        name: 'android.permission.INTERNET',
        maxSdkVersion: null,
        platformApiRange: {
          introducedApiLevel: 1,
          removedApiLevel: null
        },
        sourcePackage: 'android',
        protectionLevel: ['normal'],
        permissionFlags: [],
        availability: 'ready',
        accessPath: 'ready',
        preparation: {
          method: 'automatic',
          label: '安装时自动获得',
          requiresApk: false,
          requiresRoot: false,
          requiresReboot: false,
          blocker: null
        },
        authorization: 'granted',
        reason: '当前设备定义了此普通权限，安装时会按系统规则自动授予。',
        solution: null
      },
      {
        name: 'android.permission.CAMERA',
        maxSdkVersion: null,
        platformApiRange: {
          introducedApiLevel: 1,
          removedApiLevel: null
        },
        sourcePackage: 'android',
        protectionLevel: ['dangerous'],
        permissionFlags: [],
        availability: 'adb-action',
        accessPath: 'adb-action',
        preparation: {
          method: 'pm-grant',
          label: 'ADB pm grant',
          requiresApk: false,
          requiresRoot: false,
          requiresReboot: false,
          blocker: null
        },
        authorization: 'denied',
        reason: '当前设备支持此危险权限，但安装 APK 不等于已经获得运行时授权。',
        solution: '应用需在运行时请求权限并由用户确认。'
      },
      {
        name: 'android.permission.SET_TIME',
        maxSdkVersion: null,
        platformApiRange: {
          introducedApiLevel: 8,
          removedApiLevel: null
        },
        sourcePackage: 'android',
        protectionLevel: ['signature', 'privileged'],
        permissionFlags: [],
        availability: 'adb-action',
        accessPath: 'adb-action',
        preparation: {
          method: 'privileged-allowlist',
          label: 'ADB 特权应用 + 最小权限白名单',
          requiresApk: true,
          requiresRoot: true,
          requiresReboot: true,
          blocker: null
        },
        authorization: 'denied',
        reason: '此权限要求特权应用身份与特权权限白名单。',
        solution: '准备流程会自动部署并回读。'
      }
    ],
    summary: {
      total: 3,
      ready: 1,
      userAction: 0,
      adbAction: 2,
      unavailable: 0,
      notApplicable: 0,
      unknown: 0
    },
    plan: {
      total: 2,
      pmGrant: 1,
      appOps: 0,
      serviceCommand: 0,
      systemApp: 0,
      privilegedAllowlist: 1,
      requiresApk: true,
      requiresRoot: true,
      requiresReboot: true
    },
    systemModification: {
      state: 'possible',
      reason: 'Root 通道已经回读验证；执行系统级准备前仍会验证系统分区可写性。'
    },
    inspectionError: null
  },
  systemDeployment: null,
  launcher: {
    currentComponent: 'com.android.launcher3/.Launcher',
    currentPackage: 'com.android.launcher3',
    originalComponent: 'com.android.launcher3/.Launcher',
    canRestore: true,
    verification: 'mismatched'
  },
  operation: {
    id: 'operation',
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
  },
  operationHistory: [],
  logs: [],
  recentTcp: {
    host: '192.168.1.100',
    port: 5555
  },
  tcpRepair: {
    endpoint: null,
    phase: 'idle',
    probe: 'not-run',
    failureKind: null,
    message: null,
    detail: null,
    serverPort: null
  },
  busy: false,
  commandCatalog: [
    {
      id: 'app.replace',
      displayName: '卸载旧版并重装',
      type: 'workflow',
      argumentTemplate: ['uninstall', '<包名>', '→', 'install'],
      resultParser: 'installed-version',
      risk: 'danger',
      timeoutMs: 300000,
      requiresDevice: true,
      requiresApk: true,
      requiresPackage: true
    },
    {
      id: 'app.uninstall',
      displayName: '卸载应用',
      type: 'adb',
      argumentTemplate: ['uninstall', '<包名>'],
      resultParser: 'success-token',
      risk: 'danger',
      timeoutMs: 120000,
      requiresDevice: true,
      requiresApk: true,
      requiresPackage: true
    }
  ]
}

let api: AdbToolApi

beforeEach(() => {
  Object.defineProperty(window, 'getComputedStyle', {
    configurable: true,
    value: (element: Element) => jsdomGetComputedStyle(element)
  })
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockImplementation(() => ({
      matches: false,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    }))
  })
  api = {
    startTerminal: vi.fn(async () => {}),
    writeTerminal: vi.fn(async () => {}),
    stopTerminal: vi.fn(async () => {}),
    acknowledgeTerminal: vi.fn(async () => {}),
    onTerminal: vi.fn(() => () => {}),
    copyTerminalText: vi.fn(async () => {}),
    readTerminalClipboard: vi.fn(async () => ''),
    getSnapshot: vi.fn(async () => snapshot),
    onSnapshot: vi.fn(() => () => {}),
    setConnectionMode: vi.fn(async () => snapshot),
    selectDevice: vi.fn(async () => snapshot),
    listLanNetworks: vi.fn(async () => []),
    searchLan: vi.fn(async () => ({ candidates: [], cancelled: false, warnings: [] })),
    cancelLanSearch: vi.fn(async () => {}),
    connectTcp: vi.fn(async () => snapshot),
    repairTcpConnection: vi.fn(async () => snapshot),
    chooseApk: vi.fn(async () => snapshot),
    parseDroppedApk: vi.fn(async () => snapshot),
    loadDeviceApplication: vi.fn(async () => snapshot),
    loadForegroundApplication: vi.fn(async () => snapshot),
    refreshDeviceApplications: vi.fn(async () => snapshot),
    selectHomeActivity: vi.fn(async () => snapshot),
    executeCommand: vi.fn(async () => snapshot),
    getOperationHistoryDetail: vi.fn(async () => {
      throw new Error('测试未配置操作详情')
    }),
    copyOperationSummary: vi.fn(async () => true),
    copyOperationDiagnostics: vi.fn(async () => true)
  }
  Object.defineProperty(window, 'adbTool', {
    configurable: true,
    value: api
  })
})

afterEach(() => {
  cleanup()
})

describe('首版界面', () => {
  it('呈现已确认的主操作，不出现明确排除的功能', async () => {
    render(<App />)

    expect(await screen.findByText('安卓触摸屏调试工具')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '返回' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Home' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '最近任务' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '系统设置' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '开发者选项' })).toBeEnabled()
    expect(screen.queryByText('通知栏')).not.toBeInTheDocument()
    expect(screen.queryByText('唤醒屏幕')).not.toBeInTheDocument()
    expect(screen.queryByText('截图')).not.toBeInTheDocument()
    expect(screen.queryByText('文件推送')).not.toBeInTheDocument()
  })

  it('TCP/IP 失败后显示只读探测与修复入口', async () => {
    const failedTcpSnapshot: AppSnapshot = {
      ...snapshot,
      connectionMode: 'tcp',
      tcpRepair: {
        endpoint: { host: '192.0.2.10', port: 5555 },
        phase: 'available',
        probe: 'not-run',
        failureKind: 'network',
        message: 'TCP/IP 连接失败。',
        detail: '可先执行只读端口探测。',
        serverPort: 5038
      },
      operation: {
        ...snapshot.operation,
        status: 'error',
        summary: 'TCP/IP 连接失败。'
      }
    }
    api.getSnapshot = vi.fn(async () => failedTcpSnapshot)
    render(<App />)

    expect(await screen.findByRole('button', { name: '修复 TCP/IP 连接' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: '修复 TCP/IP 连接' }))
    await waitFor(() => expect(api.repairTcpConnection).toHaveBeenCalledOnce())
  })

  it('目标设备只显示设备信息，并在环境状态中明确标注 ADB 客户端版本', async () => {
    render(<App />)

    const targetHeading = await screen.findByRole('heading', { name: '目标设备' })
    const targetPanel = targetHeading.closest('section')
    expect(targetPanel).toHaveTextContent('USB')
    expect(targetPanel).toHaveTextContent('Android 12 · API 31')
    expect(targetPanel).toHaveTextContent('物理分辨率')
    expect(targetPanel).toHaveTextContent('1920 × 1080')
    expect(targetPanel).toHaveTextContent('逻辑分辨率')
    expect(targetPanel).toHaveTextContent('1280 × 720')
    expect(targetPanel).not.toHaveTextContent('Version 37.0.0')

    const adbClientLabel = screen.getByText('ADB 客户端')
    expect(adbClientLabel.nextElementSibling).toHaveTextContent('Version 37.0.0')
    expect(screen.getByText('USB ADB 可用（已识别 1 台）')).toBeInTheDocument()
  })

  it('未内置 OEM 驱动包时不把已经可用的 USB ADB 误报为驱动待配置', async () => {
    const noBundledDriverSnapshot: AppSnapshot = {
      ...snapshot,
      driver: {
        state: 'not-bundled',
        message: '安装包未内置目标触摸屏的已签名 Windows x64 OEM USB 驱动包。'
      }
    }
    api.getSnapshot = vi.fn(async () => noBundledDriverSnapshot)

    render(<App />)

    expect(await screen.findByText('USB ADB 可用（已识别 1 台）')).toBeInTheDocument()
    expect(
      screen.getByText('安装包未内置目标触摸屏的已签名 Windows x64 OEM USB 驱动包。')
    ).toBeInTheDocument()
    expect(screen.getByText(/这不代表当前 USB ADB 不可用/)).toBeInTheDocument()
    expect(screen.queryByText('驱动待配置')).not.toBeInTheDocument()
  })

  it('切换 TCP/IP 时只提交结构化连接模式', async () => {
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'TCP/IP' }))
    expect(api.setConnectionMode).toHaveBeenCalledWith('tcp')
  })

  it('危险操作必须先明确确认', async () => {
    render(<App />)
    fireEvent.click(await screen.findByText('高级操作'))
    fireEvent.click(screen.getByRole('button', { name: '卸载应用' }))

    expect(api.executeCommand).not.toHaveBeenCalled()
    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      '系统应用删除后只能通过重新安装或刷写固件恢复'
    )
    const confirm = screen.getByRole('button', { name: '确认执行' })
    expect(confirm).toBeDisabled()
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: /若目标是系统应用，我接受修改系统分区/
      })
    )
    fireEvent.click(confirm)

    await waitFor(() =>
      expect(api.executeCommand).toHaveBeenCalledWith({ commandId: 'app.uninstall' })
    )
  })

  it('保留高级操作并移除权限面板和恢复桌面入口', async () => {
    render(<App />)

    const advancedTitle = await screen.findByText('高级操作')
    expect(advancedTitle.closest('details')).toHaveClass('advanced-risk-panel')
    expect(screen.queryByText('应用权限与当前设备')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '准备应用权限' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '恢复系统桌面' })).not.toBeInTheDocument()
    expect(screen.getByText('谨慎操作')).toBeInTheDocument()
    expect(screen.getByText(/可能改变安装策略或造成应用数据丢失/)).toBeInTheDocument()
  })

  it('从固定入口查看完整操作历史，并明确区分两种复制内容', async () => {
    const failedId = '11111111-1111-4111-8111-111111111111'
    const successId = '22222222-2222-4222-8222-222222222222'
    const history: OperationHistoryEntry[] = [
      {
        id: failedId,
        commandId: 'app.install',
        status: 'error',
        title: '安装 / 更新',
        summary: '应用安装失败。',
        suggestion: '请检查设备存储空间后重试。',
        serial: 'ABC123',
        connection: 'usb',
        packageName: 'com.example.touchscreen',
        clientVersion: '0.1.0',
        adbVersion: 'Version 37.0.0',
        startedAt: '2026-07-31T03:00:00.000Z',
        finishedAt: '2026-07-31T03:00:02.000Z',
        durationMs: 2_000,
        logCount: 0
      },
      {
        id: successId,
        commandId: 'nav.back',
        status: 'success',
        title: '返回',
        summary: '已发送返回键。',
        suggestion: null,
        serial: 'ABC123',
        connection: 'usb',
        packageName: null,
        clientVersion: '0.1.0',
        adbVersion: 'Version 37.0.0',
        startedAt: '2026-07-31T02:59:00.000Z',
        finishedAt: '2026-07-31T02:59:00.100Z',
        durationMs: 100,
        logCount: 1
      }
    ]
    const historyDetails: Record<string, OperationHistoryDetail> = {
      [failedId]: {
        ...history[0]!,
        logs: []
      },
      [successId]: {
        ...history[1]!,
        logs: [
          {
            id: '33333333-3333-4333-8333-333333333333',
            operationId: successId,
            time: '2026-07-31T02:59:00.050Z',
            clientVersion: '0.1.0',
            adbVersion: 'Version 37.0.0',
            serial: 'ABC123',
            connection: 'usb',
            operation: '返回',
            arguments: [
              '-P',
              '5038',
              '-s',
              'ABC123',
              'shell',
              'input',
              'keyevent',
              'KEYCODE_BACK'
            ],
            stdout: '',
            stderr: '',
            exitCode: 0,
            durationMs: 100
          }
        ]
      }
    }
    const historySnapshot: AppSnapshot = {
      ...snapshot,
      operationHistory: history
    }
    api.getSnapshot = vi.fn(async () => historySnapshot)
    api.getOperationHistoryDetail = vi.fn(async (operationId) => {
      const detail = historyDetails[operationId]
      if (!detail) throw new Error('操作详情不存在')
      return detail
    })

    render(<App />)

    fireEvent.click(
      await screen.findByRole('button', {
        name: '打开操作记录，共 2 条'
      })
    )
    expect(screen.getByRole('dialog', { name: '操作记录' })).toBeInTheDocument()
    expect(document.body).toHaveStyle({ overflow: 'hidden' })
    expect(screen.getByText(/保留最近 100 次操作并跨重启保存/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '全部 2' })).toBePressed()
    expect(screen.getByRole('button', { name: '失败 1' })).toBeInTheDocument()
    expect(screen.getAllByText('应用安装失败。').length).toBeGreaterThan(0)
    expect(screen.getByText(/操作摘要适合说明结果/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '复制操作摘要' }))
    await waitFor(() =>
      expect(api.copyOperationSummary).toHaveBeenCalledWith(failedId)
    )
    fireEvent.click(screen.getByRole('button', { name: '复制诊断详情' }))
    await waitFor(() =>
      expect(api.copyOperationDiagnostics).toHaveBeenCalledWith(failedId)
    )

    fireEvent.click(screen.getByRole('button', { name: /返回.*已发送返回键/ }))
    expect(screen.getByText('ADB 诊断步骤')).toBeInTheDocument()
    expect(screen.getByText('1 条')).toBeInTheDocument()
    expect(await screen.findByText(/KEYCODE_BACK/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '复制结果' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(document.body.style.overflow).toBe('')
  })

  it('未选择 APK 时可按包名读取设备应用', async () => {
    const emptyTargetSnapshot: AppSnapshot = {
      ...snapshot,
      selectedApk: null,
      selectedDeviceApplication: null,
      compatibility: null
    }
    api.getSnapshot = vi.fn(async () => emptyTargetSnapshot)

    render(<App />)

    const packageInput = await screen.findByRole('textbox', { name: '目标应用包名' })
    fireEvent.change(packageInput, {
      target: { value: 'com.example.installed' }
    })
    fireEvent.click(screen.getByRole('button', { name: '读取应用' }))

    await waitFor(() =>
      expect(api.loadDeviceApplication).toHaveBeenCalledWith('com.example.installed')
    )
  })

  it('可将当前桌面应用作为目标应用读取', async () => {
    const emptyTargetSnapshot: AppSnapshot = {
      ...snapshot,
      selectedApk: null,
      selectedDeviceApplication: null,
      compatibility: null
    }
    api.getSnapshot = vi.fn(async () => emptyTargetSnapshot)

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: '使用当前桌面' }))

    await waitFor(() =>
      expect(api.loadDeviceApplication).toHaveBeenCalledWith('com.android.launcher3')
    )
  })

  it('可读取当前前台应用作为目标应用', async () => {
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: '使用当前前台' }))

    expect(api.loadForegroundApplication).toHaveBeenCalledOnce()
  })

  it('可从设备应用列表搜索并选择目标应用', async () => {
    const catalogSnapshot: AppSnapshot = {
      ...snapshot,
      selectedApk: null,
      selectedDeviceApplication: null,
      compatibility: null,
      deviceApplicationCatalog: {
        serial: snapshot.selectedSerial,
        applications: [
          {
            packageName: 'com.example.installed',
            launchActivity: {
              name: 'com.example.installed.MainActivity',
              component: 'com.example.installed/.MainActivity',
              exported: true
            },
            homeActivities: [],
            isCurrentHome: false
          }
        ]
      }
    }
    api.getSnapshot = vi.fn(async () => catalogSnapshot)
    api.refreshDeviceApplications = vi.fn(async () => catalogSnapshot)

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: '选择设备应用' }))

    expect(api.refreshDeviceApplications).toHaveBeenCalledOnce()
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索设备应用' }), {
      target: { value: 'example.installed' }
    })
    fireEvent.click(screen.getByRole('button', { name: /com\.example\.installed/ }))

    await waitFor(() =>
      expect(api.loadDeviceApplication).toHaveBeenCalledWith('com.example.installed')
    )
  })

  it('APK 对应包已安装时允许直接操作设备现有版本', async () => {
    const apkRecognizedSnapshot: AppSnapshot = {
      ...snapshot,
      selectedDeviceApplication: {
        serial: snapshot.selectedSerial!,
        packageName: snapshot.selectedApk!.packageName,
        versionName: '1.3.1',
        versionCode: 10301,
        declaredPermissions: snapshot.selectedApk!.declaredPermissions,
        permissionInspectionError: null,
        launchActivity: snapshot.selectedApk!.launchActivity,
        homeActivities: snapshot.selectedApk!.homeActivities,
        selectedHomeComponent: snapshot.selectedApk!.selectedHomeComponent
      }
    }
    api.getSnapshot = vi.fn(async () => apkRecognizedSnapshot)

    render(<App />)

    expect(await screen.findByRole('button', { name: '启动应用' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '重启应用' })).toBeEnabled()
  })

  it('仅在 Root 已验证后允许选择特权部署，并要求系统风险确认', async () => {
    render(<App />)

    expect(await screen.findByRole('button', { name: 'Root 权限已验证' })).toBeDisabled()
    fireEvent.click(screen.getByRole('radio', { name: /特权应用/ }))
    const deploy = screen.getByRole('button', { name: '部署为特权应用' })
    expect(deploy).toBeEnabled()
    fireEvent.click(deploy)

    const acknowledgement = screen.getByRole('checkbox', {
      name: /确认设备具备刷机恢复手段/
    })
    const confirm = screen.getByRole('button', { name: '确认执行' })
    expect(confirm).toBeDisabled()
    fireEvent.click(acknowledgement)
    fireEvent.click(confirm)
    await waitFor(() =>
      expect(api.executeCommand).toHaveBeenCalledWith({
        commandId: 'app.deploySystem',
        systemDeploymentMode: 'privileged'
      })
    )
  })

  it('默认采用已验证过的 system/app 系统应用模式', async () => {
    render(<App />)

    const deploy = await screen.findByRole('button', { name: '部署为系统应用' })
    expect(screen.getByRole('radio', { name: /系统应用/ })).toBeChecked()
    fireEvent.click(deploy)
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: /确认设备具备刷机恢复手段/
      })
    )
    fireEvent.click(screen.getByRole('button', { name: '确认执行' }))

    await waitFor(() =>
      expect(api.executeCommand).toHaveBeenCalledWith({
        commandId: 'app.deploySystem',
        systemDeploymentMode: 'system'
      })
    )
  })

  it('未获得 Root 时启用 Root 按钮并禁用特权部署', async () => {
    const shellSnapshot: AppSnapshot = {
      ...snapshot,
      selectedDevice: {
        ...snapshot.selectedDevice!,
        adbUid: 2000,
        rootAccessMode: 'none'
      }
    }
    api.getSnapshot = vi.fn(async () => shellSnapshot)

    render(<App />)

    expect(await screen.findByRole('button', { name: '获取 Root 权限' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '部署为系统应用' })).toBeDisabled()
  })

  it('没有本地 APK 时仍显示已有托管部署的回滚入口', async () => {
    const managedDeploymentSnapshot: AppSnapshot = {
      ...snapshot,
      selectedApk: null,
      permissionCompatibility: null,
      selectedDeviceApplication: {
        serial: 'ABC123',
        packageName: 'com.example.touchscreen',
        versionName: '1.3.2',
        versionCode: 10302,
        declaredPermissions: [],
        permissionInspectionError: null,
        launchActivity: null,
        homeActivities: [],
        selectedHomeComponent: null
      },
      systemDeployment: {
        serial: 'ABC123',
        packageName: 'com.example.touchscreen',
        versionCode: 10302,
        deploymentMode: 'system',
        appDirectory: '/system/app/AdbTool_com_example_touchscreen',
        apkPath: '/system/app/AdbTool_com_example_touchscreen/base.apk',
        allowlistPath: null,
        createdAt: '2026-07-30T00:00:00.000Z'
      }
    }
    api.getSnapshot = vi.fn(async () => managedDeploymentSnapshot)

    render(<App />)

    expect(await screen.findByRole('button', { name: '部署为系统应用' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '回滚系统应用部署' })).toBeEnabled()
  })

  it('读取设备应用后无需 APK 即可启用应用和 Launcher 操作', async () => {
    const deviceApplicationSnapshot: AppSnapshot = {
      ...snapshot,
      selectedApk: null,
      selectedDeviceApplication: {
        serial: snapshot.selectedSerial!,
        packageName: 'com.example.installed',
        versionName: '2.1.0',
        versionCode: 20100,
        declaredPermissions: snapshot.selectedApk!.declaredPermissions,
        permissionInspectionError: null,
        launchActivity: {
          name: 'com.example.installed.MainActivity',
          component: 'com.example.installed/.MainActivity',
          exported: true
        },
        homeActivities: [
          {
            name: 'com.example.installed.HomeActivity',
            component: 'com.example.installed/.HomeActivity',
            exported: true
          }
        ],
        selectedHomeComponent: 'com.example.installed/.HomeActivity'
      },
      compatibility: null
    }
    api.getSnapshot = vi.fn(async () => deviceApplicationSnapshot)

    render(<App />)

    expect(await screen.findByText('从目标设备读取 · 无需上传 APK')).toBeInTheDocument()
    expect(screen.queryByText('应用权限与当前设备')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '安装 / 更新' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '启动应用' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '停止应用' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '重启应用' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '设为开机应用' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '验证开机应用' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '重启并验证' })).toBeEnabled()
  })

  it('签名冲突时禁用覆盖安装但允许操作设备中的现有应用', async () => {
    const conflictSnapshot: AppSnapshot = {
      ...snapshot,
      compatibility: {
        ...snapshot.compatibility!,
        installedPackage: {
          installed: true,
          versionName: snapshot.selectedApk!.versionName,
          versionCode: snapshot.selectedApk!.versionCode
        },
        versionRelation: 'same'
      },
      operation: {
        ...snapshot.operation,
        status: 'error',
        commandId: 'app.install',
        summary: '新旧应用签名不一致，无法覆盖安装。',
        suggestion: '卸载重装会清除应用数据。',
        stage: '失败',
        recovery: {
          kind: 'signature-conflict',
          commandId: 'app.replace',
          serial: snapshot.selectedSerial!,
          apkToken: snapshot.selectedApk!.token,
          packageName: snapshot.selectedApk!.packageName
        }
      }
    }
    api.getSnapshot = vi.fn(async () => conflictSnapshot)

    render(<App />)

    const replaceButton = await screen.findByRole('button', { name: '卸载旧版并重装' })
    expect(screen.getByRole('button', { name: '安装 / 更新' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '启动应用' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '停止应用' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '重启应用' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '设为开机应用' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '验证开机应用' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '重启并验证' })).toBeEnabled()

    fireEvent.click(replaceButton)
    const confirmButton = screen.getByRole('button', { name: '确认执行' })
    expect(screen.getByRole('alertdialog')).toHaveTextContent('永久删除')
    expect(confirmButton).toBeDisabled()

    fireEvent.click(
      screen.getByRole('checkbox', {
        name: '我已确认旧应用数据可以删除，并接受新 APK 可能仍安装失败。'
      })
    )
    expect(confirmButton).toBeEnabled()
    fireEvent.click(confirmButton)

    await waitFor(() =>
      expect(api.executeCommand).toHaveBeenCalledWith({ commandId: 'app.replace' })
    )
  })
})
