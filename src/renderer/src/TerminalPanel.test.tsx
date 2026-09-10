// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot } from '../../shared/contracts'
import type { TerminalApi, TerminalEvent } from '../../shared/terminal'

const mock = vi.hoisted(() => ({
  onData: null as null | ((data: string) => void),
  write: vi.fn((_data: string, callback?: () => void) => callback?.()),
  writeln: vi.fn(), focus: vi.fn(), paste: vi.fn(), clear: vi.fn()
}))
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options = {}; cols = 100; rows = 24
    buffer = { active: { length: 0 } }
    write = mock.write; writeln = mock.writeln; focus = mock.focus; paste = mock.paste; clear = mock.clear
    open() {} loadAddon() {} dispose() {} attachCustomKeyEventHandler() {}
    hasSelection() { return false } getSelection() { return '' }
    onData(listener: (data: string) => void) { mock.onData = listener; return { dispose() {} } }
  }
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))
import TerminalPanel from './TerminalPanel'

let api: TerminalApi
let receive: (event: TerminalEvent) => void
const snapshot = {
  selectedSerial: 'ABC', busy: false,
  adb: { state: 'ready', serverPort: 5042 }
} as AppSnapshot

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  api = {
    startTerminal: vi.fn(async () => {}), writeTerminal: vi.fn(async () => {}),
    stopTerminal: vi.fn(async () => {}), acknowledgeTerminal: vi.fn(async () => {}),
    copyTerminalText: vi.fn(async () => {}), readTerminalClipboard: vi.fn(async () => 'devices -l'),
    onTerminal: vi.fn((listener) => { receive = listener; return () => {} })
  }
  Object.defineProperty(window, 'adbTool', { configurable: true, value: api })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

async function execute(command: string): Promise<string> {
  fireEvent.change(screen.getByRole('textbox', { name: 'ADB 命令' }), { target: { value: command } })
  fireEvent.click(screen.getByRole('button', { name: '执行' }))
  await waitFor(() => expect(api.startTerminal).toHaveBeenCalled())
  return vi.mocked(api.startTerminal).mock.calls.at(-1)![0].id
}

describe('ADB 终端面板', () => {
  it('提交当前设备、持续接收输出、确认渲染并恢复历史命令', async () => {
    render(<TerminalPanel snapshot={snapshot} open onClose={() => {}} />)
    const id = await execute('adb devices -l')
    expect(api.startTerminal).toHaveBeenCalledWith({ id, command: 'adb devices -l', serial: 'ABC', cols: 100, rows: 24 })
    act(() => receive({ id, type: 'output', data: 'ABC\tdevice\n' }))
    expect(mock.write).toHaveBeenCalledWith('ABC\tdevice\n', expect.any(Function))
    expect(api.acknowledgeTerminal).toHaveBeenCalledWith(id, 11)
    act(() => receive({ id, type: 'exit', code: 0, stopped: false, message: '进程结束' }))
    const input = screen.getByRole('textbox', { name: 'ADB 命令' })
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(input).toHaveValue('adb devices -l')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input).toHaveValue('')
  })
  it('Shell 中透传中断，收起保留会话，结束按钮停止客户端', async () => {
    const close = vi.fn()
    const { rerender } = render(<TerminalPanel snapshot={snapshot} open onClose={close} />)
    const id = await execute('adb shell')
    act(() => receive({ id, type: 'started', mode: 'shell', serial: 'ABC' }))
    act(() => mock.onData?.('\x03'))
    expect(api.writeTerminal).toHaveBeenCalledWith(id, '\x03')
    expect(api.stopTerminal).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '收起终端' }))
    expect(close).toHaveBeenCalled()
    rerender(<TerminalPanel snapshot={snapshot} open={false} onClose={close} />)
    expect(api.stopTerminal).not.toHaveBeenCalled()
    rerender(<TerminalPanel snapshot={snapshot} open onClose={close} />)
    fireEvent.click(screen.getByRole('button', { name: '结束会话' }))
    expect(api.stopTerminal).toHaveBeenCalledWith(id)
  })
  it('普通命令 Ctrl+C 停止客户端，忽略过期会话消息', async () => {
    render(<TerminalPanel snapshot={snapshot} open onClose={() => {}} />)
    const id = await execute('adb logcat')
    act(() => receive({ id: 'stale', type: 'output', data: 'wrong device' }))
    expect(mock.write).not.toHaveBeenCalled()
    act(() => mock.onData?.('\x03'))
    expect(api.stopTerminal).toHaveBeenCalledWith(id)
  })
  it('粘贴命令不会自动执行，其他工作流忙碌时禁止提交', async () => {
    const { rerender } = render(<TerminalPanel snapshot={snapshot} open onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '粘贴' }))
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'ADB 命令' })).toHaveValue('devices -l'))
    expect(api.startTerminal).not.toHaveBeenCalled()
    rerender(<TerminalPanel snapshot={{ ...snapshot, busy: true }} open onClose={() => {}} />)
    expect(screen.getByRole('button', { name: '执行' })).toBeDisabled()
  })
})

