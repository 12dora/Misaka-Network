import { Router, type Request, type Response, type NextFunction } from 'express'
import { createHash, randomBytes } from 'crypto'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { nodes, channels, qrTokens, reports, stats, getOnlineCount, getLongestUptimeMs, countNodesByIp, getCpuUsagePercent, findSessionByToken, attemptLocks, attemptKey } from './store.js'
import { broadcast } from './activity.js'
import { checkRateLimit } from './ratelimit.js'
import { issueCredentials, getTurnStatus } from './turn.js'
import type { NodeSession, QrTokenRecord, ReportRecord } from './types.js'
import {
  MAX_NODES, MAX_NODES_PER_IP, NODE_ID_MIN, NODE_ID_MAX,
  MAX_ATTEMPTS, LOCK_DURATION_MS,
  SESSION_TTL_MS, QR_TOKEN_TTL_MS,
  RATE_LIMIT_PER_MIN, RATE_WINDOW_MS,
  REPORT_RATE_MAX, REPORT_RATE_WINDOW_MS, REPORT_WARN_COUNT, REPORT_WARN_WINDOW_MS,
} from './config.js'

export const router = Router()

function hashPassCode(code: string) {
  return createHash('sha256').update(code).digest('hex')
}

function getClientIP(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown'
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

// POST /api/register
router.post('/register', (req, res) => {
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
  const passCodeHash = hashPassCode(passCode)

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

  // Identity = (nodeId, passCodeHash). Reject if any session already exists
  // with the same nodeId but a different passcode — that nodeId is "owned" by
  // someone else. Otherwise we permit a brand-new session for this identity:
  // multiple devices may share the same identity (phone + PC1 + PC2) and the
  // cluster channel relies on that.
  const sameNodeSessions: NodeSession[] = []
  for (const s of nodes.values()) {
    if (s.nodeId === nodeId) sameNodeSessions.push(s)
  }
  const conflict = sameNodeSessions.find(s => s.passCodeHash !== passCodeHash)
  if (conflict) {
    // Failure attributed to (ip, nodeId), NOT to the owner session. The
    // owner's NodeSession.failedAttempts / lockedUntil are now legacy and
    // remain zero in normal operation — they are kept on the type only so
    // that persisted state from older builds can be loaded without
    // crashing. Brute-force semantics live entirely in `attemptLocks`.
    if (!lock) {
      lock = { attempts: 0, lockedUntil: 0, lastAttemptAt: now }
      attemptLocks.set(lockKey, lock)
    }
    lock.attempts++
    lock.lastAttemptAt = now
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
  const session: NodeSession = {
    sessionId,
    nodeId,
    passCodeHash,
    token,
    socket: null,
    lastSeen: now,
    channelId: null,
    blockedIds: new Set(),
    failedAttempts: 0,
    lockedUntil: 0,
    joinedAt: now,
    ip,
  }
  nodes.set(sessionId, session)

  // A successful register from this (ip, nodeId) means the caller knows the
  // right passcode, so clear any prior lockout we'd been tracking against
  // this attempter. Without this, a user who typed wrong once and right the
  // second time would still see a lingering counter on their next try.
  attemptLocks.delete(lockKey)

  broadcast({ type: 'join', nodeId, message: `御坂 ${nodeId} 号已接入网络` })

  res.json({ sessionId, token, expiresAt: now + SESSION_TTL_MS, resumed: false })
})

// POST /api/release-by-ip
// Releases the caller's stale sessions from the caller's IP. Used by the
// client when the IP node limit is hit so the user can wipe stale sessions
// (typical for local dev with multiple browsers) and try again.
//
// Security (F6): this endpoint MUST require a valid Bearer token. Without
// auth, any anonymous attacker on a shared egress IP (CGNAT, corporate NAT,
// dorm WiFi) could wipe every other Misaka user behind that same IP. We
// authenticate the caller, then only release sessions that belong to the
// SAME identity (same token == same registration). Other users on the same
// IP are untouched.
router.post('/release-by-ip', (req, res) => {
  const authHeader = req.headers.authorization
  const ip = getClientIP(req)

  // Test escape hatch: when the server is launched with
  // E2E_ALLOW_UNAUTH_RELEASE_BY_IP=1, allow anonymous calls to wipe every
  // session on the caller's IP. The e2e suite uses this in beforeEach to
  // prevent cross-test pollution (zombie sessions from a previous test
  // accumulating in the same identity cluster). Production never sets this.
  const testBypass = process.env.E2E_ALLOW_UNAUTH_RELEASE_BY_IP === '1'

  let caller: ReturnType<typeof findSessionByToken> | undefined
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7)
    caller = findSessionByToken(token)
    if (!caller && !testBypass) { res.status(401).json({ error: 'UNAUTHORIZED' }); return }
  } else if (!testBypass) {
    res.status(401).json({ error: 'UNAUTHORIZED' }); return
  }

  let released = 0
  for (const [sessionId, session] of nodes) {
    if (session.ip !== ip) continue
    // In test-bypass mode (no caller) we wipe everything on the IP.
    // In authenticated mode, only release sessions belonging to the same
    // identity (same nodeId + passCodeHash as the caller).
    if (caller && (session.nodeId !== caller.nodeId || session.passCodeHash !== caller.passCodeHash)) continue
    if (session.socket) {
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
})

// POST /api/release
router.post('/release', (req, res) => {
  const parsed = z.object({ token: z.string() }).safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ error: 'INVALID_INPUT' }); return }

  const session = findSessionByToken(parsed.data.token)
  if (session) {
    if (session.socket) {
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
// Auth: Bearer <session token>. Returns short-lived TURN credentials issued
// by Cloudflare and tagged with customIdentifier=`misaka-${sessionId}`.
// All enforcement (per-IP rate / global kill switch) lives in
// turn.issueCredentials — clients are pure consumers.
router.get('/turn-credentials', async (req, res) => {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) { res.status(401).json({ error: 'UNAUTHORIZED' }); return }
  const token = authHeader.slice(7)
  const session = findSessionByToken(token)
  if (!session) { res.status(401).json({ error: 'UNAUTHORIZED' }); return }

  const result = await issueCredentials(session.sessionId, session.ip)
  if (!result.ok) {
    // Map abuse reasons to HTTP status; client should fall back to no auto TURN.
    const status = result.reason === 'DISABLED' || result.reason === 'NOT_CONFIGURED' ? 503
      : result.reason === 'GLOBAL_QUOTA_EXCEEDED' ? 503
      : result.reason === 'IP_RATE_LIMITED' || result.reason === 'IP_BYTES_LIMITED' ? 429
      : 502
    res.status(status).json({ enabled: false, reason: result.reason })
    return
  }

  res.json({
    enabled: true,
    iceServers: result.iceServers,
    expiresAt: result.expiresAt,
    // customIdentifier is intentionally not returned — it embeds sessionId.
  })
})

// GET /api/turn-status (no secrets, safe to expose)
router.get('/turn-status', (_req, res) => {
  res.json(getTurnStatus())
})

// GET /api/health
router.get('/health', (_req, res) => {
  res.json({
    ok: true,
    uptimeSeconds: Math.floor((Date.now() - stats.startedAt) / 1000),
    onlineNodes: getOnlineCount(),
  })
})

// POST /api/transfer-done
router.post('/transfer-done', (req, res) => {
  const parsed = z.object({
    token: z.string(),
    bytes: z.number().int().min(0).optional(),
  }).safeParse(req.body)

  if (!parsed.success) { res.status(400).json({ error: 'INVALID_INPUT' }); return }

  const session = authMiddleware(parsed.data.token)
  if (!session) { res.status(401).json({ error: 'UNAUTHORIZED' }); return }

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

  const qrToken = nanoid(32)
  const channelId = nanoid(8)
  const expiresAt = Date.now() + QR_TOKEN_TTL_MS
  const passCode = req.query.passCode as string | undefined
  const record: QrTokenRecord = {
    token: qrToken,
    ownerNodeId: ownerSession.nodeId,
    type: 'node',
    channelId,
    passCodeHash: passCode ? hashPassCode(passCode) : undefined,
    createdAt: Date.now(),
    expiresAt,
    used: false,
  }
  qrTokens.set(qrToken, record)
  res.json({ qrToken, channelId, expiresAt })
})

// POST /api/qr-redeem
router.post('/qr-redeem', (req, res) => {
  const parsed = z.object({
    qrToken:    z.string(),
    myNodeId:   z.number().int().min(NODE_ID_MIN).max(NODE_ID_MAX),
    myPassCode: z.string().length(6),
  }).safeParse(req.body)

  if (!parsed.success) { res.status(400).json({ error: 'INVALID_INPUT' }); return }

  const record = qrTokens.get(parsed.data.qrToken)
  if (!record || record.used || Date.now() > record.expiresAt) {
    res.status(400).json({ error: 'INVALID_QR_TOKEN' })
    return
  }

  if (record.passCodeHash) {
    if (hashPassCode(parsed.data.myPassCode) !== record.passCodeHash) {
      res.status(401).json({ error: 'WRONG_PASSCODE' })
      return
    }
  } else {
    res.status(403).json({ error: 'QR_REQUIRES_PASSCODE' })
    return
  }

  record.used = true
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

  // If a node gets too many reports in a short time, broadcast a warning
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
