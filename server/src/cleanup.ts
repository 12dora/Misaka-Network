import { nodes, channels, qrTokens, reports, attemptLocks, nodeFreezes } from './store.js'
import { cleanupRateLimitWindows } from './ratelimit.js'
import {
  CLEANUP_INTERVAL_MS, DISCONNECTED_TTL_MS, LOCK_DURATION_MS, REPORT_TTL_MS,
  NODE_FREEZE_WINDOW_MS,
} from './config.js'

let cleanupTimer: NodeJS.Timeout | null = null

export function startCleanupTask() {
  if (cleanupTimer) return
  cleanupTimer = setInterval(() => {
    const now = Date.now()

    // --- Session cleanup: any session whose socket is gone AND has been idle
    //     past DISCONNECTED_TTL_MS gets purged, regardless of whether other
    //     users are still online. The old "only when activeCount === 0" gate
    //     meant a single long-lived user pinned every zombie session in the
    //     map indefinitely, eating per-IP slots on shared egress IPs.
    for (const [sessionId, session] of nodes) {
      if (session.socket !== null) continue
      if (now - session.lastSeen < DISCONNECTED_TTL_MS) continue
      nodes.delete(sessionId)
      if (session.channelId) {
        const ch = channels.get(session.channelId)
        if (ch) {
          ch.delete(sessionId)
          if (ch.size === 0) channels.delete(session.channelId)
        }
      }
    }

    // Unlock expired locks
    for (const [, session] of nodes) {
      if (session.lockedUntil > 0 && now >= session.lockedUntil) {
        session.lockedUntil = 0
        session.failedAttempts = 0
      }
    }

    // Purge stale per-attempter brute-force locks (Bug F7). Entries are
    // dropped once their lock has expired AND no attempt has happened in
    // the last LOCK_DURATION_MS — otherwise we'd reset the count for an
    // active brute-force session and let the attacker keep guessing.
    for (const [key, lock] of attemptLocks) {
      const lockExpired = lock.lockedUntil === 0 || now >= lock.lockedUntil
      const idle = now - lock.lastAttemptAt >= LOCK_DURATION_MS
      if (lockExpired && idle) {
        attemptLocks.delete(key)
      }
    }

    // Purge expired node freezes (P1-5). When a freeze has elapsed AND its
    // most recent failure is older than the rolling window, the entry is
    // pure garbage — drop it.
    for (const [nodeId, freeze] of nodeFreezes) {
      const freezeExpired = freeze.frozenUntil === 0 || now >= freeze.frozenUntil
      const lastFailureAt = freeze.recentFailures.length
        ? freeze.recentFailures[freeze.recentFailures.length - 1].at
        : 0
      const idle = now - lastFailureAt >= NODE_FREEZE_WINDOW_MS
      if (freezeExpired && idle) {
        nodeFreezes.delete(nodeId)
      } else if (freezeExpired) {
        // Reset the timer but keep recent failure history so a re-trigger
        // is fast.
        freeze.frozenUntil = 0
        freeze.recentFailures = freeze.recentFailures.filter(r => now - r.at < NODE_FREEZE_WINDOW_MS)
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
  cleanupTimer.unref?.()
}

export function stopCleanupTask() {
  if (!cleanupTimer) return
  clearInterval(cleanupTimer)
  cleanupTimer = null
}
