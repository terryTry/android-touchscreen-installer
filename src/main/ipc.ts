import { isIP } from 'node:net'
import { clipboard, dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import {
  COMMAND_IDS,
  type AppSnapshot,
  type ConnectionMode
} from '../shared/contracts'
import { IPC_CHANNELS } from '../shared/ipc'
import type { AppController } from './controller'
import type { TerminalSession } from './terminal-session'

const connectionModeSchema = z.enum(['usb', 'tcp'])
const nullableSerialSchema = z.string().trim().min(1).max(1_024).nullable()
const tcpRequestSchema = z.object({
  host: z
    .string()
    .trim()
    .refine((value) => isIP(value) !== 0, '请输入有效的 IPv4 或 IPv6 地址'),
  port: z.number().int().min(1).max(65_535)
})
const apkPathSchema = z.string().trim().min(1).max(4_096)
const packageNameSchema = z
  .string()
  .trim()
  .min(3)
  .max(255)
  .regex(
    /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/,
    '请输入完整包名，例如 com.example.application'
  )
const componentSchema = z.string().trim().min(3).max(1_024)
const operationIdSchema = z.uuid()
const executeSchema = z.object({
  commandId: z.enum(COMMAND_IDS),
  allowDowngrade: z.boolean().optional()
})
function assertTrustedSender(event: IpcMainInvokeEvent, window: BrowserWindow): void {
  if (
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame
  ) {
    throw new Error('已拒绝来自非主窗口的 IPC 请求')
  }
}

export function registerIpcHandlers(
  window: BrowserWindow,
  controller: AppController,
  terminal: TerminalSession
): () => void {
  const channels = Object.values(IPC_CHANNELS).filter(
    (channel) => channel !== IPC_CHANNELS.snapshotChanged && channel !== IPC_CHANNELS.terminalEvent
  )
  for (const channel of channels) {
    ipcMain.removeHandler(channel)
  }

  ipcMain.handle(IPC_CHANNELS.terminalStart, (event, raw: unknown) => {
    assertTrustedSender(event, window)
    return terminal.start(z.object({
      id: z.uuid(), command: z.string().min(1).max(8192), serial: nullableSerialSchema,
      cols: z.number().int().min(20).max(400), rows: z.number().int().min(5).max(200)
    }).strict().parse(raw))
  })
  ipcMain.handle(IPC_CHANNELS.terminalCopy, (event, text: unknown) => {
    assertTrustedSender(event, window)
    clipboard.writeText(z.string().max(2 * 1024 * 1024).parse(text))
  })
  ipcMain.handle(IPC_CHANNELS.terminalPaste, (event) => {
    assertTrustedSender(event, window)
    const text = clipboard.readText()
    if (text.length > 8192) throw new Error('一次粘贴最多 8192 字符。')
    return text
  })
  ipcMain.handle(IPC_CHANNELS.terminalWrite, (event, id: unknown, data: unknown) => {
    assertTrustedSender(event, window)
    terminal.write(z.uuid().parse(id), z.string().min(1).max(8192).parse(data))
  })
  ipcMain.handle(IPC_CHANNELS.terminalStop, (event, id: unknown) => {
    assertTrustedSender(event, window)
    return terminal.stop(z.uuid().parse(id))
  })
  ipcMain.handle(IPC_CHANNELS.terminalAcknowledge, (event, id: unknown, length: unknown) => {
    assertTrustedSender(event, window)
    terminal.acknowledge(z.uuid().parse(id), z.number().int().min(1).max(1024 * 1024).parse(length))
  })

  ipcMain.handle(IPC_CHANNELS.getSnapshot, (event): AppSnapshot => {
    assertTrustedSender(event, window)
    return controller.getSnapshot()
  })

  ipcMain.handle(IPC_CHANNELS.setConnectionMode, async (event, rawMode: unknown) => {
    assertTrustedSender(event, window)
    const mode: ConnectionMode = connectionModeSchema.parse(rawMode)
    return controller.setConnectionMode(mode)
  })

  ipcMain.handle(IPC_CHANNELS.selectDevice, async (event, rawSerial: unknown) => {
    assertTrustedSender(event, window)
    return controller.selectDevice(nullableSerialSchema.parse(rawSerial))
  })

  ipcMain.handle(IPC_CHANNELS.listLanNetworks, (event) => {
    assertTrustedSender(event, window)
    return controller.listLanNetworks()
  })
  ipcMain.handle(IPC_CHANNELS.searchLan, (event, id: unknown, port: unknown) => {
    assertTrustedSender(event, window)
    return controller.searchLan(z.string().min(1).max(512).parse(id), z.number().int().min(1).max(65535).parse(port))
  })
  ipcMain.handle(IPC_CHANNELS.cancelLanSearch, (event) => {
    assertTrustedSender(event, window)
    controller.cancelLanSearch()
  })

  ipcMain.handle(IPC_CHANNELS.connectTcp, async (event, rawRequest: unknown) => {
    assertTrustedSender(event, window)
    return controller.connectTcp(tcpRequestSchema.parse(rawRequest))
  })

  ipcMain.handle(IPC_CHANNELS.repairTcp, async (event) => {
    assertTrustedSender(event, window)
    return controller.repairTcpConnection()
  })

  ipcMain.handle(IPC_CHANNELS.chooseApk, async (event) => {
    assertTrustedSender(event, window)
    const result = await dialog.showOpenDialog(window, {
      title: '选择 Android APK',
      properties: ['openFile'],
      filters: [
        {
          name: 'Android APK',
          extensions: ['apk']
        }
      ]
    })
    const selectedPath = result.filePaths[0]
    if (result.canceled || !selectedPath) return controller.getSnapshot()
    return controller.loadApk(selectedPath)
  })

  ipcMain.handle(IPC_CHANNELS.parseApk, async (event, rawPath: unknown) => {
    assertTrustedSender(event, window)
    return controller.loadApk(apkPathSchema.parse(rawPath))
  })

  ipcMain.handle(IPC_CHANNELS.loadDeviceApplication, async (event, rawPackageName: unknown) => {
    assertTrustedSender(event, window)
    return controller.loadDeviceApplication(packageNameSchema.parse(rawPackageName))
  })

  ipcMain.handle(IPC_CHANNELS.loadForegroundApplication, async (event) => {
    assertTrustedSender(event, window)
    return controller.loadForegroundApplication()
  })

  ipcMain.handle(IPC_CHANNELS.refreshDeviceApplications, async (event) => {
    assertTrustedSender(event, window)
    return controller.refreshDeviceApplications()
  })

  ipcMain.handle(IPC_CHANNELS.selectHomeActivity, async (event, rawComponent: unknown) => {
    assertTrustedSender(event, window)
    return controller.selectHomeActivity(componentSchema.parse(rawComponent))
  })

  ipcMain.handle(IPC_CHANNELS.executeCommand, async (event, rawRequest: unknown) => {
    assertTrustedSender(event, window)
    const request = executeSchema.parse(rawRequest)
    return controller.executeCommand(
      request.allowDowngrade === undefined
        ? { commandId: request.commandId }
        : { commandId: request.commandId, allowDowngrade: request.allowDowngrade }
    )
  })

  ipcMain.handle(
    IPC_CHANNELS.getOperationHistoryDetail,
    (event, rawOperationId: unknown) => {
      assertTrustedSender(event, window)
      return controller.getOperationHistoryDetail(
        operationIdSchema.parse(rawOperationId)
      )
    }
  )

  ipcMain.handle(IPC_CHANNELS.copyOperationSummary, (event, rawOperationId: unknown) => {
    assertTrustedSender(event, window)
    clipboard.writeText(
      controller.formatOperationSummary(operationIdSchema.parse(rawOperationId))
    )
    return true
  })

  ipcMain.handle(
    IPC_CHANNELS.copyOperationDiagnostics,
    (event, rawOperationId: unknown) => {
      assertTrustedSender(event, window)
      clipboard.writeText(
        controller.formatOperationDiagnostics(
          operationIdSchema.parse(rawOperationId)
        )
      )
      return true
    }
  )

  const unsubscribe = controller.subscribe((snapshot) => {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.snapshotChanged, snapshot)
    }
  })

  return () => {
    unsubscribe()
    for (const channel of channels) {
      ipcMain.removeHandler(channel)
    }
  }
}