describe('终端快捷输入交互', () => {
  it('常用命令只填入输入框，支持撤销替换，不自动执行', () => {
    render(<TerminalPanel snapshot={snapshot} open onClose={() => {}} />)
    const input = screen.getByRole('textbox', { name: 'ADB 命令' })
    fireEvent.change(input, { target: { value: 'adb shell my-command' } })
    fireEvent.click(screen.getByRole('button', { name: '全部系统属性' }))
    expect(input).toHaveValue('adb shell getprop')
    expect(api.startTerminal).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '撤销填入' }))
    expect(input).toHaveValue('adb shell my-command')
  })
  it('搜索参数命令，带入当前包名并预览，确认填入后仍不执行', () => {
    const state = { ...snapshot, selectedDeviceApplication: { packageName: 'com.current.app' } } as AppSnapshot
    render(<TerminalPanel snapshot={state} open onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '快捷命令' }))
    fireEvent.change(screen.getByRole('textbox', { name: '搜索快捷命令' }), { target: { value: '应用详情' } })
    expect(screen.getByRole('textbox', { name: /应用包名/ })).toHaveValue('com.current.app')
    expect(screen.getByText('adb shell dumpsys package com.current.app')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '填入命令' }))
    expect(screen.queryByRole('dialog', { name: '快捷命令库' })).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'ADB 命令' })).toHaveValue('adb shell dumpsys package com.current.app')
    expect(api.startTerminal).not.toHaveBeenCalled()
  })
  it('缺少参数不能填入，操作命令显示实际影响', () => {
    render(<TerminalPanel snapshot={snapshot} open onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '快捷命令' }))
    fireEvent.change(screen.getByRole('textbox', { name: '搜索快捷命令' }), { target: { value: '清除应用数据' } })
    expect(screen.getByText('会永久删除该应用的数据与登录状态。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '填入命令' })).toBeDisabled()
    fireEvent.change(screen.getByRole('textbox', { name: '应用包名' }), { target: { value: 'com.example.app' } })
    expect(screen.getByRole('button', { name: '填入命令' })).toBeEnabled()
    expect(api.startTerminal).not.toHaveBeenCalled()
  })
  it('Shell 中填入设备命令且不追加回车，不支持的本机命令保持禁用', async () => {
    render(<TerminalPanel snapshot={snapshot} open onClose={() => {}} />)
    const id = await execute('adb shell')
    act(() => receive({ id, type: 'started', mode: 'shell', serial: 'ABC' }))
    fireEvent.click(screen.getByRole('button', { name: '全部系统属性' }))
    expect(mock.paste).toHaveBeenCalledWith('getprop')
    expect(api.writeTerminal).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '进入设备 Shell' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '快捷命令' }))
    fireEvent.change(screen.getByRole('textbox', { name: '搜索快捷命令' }), { target: { value: '安装或覆盖 APK' } })
    expect(screen.getByRole('button', { name: '填入 Shell' })).toBeDisabled()
  })
  it('快捷键打开与 Escape 关闭，搜索无匹配时显示空状态', () => {
    render(<TerminalPanel snapshot={snapshot} open onClose={() => {}} />)
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'ADB 命令' }), { key: 'k', ctrlKey: true })
    const search = screen.getByRole('textbox', { name: '搜索快捷命令' })
    fireEvent.change(search, { target: { value: 'no-such-command-xyz' } })
    expect(screen.getByText('没有匹配命令，试试其他关键词或分类。')).toBeInTheDocument()
    fireEvent.keyDown(search, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '快捷命令库' })).not.toBeInTheDocument()
  })
})
