import type { NodeSession, QrTokenRecord, ReportRecord } from './types.js'

export const nodes    = new Map<number, NodeSession>()
export const channels = new Map<string, Set<number>>()
export const qrTokens = new Map<string, QrTokenRecord>()
export const reports: ReportRecord[] = []

export const stats = {
  totalTransfers: 0,
  totalBytes: 0,
  startedAt: Date.now(),
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
