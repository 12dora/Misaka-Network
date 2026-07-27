import { Router, type Request, type Response, type NextFunction } from 'express'
import { randomBytes, timingSafeEqual } from 'crypto'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import {
  nodes, channels, qrTokens, reports, stats, getOnlineCount, getLongestUptimeMs, countNodesByIp,
  getCpuUsagePercent, findSessionByToken, attemptLocks, attemptKey,
  nodeFreezes, hashPassCodeIdentity, newPassCodeRecord, verifyAndMaybeUpgrade,
  deriveCustomIdentifier, redactCustomIdentifier, ScryptBusyError, unmarkSocket,
} from './store.js'
import { broadcast } from './activity.js'
import { checkRateLimit } from './ratelimit.js'
import { issueCredentials, getPublicTurnStatus, getOperatorTurnStatus, classifyTurnStatusAuth } from './turn.js'
import { getPersistReadiness } from './persist.js'
import { isHttpOriginAllowed, getRequestOrigin } from './origin.js'
import type { NodeSession, QrTokenRecord, ReportRecord } from './types.js'
import {
  MAX_NODES, MAX_NODES_PER_IP, NODE_ID_MIN, NODE_ID_MAX,
  MAX_ATTEMPTS, LOCK_DURATION_MS,
  SESSION_TTL_MS, QR_TOKEN_TTL_MS,
  RATE_LIMIT_PER_MIN, RATE_WINDOW_MS,
  REPORT_RATE_MAX, REPORT_RATE_WINDOW_MS, REPORT_WARN_COUNT, REPORT_WARN_WINDOW_MS,
  NODE_FREEZE_THRESHOLD, NODE_FREEZE_WINDOW_MS, NODE_FREEZE_DURATION_MS,
  QR_REDEEM_RATE_LIMIT, QR_REDEEM_RATE_WINDOW_MS,
  MAX_TRANSFER_BYTES, TRANSFER_DONE_RATE_LIMIT, TRANSFER_DONE_RATE_WINDOW_MS,
  E2E_UNAUTH_RELEASE_ALLOWED,
} from './config.js'

export const router = Router()

// Re-export so legacy import sites keep working without touching the new
// derivation location (which lives in store.js to avoid a circular import
// between turn.ts and http.ts).
export { deriveCustomIdentifier, redactCustomIdentifier }

// Canonical client-IP extractor used by every HTTP handler. Express'
// `req.ip` already honours `app.set('trust proxy', 1)`, so X-Forwarded-For's
// first hop becomes req.ip in test scripts that pass that header. Falling
// back to the socket address keeps unit tests that bypass the proxy chain
// (and any non-proxied prod request) from getting an "unknown" IP.
export function getClientIP(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown'
}

// Shared origin guard for CSRF-sensitive routes. We refuse if the request
// arrived with an Origin header that isn't on the allow-list. Missing
// Origin (server-to-server / native client / curl) keeps falling through
// to whatever token auth the route already requires.
function enforceOrigin(req: Request, res: Response): boolean {
  if (isHttpOriginAllowed(req)) return true
  res.status(403).json({ error: 'BAD_ORIGIN', origin: getRequestOrigin(req) ?? null })
  return false
}

// Express 4 does not forward a rejected promise out of a route handler, so an
// async route that throws would leave the request hanging until the client
// gives up. Every async handler below goes through this wrapper. A
// ScryptBusyError means the bounded passcode-hashing budget (SECURITY-013) is
// saturated — that is a "come back later", not a bug, so it maps to 503.
function asyncRoute(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err: unknown) => {
      if (res.headersSent) return
      if (err instanceof ScryptBusyError) {
        res.status(503).json({ error: 'SERVER_BUSY', message: '服务器繁忙，请稍后再试' })
        return
      }
      console.error('[http] 路由未捕获异常:', err)
      res.status(500).json({ error: 'INTERNAL' })
    })
  }
}

