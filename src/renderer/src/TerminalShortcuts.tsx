import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowDownToLine, Search, X } from 'lucide-react'
import { buildShortcut, shortcutDefaults, SHORTCUT_CATEGORIES, TERMINAL_SHORTCUTS, QUICK_SHORTCUT_IDS, type TerminalShortcut } from '../../shared/terminal-shortcuts'

interface Props {
  packageName: string | null
  mode: 'adb' | 'shell'
  blocked: boolean
  recent: string[]
  onFill: (command: string, shortcut: TerminalShortcut) => void
  onClose: () => void
}

function ShortcutDetails({ shortcut, packageName, mode, blocked, onFill }: Omit<Props, 'recent' | 'onClose'> & { shortcut: TerminalShortcut }): React.JSX.Element {
  const [values, setValues] = useState(() => shortcutDefaults(shortcut, packageName))
  let preview = ''
  let problem: string | null = null
  try { preview = buildShortcut(shortcut, values, mode) }
  catch (error) { problem = error instanceof Error ? error.message : String(error) }
  const wrongMode = mode === 'shell' && shortcut.scope !== 'shell'
  return (
    <form className="shortcut-detail" onSubmit={(event) => { event.preventDefault(); if (!blocked && !problem) onFill(preview, shortcut) }}>
      <div className="shortcut-detail-scroll">
        <div className="shortcut-detail-heading"><h3>{shortcut.title}</h3><span className={shortcut.effect ? 'shortcut-effect-badge' : 'shortcut-read-badge'}>{shortcut.id === 'shell' ? '会话' : shortcut.effect ? '操作' : '查询'}</span></div>
        <p>{shortcut.description}</p>
        {shortcut.effect && <p className="shortcut-effect">{shortcut.effect}</p>}
        {shortcut.note && <p className="shortcut-note">{shortcut.note}</p>}
        <div className="shortcut-fields">
          {shortcut.parameters.map((parameter) => <label key={parameter.key}>
            <span>{parameter.label}{parameter.key === 'package' && packageName && values[parameter.key] === packageName && <small>已带入当前应用</small>}</span>
            <input value={values[parameter.key] ?? ''} placeholder={parameter.placeholder} autoComplete="off" spellCheck={false}
              inputMode={parameter.kind === 'number' || parameter.kind === 'port' ? 'numeric' : 'text'} maxLength={4096}
              onChange={(event) => setValues((current) => ({ ...current, [parameter.key]: event.target.value }))} />
          </label>)}
        </div>
        <div className="shortcut-preview-label">命令预览</div>
        <pre className="shortcut-preview">{preview || `${mode === 'shell' ? '' : `adb ${shortcut.scope === 'shell' ? 'shell ' : ''}`}${shortcut.template}`}</pre>
        {problem && <p className="shortcut-validation">{problem}</p>}
      </div>
      <div className="shortcut-fill-bar">
        <small>{blocked ? '当前命令执行中，结束后可填入。' : wrongMode ? '请先输入 exit 返回命令模式。' : mode === 'shell' ? '追加到当前 Shell 输入位置，不发送回车。' : '替换输入框内容，检查后按 Enter 执行。'}</small>
        <button type="submit" disabled={blocked || Boolean(problem)}><ArrowDownToLine size={15} />{mode === 'shell' ? '填入 Shell' : '填入命令'}</button>
      </div>
    </form>
  )
}

