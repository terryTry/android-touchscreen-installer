import { existsSync } from 'node:fs'
import { Socket } from 'node:net'
import { execa } from 'execa'
import type { TcpProbeStatus } from '../shared/contracts'

export interface AdbRunOptions {
  serial?: string
  timeoutMs?: number
  onOutput?: (chunk: string) => void
  /** 通过子进程标准输入传输本地文件，不把文件内容放入命令参数。 */
  inputFile?: string
}

export interface AdbExecution {
  args: string[]
  stdout: string
  stderr: string
  exitCode: number
  durationMs: number
  timedOut: boolean
}

export interface AdbInitialization {
  ok: boolean
  version: string | null
  message: string
}

export interface TcpEndpointProbe {
  status: Exclude<TcpProbeStatus, 'not-run'>
  detail: string
}

export interface AdbServerRestartResult {
  ok: boolean
  serverPort: number
  message: string
  kill: AdbExecution
  start: AdbExecution
}

export interface AdbGateway {
  readonly executablePath: string
  readonly serverPort: number
  readonly version: string | null
  initialize(): Promise<AdbInitialization>
  run(args: string[], options?: AdbRunOptions): Promise<AdbExecution>
  probeTcpEndpoint(
    host: string,
    port: number,
    timeoutMs?: number
  ): Promise<TcpEndpointProbe>
  restartServer(): Promise<AdbServerRestartResult>
  dispose(): Promise<void>
}

export type LoopbackPortState = 'free' | 'adb' | 'other'

export interface AdbClientOptions {
  fallbackPortCount?: number
  probePort?: (port: number) => Promise<LoopbackPortState>
}

interface ServerSelection {
  ok: boolean
  mode: 'started' | 'reused' | null
  port: number
  skippedPorts: number[]
  error: string | null
}

const ADB_VERSION_REQUEST = '000chost:version'

export function classifyAdbProbeResponse(
  response: string
): Exclude<LoopbackPortState, 'free'> | null {
  if (response.length < 4) return null
  const status = response.slice(0, 4)
  return status === 'OKAY' || status === 'FAIL' ? 'adb' : 'other'
}

export function probeLoopbackPort(
  port: number,
  timeoutMs = 800
): Promise<LoopbackPortState> {
  return new Promise((resolve) => {
    const socket = new Socket()
    let connected = false
    let settled = false
    let response = ''

    const finish = (state: LoopbackPortState): void => {
      if (settled) return
      settled = true
      socket.removeAllListeners()
      socket.destroy()
      resolve(state)
    }

    socket.setTimeout(timeoutMs)
    socket.once('connect', () => {
      connected = true
      socket.write(ADB_VERSION_REQUEST)
    })
    socket.on('data', (chunk: Buffer) => {
      response += chunk.toString('ascii')
      const state = classifyAdbProbeResponse(response)
      if (state) finish(state)
    })
    socket.once('timeout', () => finish(connected ? 'other' : 'free'))
    socket.once('error', (error: NodeJS.ErrnoException) => {
      finish(!connected && error.code === 'ECONNREFUSED' ? 'free' : 'other')
    })
    socket.once('close', () => finish(connected ? 'other' : 'free'))
    socket.connect(port, '127.0.0.1')
  })
}

/** 只建立 TCP 握手，不发送任何 ADB 或设备端命令。 */
export function probeTcpEndpoint(
  host: string,
  port: number,
  timeoutMs = 1_500
): Promise<TcpEndpointProbe> {
  return new Promise((resolve) => {
    const socket = new Socket()
    let settled = false

    const finish = (status: Exclude<TcpProbeStatus, 'not-run'>, detail: string): void => {
      if (settled) return
      settled = true
      socket.removeAllListeners()
      socket.destroy()
      resolve({ status, detail })
    }

    socket.setTimeout(timeoutMs)
    socket.once('connect', () => {
      finish('open', `TCP 握手成功，${host}:${port} 端口可达；这只证明端口已监听，不代表一定提供 ADB 服务。`)
    })
    socket.once('timeout', () => {
      finish('timeout', `连接 ${host}:${port} 超时，未能完成 TCP 握手。`)
    })
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED') {
        finish('closed', `${host}:${port} 可达，但目标端口拒绝连接，当前没有可用监听服务。`)
        return
      }
      if (error.code === 'EHOSTUNREACH' || error.code === 'ENETUNREACH') {
        finish('unreachable', `无法到达 ${host}:${port}，请检查 IP、路由、VPN、VLAN 或 Wi-Fi 客户端隔离。`)
        return
      }
      finish('unknown', `目标端口探测失败：${error.code ?? '未知网络错误'}。`)
    })
    socket.once('close', () => {
      finish('unknown', `目标端口 ${host}:${port} 在探测完成前关闭连接。`)
    })
    socket.connect(port, host)
  })
}

