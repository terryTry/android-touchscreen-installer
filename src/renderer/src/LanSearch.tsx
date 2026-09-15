import { CheckCircle2, ChevronDown, Network, LoaderCircle, Monitor, Wifi } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { LanNetwork, LanSearchResult } from '../../shared/contracts'

interface CachedSearch { result: LanSearchResult; time: string }
// 仅保存在当前渲染进程内，退出软件后释放。
const searchCache = new Map<string, CachedSearch>()
function cacheKey(network: LanNetwork | undefined, port: number): string {
  return network ? JSON.stringify([network.id, network.address, network.netmask, port]) : ''
}

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
  const [historyTime, setHistoryTime] = useState<string | null>(null)
  const [conditionsChanged, setConditionsChanged] = useState(false)
  const [connecting, setConnecting] = useState<string | null>(null)
  const [connectionError, setConnectionError] = useState<{ endpoint: string; message: string } | null>(null)
  const connectingRef = useRef(false)
  const searchRef = useRef<{ cancelled: boolean } | null>(null)
  const resultsRef = useRef<HTMLElement>(null)
  const advancedRef = useRef<HTMLDetailsElement>(null)
  const mounted = useRef(true)
  const locked = disabled || busy || connecting !== null
  const selectedNetwork = networks.find((item) => item.id === network)
  const networkName = (item: LanNetwork) => item.label.split(' · ')[0] ?? item.id
  const searchRange = selectedNetwork
    ? selectedNetwork.address.split('.').map((part, index) => Number(part) & Number(selectedNetwork.netmask.split('.')[index])).join('.') + '/' + selectedNetwork.netmask.split('.').reduce((sum, part) => sum + Number(part).toString(2).replaceAll('0', '').length, 0)
    : ''
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
  function invalidateSearch(nextNetwork: string, nextPort: string) {
    setResult(null)
    setError('')
    setConnectionError(null)
    setConditionsChanged(true)
    setHistoryTime(null)
    const entry = searchCache.get(cacheKey(networks.find((item) => item.id === nextNetwork), Number(nextPort)))
    if (entry) void search(false, { network: nextNetwork, port: Number(nextPort) })
  }
  async function search(useDefaults = false, selection?: { network: string; port: number }) {
    if (searchRef.current || locked) return
    const task = { cancelled: false }
    searchRef.current = task
    setOpen(true)
    setCollapsed(false)
    setBusy(true)
    setHistoryTime(null)
    setConditionsChanged(false)
    setError('')
    setResult(null)
    setConnectionError(null)
    try {
      let selectedNetwork = selection?.network ?? network
      let selectedPort = selection?.port ?? Number(port)
      let availableNetworks = networks
      if (useDefaults) {
        const items = await window.adbTool.listLanNetworks()
        if (!mounted.current) return
        setNetworks(items)
        availableNetworks = items
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
      const key = cacheKey(availableNetworks.find((item) => item.id === selectedNetwork), selectedPort)
      const cached = searchCache.get(key)
      if (cached) {
        setResult(cached.result)
        setHistoryTime(cached.time)
      }
      const value = await window.adbTool.searchLan(selectedNetwork, selectedPort)
      if (!mounted.current) return
      if (value.cancelled || task.cancelled) {
        if (!cached) setResult({ ...value, cancelled: true })
        else setError('重新验证已取消，当前显示历史结果。')
      } else {
        setResult(value)
        setHistoryTime(null)
        if (key) searchCache.set(key, { result: value, time: new Date().toLocaleTimeString('zh-CN', { hour12: false }) })
      }
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
      <div className="lan-network-intro">
        <Network size={20} aria-hidden="true" />
        <div><strong>自动查找局域网设备</strong><p>无需填写端口即可搜索 ADB 服务，TCP 扫描默认使用 5555。切换搜索网络不会断开当前设备。</p></div>
      </div>
      <form className="tcp-form" onSubmit={(event) => { event.preventDefault(); void search() }}>
        <label className="field"><span>电脑使用的网络</span><select aria-label="电脑使用的网络" value={network} disabled={locked} onChange={(e) => { setNetwork(e.target.value); invalidateSearch(e.target.value, port) }}>
          {networks.map((item) => <option key={item.id} value={item.id}>{networkName(item)} · {item.address}</option>)}
        </select></label>
        <button className="button" disabled={locked || !network} type="submit">{busy ? '正在搜索…' : '开始搜索'}</button>
        {busy && <button className="button" type="button" onClick={() => void cancelSearch()}>取消搜索</button>}
        <details className="lan-search-advanced" ref={advancedRef} onInvalid={() => { if (advancedRef.current) advancedRef.current.open = true }}>
          <summary><span>高级选项</span><span className="lan-port-summary">TCP 扫描端口：{port || '未填写'}</span></summary>
          <div className="lan-search-advanced-fields">
            <label className="field port-field"><span>扫描端口</span><input type="number" min="1" max="65535" required value={port} disabled={locked} aria-describedby="lan-port-hint" onChange={(e) => { setPort(e.target.value); invalidateSearch(network, e.target.value) }} /></label>
            <p id="lan-port-hint">设备使用自定义端口且未被自动发现时，可填写设备当前的调试端口。此设置仅影响 TCP 扫描，ADB 服务发现仍会查找其他端口。</p>
          </div>
        </details>
      </form>
      {selectedNetwork && <div className="lan-network-context" aria-label="当前搜索网络">
        <div><span>电脑 IP</span><strong className="mono">{selectedNetwork.address}</strong></div>
        <div><span>搜索网段</span><strong className="mono">{searchRange}</strong></div>
        <div><span>搜索状态</span><strong>{busy ? historyTime ? '正在更新历史结果' : '正在扫描' : conditionsChanged ? '等待搜索' : historyTime ? '历史结果待验证' : error ? '搜索未完成' : result?.cancelled ? '已取消' : result ? '搜索完成' : '准备搜索'}</strong></div>
      </div>}
      {connectedEndpoint && <p className="lan-active-connection"><CheckCircle2 size={14} aria-hidden="true" />当前连接：{connectedEndpoint}</p>}
      {!busy && !networks.length && <p>没有可用的 IPv4 网卡，请检查网络连接。</p>}
      <div className={`lan-search-feedback${busy ? " is-scanning" : ""}`} role="status" aria-live="polite">
        {conditionsChanged && <><p>搜索条件已变更，请点击开始搜索</p><p className="lan-feedback-detail">当前条件暂无可用历史结果；搜索后将在下方显示设备。</p></>}
        {busy && <p>正在搜索，请稍候；较大网段可能需要约一分钟。</p>}
        {historyTime && <p>上次发现于 {historyTime}，{busy ? '正在重新验证' : '历史结果尚未重新验证，请点击开始搜索'}</p>}
        {result && !historyTime && <p>{result.cancelled ? '搜索已取消' : '搜索完成'}，找到 {result.candidates.length} 个候选地址。</p>}
        {result?.warnings.map((warning) => <p key={warning}>{warning}</p>)}
      </div>
      {error && <p role="alert">{error}</p>}
      {result && <section className="lan-results" aria-label="发现的设备" ref={resultsRef}>
        <div className="lan-results-heading">
          <div>{selectedNetwork && <span className="lan-results-source">{networkName(selectedNetwork)} · {searchRange} · ADB 自动发现 + TCP 端口 {port}</span>}<h3><Monitor size={20} aria-hidden="true" />发现的设备 <span className="lan-count">{result.candidates.length}</span></h3>
            <p>{result.candidates.length ? '点击设备右侧的按钮即可连接，无需再填写 IP。' : '请确认屏幕已开启网络 ADB，并选择正确的网络。仍未找到时，可在高级选项填写设备当前的调试端口，或手动填写 IP 和端口连接。'}</p>
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
                disabled={locked || historyTime !== null || item.pairing || isConnected}
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
