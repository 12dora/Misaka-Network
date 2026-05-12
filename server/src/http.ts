import { Router } from 'express'
import { createHash, randomBytes } from 'crypto'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { nodes, qrTokens, stats, getOnlineCount, getLongestUptimeMs } from './store.js'
import { broadcast } from './activity.js'
import type { NodeSession, QrTokenRecord } from './types.js'

export const router = Router()

const MAX_NODES_PER_IP = 5
const LOCK_DURATION = 5 * 60 * 1000
const MAX_ATTEMPTS = 3

function hashPassCode(code: string) {
  return createHash('sha256').update(code).digest('hex')
}

// POST /api/register
router.post('/register', (req, res) => {
  const parsed = z.object({
    nodeId:   z.number().int().min(1).max(20001),
    passCode: z.string().length(6).regex(/^\d{6}$/),
  }).safeParse(req.body)

  if (!parsed.success) {
    res.status(400).json({ error: 'INVALID_INPUT' })
    return
  }

  const { nodeId, passCode } = parsed.data
  const now = Date.now()
  const existing = nodes.get(nodeId)

  if (existing) {
    // Check if locked
    if (now < existing.lockedUntil) {
      res.status(423).json({ error: 'NODE_LOCKED', unlockAt: existing.lockedUntil })
      return
    }

    // Try to resume with same pass code
    if (existing.passCodeHash === hashPassCode(passCode)) {
      existing.lastSeen = now
      existing.token = randomBytes(32).toString('hex')
      existing.failedAttempts = 0
      res.json({ token: existing.token, expiresAt: now + 30 * 60 * 1000, resumed: true })
      return
    }

    // Wrong pass code on existing node
    existing.failedAttempts++
    if (existing.failedAttempts >= MAX_ATTEMPTS) {
      existing.lockedUntil = now + LOCK_DURATION
      res.status(423).json({ error: 'NODE_LOCKED', unlockAt: existing.lockedUntil })
    } else {
      res.status(409).json({ error: 'NODE_OCCUPIED' })
    }
    return
  }

  // New registration
  const token = randomBytes(32).toString('hex')
  const session: NodeSession = {
    nodeId,
    passCodeHash: hashPassCode(passCode),
    token,
    socket: null,
    lastSeen: now,
    channelId: null,
    blockedIds: new Set(),
    failedAttempts: 0,
    lockedUntil: 0,
    joinedAt: now,
  }
  nodes.set(nodeId, session)

  broadcast({ type: 'join', nodeId, message: `御坂 ${nodeId} 号已接入网络` })

  res.json({ token, expiresAt: now + 30 * 60 * 1000, resumed: false })
})

// POST /api/release
router.post('/release', (req, res) => {
  const parsed = z.object({ token: z.string() }).safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ error: 'INVALID_INPUT' }); return }

  for (const session of nodes.values()) {
    if (session.token === parsed.data.token) {
      if (session.socket) {
        session.socket.close()
        session.socket = null
      }
      session.lastSeen = Date.now()
      broadcast({ type: 'leave', nodeId: session.nodeId, message: `御坂 ${session.nodeId} 号通信终止` })
      break
    }
  }
  res.status(204).end()
})

// POST /api/verify-passcode
router.post('/verify-passcode', (req, res) => {
  const parsed = z.object({
    targetNodeId: z.number().int().min(1).max(20001),
    passCode:     z.string().length(6).regex(/^\d{6}$/),
    sourceToken:  z.string(),
  }).safeParse(req.body)

  if (!parsed.success) { res.status(400).json({ error: 'INVALID_INPUT' }); return }

  const { targetNodeId, passCode } = parsed.data
  const target = nodes.get(targetNodeId)
  if (!target) { res.status(404).json({ error: 'NODE_NOT_FOUND' }); return }

  const now = Date.now()
  if (now < target.lockedUntil) {
    res.status(423).json({ error: 'NODE_LOCKED', unlockAt: target.lockedUntil })
    return
  }

  if (target.passCodeHash === hashPassCode(passCode)) {
    target.failedAttempts = 0
    res.json({ ok: true })
  } else {
    target.failedAttempts++
    if (target.failedAttempts >= MAX_ATTEMPTS) {
      target.lockedUntil = now + LOCK_DURATION
    }
    res.status(401).json({
      error: 'WRONG_PASSCODE',
      attemptsLeft: Math.max(0, MAX_ATTEMPTS - target.failedAttempts),
    })
  }
})

// GET /api/stats
router.get('/stats', (_req, res) => {
  res.json({
    onlineNodes:      getOnlineCount(),
    totalTransfers:   stats.totalTransfers,
    totalBytes:       stats.totalBytes,
    activeChannels:   0, // TODO: count active transfers
    uptimeLongestMs:  getLongestUptimeMs(),
    cpuLoadPercent:   Math.floor(Math.random() * 30 + 20), // decorative
  })
})

// GET /api/qr-token
router.get('/qr-token', (req, res) => {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) { res.status(401).json({ error: 'UNAUTHORIZED' }); return }
  const token = authHeader.slice(7)

  let ownerSession: NodeSession | undefined
  for (const s of nodes.values()) {
    if (s.token === token) { ownerSession = s; break }
  }
  if (!ownerSession) { res.status(401).json({ error: 'UNAUTHORIZED' }); return }

  const qrToken = nanoid(32)
  const expiresAt = Date.now() + 5 * 60 * 1000
  const record: QrTokenRecord = {
    token: qrToken,
    ownerNodeId: ownerSession.nodeId,
    type: 'node',
    createdAt: Date.now(),
    expiresAt,
    used: false,
  }
  qrTokens.set(qrToken, record)
  res.json({ qrToken, expiresAt })
})

// POST /api/qr-redeem
router.post('/qr-redeem', (req, res) => {
  const parsed = z.object({
    qrToken:    z.string(),
    myNodeId:   z.number().int().min(1).max(20001),
    myPassCode: z.string().length(6),
  }).safeParse(req.body)

  if (!parsed.success) { res.status(400).json({ error: 'INVALID_INPUT' }); return }

  const record = qrTokens.get(parsed.data.qrToken)
  if (!record || record.used || Date.now() > record.expiresAt) {
    res.status(400).json({ error: 'INVALID_QR_TOKEN' })
    return
  }

  record.used = true
  const channelId = record.channelId ?? nanoid(8)
  res.json({ targetNodeId: record.ownerNodeId, channelId })
})

// Middleware to look up session by token
export function authMiddleware(token: string): NodeSession | null {
  for (const s of nodes.values()) {
    if (s.token === token) return s
  }
  return null
}