// Rate limit middleware
router.use((req: Request, res: Response, next: NextFunction) => {
  const ip = getClientIP(req)
  if (!checkRateLimit(`api:${ip}`, RATE_LIMIT_PER_MIN, RATE_WINDOW_MS)) {
    res.status(429).json({ error: 'RATE_LIMITED', message: '请求过于频繁，请稍后再试' })
    return
  }
  next()
})

// ── nodeId-freeze helpers (P1-5) ─────────────────────────────────────
function pruneFreezeFailures(freeze: { recentFailures: Array<{ at: number; ip: string }> }, now: number) {
  const cutoff = now - NODE_FREEZE_WINDOW_MS
  if (freeze.recentFailures.length === 0) return
  // Keep entries newer than cutoff. Most freezes hold a handful of entries
  // so a single pass is fine; only when we reach the threshold (default 20)
  // do we even allocate.
  freeze.recentFailures = freeze.recentFailures.filter(r => r.at >= cutoff)
}

function isNodeFrozen(nodeId: number, now: number): { frozen: true; until: number } | { frozen: false } {
  const freeze = nodeFreezes.get(nodeId)
  if (!freeze) return { frozen: false }
  if (freeze.frozenUntil > now) return { frozen: true, until: freeze.frozenUntil }
  // Expired freeze — clear and let the caller proceed normally.
  if (freeze.frozenUntil > 0) {
    freeze.frozenUntil = 0
    freeze.recentFailures = []
  }
  return { frozen: false }
}

function recordFailedPasscodeAttempt(nodeId: number, ip: string, now: number) {
  let freeze = nodeFreezes.get(nodeId)
  if (!freeze) {
    freeze = { recentFailures: [], frozenUntil: 0 }
    nodeFreezes.set(nodeId, freeze)
  }
  pruneFreezeFailures(freeze, now)
  freeze.recentFailures.push({ at: now, ip })
  // Trigger condition: total failures from N distinct IPs in window OR raw
  // failure count >= threshold. We treat the latter as the dominant signal
  // because a single noisy attacker rotating proxies still funnels through
  // shared egress IPs sometimes.
  if (freeze.recentFailures.length >= NODE_FREEZE_THRESHOLD) {
    freeze.frozenUntil = now + NODE_FREEZE_DURATION_MS
  }
}

function clearNodeFreezeOnSuccess(nodeId: number) {
  // Owner just succeeded — drop the freeze counter (but not an active
  // freeze, which they cannot dismiss by themselves; that requires the
  // duration to elapse). This avoids a freeze caused by past noise from
  // unrelated attempters persisting forever in memory.
  const freeze = nodeFreezes.get(nodeId)
  if (!freeze) return
  if (freeze.frozenUntil === 0) {
    nodeFreezes.delete(nodeId)
  } else {
    // Active freeze — keep the timer running but stop bleeding the counter
    // upward. The owner getting in (impossible during a freeze for new
    // registers; only their existing session would still be authenticated)
    // is logged but doesn't unfreeze.
  }
}