export default function TerminalShortcuts(props: Props): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('常用')
  const [selectedId, setSelectedId] = useState(props.mode === 'shell' ? 'getprop' : 'shell')
  const search = useRef<HTMLInputElement>(null)
  const dialog = useRef<HTMLDivElement>(null)
  useEffect(() => { search.current?.focus() }, [])
  const visible = useMemo(() => {
    const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean)
    const candidates = category === '最近'
      ? props.recent.flatMap((id) => TERMINAL_SHORTCUTS.find((item) => item.id === id) ?? [])
      : TERMINAL_SHORTCUTS
    return candidates.filter((item) => {
      if (category === '常用' && !QUICK_SHORTCUT_IDS.includes(item.id)) return false
      if (!['全部', '常用', '最近'].includes(category) && item.category !== category) return false
      const text = `${item.title} ${item.description} ${item.template} ${item.category}`.toLocaleLowerCase()
      return words.every((word) => text.includes(word))
    })
  }, [category, query, props.recent])
  const selected = visible.find((item) => item.id === selectedId) ?? visible[0]
  const navigate = (event: KeyboardEvent, index: number): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const next = visible[Math.max(0, Math.min(visible.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]
    if (next) {
      setSelectedId(next.id)
      if (event.currentTarget !== search.current) requestAnimationFrame(() => document.getElementById(`shortcut-result-${next.id}`)?.focus())
    }
  }
  return (
    <div ref={dialog} className="terminal-shortcuts" role="dialog" aria-modal="true" aria-label="快捷命令库" onKeyDown={(event) => {
      if (event.key === 'Escape') { event.stopPropagation(); props.onClose() }
      if (event.key === 'Tab') {
        const focusable = dialog.current?.querySelectorAll<HTMLElement>('input:not([disabled]), button:not([disabled]):not([tabindex="-1"])')
        const first = focusable?.[0]
        const last = focusable?.[focusable.length - 1]
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }}>
      <div className="shortcut-search-row">
        <Search size={17} />
        <input ref={search} aria-label="搜索快捷命令" placeholder={`搜索 ${TERMINAL_SHORTCUTS.length} 条命令：包名、日志、网络、pm、logcat…`}
          value={query} onChange={(event) => { setQuery(event.target.value); setCategory('全部') }}
          onKeyDown={(event) => {
            navigate(event, selected ? visible.indexOf(selected) : -1)
            if (event.key === 'Enter') {
              event.preventDefault()
              if (selected && !props.blocked && (props.mode !== 'shell' || selected.scope === 'shell')) {
                if (selected.parameters.length === 0) props.onFill(buildShortcut(selected, {}, props.mode), selected)
                else document.getElementById(`shortcut-result-${selected.id}`)?.focus()
              }
            }
          }} />
        <span>{visible.length} 条</span>
        <button type="button" onClick={props.onClose} aria-label="关闭快捷命令库"><X size={16} /></button>
      </div>
      <nav className="shortcut-categories" aria-label="快捷命令分类">
        {['常用', '最近', '全部', ...SHORTCUT_CATEGORIES].map((name) => <button type="button" key={name}
          aria-pressed={category === name} onClick={() => setCategory(name)}>{name}</button>)}
      </nav>
      <div className="shortcut-browser">
        <div className="shortcut-results" role="list" aria-label="快捷命令列表">
          {visible.map((item, index) => <div role="listitem" key={item.id}>
            <button type="button" id={`shortcut-result-${item.id}`} aria-pressed={selected?.id === item.id}
              tabIndex={selected?.id === item.id ? 0 : -1} onClick={() => setSelectedId(item.id)}
              onKeyDown={(event) => navigate(event, index)}
              ref={(element) => { if (selected?.id === item.id) element?.scrollIntoView?.({ block: 'nearest' }) }}>
              <span>{item.title}{item.effect && <small>操作</small>}</span>
              <code>{item.scope === 'shell' ? 'shell ' : ''}{item.template}</code>
            </button>
          </div>)}
          {visible.length === 0 && <p className="shortcut-empty">{category === '最近' ? '填入过的命令会出现在这里。' : '没有匹配命令，试试其他关键词或分类。'}</p>}
        </div>
        {selected ? <ShortcutDetails key={`${selected.id}:${props.packageName}`} {...props} shortcut={selected} />
          : <div className="shortcut-empty">选择左侧命令，查看用途、参数和完整指令。</div>}
      </div>
    </div>
  )
}
