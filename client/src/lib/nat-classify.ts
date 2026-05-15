// ── Pure NAT classification logic ─────────────────────────────────────
// Separated from nat.ts so it can be unit-tested without a browser
// (no DOM globals, no path aliases, no module-level side effects).

export type NatType = 'open' | 'cone' | 'symmetric' | 'blocked' | 'unknown'

export interface ParsedCandidate {
  type: 'host' | 'srflx' | 'relay' | 'prflx'
  protocol: 'udp' | 'tcp'
  address: string
  port: number
  relatedAddress?: string
  relatedPort?: number
}

export interface NatDetectionResult {
  type: NatType
  publicEndpoints: string[]      // unique srflx "ip:port" observed
  hasHostCandidate: boolean
  reason: string
}

const PRIVATE_V4 = [
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^127\./,
  /^169\.254\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,    // CGNAT 100.64.0.0/10
]

export function isPrivateAddress(addr: string): boolean {
  if (!addr) return true
  if (addr.endsWith('.local')) return true
  if (addr.includes(':')) {
    // IPv6 — fc00::/7 (ULA), fe80::/10 (link-local), ::1
    const lo = addr.toLowerCase()
    if (lo === '::1') return true
    if (lo.startsWith('fe8') || lo.startsWith('fe9') || lo.startsWith('fea') || lo.startsWith('feb')) return true
    if (lo.startsWith('fc') || lo.startsWith('fd')) return true
    return false
  }
  return PRIVATE_V4.some(re => re.test(addr))
}

// Parse a single SDP candidate line. Accepts both the `candidate:` prefix
// and the bare attribute body.
//
//   candidate:842163049 1 udp 1677729535 1.2.3.4 51234 typ srflx raddr 192.168.1.10 rport 56789
//
export function parseCandidate(line: string): ParsedCandidate | null {
  if (!line) return null
  const s = line.startsWith('candidate:') ? line.slice('candidate:'.length) : line
  const tokens = s.trim().split(/\s+/)
  if (tokens.length < 8) return null

  // tokens: foundation component proto priority ip port "typ" type [extras]
  const protocol = tokens[2]?.toLowerCase()
  const address = tokens[4]
  const port = Number(tokens[5])
  const typIdx = tokens.indexOf('typ')
  const type = typIdx >= 0 ? tokens[typIdx + 1] : undefined

  if (!type || !address || !Number.isFinite(port)) return null
  if (type !== 'host' && type !== 'srflx' && type !== 'relay' && type !== 'prflx') return null
  if (protocol !== 'udp' && protocol !== 'tcp') return null

  let relatedAddress: string | undefined
  let relatedPort: number | undefined
  const raddrIdx = tokens.indexOf('raddr')
  if (raddrIdx >= 0 && tokens[raddrIdx + 1]) relatedAddress = tokens[raddrIdx + 1]
  const rportIdx = tokens.indexOf('rport')
  if (rportIdx >= 0 && tokens[rportIdx + 1]) relatedPort = Number(tokens[rportIdx + 1])

  return { type: type as ParsedCandidate['type'], protocol: protocol as 'udp' | 'tcp', address, port, relatedAddress, relatedPort }
}

export function classifyNat(candidates: ParsedCandidate[]): NatDetectionResult {
  const hostV4Public = candidates.find(c =>
    c.type === 'host' && !c.address.includes(':') && !isPrivateAddress(c.address),
  )
  const hostAny = candidates.find(c => c.type === 'host')
  const srflx = candidates.filter(c => c.type === 'srflx')

  if (hostV4Public) {
    return {
      type: 'open',
      publicEndpoints: [`${hostV4Public.address}:${hostV4Public.port}`],
      hasHostCandidate: true,
      reason: '本机已分配公网地址，无 NAT。',
    }
  }

  const publicEndpoints = Array.from(new Set(srflx.map(c => `${c.address}:${c.port}`)))

  if (srflx.length === 0) {
    return {
      type: 'blocked',
      publicEndpoints: [],
      hasHostCandidate: !!hostAny,
      reason: '未收到任何 srflx 候选，UDP 可能被防火墙拦截。',
    }
  }

  // Group srflx candidates by their local socket (relatedAddress:relatedPort).
  // Within a single local socket, multiple distinct public mappings →
  // symmetric NAT (different external port per destination).
  const byLocal = new Map<string, Set<string>>()
  for (const c of srflx) {
    const key = `${c.relatedAddress ?? '?'}:${c.relatedPort ?? '?'}`
    const set = byLocal.get(key) ?? new Set<string>()
    set.add(`${c.address}:${c.port}`)
    byLocal.set(key, set)
  }

  for (const set of byLocal.values()) {
    if (set.size > 1) {
      return {
        type: 'symmetric',
        publicEndpoints,
        hasHostCandidate: !!hostAny,
        reason: `同一本地端口对不同 STUN 返回了 ${set.size} 个不同的公网映射，判定为对称 NAT。`,
      }
    }
  }

  return {
    type: 'cone',
    publicEndpoints,
    hasHostCandidate: !!hostAny,
    reason: '同一本地端口在所有 STUN 上的公网映射一致，可被 P2P 直连。',
  }
}
