import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Copy, Eraser, Minimize2, Square, TerminalSquare, ListFilter } from 'lucide-react'
import type { AppSnapshot } from '../../shared/contracts'
import { buildShortcut, QUICK_SHORTCUT_IDS, TERMINAL_SHORTCUTS, type TerminalShortcut } from '../../shared/terminal-shortcuts'
import TerminalShortcuts from './TerminalShortcuts'
import '@xterm/xterm/css/xterm.css'

interface Props {
  snapshot: AppSnapshot
  open: boolean
  onClose: () => void
}

export default function TerminalPanel({ snapshot, open, onClose }: Props): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const terminal = useRef<Terminal | null>(null)
  const fit = useRef<FitAddon | null>(null)
  const session = useRef<string | null>(null)
  const mode = useRef<'command' | 'shell'>('command')
  const [command, setCommand] = useState('')
  const [running, setRunning] = useState(false)
  const [shell, setShell] = useState(false)
  const [boundSerial, setBoundSerial] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [recentShortcuts, setRecentShortcuts] = useState<string[]>([])
  const [replacedDraft, setReplacedDraft] = useState<string | null>(null)
  const history = useRef<string[]>([])
  const historyIndex = useRef(0)
  const draft = useRef('')

  const report = (reason: unknown): void => setError(reason instanceof Error ? reason.message : String(reason))
  const fillShortcut = (value: string, shortcut: TerminalShortcut): void => {
    if (session.current) {
      if (mode.current !== 'shell' || shortcut.scope !== 'shell') return
      terminal.current?.paste(value)
      terminal.current?.focus()
    } else {
      setReplacedDraft(command && command !== value ? command : null)
      setCommand(value)
      requestAnimationFrame(() => input.current?.focus())
    }
    setRecentShortcuts((current) => [shortcut.id, ...current.filter((id) => id !== shortcut.id)].slice(0, 12))
    setShortcutsOpen(false)
    setError(null)
  }

  useEffect(() => {
    if (!host.current) return
    const term = new Terminal({
      cursorBlink: true, fontSize: 13, fontFamily: 'Menlo, Consolas, monospace',
      scrollback: 3000, convertEol: true, screenReaderMode: true,
      theme: { background: '#101820', foreground: '#dce7ee', cursor: '#75d9c1', selectionBackground: '#36546b' }
    })
    const addon = new FitAddon()
    term.loadAddon(addon)
    term.open(host.current)
    terminal.current = term
    fit.current = addon
    term.writeln('ADB 终端 · 输入 adb shell 进入设备 Shell，exit 返回命令模式。')
    const unsubscribe = window.adbTool.onTerminal((event) => {
      if (event.id !== session.current) return
      if (event.type === 'started') {
        mode.current = event.mode
        setShell(event.mode === 'shell')
        setBoundSerial(event.serial)
        term.options.convertEol = event.mode !== 'shell'
        term.focus()
      } else if (event.type === 'output') {
        term.write(event.data, () => {
          void window.adbTool.acknowledgeTerminal(event.id, event.data.length).catch(report)
        })
      } else {
        term.options.convertEol = true
        term.writeln(`\r\n[${event.message}]`)
        session.current = null
        mode.current = 'command'
        setRunning(false)
        setShell(false)
        requestAnimationFrame(() => input.current?.focus())
      }
    })
    const dataSubscription = term.onData((data) => {
      const id = session.current
      if (!id) { input.current?.focus(); return }
      if (data === '\x03' && mode.current !== 'shell') {
        void window.adbTool.stopTerminal(id).catch(report)
      } else if (data.length > 8192) {
        setError('一次粘贴最多 8192 字符。')
      } else {
        void window.adbTool.writeTerminal(id, data).catch(report)
      }
    })
    term.attachCustomKeyEventHandler((event) => {
      if (event.type === 'keydown' && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        event.stopPropagation()
        setShortcutsOpen((value) => !value)
        return false
      }
      if (event.type === 'keydown' && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c' && term.hasSelection()) {
        void window.adbTool.copyTerminalText(term.getSelection()).catch(report)
        return false
      }
      return true
    })
    const observer = new ResizeObserver(() => {
      // 会话期间固定字符尺寸，避免显示宽度与设备 PTY 宽度不一致。
      if (!session.current && host.current?.offsetWidth) addon.fit()
    })
    observer.observe(host.current)
    return () => {
      unsubscribe()
      dataSubscription.dispose()
      observer.disconnect()
      if (session.current) void window.adbTool.stopTerminal(session.current).catch(() => {})
      term.dispose()
      terminal.current = null
    }
  }, [])

  useEffect(() => {
    if (open) {
      if (!running) { fit.current?.fit(); input.current?.focus() }
      else terminal.current?.focus()
    }
  }, [open, running])

  const execute = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!command.trim() || session.current || snapshot.busy) return
    const text = command.trim()
    const id = crypto.randomUUID()
    session.current = id
    setRunning(true)
    setError(null)
    setReplacedDraft(null)
    setShortcutsOpen(false)
    setBoundSerial(snapshot.selectedSerial)
    terminal.current?.writeln(`\r\n> ${text}`)
    history.current = [...history.current.filter((item) => item !== text), text].slice(-100)
    historyIndex.current = history.current.length
    draft.current = ''
    setCommand('')
    try {
      await window.adbTool.startTerminal({
        id, command: text, serial: snapshot.selectedSerial,
        cols: Math.max(20, Math.min(400, terminal.current?.cols ?? 100)),
        rows: Math.max(5, Math.min(200, terminal.current?.rows ?? 20))
      })
    } catch (reason) {
      if (session.current === id) {
        session.current = null
        setRunning(false)
        terminal.current?.writeln(`\r\n[${reason instanceof Error ? reason.message : String(reason)}]`)
      }
      report(reason)
    }
  }

  const navigateHistory = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault()
      if (historyIndex.current === history.current.length) draft.current = command
      historyIndex.current = Math.max(0, Math.min(history.current.length,
        historyIndex.current + (event.key === 'ArrowUp' ? -1 : 1)))
      setCommand(history.current[historyIndex.current] ?? draft.current)
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l') {
      event.preventDefault()
      terminal.current?.clear()
    }
  }

  const copy = async (): Promise<void> => {
    const term = terminal.current
    if (!term) return
    const lines: string[] = []
    for (let index = 0; index < term.buffer.active.length; index++) {
      lines.push(term.buffer.active.getLine(index)?.translateToString(true) ?? '')
    }
    try { await window.adbTool.copyTerminalText(term.getSelection() || lines.join('\n').trimEnd()) }
    catch (reason) { report(reason) }
  }

  const paste = async (): Promise<void> => {
    try {
      const text = await window.adbTool.readTerminalClipboard()
      if (session.current) {
        terminal.current?.paste(text)
      } else {
        setCommand((current) => (current + text.replace(/[\r\n]+/g, ' ')).slice(0, 8192))
        input.current?.focus()
      }
    } catch (reason) { report(reason) }
  }

  return (
    <section className={`terminal-panel${shortcutsOpen ? ' terminal-panel-expanded' : ''}`} hidden={!open} aria-label="ADB 终端"
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
          event.preventDefault(); event.stopPropagation(); setShortcutsOpen((value) => !value)
        }
      }}>
      <header className="terminal-header">
        <div className="terminal-heading"><TerminalSquare size={18} /><strong>ADB 终端</strong>
          <span>{shell ? '设备 Shell' : running ? '执行中' : '命令模式'}</span>
        </div>
        <div className="terminal-actions">
          <button type="button" onClick={() => setShortcutsOpen((value) => !value)} aria-expanded={shortcutsOpen}
            title="快捷命令（Ctrl / ⌘ + K）"><ListFilter size={15} />快捷命令</button>
          <button type="button" onClick={() => void copy()} title="复制选中内容或全部输出"><Copy size={14} />复制</button>
          <button type="button" onClick={() => void paste()}>粘贴</button>
          <button type="button" onClick={() => terminal.current?.clear()}><Eraser size={14} />清屏</button>
          <button type="button" disabled={!running} onClick={() => { if (session.current) void window.adbTool.stopTerminal(session.current).catch(report) }}><Square size={13} />结束会话</button>
          <button type="button" onClick={onClose} aria-label="收起终端"><Minimize2 size={16} /></button>
        </div>
      </header>
      <div className="terminal-context">
        <span>设备：{(running ? boundSerial : snapshot.selectedSerial) ?? '未选择'} · Server：127.0.0.1:{snapshot.adb.serverPort}</span>
        <span>{running ? '会话期间暂停其他设备操作 · Ctrl+C 中断' : '↑↓ 历史命令 · 输入 help 查看 ADB 帮助'}</span>
      </div>
      <div className="terminal-quick-row" aria-label="常用快捷命令">
        <small>常用</small>
        {QUICK_SHORTCUT_IDS.map((id) => {
          const shortcut = TERMINAL_SHORTCUTS.find((item) => item.id === id)!
          return <button type="button" key={id} title={`${shortcut.description} 点击只填入，不执行。`}
            disabled={running ? !shell || shortcut.scope !== 'shell' : snapshot.busy}
            onClick={() => fillShortcut(buildShortcut(shortcut, {}, shell ? 'shell' : 'adb'), shortcut)}>{shortcut.title}</button>
        })}
      </div>
      <div className="terminal-output" ref={host} />
      {error && <div className="terminal-error" role="alert">{error}</div>}
      {!running && <form className="terminal-command" onSubmit={(event) => void execute(event)}>
        <span aria-hidden="true">❯</span>
        <input ref={input} aria-label="ADB 命令" value={command} maxLength={8192}
          onChange={(event) => { setCommand(event.target.value); setReplacedDraft(null) }} onKeyDown={navigateHistory}
          autoComplete="off" spellCheck={false} placeholder="adb shell getprop ro.product.model"
          disabled={snapshot.busy || snapshot.adb.state !== 'ready'} />
        <button type="submit" disabled={!command.trim() || snapshot.busy || snapshot.adb.state !== 'ready'}>执行</button>
        {replacedDraft !== null && <button type="button" onClick={() => { setCommand(replacedDraft); setReplacedDraft(null); input.current?.focus() }}>撤销填入</button>}
      </form>}
      {running && <div className="terminal-command terminal-session-hint">
        {shell ? '在终端中直接输入设备命令 · exit 返回命令模式' : '正在接收命令输出 · Ctrl+C 中断'}
      </div>}
      {shortcutsOpen && <TerminalShortcuts
        packageName={snapshot.selectedApk?.packageName ?? snapshot.selectedDeviceApplication?.packageName ?? null}
        mode={shell ? 'shell' : 'adb'} blocked={running ? !shell : snapshot.busy}
        recent={recentShortcuts} onFill={fillShortcut} onClose={() => { setShortcutsOpen(false); requestAnimationFrame(() => running ? terminal.current?.focus() : input.current?.focus()) }} />}
    </section>
  )
}