// POST /api/register
router.post('/register', asyncRoute(async (req, res) => {
  if (!enforceOrigin(req, res)) return

  const parsed = z.object({
    nodeId:   z.number().int().min(NODE_ID_MIN).max(NODE_ID_MAX),
    passCode: z.string().length(6).regex(/^\d{6}$/),
  }).safeParse(req.body)

  if (!parsed.success) {
    res.status(400).json({ error: 'INVALID_INPUT' })
    return
  }

  const { nodeId, passCode } = parsed.data
  const ip = getClientIP(req)
  const now = Date.now()
  const identityHash = hashPassCodeIdentity(passCode)

  // Per-nodeId global freeze (P1-5). Refuses *every* register from any IP
  // while the freeze is active — even the owner from a new IP. The owner's
  // already-open WS session continues working (this only gates new
  // registrations).
  const frozen = isNodeFrozen(nodeId, now)
  if (frozen.frozen) {
    res.status(423).json({ error: 'NODE_LOCKED', reason: 'NODE_FROZEN', unlockAt: frozen.until })
    return
  }

  // Brute-force lock (Bug F7): the lock follows the *attempter*, not the
  // owner. Key = (ip, nodeId). If the attempter is currently locked we
  // refuse before even looking at the passcode, so brute-force probes can't
  // distinguish "you got it right but you're still locked" from a guess.
  // The owner on a DIFFERENT IP is unaffected — that is the whole point
  // of the fix.
  const lockKey = attemptKey(ip, nodeId)
  let lock = attemptLocks.get(lockKey)
  if (lock && now < lock.lockedUntil) {
    res.status(423).json({ error: 'NODE_LOCKED', reason: 'WRONG_PASSCODE', unlockAt: lock.lockedUntil })
    return
  }
  // Expired lock — clear it so a fresh attempt cycle can begin.
  if (lock && lock.lockedUntil > 0 && now >= lock.lockedUntil) {
    attemptLocks.delete(lockKey)
    lock = undefined
  }

  // Identity = (nodeId, identityHash). Reject if any session already exists
  // with the same nodeId but a different identity hash — that nodeId is
  // "owned" by someone else. Otherwise we permit a brand-new session for
  // this identity: multiple devices may share the same identity
  // (phone + PC1 + PC2) and the cluster channel relies on that.
  const sameNodeSessions: NodeSession[] = []
  for (const s of nodes.values()) {
    if (s.nodeId === nodeId) sameNodeSessions.push(s)
  }
  const conflict = sameNodeSessions.find(s => s.passCodeHash !== identityHash)
  if (conflict) {
    // Failure attributed to (ip, nodeId), NOT to the owner session.
    if (!lock) {
      lock = { attempts: 0, lockedUntil: 0, lastAttemptAt: now }
      attemptLocks.set(lockKey, lock)
    }
    lock.attempts++
    lock.lastAttemptAt = now

    // Also feed the per-nodeId global counter so IP-rotation attacks get
    // caught even though each IP individually never reaches MAX_ATTEMPTS.
    recordFailedPasscodeAttempt(nodeId, ip, now)

    if (lock.attempts >= MAX_ATTEMPTS) {
      lock.lockedUntil = now + LOCK_DURATION_MS
      res.status(423).json({ error: 'NODE_LOCKED', reason: 'WRONG_PASSCODE', unlockAt: lock.lockedUntil })
    } else {
      const remaining = MAX_ATTEMPTS - lock.attempts
      res.status(409).json({ error: 'NODE_OCCUPIED', message: '该节点编号的通行码错误，请重新输入', remaining })
    }
    return
  }

  if (nodes.size >= MAX_NODES) {
    res.status(503).json({ error: 'NETWORK_FULL', message: '御坂网络已达容量上限' })
    return
  }
  if (countNodesByIp(ip) >= MAX_NODES_PER_IP) {
    res.status(429).json({ error: 'IP_LIMITED', message: '此 IP 地址节点数已达上限' })
    return
  }

  const sessionId = nanoid(16)
  const token = randomBytes(32).toString('hex')
  // scrypt is async now (SECURITY-013), so the admission checks above are no
  // longer atomic with the insert below — two concurrent registers for the
  // same nodeId could both have passed. Re-run the two checks that guard
  // shared state after the await, before we publish the session.
  const pcRecord = await newPassCodeRecord(passCode)
  for (const s of nodes.values()) {
    if (s.nodeId === nodeId && s.passCodeHash !== pcRecord.passCodeHash) {
      res.status(409).json({ error: 'NODE_OCCUPIED', message: '该节点编号的通行码错误，请重新输入', remaining: MAX_ATTEMPTS })
      return
    }
  }
  if (nodes.size >= MAX_NODES) {
    res.status(503).json({ error: 'NETWORK_FULL', message: '御坂网络已达容量上限' })
    return
  }
  if (countNodesByIp(ip) >= MAX_NODES_PER_IP) {
    res.status(429).json({ error: 'IP_LIMITED', message: '此 IP 地址节点数已达上限' })
    return
  }

  const session: NodeSession = {
    sessionId,
    nodeId,
    passCodeHash: pcRecord.passCodeHash,
    token,
    socket: null,
    lastSeen: now,
    channelId: null,
    blockedIds: new Set(),
    failedAttempts: 0,
    lockedUntil: 0,
    joinedAt: now,
    // SECURITY-001: the TTL we advertise below is now also the one we store
    // and enforce. Absolute, never extended by reconnects.
    expiresAt: now + SESSION_TTL_MS,
    ip,
  }
  // Attach scrypt verification fields. These may not exist on the
  // NodeSession type yet — the main agent will add them — so we use a
  // cast for the per-field assignment until the type is updated.
  const sessAny = session as NodeSession & {
    passCodeVerifyHash?: string
    passCodeSalt?: string
    passCodeAlgo?: 'sha256' | 'scrypt'
  }
  sessAny.passCodeVerifyHash = pcRecord.passCodeVerifyHash
  sessAny.passCodeSalt = pcRecord.passCodeSalt
  sessAny.passCodeAlgo = pcRecord.passCodeAlgo

  nodes.set(sessionId, session)

  // A successful register from this (ip, nodeId) means the caller knows the
  // right passcode, so clear any prior lockout we'd been tracking against
  // this attempter.
  attemptLocks.delete(lockKey)
  clearNodeFreezeOnSuccess(nodeId)

  broadcast({ type: 'join', nodeId, message: `御坂 ${nodeId} 号已接入网络` })

  res.json({ sessionId, token, expiresAt: session.expiresAt, resumed: false })
}))

