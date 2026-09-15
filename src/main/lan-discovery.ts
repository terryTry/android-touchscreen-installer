import { networkInterfaces } from 'node:os'
import { isIP } from 'node:net'
import type { AdbGateway } from './adb-client'
import type { LanNetwork, LanCandidate, LanSearchResult } from '../shared/contracts'

const numberIp = (ip: string): number => ip.split('.').reduce((n, part) => (n * 256 + Number(part)) >>> 0, 0)
const textIp = (n: number): string => [24, 16, 8, 0].map((shift) => (n >>> shift) & 255).join('.')

export function subnetHosts(network: LanNetwork): string[] {
  const address = numberIp(network.address)
  const mask = numberIp(network.netmask)
  const size = (~mask >>> 0) + 1
  if (size > 4096) throw new Error('当前网段超过 4094 个地址，请选择较小网段或手动连接。')
  if (size <= 2) return []
  const start = (address & mask) >>> 0
  return Array.from({ length: size - 2 }, (_, i) => textIp(start + i + 1)).filter((ip) => ip !== network.address)
}

export function parseMdns(output: string): LanCandidate[] {
  const result: LanCandidate[] = []
  for (const line of output.split('\n')) {
    const match = line.match(/\b(_adb-tls-connect|_adb-tls-pairing|_adb)\._tcp\.?\s+(\d+\.\d+\.\d+\.\d+):(\d+)\s*$/)
    if (!match) continue
    const host = match[2]!
    const port = Number(match[3])
    if (isIP(host) !== 4 || port < 1 || port > 65535) continue
    result.push({ host, port, source: 'mdns', pairing: match[1] === '_adb-tls-pairing' })
  }
  return result
}

export class LanDiscovery {
  private active: { cancelled: boolean } | null = null
  constructor(private readonly adb: AdbGateway) {}

  networks(): LanNetwork[] {
    return Object.entries(networkInterfaces()).flatMap(([name, entries]) =>
      (entries ?? []).filter((entry) => entry.family === 'IPv4' && !entry.internal).map((entry) => ({
        id: `${name}:${entry.address}`, label: `${name} · ${entry.address} / ${entry.netmask}`,
        address: entry.address, netmask: entry.netmask
      })))
  }

  cancel(): void { if (this.active) this.active.cancelled = true }

  async search(id: string, port: number): Promise<LanSearchResult> {
    if (this.active) throw new Error('已有局域网搜索正在进行。')
    const network = this.networks().find((item) => item.id === id)
    if (!network) throw new Error('网卡地址已变化，请重新打开搜索。')
    const hosts = subnetHosts(network)
    const token = { cancelled: false }
    this.active = token
    const candidates = new Map<string, LanCandidate>()
    const warnings: string[] = []
    const add = (candidate: LanCandidate) => {
      const key = `${candidate.host}:${candidate.port}`
      if (!token.cancelled && candidates.get(key)?.source !== 'mdns') candidates.set(key, candidate)
    }
    try {
      let next = 0
      const workers = Array.from({ length: Math.min(32, hosts.length) }, async () => {
        while (!token.cancelled && next < hosts.length) {
          const host = hosts[next++]!
          try {
            const probe = await this.adb.probeTcpEndpoint(host, port, 450)
            if (probe.status === 'open') add({ host, port, source: 'tcp', pairing: false })
          } catch {
            if (!warnings.includes('部分地址探测失败。')) warnings.push('部分地址探测失败。')
          }
        }
      })
      const mdns = (async () => {
        try {
          const result = await this.adb.run(['mdns', 'services'], { timeoutMs: 4000 })
          if (result.exitCode !== 0 || result.timedOut) warnings.push('mDNS 发现不可用，已使用端口扫描。')
          else {
            const mask = numberIp(network.netmask)
            for (const candidate of parseMdns(result.stdout)) {
              if ((numberIp(candidate.host) & mask) === (numberIp(network.address) & mask)) add(candidate)
            }
          }
        } catch { warnings.push('mDNS 发现失败，已使用端口扫描。') }
      })()
      await Promise.all([...workers, mdns])
      return { candidates: [...candidates.values()].sort((a, b) => numberIp(a.host) - numberIp(b.host) || a.port - b.port), cancelled: token.cancelled, warnings }
    } finally { this.active = null }
  }
}
