import type { NodeSession, QrTokenRecord, ReportRecord } from './types.js'

// Sessions keyed by unique sessionId (one entry per WS session). Multiple
// sessions may share the same nodeId — that is the "multi-device same
// identity" model the cluster channel relies on.
export const nodes    = new Map<string, NodeSession>()
export const channels = new Map<string, Set<string>>()    // channelId -> sessionIds
export const qrTokens = new Map<string, QrTokenRecord>()
export const reports: ReportRecord[] = []

export function findSessionByToken(token: string): NodeSession | null {
  for (const s of nodes.values()) {
    if (s.token === token) return s
  }
  return null
}

export function findSessionsByNodeAndHash(nodeId: number, passCodeHash: string): NodeSession[] {
  const out: NodeSession[] = []
  for (const s of nodes.values()) {
    if (s.nodeId === nodeId && s.passCodeHash === passCodeHash) out.push(s)
  }
  return out
}

export const stats = {
  totalTransfers: 0,
  totalBytes: 0,
  startedAt: Date.now(),
  peakConcurrent: 0,
}

// Track peak concurrent connections
const cpuStart = process.cpuUsage()
export function getCpuUsagePercent(): number {
  const elapsed = (Date.now() - stats.startedAt) / 1000
  const used = process.cpuUsage(cpuStart)
  const totalMs = (used.user + used.system) / 1000 // CPU time in ms
  return Math.round((totalMs / (elapsed * 1000)) * 100)
}

export function updatePeakConcurrent() {
  const online = getOnlineCount()
  if (online > stats.peakConcurrent) stats.peakConcurrent = online
}

export function getOnlineCount() {
  let count = 0
  for (const n of nodes.values()) {
    if (n.socket !== null) count++
  }
  return count
}

export function getLongestUptimeMs() {
  let longest = 0
  const now = Date.now()
  for (const n of nodes.values()) {
    if (n.socket !== null) {
      const uptime = now - n.joinedAt
      if (uptime > longest) longest = uptime
    }
  }
  return longest
}

export function countNodesByIp(ip: string): number {
  let count = 0
  for (const n of nodes.values()) {
    if (n.ip === ip) count++
  }
  return count
}

export function countReportsForTarget(nodeId: number, since: number): number {
  let count = 0
  for (const r of reports) {
    if (r.targetNodeId === nodeId && r.reportedAt > since) count++
  }
  return count
}

export function clusterChannelId(nodeId: number, passCodeHash: string): string {
  // Channel scope = identity tuple. Same nodeId+passcode → same cluster.
  return `cluster-${nodeId}-${passCodeHash.slice(0, 16)}`
}
