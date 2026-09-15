import { describe, expect, it, vi } from 'vitest'
import { LanDiscovery, parseMdns, subnetHosts } from './lan-discovery'
import type { AdbGateway } from './adb-client'

const network = { id: 'test', label: 'test', address: '192.168.2.5', netmask: '255.255.255.248' }
describe('局域网发现', () => {
  it('按真实子网掩码排除网络、广播和本机地址，拒绝过大网段', () => {
    expect(subnetHosts(network)).toEqual(['192.168.2.1', '192.168.2.2', '192.168.2.3', '192.168.2.4', '192.168.2.6'])
    expect(() => subnetHosts({ ...network, netmask: '255.255.0.0' })).toThrow('超过')
    expect(subnetHosts({ ...network, netmask: '255.255.255.254' })).toEqual([])
  })
  it('区分配对端口和连接端口并过滤非法地址', () => {
    expect(parseMdns('List of discovered mdns services\na _adb-tls-connect._tcp 192.168.2.2:32123\nb _adb-tls-pairing._tcp. 192.168.2.3:32124\nc _adb._tcp 999.1.1.1:5555')).toEqual([
      { host: '192.168.2.2', port: 32123, source: 'mdns', pairing: false },
      { host: '192.168.2.3', port: 32124, source: 'mdns', pairing: true }
    ])
  })
  it('合并去重并保留 mDNS 信息，过滤其他网段且不执行连接', async () => {
    const run = vi.fn(async () => ({ exitCode: 0, timedOut: false, stdout: 'a _adb-tls-connect._tcp 192.168.2.2:5555\nb _adb._tcp 10.0.0.1:5555' }))
    const discovery = new LanDiscovery({ run, probeTcpEndpoint: vi.fn(async (host: string) => ({ status: host.endsWith('.2') ? 'open' : 'closed' })) } as unknown as AdbGateway)
    vi.spyOn(discovery, 'networks').mockReturnValue([network])
    expect((await discovery.search('test', 5555)).candidates).toEqual([{ host: '192.168.2.2', port: 5555, source: 'mdns', pairing: false }])
    expect(run).toHaveBeenCalledExactlyOnceWith(['mdns', 'services'], { timeoutMs: 4000 })
  })
  it('指定 TCP 扫描端口不限制 mDNS 的动态连接和配对端口', async () => {
    const probeTcpEndpoint = vi.fn(async () => ({ status: 'closed' }))
    const discovery = new LanDiscovery({
      run: async () => ({ exitCode: 0, timedOut: false, stdout: 'a _adb-tls-connect._tcp 192.168.2.2:37123\nb _adb-tls-pairing._tcp 192.168.2.2:39123' }),
      probeTcpEndpoint
    } as unknown as AdbGateway)
    vi.spyOn(discovery, 'networks').mockReturnValue([network])
    for (const port of [5555, 5556]) {
      probeTcpEndpoint.mockClear()
      expect((await discovery.search('test', port)).candidates).toEqual([
        { host: '192.168.2.2', port: 37123, source: 'mdns', pairing: false },
        { host: '192.168.2.2', port: 39123, source: 'mdns', pairing: true }
      ])
      expect(probeTcpEndpoint.mock.calls).toEqual(subnetHosts(network).map((host) => [host, port, 450]))
    }
  })
  it('取消后不收集迟到结果，并拒绝并发搜索', async () => {
    let resolve!: (value: { status: string }) => void
    const pending = new Promise<{ status: string }>((done) => { resolve = done })
    const discovery = new LanDiscovery({ run: async () => ({ exitCode: 1 }), probeTcpEndpoint: () => pending } as unknown as AdbGateway)
    vi.spyOn(discovery, 'networks').mockReturnValue([network])
    const search = discovery.search('test', 5555)
    await expect(discovery.search('test', 5555)).rejects.toThrow('正在进行')
    discovery.cancel()
    resolve({ status: 'open' })
    expect(await search).toMatchObject({ candidates: [], cancelled: true })
  })
})
