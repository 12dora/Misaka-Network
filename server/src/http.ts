import { Router, type Request, type Response, type NextFunction } from 'express'
import { createHash, randomBytes } from 'crypto'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { nodes, channels, qrTokens, reports, stats, getOnlineCount, getLongestUptimeMs, countNodesByIp, getCpuUsagePercent, findSessionByToken } from './store.js'
import { broadcast } from './activity.js'
import { checkRateLimit } from './ratelimit.js'
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

  // Identity = (nodeId, passCodeHash). Reject if any session already exists
  // with the same nodeId but a different passcode — that nodeId is "owned" by
  // someone else. Otherwise we permit a brand-new session for this identity:
  // multiple devices may share the same identity (phone + PC1 + PC2) and the
  // cluster channel relies on that.
  const sameNodeSessions: NodeSession[] = []
  for (const s of nodes.values()) {
    if (s.nodeId === nodeId) sameNodeSessions.push(s)
  }
  const lockedSession = sameNodeSessions.find(s => now < s.lockedUntil)
  if (lockedSession) {
    res.status(423).json({ error: 'NODE_LOCKED', reason: 'WRONG_PASSCODE', unlockAt: lockedSession.lockedUntil })
    return
  }
  const conflict = sameNodeSessions.find(s => s.passCodeHash !== passCodeHash)
  if (conflict) {
    conflict.failedAttempts++
    if (conflict.failedAttempts >= MAX_ATTEMPTS) {
      conflict.lockedUntil = now + LOCK_DURATION_MS
      res.status(423).json({ error: 'NODE_LOCKED', reason: 'WRONG_PASSCODE', unlockAt: conflict.lockedUntil })
    } else {
      const remaining = MAX_ATTEMPTS - conflict.failedAttempts
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

  broadcast({ type: 'join', nodeId, message: `御坂 ${nodeId} 号已接入网络` })

  res.json({ sessionId, token, expiresAt: now + SESSION_TTL_MS, resumed: false })
})

// POST /api/release-by-ip
// Releases every node currently registered from the caller's IP. Used by the
// client when the IP node limit is hit so the user can wipe stale sessions
// (typical for local dev with multiple browsers) and try again.
router.post('/release-by-ip', (req, res) => {
  const ip = getClientIP(req)
  let released = 0
  for (const [sessionId, session] of nodes) {
    if (session.ip !== ip) continue
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