// Loopback check for the E2E escape hatch (SECURITY-016). The Playwright
// harness always talks to 127.0.0.1; a real deployment's clients never do.
function isLoopbackAddress(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip.startsWith('127.')
}

// POST /api/release-by-ip
router.post('/release-by-ip', asyncRoute(async (req, res) => {
  if (!enforceOrigin(req, res)) return

  const authHeader = req.headers.authorization
  const ip = getClientIP(req)
  const now = Date.now()

  // SECURITY-016: the unauthenticated "wipe every session on this IP" path is
  // only reachable when ALL THREE hold — the env flag is set, the process is
  // not a production build (see config.E2E_UNAUTH_RELEASE_ALLOWED), and the
  // caller is on loopback. A production process that merely inherits the flag
  // by mistake still gets the normal 401.
  const testBypass = E2E_UNAUTH_RELEASE_ALLOWED && isLoopbackAddress(req.socket.remoteAddress ?? '')

  let scopeNodeId: number | null = null
  let scopePassHash: string | null = null

  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7)
    const caller = findSessionByToken(token)
    if (!caller) { res.status(401).json({ error: 'UNAUTHORIZED' }); return }
    scopeNodeId = caller.nodeId
    scopePassHash = caller.passCodeHash
  } else if (testBypass) {
    // No scope — wipe everything on the IP.
  } else {
    const parsed = z.object({
      nodeId:   z.number().int().min(NODE_ID_MIN).max(NODE_ID_MAX),
      passCode: z.string().length(6).regex(/^\d{6}$/),
    }).safeParse(req.body)
    if (!parsed.success) { res.status(401).json({ error: 'UNAUTHORIZED' }); return }

    // Per-nodeId freeze applies here too — otherwise this endpoint would
    // be a parallel verification oracle.
    const frozen = isNodeFrozen(parsed.data.nodeId, now)
    if (frozen.frozen) {
      res.status(423).json({ error: 'NODE_LOCKED', reason: 'NODE_FROZEN', unlockAt: frozen.until })
      return
    }

    const lockKey = attemptKey(ip, parsed.data.nodeId)
    let lock = attemptLocks.get(lockKey)
    if (lock && now < lock.lockedUntil) {
      res.status(423).json({ error: 'NODE_LOCKED', reason: 'WRONG_PASSCODE', unlockAt: lock.lockedUntil })
      return
    }
    if (lock && lock.lockedUntil > 0 && now >= lock.lockedUntil) {
      attemptLocks.delete(lockKey)
      lock = undefined
    }

    const identity = hashPassCodeIdentity(parsed.data.passCode)
    // Find at least one matching session on this IP. We verify *both* the
    // identity hash (cheap pre-filter) AND the per-session scrypt hash via
    // verifyAndMaybeUpgrade (real authentication). Without the scrypt
    // step this would still be a brute-force oracle against scrypt's
    // protection.
    let matched: NodeSession | null = null
    for (const s of nodes.values()) {
      if (s.ip !== ip) continue
      if (s.nodeId !== parsed.data.nodeId) continue
      if (s.passCodeHash !== identity) continue
      const { ok, upgrade } = await verifyAndMaybeUpgrade(parsed.data.passCode, s as NodeSession & { passCodeVerifyHash?: string; passCodeSalt?: string; passCodeAlgo?: 'sha256' | 'scrypt' })
      if (!ok) continue
      if (upgrade) Object.assign(s, upgrade)
      matched = s
      break
    }
    if (!matched) {
      if (!lock) {
        lock = { attempts: 0, lockedUntil: 0, lastAttemptAt: now }
        attemptLocks.set(lockKey, lock)
      }
      lock.attempts++
      lock.lastAttemptAt = now
      if (lock.attempts >= MAX_ATTEMPTS) {
        lock.lockedUntil = now + LOCK_DURATION_MS
      }
      recordFailedPasscodeAttempt(parsed.data.nodeId, ip, now)
      res.status(401).json({ error: 'UNAUTHORIZED' })
      return
    }
    scopeNodeId = parsed.data.nodeId
    scopePassHash = identity
    attemptLocks.delete(lockKey)
    clearNodeFreezeOnSuccess(parsed.data.nodeId)
  }

  let released = 0
  for (const [sessionId, session] of nodes) {
    if (session.ip !== ip) continue
    if (scopeNodeId !== null && (session.nodeId !== scopeNodeId || session.passCodeHash !== scopePassHash)) continue
    if (session.socket) {
      // Drop the authenticated-socket index entry here rather than relying on
      // the 'close' handler: that handler bails early once session.socket is
      // null, which would otherwise leak the entry (SECURITY-014).
      unmarkSocket(session.socket)
      try { session.socket.close() } catch { /* ignore */ }
      session.socket = null
    }
    if (session.channelId) {
      const ch = channels.get(session.channelId)
      if (ch) {
        ch.delete(sessionId)
        if (ch.size === 0) channels.delete(session.channelId)
      }
    }
    nodes.delete(sessionId)
    broadcast({ type: 'leave', nodeId: session.nodeId, message: `御坂 ${session.nodeId} 号通信终止` })
    released++
  }
  res.json({ released })
}))

