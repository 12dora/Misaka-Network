import { nodes, channels, qrTokens, reports } from './store.js'
import { cleanupRateLimitWindows } from './ratelimit.js'

const SESSION_TTL = 30 * 60 * 1000  // 30 minutes
const LOCK_DURATION = 5 * 60 * 1000
const REPORT_TTL = 60 * 60 * 1000   // 1 hour

export function startCleanupTask() {
  setInterval(() => {
    const now = Date.now()

    for (const [nodeId, session] of nodes) {
      // Auto-unlock nodes whose lock has expired
      if (session.lockedUntil > 0 && now >= session.lockedUntil) {
        session.lockedUntil = 0
        session.failedAttempts = 0
      }

      // Expire idle disconnected sessions
      if (session.socket === null && now - session.lastSeen > SESSION_TTL) {
        nodes.delete(nodeId)
        if (session.channelId) {
          const ch = channels.get(session.channelId)
          if (ch) {
            ch.delete(nodeId)
            if (ch.size === 0) channels.delete(session.channelId)
          }
        }
      }
    }

    for (const [token, record] of qrTokens) {
      if (now > record.expiresAt || record.used) {
        qrTokens.delete(token)
      }
    }

    for (const [channelId, members] of channels) {
      if (members.size === 0) channels.delete(channelId)
    }

    // Purge old reports
    for (let i = reports.length - 1; i >= 0; i--) {
      if (now - reports[i].reportedAt > REPORT_TTL) {
        reports.splice(i, 1)
      }
    }

    // Purge stale rate limit windows
    cleanupRateLimitWindows()
  }, 60_000)
}