function failedExecution(args: string[], message: string): AdbExecution {
  return {
    args,
    stdout: '',
    stderr: message,
    exitCode: 1,
    durationMs: 0,
    timedOut: false
  }
}

export class AdbClient implements AdbGateway {
  readonly executablePath: string
  version: string | null = null
  private readonly preferredServerPort: number
  private readonly fallbackPortCount: number
  private readonly probePort: (port: number) => Promise<LoopbackPortState>
  private activeServerPort: number
  private ownsServer = false
  private initialized = false

  constructor(
    executablePath: string,
    serverPort = 5038,
    options: AdbClientOptions = {}
  ) {
    if (!Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65_535) {
      throw new RangeError(`ADB Server 端口无效：${serverPort}`)
    }
    this.executablePath = executablePath
    this.preferredServerPort = serverPort
    this.activeServerPort = serverPort
    this.fallbackPortCount = Math.max(
      0,
      Math.trunc(options.fallbackPortCount ?? 10)
    )
    this.probePort = options.probePort ?? probeLoopbackPort
  }

  get serverPort(): number {
    return this.activeServerPort
  }

  async initialize(): Promise<AdbInitialization> {
    if (this.initialized) {
      return {
        ok: true,
        version: this.version,
        message: `ADB 已就绪，当前 Server 端口 ${this.serverPort}`
      }
    }

    if (!existsSync(this.executablePath)) {
      return {
        ok: false,
        version: null,
        message: `找不到内置 ADB：${this.executablePath}`
      }
    }

    const versionResult = await this.run(['version'], { timeoutMs: 8_000 })
    if (versionResult.exitCode !== 0) {
      return {
        ok: false,
        version: null,
        message: versionResult.stderr || 'ADB 无法启动。'
      }
    }

    this.version =
      versionResult.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.startsWith('Version ')) ?? versionResult.stdout.split(/\r?\n/)[0] ?? '未知版本'

    const selection = await this.selectServer()
    if (!selection.ok) {
      this.activeServerPort = this.preferredServerPort
      return {
        ok: false,
        version: this.version,
        message: selection.error ?? '没有可用的 ADB Server 端口。'
      }
    }

    this.initialized = true
    const skippedPreferredPort =
      selection.port !== this.preferredServerPort ||
      selection.skippedPorts.includes(this.preferredServerPort)
    const message =
      selection.mode === 'reused'
        ? skippedPreferredPort
          ? `首选端口 ${this.preferredServerPort} 不可用，已复用 127.0.0.1:${selection.port} 上运行中的 ADB Server。`
          : `已复用 127.0.0.1:${selection.port} 上运行中的 ADB Server。`
        : skippedPreferredPort
          ? `首选端口 ${this.preferredServerPort} 不可用，已在备用端口 ${selection.port} 启动独立 ADB Server。`
          : `ADB 已就绪，独立 Server 端口 ${selection.port}`