// POST /api/release
router.post('/release', (req, res) => {
  const parsed = z.object({ token: z.string() }).safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ error: 'INVALID_INPUT' }); return }

  const session = findSessionByToken(parsed.data.token)
  if (session) {
    if (session.socket) {
      unmarkSocket(session.socket)
      session.socket.close()
      session.socket = null
    }
    session.lastSeen = Date.now()
    broadcast({ type: 'leave', nodeId: session.nodeId, message: `御坂 ${session.nodeId} 号通信终止` })
  }
  res.status(204).end()
})

// GET /api/stats
router.get('/stats', (_req, res) => {
  res.json({
    onlineNodes:      getOnlineCount(),
    peakConcurrent:   stats.peakConcurrent,
    totalTransfers:   stats.totalTransfers,
    totalBytes:       stats.totalBytes,
    activeChannels:   channels.size,
    uptimeLongestMs:  getLongestUptimeMs(),
    uptimeSeconds:    Math.floor((Date.now() - stats.startedAt) / 1000),
    cpuLoadPercent:   getCpuUsagePercent(),
  })
})

// GET /api/turn-credentials
//
// BUG-022: this used to be a bare `async` handler. Express 4 does not forward a
// rejected promise out of a route, so anything that threw after the provider
// call left the request hanging until the client gave up. It now goes through
// the same `asyncRoute` boundary as every other async route.
router.get('/turn-credentials', asyncRoute(async (req, res) => {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) { res.status(401).json({ error: 'UNAUTHORIZED' }); return }
  const token = authHeader.slice(7)
  const session = findSessionByToken(token)
  if (!session) { res.status(401).json({ error: 'UNAUTHORIZED' }); return }

  const result = await issueCredentials(session.sessionId, session.ip)
  if (!result.ok) {
    // STATE_UNAVAILABLE is the SECURITY-009 fail-closed path (we cannot read
    // the persisted month), and the ban reasons are the SECURITY-010 deny list.
    const status = result.reason === 'DISABLED' || result.reason === 'NOT_CONFIGURED' ? 503
      : result.reason === 'GLOBAL_QUOTA_EXCEEDED' || result.reason === 'STATE_UNAVAILABLE' ? 503
      : result.reason === 'IP_BANNED' || result.reason === 'SESSION_BANNED' ? 403
      : result.reason === 'IP_RATE_LIMITED' || result.reason === 'IP_BYTES_LIMITED' ? 429
      : 502
    res.status(status).json({ enabled: false, reason: result.reason })
    return
  }

  res.json({
    enabled: true,
    iceServers: result.iceServers,
    expiresAt: result.expiresAt,
    // customIdentifier is intentionally not returned — it's an internal
    // CF correlation id and is now a sha256-based derivation that should
    // not leave the server.
  })
}))

