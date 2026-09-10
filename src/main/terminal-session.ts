import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { TerminalEvent, TerminalRequest } from '../shared/terminal'
import { parseTerminalCommand } from './terminal-command'

export interface TerminalContext {
  executablePath: string
  serverPort: number
  serial: string | null
}

export interface TerminalOwner {
  acquireTerminal(id: string, serial: string | null, requiresDevice: boolean): Promise<TerminalContext>
  releaseTerminal(id: string, refresh?: boolean): Promise<void>
}

interface Session {
  id: string
  child: ChildProcessWithoutNullStreams | null
  mode: 'command' | 'shell'
  outstanding: number
  stopped: boolean
  finishing: boolean
  done: Promise<void>
  resolve: () => void
  killTimer: NodeJS.Timeout | null
}

export class TerminalSession {
  private current: Session | null = null
  private disposed = false

  constructor(
    private readonly owner: TerminalOwner,
    private readonly emit: (event: TerminalEvent) => void,
    private readonly spawnProcess: typeof spawn = spawn
  ) {}

  async start(request: TerminalRequest): Promise<void> {
    if (this.disposed) throw new Error('终端已关闭。')
    if (this.current) throw new Error('请先结束当前终端命令或 Shell 会话。')
    const parsed = parseTerminalCommand(request.command, request.cols, request.rows)
    let resolve!: () => void
    const session: Session = {
      id: request.id, child: null, mode: parsed.mode, outstanding: 0,
      stopped: false, finishing: false, done: new Promise<void>((done) => { resolve = done }),
      resolve: () => resolve(), killTimer: null
    }
    this.current = session
    try {
      const context = await this.owner.acquireTerminal(request.id, request.serial, parsed.requiresDevice)
      if (session.stopped || this.disposed) {
        await this.finish(session, null, '会话已取消。')
        return
      }
      const args = ['-H', '127.0.0.1', '-P', String(context.serverPort),
        ...(context.serial ? ['-s', context.serial] : []), ...parsed.args]
      const child = this.spawnProcess(context.executablePath, args, {
        shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
      }) as ChildProcessWithoutNullStreams
      session.child = child
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      const output = (data: string): void => {
        if (session.stopped || session.finishing) return
        session.outstanding += data.length
        this.emit({ id: session.id, type: 'output', data })
        if (session.outstanding >= 128 * 1024) {
          child.stdout.pause()
          child.stderr.pause()
        }
      }
      child.stdout.on('data', output)
      child.stderr.on('data', output)
      child.stdin.on('error', () => { /* 设备断开后的 EPIPE 由进程结束统一处理。 */ })
      let processError: string | null = null
      child.once('error', (error) => { processError = error.message })
      child.once('close', (code) => {
        void this.finish(session, code, processError ?? (session.stopped ? '已停止。' : `进程结束，退出码 ${code ?? '未知'}。`))
      })
      this.emit({ id: session.id, type: 'started', mode: session.mode, serial: context.serial })
    } catch (error) {
      await this.finish(session, null, error instanceof Error ? error.message : String(error))
      throw error
    }
  }

  write(id: string, data: string): void {
    const session = this.requireSession(id)
    if (session.finishing || session.stopped || !session.child) return
    if (session.child.stdin.writableLength + Buffer.byteLength(data) > 64 * 1024) {
      throw new Error('终端输入尚未发送完，请稍后重试。')
    }
    session.child.stdin.write(data)
  }

  acknowledge(id: string, length: number): void {
    const session = this.current
    if (!session || session.id !== id || session.finishing) return
    session.outstanding = Math.max(0, session.outstanding - length)
    if (session.outstanding < 64 * 1024) {
      session.child?.stdout.resume()
      session.child?.stderr.resume()
    }
  }

  async stop(id: string): Promise<void> {
    const session = this.current
    if (!session || session.id !== id) return
    if (!session.stopped && !session.finishing) {
      session.stopped = true
      if (session.child) {
        // 停止本次 ADB 客户端，不停止应用共用的 ADB Server。
        session.child.stdout.resume()
        session.child.stderr.resume()
        session.child.kill('SIGTERM')
        session.killTimer = setTimeout(() => session.child?.kill('SIGKILL'), 1000)
      }
    }
    await session.done
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.stopCurrent()
  }

  async stopCurrent(): Promise<void> {
    if (this.current) await this.stop(this.current.id)
  }

  private requireSession(id: string): Session {
    if (!this.current || this.current.id !== id) throw new Error('终端会话已结束。')
    return this.current
  }

  private async finish(session: Session, code: number | null, message: string): Promise<void> {
    if (session.finishing) return
    session.finishing = true
    if (session.killTimer) clearTimeout(session.killTimer)
    try {
      if (this.disposed) await this.owner.releaseTerminal(session.id, false)
      else await this.owner.releaseTerminal(session.id)
    } catch (error) {
      message += ` 状态刷新失败：${error instanceof Error ? error.message : String(error)}`
    } finally {
      if (this.current === session) this.current = null
      this.emit({ id: session.id, type: 'exit', code, stopped: session.stopped, message })
      session.resolve()
    }
  }
}
