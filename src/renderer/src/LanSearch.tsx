import { CheckCircle2, ChevronDown, LoaderCircle, Monitor, Wifi } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { LanNetwork, LanSearchResult } from '../../shared/contracts'

export function LanSearch({ disabled, connectedEndpoint, onConnect }: {
  disabled: boolean
  connectedEndpoint: string | null
  onConnect: (host: string, port: number) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [networks, setNetworks] = useState<LanNetwork[]>([])
  const [network, setNetwork] = useState('')
  const [port, setPort] = useState('5555')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<LanSearchResult | null>(null)
  const [error, setError] = useState('')
  const [connecting, setConnecting] = useState<string | null>(null)
  const [connectionError, setConnectionError] = useState<{ endpoint: string; message: string } | null>(null)
  const connectingRef = useRef(false)
  const searchRef = useRef<{ cancelled: boolean } | null>(null)
  const resultsRef = useRef<HTMLElement>(null)
  const mounted = useRef(true)
  const locked = disabled || busy || connecting !== null
  useEffect(() => {
    if (result) resultsRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [result])
  async function connect(host: string, port: number) {
    if (connectingRef.current || locked) return
    connectingRef.current = true
    const endpoint = `${host}:${port}`
    setConnecting(endpoint)
    setConnectionError(null)
    try { await onConnect(host, port) }
    catch (e) {
      if (mounted.current) setConnectionError({ endpoint, message: e instanceof Error ? e.message : String(e) })
    } finally {
      connectingRef.current = false
      if (mounted.current) setConnecting(null)
    }
  }
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; if (searchRef.current) searchRef.current.cancelled = true; void window.adbTool.cancelLanSearch().catch(() => {}) }
  }, [])
  async function search(useDefaults = false) {
    if (searchRef.current || locked) return
    const task = { cancelled: false }
    searchRef.current = task
    setOpen(true)
    setCollapsed(false)
    setBusy(true)
    setError('')
    setResult(null)
    setConnectionError(null)
    try {
      let selectedNetwork = network
      let selectedPort = Number(port)
      if (useDefaults) {
        const items = await window.adbTool.listLanNetworks()
        if (!mounted.current) return
        setNetworks(items)
        selectedNetwork = items[0]?.id ?? ''
        selectedPort = 5555
        setNetwork(selectedNetwork)
        setPort('5555')
      }
      if (task.cancelled) {
        setResult({ candidates: [], cancelled: true, warnings: [] })
        return
      }
      if (!selectedNetwork) return
      const value = await window.adbTool.searchLan(selectedNetwork, selectedPort)
      if (mounted.current) setResult(value)
    } catch (e) { if (mounted.current) setError(String(e)) }
    finally {
      searchRef.current = null
      if (mounted.current) setBusy(false)
    }
  }
  async function cancelSearch() {
    if (searchRef.current) searchRef.current.cancelled = true
    try { await window.adbTool.cancelLanSearch() }
    catch (e) { if (mounted.current) setError(String(e)) }
  }
  return <section className="lan-search" aria-label="局域网设备搜索">
    <button className="button" disabled={locked} onClick={() => void search(true)}>搜索局域网设备</button>
    {open && <div className="tcp-repair-card lan-panel">
      <button className="lan-panel-toggle" aria-expanded={!collapsed} aria-controls="lan-panel-content"
        onClick={() => setCollapsed((value) => !value)}>
        <span>局域网设备{busy ? ' · 正在搜索' : connecting ? ' · 正在连接' : result ? ` · ${result.candidates.length} 个候选地址` : ''}</span>
        <span>{collapsed ? '展开' : '收起'}<ChevronDown size={16} aria-hidden="true" /></span>
      </button>
      <div id="lan-panel-content" hidden={collapsed}>
      <p>搜索同一局域网内的安卓设备，找到后可直接连接。</p>
      <form className="tcp-form" onSubmit={(event) => { event.preventDefault(); void search() }}>
        <label className="field"><span>电脑使用的网络</span><select aria-label="电脑使用的网络" value={network} disabled={locked} onChange={(e) => setNetwork(e.target.value)}>
          {networks.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select></label>
        <label className="field port-field"><span>扫描端口</span><input type="number" min="1" max="65535" required value={port} disabled={locked} onChange={(e) => setPort(e.target.value)} /></label>
        <button className="button" disabled={locked || !network} type="submit">重新搜索</button>
        {busy && <button className="button" type="button" onClick={() => void cancelSearch()}>取消搜索</button>}
      </form>
      {!busy && !networks.length && <p>没有可用的 IPv4 网卡，请检查网络连接。</p>}
      <div role="status" aria-live="polite">
        {busy && <p>正在搜索，请稍候；较大网段可能需要约一分钟。</p>}
        {result && <p>{result.cancelled ? '搜索已取消' : '搜索完成'}，找到 {result.candidates.length} 个候选地址。</p>}
        {result?.warnings.map((warning) => <p key={warning}>{warning}</p>)}
      </div>
      {error && <p role="alert">{error}</p>}
      {result && <section className="lan-results" aria-label="发现的设备" ref={resultsRef}>
        <div className="lan-results-heading">
          <div><h3><Monitor size={20} aria-hidden="true" />发现的设备 <span className="lan-count">{result.candidates.length}</span></h3>
            <p>{result.candidates.length ? '点击设备右侧的按钮即可连接，无需再填写 IP。' : '请确认屏幕已开启网络 ADB，并检查网卡和扫描端口。'}</p>
          </div>
        </div>
        <div className="lan-device-list">
          {result.candidates.map((item) => {
            const endpoint = `${item.host}:${item.port}`
            const isConnecting = connecting === endpoint
            const isConnected = connectedEndpoint === endpoint
            const failure = connectionError?.endpoint === endpoint ? connectionError.message : null
            return <article className={`lan-device-card${isConnected ? ' is-connected' : ''}${failure ? ' is-error' : ''}`}
              aria-label={`设备 ${endpoint}`} key={endpoint}>
              <div className="lan-device-icon"><Monitor size={24} aria-hidden="true" /></div>
              <div className="lan-device-info">
                <strong className="mono">{item.host}<span>:{item.port}</span></strong>
                <span className="lan-device-description">{isConnected ? 'ADB 连接已验证' : item.pairing ? '需要配对 · 请先在外部终端完成无线调试配对' : item.source === 'mdns' ? '发现 ADB 服务' : '发现开放端口 · 连接时验证是否为安卓设备'}</span>
                <div aria-live="polite">
                  {isConnecting && <p>正在连接，请稍候…</p>}
                  {isConnected && !isConnecting && <p className="lan-connected-message">已连接，可以安装应用或操作设备。</p>}
                  {failure && <p role="alert">{failure}</p>}
                </div>
              </div>
              <button className={`button ${isConnected || item.pairing ? '' : 'button-primary'}`}
                disabled={locked || item.pairing || isConnected}
                aria-label={`${item.pairing ? '需先配对' : isConnecting ? '正在连接' : isConnected ? '已连接' : failure ? '重试连接' : '连接此设备'} ${endpoint}`}
                onClick={() => void connect(item.host, item.port)}>
                {isConnecting ? <LoaderCircle size={16} className="lan-spinner" aria-hidden="true" /> : isConnected ? <CheckCircle2 size={16} aria-hidden="true" /> : <Wifi size={16} aria-hidden="true" />}
                {item.pairing ? '需先配对' : isConnecting ? '正在连接…' : isConnected ? '已连接' : failure ? '重试连接' : '连接此设备'}
              </button>
            </article>
          })}
        </div>
      </section>}
      </div>
    </div>}
  </section>
}