// GET /api/turn-status
//
// SECURITY-017: unauthenticated callers used to receive the monthly spend, the
// configured limit and threshold, the kill-switch state and the raw Cloudflare
// error string — free cost/kill-switch reconnaissance plus provider
// diagnostics. The public view is now coarse availability only; the detailed
// counters sit behind TURN_OPERATOR_TOKEN and report stable error codes.
router.get('/turn-status', (req, res) => {
  res.set('Cache-Control', 'no-store')
  const audience = classifyTurnStatusAuth(req.headers.authorization)
  if (audience === 'invalid') { res.status(401).json({ error: 'UNAUTHORIZED' }); return }
  if (audience === 'operator') { res.json(getOperatorTurnStatus()); return }
  res.json(getPublicTurnStatus())
})

// GET /api/health — LIVENESS. The process is up and the event loop is turning.
router.get('/health', (_req, res) => {
  res.json({
    ok: true,
    uptimeSeconds: Math.floor((Date.now() - stats.startedAt) / 1000),
    onlineNodes: getOnlineCount(),
  })
})

// GET /api/ready — READINESS (SECURITY-009). Separate from liveness on purpose:
// the server only binds after both persisted snapshots have been loaded and
// validated, and this endpoint is where that outcome is visible. `degraded`
// means we are serving, but something that was supposed to be restored is not —
// most importantly an unreadable TURN snapshot, which puts issuance in its
// fail-closed state.
router.get('/ready', (_req, res) => {
  res.set('Cache-Control', 'no-store')
  const readiness = getPersistReadiness()
  const ready = readiness.turn !== 'pending' && readiness.locks !== 'pending'
  const degraded = readiness.turn !== 'ok' || readiness.locks !== 'ok'
  res.status(ready ? 200 : 503).json({
    ready,
    degraded,
    turnState: readiness.turn,
    locksState: readiness.locks,
    uptimeSeconds: Math.floor((Date.now() - stats.startedAt) / 1000),
  })
})

