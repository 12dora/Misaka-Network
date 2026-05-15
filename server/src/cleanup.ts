import { nodes, channels, qrTokens, reports, getOnlineCount } from './store.js'
import { cleanupRateLimitWindows } from './ratelimit.js'
import { CLEANUP_INTERVAL_MS, DISCONNECTED_TTL_MS, LOCK_DURATION_MS, REPORT_TTL_MS } from './config.js'

let zeroActiveSince: number | null = null

export function startCleanupTask() {
  setInterval(() => {
    const now = Date.now()

    // --- Session cleanup: when all nodes go offline, remove disconnected
    //     sessions after a short grace period.
    const activeCount = getOnlineCount()
    if (activeCount === 0) {
      if (zeroActiveSince === null) {
        zeroActiveSince = now
      } else if (now - zeroActiveSince >= DISCONNECTED_TTL_MS) {
        for (const [sessionId, session] of nodes) {
          if (session.socket === null) {
            nodes.delete(sessionId)
            if (session.channelId) {
              const ch = channels.get(session.channelId)
              if (ch) {
                ch.delete(sessionId)
                if (ch.size === 0) channels.delete(session.channelId)
              }
            }
          }
        }
        zeroActiveSince = null
      }
    } else {
      zeroActiveSince = null
    }

    // Unlock expired locks
    for (const [, session] of nodes) {
      if (session.lockedUntil > 0 && now >= session.lockedUntil) {
        session.lockedUntil = 0
        session.failedAttempts = 0
      }
    }

    // Purge expired / used QR tokens
    for (const [token, record] of qrTokens) {
      if (now > record.expiresAt || record.used) {
        qrTokens.delete(token)
      }
    }

    // Purge empty channels
    for (const [channelId, members] of channels) {
      if (members.size === 0) channels.delete(channelId)
    }

    // Purge old reports
    for (let i = reports.length - 1; i >= 0; i--) {
      if (now - reports[i].reportedAt > REPORT_TTL_MS) {
        reports.splice(i, 1)
      }
    }

    // Purge stale rate limit windows
    cleanupRateLimitWindows()
  }, CLEANUP_INTERVAL_MS)
}
