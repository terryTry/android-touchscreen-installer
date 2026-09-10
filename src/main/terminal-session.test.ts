import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalSession, type TerminalOwner } from './terminal-session'
import type { TerminalEvent, TerminalRequest } from '../shared/terminal'

const request: TerminalRequest = { id: 'one', command: 'adb shell', serial: 'ABC', cols: 100, rows: 24 }
function setup() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(() => true)
  })
  const owner: TerminalOwner = {
    acquireTerminal: vi.fn(async (_id, serial, requiresDevice) => ({ executablePath: '/bundled/adb', serverPort: 5042, serial: requiresDevice ? serial : null })),
    releaseTerminal: vi.fn(async () => {})
  }
  const events: TerminalEvent[] = []
  const spawnProcess = vi.fn((_file: string, _args: readonly string[], _options: object) => child)
  const terminal = new TerminalSession(owner, (event) => events.push(event), spawnProcess as unknown as typeof spawn)
  return { child, owner, events, spawnProcess, terminal }
}

afterEach(() => vi.useRealTimers())

describe('终端会话生命周期', () => {
  it('复用实际 Server 端口并绑定设备，透传输入和 UTF-8 输出', async () => {
    const { terminal, child, events, spawnProcess, owner } = setup()
    await terminal.start(request)
    expect(spawnProcess.mock.calls[0]).toEqual(['/bundled/adb', [
      '-H', '127.0.0.1', '-P', '5042', '-s', 'ABC', 'shell', '-tt',
      'stty cols 100 rows 24; export TERM=xterm-256color; exec /system/bin/sh -i'
    ], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }])
    const input: string[] = []
    child.stdin.on('data', (chunk) => input.push(String(chunk)))
    terminal.write('one', 'cd /sdcard\r')
    terminal.write('one', '\x03')
    expect(input).toEqual(['cd /sdcard\r', '\x03'])
    const bytes = Buffer.from('中文输出')
    child.stdout.write(bytes.subarray(0, 2))
    child.stdout.write(bytes.subarray(2))
    expect(events.filter((event) => event.type === 'output').map((event) => event.data).join('')).toBe('中文输出')
    child.emit('close', 0)
    await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ type: 'exit', code: 0 }))
    expect(owner.releaseTerminal).toHaveBeenCalledWith('one')
  })
  it('高流量时暂停读取，渲染确认后恢复，不累计完整输出', async () => {
    const { terminal, child } = setup()
    await terminal.start(request)
    child.stdout.write('x'.repeat(128 * 1024))
    expect(child.stdout.isPaused()).toBe(true)
    terminal.acknowledge('stale', 128 * 1024)
    expect(child.stdout.isPaused()).toBe(true)
    terminal.acknowledge('one', 128 * 1024)
    expect(child.stdout.isPaused()).toBe(false)
    child.emit('close', 0)
    await terminal.dispose()
  })
  it('关闭会话仅终止客户端，超时强制结束，等待状态刷新后释放', async () => {
    vi.useFakeTimers()
    const { terminal, child, owner, events } = setup()
    await terminal.start(request)
    await expect(terminal.start({ ...request, id: 'two' })).rejects.toThrow('先结束')
    const stop = terminal.stop('one')
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    await vi.advanceTimersByTimeAsync(1000)
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    child.emit('close', null)
    await stop
    expect(owner.releaseTerminal).toHaveBeenCalledTimes(1)
    expect(events.at(-1)).toMatchObject({ type: 'exit', stopped: true })
    expect(() => terminal.write('one', 'reboot\r')).toThrow('已结束')
  })
  it('启动失败和断连都会释放设备操作锁', async () => {
    const { terminal, child, events, owner } = setup()
    await terminal.start(request)
    child.emit('error', new Error('spawn ENOENT'))
    child.emit('close', -2)
    await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ type: 'exit', message: 'spawn ENOENT' }))
    expect(owner.releaseTerminal).toHaveBeenCalledWith('one')
  })
  it('等待设备锁期间退出不会遗留进程或占用', async () => {
    const { terminal, owner, spawnProcess } = setup()
    let unlock!: () => void
    vi.mocked(owner.acquireTerminal).mockImplementation(async () => {
      await new Promise<void>((resolve) => { unlock = resolve })
      return { executablePath: '/adb', serverPort: 5038, serial: 'ABC' }
    })
    const start = terminal.start(request)
    const dispose = terminal.dispose()
    unlock()
    await Promise.all([start, dispose])
    expect(spawnProcess).not.toHaveBeenCalled()
    expect(owner.releaseTerminal).toHaveBeenCalledTimes(1)
  })
  it('查询命令不注入选中的设备', async () => {
    const { terminal, spawnProcess, child } = setup()
    await terminal.start({ ...request, command: 'adb devices -l' })
    expect(spawnProcess.mock.calls[0]?.[1]).toEqual(['-H', '127.0.0.1', '-P', '5042', 'devices', '-l'])
    child.emit('close', 0)
    await terminal.dispose()
  })
})