// POST /api/transfer-done
//
// SECURITY-018: this counter is self-reported and published on /api/stats, so
// it needs three bounds, not one. `z.number().int()` alone accepted 1e308
// (Number.isInteger(1e308) is true), which pushed totalBytes to Infinity in a
// single call. Now: a safe-integer + realistic-size ceiling per call, and a
// per-IP call rate so a loop cannot inflate the totals either.
router.post('/transfer-done', (req, res) => {
  const parsed = z.object({
    token: z.string(),
    bytes: z.number()
      .int()
      .min(0)
      .max(MAX_TRANSFER_BYTES)
      .refine(Number.isSafeInteger, { message: 'bytes must be a safe integer' })
      .optional(),
  }).safeParse(req.body)

  if (!parsed.success) { res.status(400).json({ error: 'INVALID_INPUT' }); return }

  const session = authMiddleware(parsed.data.token)
  if (!session) { res.status(401).json({ error: 'UNAUTHORIZED' }); return }

  const ip = getClientIP(req)
  if (!checkRateLimit(`transfer-done:${ip}`, TRANSFER_DONE_RATE_LIMIT, TRANSFER_DONE_RATE_WINDOW_MS)) {
    res.status(429).json({ error: 'RATE_LIMITED', message: '传输上报过于频繁' })
    return
  }

  stats.totalTransfers++
  stats.totalBytes += parsed.data.bytes ?? 0
  broadcast({ type: 'transfer', nodeId: session.nodeId, message: `御坂 ${session.nodeId} 号完成一次传输` })
  res.status(204).end()
})

// GET /api/qr-token
router.get('/qr-token', (req, res) => {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) { res.status(401).json({ error: 'UNAUTHORIZED' }); return }
  const token = authHeader.slice(7)

  const ownerSession = findSessionByToken(token)
  if (!ownerSession) { res.status(401).json({ error: 'UNAUTHORIZED' }); return }

  // passCode (if supplied) MUST match the canonical 6-digit shape — same
  // rule as /register. The previous code accepted any string here, so the
  // matching qr-redeem check could never trip on the format.
  const passCodeRaw = req.query.passCode
  let passCode: string | undefined
  if (typeof passCodeRaw === 'string' && passCodeRaw.length > 0) {
    const parsed = z.string().regex(/^\d{6}$/).safeParse(passCodeRaw)
    if (!parsed.success) {
      res.status(400).json({ error: 'INVALID_INPUT', message: 'passCode 必须是 6 位数字' })
      return
    }
    passCode = parsed.data
  }

  const qrToken = nanoid(32)
  const channelId = nanoid(8)
  const expiresAt = Date.now() + QR_TOKEN_TTL_MS
  const record: QrTokenRecord = {
    token: qrToken,
    ownerNodeId: ownerSession.nodeId,
    type: 'node',
    channelId,
    passCodeHash: passCode ? hashPassCodeIdentity(passCode) : undefined,
    createdAt: Date.now(),
    expiresAt,
    used: false,
  }
  qrTokens.set(qrToken, record)
  res.json({ qrToken, channelId, expiresAt })
})

