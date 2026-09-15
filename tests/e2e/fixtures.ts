import { test as base, expect, type Page } from '@playwright/test'
import { COMMAND_CATALOG } from '../../src/main/command-catalog'
import type { AdbToolApi, ApkInfo, AppSnapshot, DeviceApplicationInfo, OperationHistoryDetail } from '../../src/shared/contracts'
import type { TerminalEvent } from '../../src/shared/terminal'

export const apk: ApkInfo = {
  token: 'fixture-apk', fileName: 'panel.apk', fileSize: 5 * 1024 * 1024,
  appName: '测试触摸屏', applicationClassName: null, iconDataUrl: null,
  packageName: 'com.example.panel', versionName: '2.0.0', versionCode: 200,
  minSdk: 26, targetSdk: 35, abis: ['arm64-v8a'], debuggable: true,
  declaredPermissions: [], definedPermissions: [], warnings: [],
  launchActivity: { name: 'MainActivity', component: 'com.example.panel/.MainActivity', exported: true },
  homeActivities: [{ name: 'HomeActivity', component: 'com.example.panel/.HomeActivity', exported: true }],
  selectedHomeComponent: 'com.example.panel/.HomeActivity'
}

export const deviceApplication: DeviceApplicationInfo = {
  serial: 'E2E-USB-001', packageName: apk.packageName, versionName: '1.0.0', versionCode: 100,
  declaredPermissions: [], permissionInspectionError: null, launchActivity: apk.launchActivity,
  homeActivities: apk.homeActivities, selectedHomeComponent: apk.selectedHomeComponent
}

export function snapshot(overrides: Partial<AppSnapshot> = {}): AppSnapshot {
  const device: AppSnapshot['selectedDevice'] = {
    serial: 'E2E-USB-001', state: 'device', product: 'panel', model: '测试触摸屏',
    deviceName: 'panel', transport: 'usb', manufacturer: 'Example', androidVersion: '12',
    apiLevel: 31, abis: ['arm64-v8a'], buildType: 'userdebug', debuggable: true,
    verifiedBootState: 'orange', bootloaderUnlocked: true, adbUid: 2000, suPath: null,
    rootAccessMode: 'none', physicalResolution: { width: 1920, height: 1080 },
    logicalResolution: { width: 1280, height: 720 }
  }
  return {
    revision: 1,
    adb: { state: 'ready', executablePath: '/fixture/adb', version: '37.0.0', serverPort: 5042, message: 'ADB 已就绪' },
    driver: { state: 'not-bundled', message: '未内置 OEM 驱动包' },
    connectionMode: 'usb', devices: [device], selectedSerial: device.serial, selectedDevice: device,
    selectedApk: null, selectedDeviceApplication: null,
    deviceApplicationCatalog: { serial: device.serial, applications: [] },
    compatibility: null, permissionCompatibility: null, systemDeployment: null,
    launcher: { currentComponent: 'com.android.launcher/.Home', currentPackage: 'com.android.launcher', originalComponent: null, canRestore: false, verification: 'unknown' },
    operation: { id: 'idle', commandId: null, status: 'idle', title: '等待操作', summary: '请选择应用', suggestion: null, stage: null, progress: null, startedAt: null, finishedAt: null, durationMs: null, recovery: null },
    operationHistory: [], logs: [], recentTcp: { host: '', port: 5555 },
    tcpRepair: { endpoint: null, phase: 'idle', probe: 'not-run', failureKind: null, message: null, detail: null, serverPort: null },
    busy: false, commandCatalog: COMMAND_CATALOG,
    ...overrides
  }
}

export function apkSnapshot(overrides: Partial<AppSnapshot> = {}): AppSnapshot {
  return snapshot({
    selectedApk: apk,
    compatibility: { ok: true, errors: [], warnings: [], installedPackage: { installed: true, versionName: '1.0.0', versionCode: 100 }, versionRelation: 'upgrade' },
    ...overrides
  })
}

type Method = Exclude<keyof AdbToolApi, 'onSnapshot' | 'onTerminal'>
type Reply = { value?: unknown; error?: string }
interface Call { method: Method; args: unknown[] }
interface Bridge {
  calls: Call[]
  replies: Partial<Record<Method, Reply[]>>
  publish: (value: AppSnapshot) => void
  emit: (event: TerminalEvent) => void
}

declare global { interface Window { __adbE2E: Bridge } }

class Harness {
  constructor(readonly page: Page) {}

