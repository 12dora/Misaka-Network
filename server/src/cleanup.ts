import { nodes, channels, qrTokens, reports, attemptLocks, nodeFreezes, isSessionExpired, unmarkSocket } from './store.js'
import { broadcast } from './activity.js'
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

    // --- Session cleanup. Two independent reasons to purge:
    //
    //   1. Expiry (SECURITY-001). The advertised absolute TTL is enforced
    //      here, for CONNECTED sessions too: the socket is closed with 4002
    //      (which the client already treats as "drop the cached session and
    //      re-register") and the session leaves the map, so its nodeId, its
    //      per-IP slot and every token-derived permission stop together.
    //   2. Idle-after-disconnect: socket gone AND untouched past
    //      DISCONNECTED_TTL_MS. The old "only when activeCount === 0" gate
    //      meant a single long-lived user pinned every zombie session in the
    //      map indefinitely, eating per-IP slots on shared egress IPs.
    for (const [sessionId, session] of nodes) {
      const expired = isSessionExpired(session, now)
      if (!expired) {
        if (session.socket !== null) continue
        if (now - session.lastSeen < DISCONNECTED_TTL_MS) continue
      }
      if (session.socket) {
        unmarkSocket(session.socket)
        try { session.socket.close(4002, 'SESSION_EXPIRED') } catch { /* already gone */ }
        session.socket = null
      }
      nodes.delete(sessionId)
      if (session.channelId) {
        const ch = channels.get(session.channelId)
        if (ch) {
          ch.delete(sessionId)
          if (ch.size === 0) channels.delete(session.channelId)
        }
      }
      if (expired) {
        broadcast({ type: 'leave', nodeId: session.nodeId, message: `御坂 ${session.nodeId} 号通信终止` })
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
