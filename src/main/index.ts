import { fileURLToPath } from 'node:url'
import {
  app,
  BrowserWindow,
  Menu,
  session,
  type WebContents
} from 'electron'
import { AdbClient } from './adb-client'
import { ApkInspector } from './apk-inspector'
import { AppController } from './controller'
import { detectDriverStatus } from './driver-status'
import { registerIpcHandlers } from './ipc'
import { configureLogger, writeApplicationError } from './logger'
import { resolveAdbPath, resolveDriverDirectory } from './paths'
import { SettingsStore } from './settings-store'
import { TerminalSession } from './terminal-session'
import { IPC_CHANNELS } from '../shared/ipc'

let mainWindow: BrowserWindow | null = null
let controller: AppController | null = null
let disposeIpc: (() => void) | null = null
let terminal: TerminalSession | null = null
let quitting = false

function requestGracefulQuit(): void {
  app.quit()
}

function denyUnexpectedNavigation(contents: WebContents): void {
  contents.on('will-navigate', (event, navigationUrl) => {
    if (navigationUrl !== contents.getURL()) {
      event.preventDefault()
    }
  })
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
}

function configureContentSecurityPolicy(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const developmentPolicy = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self' http://localhost:* ws://localhost:*",
      "object-src 'none'",
      "frame-src 'none'"
    ].join('; ')
    const productionPolicy = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'none'",
      "object-src 'none'",
      "frame-src 'none'",
      "base-uri 'none'",
      "form-action 'none'"
    ].join('; ')

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [app.isPackaged ? productionPolicy : developmentPolicy]
      }
    })
  })
}

async function createWindow(): Promise<void> {
  const preloadPath = fileURLToPath(new URL('../preload/index.cjs', import.meta.url))
  mainWindow = new BrowserWindow({
    title: '安卓触摸屏安装助手',
    width: 1180,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    show: false,
    autoHideMenuBar: false,
    backgroundColor: '#f4f6f9',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false
    }
  })

  denyUnexpectedNavigation(mainWindow.webContents)
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  const adbPath = resolveAdbPath({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    platform: process.platform,
    environment: process.env
  })
  const driverDirectory = resolveDriverDirectory(
    process.resourcesPath,
    app.getAppPath(),
    app.isPackaged
  )
  controller = new AppController({
    adb: new AdbClient(adbPath),
    settings: new SettingsStore(),
    apkInspector: new ApkInspector(),
    driverStatus: detectDriverStatus(driverDirectory, process.platform),
    clientVersion: app.getVersion()
  })
  const window = mainWindow
  terminal = new TerminalSession(controller, (event) => {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.terminalEvent, event)
    }
  })
  const windowTerminal = terminal
  window.webContents.on('render-process-gone', () => { void windowTerminal.stopCurrent().catch(writeApplicationError) })
  window.webContents.on('did-start-loading', () => { void windowTerminal.stopCurrent().catch(writeApplicationError) })
  disposeIpc = registerIpcHandlers(mainWindow, controller, terminal)
  const deviceController = controller
  const menu = Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    { label: '编辑', role: 'editMenu' },
    {
      label: '设备管理',
      submenu: [{
        id: 'refresh-usb-devices',
        label: '刷新 USB 设备',
        enabled: false,
        click: () => { void deviceController.refreshUsbDevices().catch(writeApplicationError) }
      }]
    }
  ])
  Menu.setApplicationMenu(menu)
  const unsubscribeMenu = deviceController.subscribe((snapshot) => {
    const item = menu.getMenuItemById('refresh-usb-devices')
    if (item) item.enabled = snapshot.adb.state === 'ready' && !snapshot.busy
  })
  mainWindow.once('closed', unsubscribeMenu)

  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && rendererUrl) {
    await mainWindow.loadURL(rendererUrl)
  } else {
    await mainWindow.loadFile(fileURLToPath(new URL('../renderer/index.html', import.meta.url)))
  }

  void controller.initialize().catch(writeApplicationError)
}

const hasLock = app.requestSingleInstanceLock()
if (!hasLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(async () => {
    configureLogger()
    configureContentSecurityPolicy()
    app.on('web-contents-created', (_event, contents) => denyUnexpectedNavigation(contents))
    await createWindow()
  }).catch(writeApplicationError)
}

app.on('window-all-closed', () => {
  app.quit()
})

// 开发终端中断或系统结束进程时，仍优先执行 ADB Server 清理。
process.once('SIGINT', requestGracefulQuit)
process.once('SIGTERM', requestGracefulQuit)
if (process.platform !== 'win32') {
  process.once('SIGHUP', requestGracefulQuit)
}

app.on('before-quit', (event) => {
  if (!controller) return
  if (quitting) {
    event.preventDefault()
    return
  }
  event.preventDefault()
  quitting = true
  disposeIpc?.()
  disposeIpc = null
  const quittingController = controller
  void Promise.resolve(terminal?.dispose())
    .then(() => quittingController.dispose())
    .catch(writeApplicationError)
    .finally(() => {
      controller = null
      app.quit()
    })
})
