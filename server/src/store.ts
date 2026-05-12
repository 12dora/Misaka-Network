import type { NodeSession, QrTokenRecord } from './types.js'

export const nodes    = new Map<number, NodeSession>()
export const channels = new Map<string, Set<number>>()
export const qrTokens = new Map<string, QrTokenRecord>()

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