    return {
      ok: true,
      version: this.version,
      message
    }
  }

  private async selectServer(): Promise<ServerSelection> {
    const skippedPorts: number[] = []
    let lastError: string | null = null

    for (let offset = 0; offset <= this.fallbackPortCount; offset += 1) {
      const candidatePort = this.preferredServerPort + offset
      if (candidatePort > 65_535) break
      this.activeServerPort = candidatePort

      const currentState = await this.probePort(candidatePort)
      if (currentState === 'adb') {
        this.ownsServer = false
        return {
          ok: true,
          mode: 'reused',
          port: candidatePort,
          skippedPorts,
          error: null
        }
      }
      if (currentState === 'other') {
        skippedPorts.push(candidatePort)
        continue
      }

      const startResult = await this.run(['start-server'], {
        timeoutMs: 12_000
      })
      const startedState = await this.probePort(candidatePort)
      if (startedState === 'adb') {
        this.ownsServer =
          startResult.exitCode === 0 && !startResult.timedOut
        return {
          ok: true,
          mode: this.ownsServer ? 'started' : 'reused',
          port: candidatePort,
          skippedPorts,
          error: null
        }
      }

      lastError =
        startResult.stderr.trim() ||
        startResult.stdout.trim() ||
        `端口 ${candidatePort} 上的 ADB Server 启动后未能响应。`
      skippedPorts.push(candidatePort)
    }

    const finalPort = Math.min(
      65_535,
      this.preferredServerPort + this.fallbackPortCount
    )
    const portRange =
      finalPort === this.preferredServerPort
        ? String(this.preferredServerPort)
        : `${this.preferredServerPort}–${finalPort}`
    return {
      ok: false,
      mode: null,
      port: this.preferredServerPort,
      skippedPorts,
      error: `端口 ${portRange} 均被非 ADB 服务占用或无法启动 ADB。${lastError ? ` ${lastError}` : ''}`
    }
  }

  async run(args: string[], options: AdbRunOptions = {}): Promise<AdbExecution> {
    const startedAt = Date.now()
    const fullArgs = [
      '-P',
      String(this.serverPort),
      ...(options.serial ? ['-s', options.serial] : []),
      ...args
    ]

    try {
      const subprocess = execa(this.executablePath, fullArgs, {
        shell: false,
        windowsHide: true,
        reject: false,
        timeout: options.timeoutMs ?? 30_000,
        maxBuffer: 16 * 1024 * 1024,
        stripFinalNewline: false,
        ...(options.inputFile ? { inputFile: options.inputFile } : {})
      })

      if (options.onOutput) {
        subprocess.stdout?.on('data', (chunk: Buffer | string) => options.onOutput?.(String(chunk)))
        subprocess.stderr?.on('data', (chunk: Buffer | string) => options.onOutput?.(String(chunk)))
      }

      const result = await subprocess
      return {
        args: fullArgs,
        stdout: typeof result.stdout === 'string' ? result.stdout : '',
        stderr: typeof result.stderr === 'string' ? result.stderr : '',
        exitCode: result.exitCode ?? 1,
        durationMs: Date.now() - startedAt,
        timedOut: result.timedOut
      }
    } catch (error) {
      return {
        args: fullArgs,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: 1,
        durationMs: Date.now() - startedAt,
        timedOut: false
      }
    }
  }

  async probeTcpEndpoint(
    host: string,
    port: number,
    timeoutMs = 1_500
  ): Promise<TcpEndpointProbe> {
    return probeTcpEndpoint(host, port, timeoutMs)
  }

  async restartServer(): Promise<AdbServerRestartResult> {
    const killArgs = ['kill-server']
    const startArgs = ['start-server']
    if (!this.initialized) {
      const message = '当前 ADB 尚未初始化，不能重启应用内 Server。'
      return {
        ok: false,
        serverPort: this.serverPort,
        message,
        kill: failedExecution(killArgs, message),
        start: failedExecution(startArgs, message)
      }
    }
    if (!this.ownsServer) {
      const externalPort = this.serverPort
      let lastError = ''
      let lastStart = failedExecution(startArgs, '没有找到可启动的备用端口。')
      for (let offset = 1; offset <= this.fallbackPortCount; offset += 1) {
        const candidatePort = this.preferredServerPort + offset
        if (candidatePort > 65_535) break
        const candidateState = await this.probePort(candidatePort)
        if (candidateState !== 'free') continue

        this.activeServerPort = candidatePort
        const start = await this.run(startArgs, { timeoutMs: 12_000 })
        lastStart = start
        const startedState = await this.probePort(candidatePort)
        if (startedState === 'adb' && start.exitCode === 0 && !start.timedOut) {
          this.ownsServer = true
          this.initialized = true
          return {
            ok: true,
            serverPort: candidatePort,
            message: `当前复用的外部 ADB Server 127.0.0.1:${externalPort} 未被终止，已在备用端口 127.0.0.1:${candidatePort} 启动应用内独立 Server。`,
            kill: failedExecution(killArgs, `未终止外部 ADB Server 127.0.0.1:${externalPort}。`),
            start
          }
        }
        lastError =
          start.stderr.trim() ||
          start.stdout.trim() ||
          `端口 ${candidatePort} 上的 ADB Server 启动后未能响应。`
      }

      this.activeServerPort = externalPort
      const message =
        `当前复用的是外部 ADB Server 127.0.0.1:${externalPort}，为避免误杀其他工具的 Server，未自动终止；备用端口也无法启动应用内 Server。${lastError ? ` ${lastError}` : ''}`
      return {
        ok: false,
        serverPort: externalPort,
        message,
        kill: failedExecution(killArgs, `未终止外部 ADB Server 127.0.0.1:${externalPort}。`),
        start: lastStart
      }
    }

    const kill = await this.run(killArgs, { timeoutMs: 5_000 })
    if (kill.exitCode !== 0 && !/daemon not running|cannot connect to daemon/i.test(`${kill.stdout}\n${kill.stderr}`)) {
      return {
        ok: false,
        serverPort: this.serverPort,
        message: '停止应用内 ADB Server 失败。',
        kill,
        start: failedExecution(startArgs, '因停止失败，未执行启动命令。')
      }
    }

    const start = await this.run(startArgs, { timeoutMs: 12_000 })
    const state = await this.probePort(this.serverPort)
    const ok =
      state === 'adb' &&
      start.exitCode === 0 &&
      !start.timedOut
    this.ownsServer = ok
    this.initialized = ok
    return {
      ok,
      serverPort: this.serverPort,
      message: ok
        ? `已重启应用内 ADB Server，当前端口 127.0.0.1:${this.serverPort}。`
        : 'ADB Server 启动后没有响应，未能完成修复。',
      kill,
      start
    }
  }

  async dispose(): Promise<void> {
    if (this.ownsServer) {
      await this.run(['kill-server'], { timeoutMs: 5_000 })
    }
    this.ownsServer = false
    this.initialized = false
    this.activeServerPort = this.preferredServerPort
  }
}