  async open(initial = snapshot()) {
    // 只替换 Preload 边界；页面、样式和 xterm 全部使用生产源文件。
    await this.page.addInitScript((initialSnapshot) => {
      let state = initialSnapshot
      const snapshots = new Set<(value: AppSnapshot) => void>()
      const terminals = new Set<(value: TerminalEvent) => void>()
      const bridge: Bridge = {
        calls: [], replies: {},
        publish(value) {
          state = structuredClone(value)
          for (const listener of snapshots) listener(structuredClone(state))
        },
        emit(event) { for (const listener of terminals) listener(event) }
      }
      window.__adbE2E = bridge
      const invoke = async <T>(method: Method, args: unknown[], fallback: T): Promise<T> => {
        bridge.calls.push({ method, args })
        const reply = bridge.replies[method]?.shift()
        if (reply?.error) throw new Error(reply.error)
        return structuredClone(reply && 'value' in reply ? reply.value : fallback) as T
      }
      const current = async (method: Method, args: unknown[] = []) => {
        state = await invoke(method, args, state)
        return structuredClone(state)
      }
      window.adbTool = {
        getSnapshot: () => current('getSnapshot'),
        onSnapshot: (listener) => { snapshots.add(listener); return () => { snapshots.delete(listener) } },
        onTerminal: (listener) => { terminals.add(listener); return () => { terminals.delete(listener) } },
        setConnectionMode: (mode) => current('setConnectionMode', [mode]),
        selectDevice: (serial) => current('selectDevice', [serial]),
        listLanNetworks: () => invoke('listLanNetworks', [], []),
        searchLan: (id, port) => invoke('searchLan', [id, port], { candidates: [], cancelled: false, warnings: [] }),
        cancelLanSearch: () => invoke('cancelLanSearch', [], undefined),
        connectTcp: (request) => current('connectTcp', [request]),
        repairTcpConnection: () => current('repairTcpConnection'),
        chooseApk: () => current('chooseApk'),
        parseDroppedApk: (file) => current('parseDroppedApk', [{ name: file.name, size: file.size, type: file.type }]),
        loadDeviceApplication: (name) => current('loadDeviceApplication', [name]),
        loadForegroundApplication: () => current('loadForegroundApplication'),
        refreshDeviceApplications: () => current('refreshDeviceApplications'),
        selectHomeActivity: (component) => current('selectHomeActivity', [component]),
        executeCommand: (request) => current('executeCommand', [request]),
        getOperationHistoryDetail: (id) => {
          if (!bridge.replies.getOperationHistoryDetail?.length) throw new Error('请为操作记录详情配置测试响应')
          return invoke<OperationHistoryDetail>('getOperationHistoryDetail', [id], {} as OperationHistoryDetail)
        },
        copyOperationSummary: (id) => invoke('copyOperationSummary', [id], true),
        copyOperationDiagnostics: (id) => invoke('copyOperationDiagnostics', [id], true),
        startTerminal: (request) => invoke('startTerminal', [request], undefined),
        writeTerminal: (id, data) => invoke('writeTerminal', [id, data], undefined),
        stopTerminal: (id) => invoke('stopTerminal', [id], undefined),
        acknowledgeTerminal: (id, length) => invoke('acknowledgeTerminal', [id, length], undefined),
        copyTerminalText: (text) => invoke('copyTerminalText', [text], undefined),
        readTerminalClipboard: () => invoke('readTerminalClipboard', [], '')
      } satisfies AdbToolApi
    }, initial)
    await this.page.goto('/')
    await expect(this.page).toHaveTitle('安卓触摸屏调试工具')
    await expect(this.page.getByRole('heading', { name: '安卓触摸屏调试工具' })).toBeVisible()
  }

  async reply<M extends Method>(method: M, value: Awaited<ReturnType<AdbToolApi[M]>>) {
    await this.page.evaluate(({ method, value }) => {
      const queue: Reply[] = window.__adbE2E.replies[method] ?? []
      queue.push({ value })
      window.__adbE2E.replies[method] = queue
    }, { method, value })
  }
  async reject(method: Method, error: string) {
    await this.page.evaluate(({ method, error }) => {
      (window.__adbE2E.replies[method] ??= []).push({ error })
    }, { method, error })
  }
  async publish(value: AppSnapshot) { await this.page.evaluate((value) => window.__adbE2E.publish(value), value) }
  async emit(event: TerminalEvent) { await this.page.evaluate((event) => window.__adbE2E.emit(event), event) }
  async calls(method: Method) { return this.page.evaluate((method) => window.__adbE2E.calls.filter((call) => call.method === method).map((call) => call.args), method) }
  async expectCalls(method: Method, args: unknown[][]) { await expect.poll(() => this.calls(method)).toEqual(args) }
  async advanced() { await this.page.locator('summary').filter({ hasText: '高级操作' }).click() }
}

export const test = base.extend<{ app: Harness }>({
  app: async ({ page }, use) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await use(new Harness(page))
    expect(errors, '浏览器不应出现未处理的异常').toEqual([])
  }
})
export { expect }

export function historyDetail(id: string, status: 'success' | 'error'): OperationHistoryDetail {
  return {
    id, commandId: 'app.install', status, title: status === 'success' ? '安装成功记录' : '安装失败记录',
    summary: status === 'success' ? '安装成功，版本已验证。' : '设备存储空间不足。',
    suggestion: status === 'error' ? '释放设备存储空间后重试。' : null,
    serial: 'E2E-USB-001', connection: 'usb', packageName: apk.packageName, clientVersion: '0.2.1-rc.1', adbVersion: '37.0.0',
    startedAt: '2026-09-14T01:00:00Z', finishedAt: '2026-09-14T01:00:02Z', durationMs: 2000, logCount: 1,
    logs: [{ id: `${id}-log`, operationId: id, time: '2026-09-14T01:00:01Z', clientVersion: '0.2.1-rc.1', adbVersion: '37.0.0', serial: 'E2E-USB-001', connection: 'usb', operation: 'Package Manager 安装', arguments: ['-s', 'E2E-USB-001', 'shell', 'pm', 'install', '/data/local/tmp/panel.apk'], stdout: status === 'success' ? 'Success' : '', stderr: status === 'error' ? 'INSTALL_FAILED_INSUFFICIENT_STORAGE' : '', exitCode: status === 'success' ? 0 : 1, durationMs: 2000 }]
  }
}
