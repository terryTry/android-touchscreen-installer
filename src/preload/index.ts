import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AdbToolApi,
  AppSnapshot,
  ConnectionMode,
  ExecuteCommandRequest,
  TcpConnectRequest
} from '../shared/contracts'
import { IPC_CHANNELS } from '../shared/ipc'
import type { TerminalEvent } from '../shared/terminal'

const api: AdbToolApi = {
  copyTerminalText: (text) => ipcRenderer.invoke(IPC_CHANNELS.terminalCopy, text),
  readTerminalClipboard: () => ipcRenderer.invoke(IPC_CHANNELS.terminalPaste),
  startTerminal: (request) => ipcRenderer.invoke(IPC_CHANNELS.terminalStart, request),
  writeTerminal: (id, data) => ipcRenderer.invoke(IPC_CHANNELS.terminalWrite, id, data),
  stopTerminal: (id) => ipcRenderer.invoke(IPC_CHANNELS.terminalStop, id),
  acknowledgeTerminal: (id, length) => ipcRenderer.invoke(IPC_CHANNELS.terminalAcknowledge, id, length),
  onTerminal: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, event: TerminalEvent): void => listener(event)
    ipcRenderer.on(IPC_CHANNELS.terminalEvent, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.terminalEvent, handler)
  },
  getSnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.getSnapshot),
  onSnapshot: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: AppSnapshot): void => {
      listener(snapshot)
    }
    ipcRenderer.on(IPC_CHANNELS.snapshotChanged, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.snapshotChanged, handler)
  },
  setConnectionMode: (mode: ConnectionMode) =>
    ipcRenderer.invoke(IPC_CHANNELS.setConnectionMode, mode),
  selectDevice: (serial: string | null) =>
    ipcRenderer.invoke(IPC_CHANNELS.selectDevice, serial),
  listLanNetworks: () => ipcRenderer.invoke(IPC_CHANNELS.listLanNetworks),
  searchLan: (id, port) => ipcRenderer.invoke(IPC_CHANNELS.searchLan, id, port),
  cancelLanSearch: () => ipcRenderer.invoke(IPC_CHANNELS.cancelLanSearch),
  connectTcp: (request: TcpConnectRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.connectTcp, request),
  repairTcpConnection: () => ipcRenderer.invoke(IPC_CHANNELS.repairTcp),
  chooseApk: () => ipcRenderer.invoke(IPC_CHANNELS.chooseApk),
  parseDroppedApk: (file: File) => {
    const filePath = webUtils.getPathForFile(file)
    if (!filePath) {
      return Promise.reject(new Error('无法读取拖入文件的本地路径'))
    }
    return ipcRenderer.invoke(IPC_CHANNELS.parseApk, filePath)
  },
  loadDeviceApplication: (packageName: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.loadDeviceApplication, packageName),
  loadForegroundApplication: () =>
    ipcRenderer.invoke(IPC_CHANNELS.loadForegroundApplication),
  refreshDeviceApplications: () =>
    ipcRenderer.invoke(IPC_CHANNELS.refreshDeviceApplications),
  selectHomeActivity: (component: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.selectHomeActivity, component),
  executeCommand: (request: ExecuteCommandRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.executeCommand, request),
  getOperationHistoryDetail: (operationId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.getOperationHistoryDetail, operationId),
  copyOperationSummary: (operationId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.copyOperationSummary, operationId),
  copyOperationDiagnostics: (operationId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.copyOperationDiagnostics, operationId)
}

contextBridge.exposeInMainWorld('adbTool', api)