// POST /api/qr-redeem
router.post('/qr-redeem', (req, res) => {
  if (!enforceOrigin(req, res)) return

  // Dedicated tighter rate limit on this endpoint — it accepts a 6-digit
  // passcode and was previously only bounded by the (looser) global API
  // limiter. 10 req/min/IP is plenty for legitimate use and turns the
  // worst case into a 1-in-100k brute-force from any single IP per day.
  const ip = getClientIP(req)
  if (!checkRateLimit(`qr-redeem:${ip}`, QR_REDEEM_RATE_LIMIT, QR_REDEEM_RATE_WINDOW_MS)) {
    res.status(429).json({ error: 'RATE_LIMITED', message: 'QR 兑换请求过于频繁，请稍后再试' })
    return
  }

  const parsed = z.object({
    qrToken:    z.string(),
    myNodeId:   z.number().int().min(NODE_ID_MIN).max(NODE_ID_MAX),
    myPassCode: z.string().regex(/^\d{6}$/),
  }).safeParse(req.body)

  if (!parsed.success) { res.status(400).json({ error: 'INVALID_INPUT' }); return }

  const record = qrTokens.get(parsed.data.qrToken)
  if (!record || record.used || Date.now() > record.expiresAt) {
    res.status(400).json({ error: 'INVALID_QR_TOKEN' })
    return
  }

  // Same per-nodeId freeze that guards /register — otherwise qr-redeem is a
  // parallel passcode-guessing oracle immune to the IP-rotation defence.
  const now = Date.now()
  const frozen = isNodeFrozen(record.ownerNodeId, now)
  if (frozen.frozen) {
    res.status(423).json({ error: 'NODE_LOCKED', reason: 'NODE_FROZEN', unlockAt: frozen.until })
    return
  }

  if (record.passCodeHash) {
    // Timing-safe compare of the sha256 identity hashes (equal length → safe).
    const provided = Buffer.from(hashPassCodeIdentity(parsed.data.myPassCode))
    const expected = Buffer.from(record.passCodeHash)
    const match = provided.length === expected.length && timingSafeEqual(provided, expected)
    if (!match) {
      // A wrong guess used to neither burn the single-use token nor feed any
      // lockout, so the same token could be retried across the full 6-digit
      // keyspace for its 5-min TTL. Now: count the failure into the per-nodeId
      // freeze AND burn the token after MAX_ATTEMPTS wrong guesses.
      record.failedAttempts = (record.failedAttempts ?? 0) + 1
      recordFailedPasscodeAttempt(record.ownerNodeId, ip, now)
      if (record.failedAttempts >= MAX_ATTEMPTS) record.used = true
      res.status(401).json({ error: 'WRONG_PASSCODE' })
      return
    }
  } else {
    res.status(403).json({ error: 'QR_REQUIRES_PASSCODE' })
    return
  }

  record.used = true
  clearNodeFreezeOnSuccess(record.ownerNodeId)
  const channelId = record.channelId ?? nanoid(8)
  res.json({ targetNodeId: record.ownerNodeId, channelId })
})

// POST /api/report
router.post('/report', (req, res) => {
  const parsed = z.object({
    targetNodeId: z.number().int().min(NODE_ID_MIN).max(NODE_ID_MAX),
    reason:       z.enum(['spam', 'malicious', 'harassment', 'other']),
    sourceToken:  z.string(),
  }).safeParse(req.body)

  if (!parsed.success) { res.status(400).json({ error: 'INVALID_INPUT' }); return }

  const { targetNodeId, reason, sourceToken } = parsed.data
  const ip = getClientIP(req)

  const sourceSession = findSessionByToken(sourceToken)
  if (!sourceSession) { res.status(401).json({ error: 'UNAUTHORIZED' }); return }

  if (sourceSession.nodeId === targetNodeId) { res.status(400).json({ error: 'CANNOT_REPORT_SELF' }); return }

  // Target nodeId must exist on at least one session
  let targetExists = false
  for (const s of nodes.values()) {
    if (s.nodeId === targetNodeId) { targetExists = true; break }
  }
  if (!targetExists) { res.status(404).json({ error: 'NODE_NOT_FOUND' }); return }

  // Rate limit: max 5 reports per IP per 10 minutes
  const now = Date.now()
  const recentFromIp = reports.filter(r => r.reporterIp === ip && now - r.reportedAt < REPORT_RATE_WINDOW_MS).length
  if (recentFromIp >= REPORT_RATE_MAX) {
    res.status(429).json({ error: 'RATE_LIMITED', message: '上报过于频繁' })
    return
  }

  const record: ReportRecord = {
    id: nanoid(12),
    sourceNodeId: sourceSession.nodeId,
    targetNodeId,
    reason,
    reporterIp: ip,
    reportedAt: now,
  }
  reports.push(record)

  const recentOnTarget = reports.filter(r => r.targetNodeId === targetNodeId && now - r.reportedAt < REPORT_WARN_WINDOW_MS).length
  if (recentOnTarget >= REPORT_WARN_COUNT) {
    broadcast({ type: 'channel', message: `树形图设计者已注意到御坂 ${targetNodeId} 号的行为` })
  }

  res.status(204).end()
})

// Middleware to look up session by token
export function authMiddleware(token: string): NodeSession | null {
  return findSessionByToken(token)
}

// Catch-all for unknown /api routes — always return JSON
router.all('*', (_req, res) => {
  res.status(404).json({ error: 'NOT_FOUND' })
})
