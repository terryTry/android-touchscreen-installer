import { describe, expect, it, vi } from 'vitest'
import {
  AdbClient,
  classifyAdbProbeResponse,
  probeTcpEndpoint,
  type AdbExecution,
  type LoopbackPortState
} from './adb-client'

function execution(
  args: string[],
  overrides: Partial<AdbExecution> = {}
): AdbExecution {
  return {
    args,
    stdout: '',
    stderr: '',
    exitCode: 0,
    durationMs: 1,
    timedOut: false,
    ...overrides
  }
}

describe('classifyAdbProbeResponse', () => {
  it('识别 ADB host:version 的成功或失败协议响应', () => {
    expect(classifyAdbProbeResponse('OKAY00040029')).toBe('adb')
    expect(classifyAdbProbeResponse('FAIL0004nope')).toBe('adb')
  })

  it('不会把普通 TCP 响应或未完成响应误判为 ADB Server', () => {
    expect(classifyAdbProbeResponse('HTTP/1.1 200 OK\r\n')).toBe('other')
    expect(classifyAdbProbeResponse('OK')).toBeNull()
  })
})

describe('AdbClient 端口恢复', () => {
  it('重启时始终使用初始化后实际选中的 Server 端口', async () => {
    const probePort = vi
      .fn<(port: number) => Promise<LoopbackPortState>>()
      .mockResolvedValueOnce('free')
      .mockResolvedValueOnce('adb')
      .mockResolvedValueOnce('adb')
    const client = new AdbClient(process.execPath, 5038, { probePort })
    const run = vi.spyOn(client, 'run').mockImplementation(async (args) =>
      execution(args, {
        stdout:
          args[0] === 'version'
            ? 'Android Debug Bridge version 1.0.41\nVersion 36.0.0'
            : '',
        exitCode: 0
      })
    )

    await expect(client.initialize()).resolves.toMatchObject({ ok: true })
    const restarted = await client.restartServer()

    expect(restarted).toMatchObject({ ok: true, serverPort: 5038 })
    expect(run.mock.calls.map(([args]) => args)).toEqual([
      ['version'],
      ['start-server'],
      ['kill-server'],
      ['start-server']
    ])
    expect(probePort.mock.calls.map(([port]) => port)).toEqual([5038, 5038, 5038])
  })

  it('复用外部 ADB Server 时拒绝自动终止外部进程', async () => {
    const probePort = vi
      .fn<(port: number) => Promise<LoopbackPortState>>()
      .mockResolvedValue('adb')
    const client = new AdbClient(process.execPath, 5042, { probePort })
    const run = vi.spyOn(client, 'run').mockImplementation(async (args) =>
      execution(args, {
        stdout:
          args[0] === 'version'
            ? 'Android Debug Bridge version 1.0.41\nVersion 36.0.0'
            : ''
      })
    )

    await client.initialize()
    const restarted = await client.restartServer()

    expect(restarted.ok).toBe(false)
    expect(restarted.message).toContain('复用的是外部 ADB Server')
    expect(run.mock.calls.map(([args]) => args)).toEqual([['version']])
  })

  it('复用外部 ADB Server 时在备用端口启动应用自己的 Server', async () => {
    const probePort = vi
      .fn<(port: number) => Promise<LoopbackPortState>>()
      .mockResolvedValueOnce('adb')
      .mockResolvedValueOnce('free')
      .mockResolvedValueOnce('adb')
    const client = new AdbClient(process.execPath, 5038, { probePort })
    const run = vi.spyOn(client, 'run').mockImplementation(async (args) =>
      execution(args, {
        stdout:
          args[0] === 'version'
            ? 'Android Debug Bridge version 1.0.41\nVersion 36.0.0'
            : ''
      })
    )

    await client.initialize()
    const restarted = await client.restartServer()

    expect(restarted).toMatchObject({ ok: true, serverPort: 5039 })
    expect(restarted.message).toContain('未被终止')
    expect(run.mock.calls.map(([args]) => args)).toEqual([
      ['version'],
      ['start-server']
    ])
    expect(client.serverPort).toBe(5039)
  })

  it('首选端口已有健康 ADB 时直接复用且退出时不误杀', async () => {
    const probePort = vi
      .fn<(port: number) => Promise<LoopbackPortState>>()
      .mockResolvedValue('adb')
    const client = new AdbClient(process.execPath, 5038, { probePort })
    const run = vi.spyOn(client, 'run').mockImplementation(async (args) =>
      execution(args, {
        stdout:
          args[0] === 'version'
            ? 'Android Debug Bridge version 1.0.41\nVersion 36.0.0'
            : ''
      })
    )

    await expect(client.initialize()).resolves.toMatchObject({
      ok: true,
      message: '已复用 127.0.0.1:5038 上运行中的 ADB Server。'
    })
    expect(client.serverPort).toBe(5038)
    expect(run.mock.calls.map(([args]) => args)).toEqual([['version']])

    await client.dispose()
    expect(run.mock.calls.map(([args]) => args)).toEqual([['version']])
  })

  it('首选端口被普通服务占用时自动改用备用端口', async () => {
    const probeCounts = new Map<number, number>()
    const probePort = vi.fn(async (port: number): Promise<LoopbackPortState> => {
      const count = probeCounts.get(port) ?? 0
      probeCounts.set(port, count + 1)
      if (port === 5038) return 'other'
      if (port === 5039) return count === 0 ? 'free' : 'adb'
      return 'other'
    })
    const client = new AdbClient(process.execPath, 5038, { probePort })
    const run = vi.spyOn(client, 'run').mockImplementation(async (args) =>
      execution(args, {
        stdout:
          args[0] === 'version'
            ? 'Android Debug Bridge version 1.0.41\nVersion 36.0.0'
            : ''
      })
    )

    await expect(client.initialize()).resolves.toMatchObject({
      ok: true,
      message:
        '首选端口 5038 不可用，已在备用端口 5039 启动独立 ADB Server。'
    })
    expect(client.serverPort).toBe(5039)
    expect(run.mock.calls.map(([args]) => args)).toEqual([
      ['version'],
      ['start-server']
    ])

    await client.dispose()
    expect(run.mock.calls.map(([args]) => args)).toEqual([
      ['version'],
      ['start-server'],
      ['kill-server']
    ])
  })

  it('候选端口均为普通服务时返回明确错误', async () => {
    const probePort = vi
      .fn<(port: number) => Promise<LoopbackPortState>>()
      .mockResolvedValue('other')
    const client = new AdbClient(process.execPath, 5038, {
      fallbackPortCount: 2,
      probePort
    })
    vi.spyOn(client, 'run').mockImplementation(async (args) =>
      execution(args, {
        stdout:
          args[0] === 'version'
            ? 'Android Debug Bridge version 1.0.41\nVersion 36.0.0'
            : ''
      })
    )

    await expect(client.initialize()).resolves.toMatchObject({
      ok: false,
      message: '端口 5038–5040 均被非 ADB 服务占用或无法启动 ADB。'
    })
    expect(client.serverPort).toBe(5038)
  })
})

describe('probeTcpEndpoint', () => {
  it('对无法建立连接的本机端口返回结构化状态，而不是抛出异常', async () => {
    const probe = await probeTcpEndpoint('127.0.0.1', 65_534, 100)
    expect(['closed', 'unknown']).toContain(probe.status)
  })
})
