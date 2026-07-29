import { Router, type Request, type Response } from 'express'
import { randomBytes, timingSafeEqual } from 'crypto'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import {
  nodes, channels, qrTokens, reports, stats, getOnlineCount, getLongestUptimeMs, countNodesByIp,
  getCpuUsagePercent, findSessionByToken, attemptLocks, attemptKey,
  nodeFreezes, hashPassCodeIdentity, newPassCodeRecord, verifyAndMaybeUpgrade,
  ScryptBusyError,
  deriveTurnPrincipal, mintReRegisterProof, indexReRegisterProof,
  resolveReRegisterProof, rotateReRegisterProof,
} from './store.js'
import { broadcast } from './activity.js'
import { checkRateLimit } from './ratelimit.js'
import { issueCredentials, getPublicTurnStatus, getOperatorTurnStatus, classifyTurnStatusAuth } from './turn.js'
import { getPersistReadiness, flushSecurityState, isLocksStateReady } from './persist.js'
import { isHttpOriginAllowed, getRequestOrigin } from './origin.js'
import { terminateSession } from './session-lifecycle.js'
import type { NodeSession, QrTokenRecord, ReportRecord } from './types.js'
import {
  MAX_NODES, MAX_NODES_PER_IP, NODE_ID_MIN, NODE_ID_MAX,
  MAX_ATTEMPTS, LOCK_DURATION_MS,
  SESSION_TTL_MS, QR_TOKEN_TTL_MS,
  REPORT_RATE_MAX, REPORT_RATE_WINDOW_MS, REPORT_WARN_COUNT, REPORT_WARN_WINDOW_MS,
  NODE_FREEZE_THRESHOLD, NODE_FREEZE_WINDOW_MS, NODE_FREEZE_DURATION_MS,
  QR_REDEEM_RATE_LIMIT, QR_REDEEM_RATE_WINDOW_MS,
  MAX_TRANSFER_BYTES, TRANSFER_DONE_RATE_LIMIT, TRANSFER_DONE_RATE_WINDOW_MS,
  E2E_UNAUTH_RELEASE_ALLOWED, E2E_BUILD_NONCE,
  TEST_INSTANCE_NONCE,
} from './config.js'

export const router = Router()

/**
 * Install the test-instance response header at the APP level (before the
 * pre-parser rate limit) so 429/400/413 short-circuits still carry the nonce
 * the integration harness requires to reject a stale listener.
 */
export function installTestInstanceHeader(app: { use: Function }) {
  if (!TEST_INSTANCE_NONCE) return
  app.use('/api', (_req: Request, res: Response, next: () => void) => {
    res.set('X-Misaka-Test-Instance', TEST_INSTANCE_NONCE)
    next()
  })
}

if (TEST_INSTANCE_NONCE) {
  router.use((_req, res, next) => {
    res.set('X-Misaka-Test-Instance', TEST_INSTANCE_NONCE)
    next()
  })
}

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

// API IP rate limit lives in index.ts AHEAD of express.json() so malformed /
// oversized bodies still consume the same per-IP budget. Routes below only
// add tighter dedicated limits (qr-redeem, transfer-done).

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
  // Expired freeze — only clear frozenUntil; keep rolling-window history so
  // the attacker does not get a fresh full budget the moment the timer elapses.
  if (freeze.frozenUntil > 0) {
    freeze.frozenUntil = 0
    pruneFreezeFailures(freeze, now)
  }
  return { frozen: false }
}

/** Fail closed when the auth-lock snapshot could not be trusted on load. */
function requireLocksReady(res: Response): boolean {
  if (isLocksStateReady()) return true
  res.status(503).json({
    error: 'STATE_UNAVAILABLE',
    message: '认证防护状态不可用，请稍后重试',
  })
  return false
}

/** Persist lock/freeze transitions before returning a security response. */
async function persistSecurityOr503(res: Response): Promise<boolean> {
  try {
    await flushSecurityState()
    return true
  } catch (err) {
    console.error('[http] security flush failed:', (err as Error).message)
    if (!res.headersSent) {
      res.status(503).json({ error: 'PERSIST_FAILED', message: '安全状态落盘失败，请稍后重试' })
    }
    return false
  }
}

function recordFailedPasscodeAttempt(nodeId: number, ip: string, now: number): boolean {
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
    return true // freeze just engaged — caller must strict-flush before 423
  }
  return false
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
  if (!requireLocksReady(res)) return

  const parsed = z.object({
    nodeId:   z.number().int().min(NODE_ID_MIN).max(NODE_ID_MAX),
    passCode: z.string().length(6).regex(/^\d{6}$/),
    admissionGrant: z.string().min(32).max(128).optional(),
  }).safeParse(req.body)

  if (!parsed.success) {
    res.status(400).json({ error: 'INVALID_INPUT' })
    return
  }

  const { nodeId, passCode } = parsed.data
  const ip = getClientIP(req)
  const now = Date.now()
  const identityHash = hashPassCodeIdentity(passCode)
  let admissionRecord: QrTokenRecord | undefined
  if (parsed.data.admissionGrant) {
    admissionRecord = Array.from(qrTokens.values()).find(record =>
      !record.used
      && record.expiresAt >= now
      && record.ownerNodeId === nodeId
      && record.passCodeHash === identityHash
      && record.admissionGrant === parsed.data.admissionGrant,
    )
    if (!admissionRecord) {
      res.status(400).json({ error: 'INVALID_ADMISSION_GRANT' })
      return
    }
  }

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

  // Collect sessions that already occupy this nodeId.
  const sameNodeSessions: NodeSession[] = []
  for (const s of nodes.values()) {
    if (s.nodeId === nodeId) sameNodeSessions.push(s)
  }

  // When the nodeId is already occupied, authenticate with scrypt against a
  // stable existing verifier BEFORE deciding identity conflict. The previous
  // path only ran a fast HMAC identity compare, so online guessing against an
  // occupied nodeId cost one HMAC and never hit scrypt — contradicting both
  // the code comments and passcode-scrypt.test.mjs.
  if (sameNodeSessions.length > 0) {
    // Prefer a session that already has scrypt fields; fall back to any.
    const verifier = sameNodeSessions.find(s => s.passCodeAlgo === 'scrypt' && s.passCodeSalt && s.passCodeVerifyHash)
      ?? sameNodeSessions[0]
    const { ok, upgrade } = await verifyAndMaybeUpgrade(passCode, verifier)
    if (!ok) {
      if (!lock) {
        lock = { attempts: 0, lockedUntil: 0, lastAttemptAt: now }
        attemptLocks.set(lockKey, lock)
      }
      lock.attempts++
      lock.lastAttemptAt = now
      // Freeze may engage before the per-IP hard-lock threshold; both must be
      // strictly flushed before any response that commits security state.
      recordFailedPasscodeAttempt(nodeId, ip, now)

      if (lock.attempts >= MAX_ATTEMPTS) {
        lock.lockedUntil = now + LOCK_DURATION_MS
      }
      // Every mutated security counter (attemptLocks + freeze history) must
      // hit disk before the response — including ordinary 409 NODE_OCCUPIED.
      // Without this a disk-failure 409 still returns `remaining` and a crash
      // restores the full guess budget. (Freeze-engaging request still returns
      // 409; freeze is enforced at the start of the *next* request.)
      if (!(await persistSecurityOr503(res))) return
      if (lock.attempts >= MAX_ATTEMPTS) {
        res.status(423).json({ error: 'NODE_LOCKED', reason: 'WRONG_PASSCODE', unlockAt: lock.lockedUntil })
      } else {
        const remaining = MAX_ATTEMPTS - lock.attempts
        res.status(409).json({ error: 'NODE_OCCUPIED', message: '该节点编号的通行码错误，请重新输入', remaining })
      }
      return
    }
    // Correct passcode for an already-owned identity: allow a multi-device
    // session. Lazily upgrade the verifier session if it was still on HMAC.
    if (upgrade) Object.assign(verifier, upgrade)
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
  const reRegisterProof = mintReRegisterProof()
  // scrypt is async now (SECURITY-013), so the admission checks above are no
  // longer atomic with the insert below — two concurrent registers for the
  // same nodeId could both have passed. Re-run the two checks that guard
  // shared state after the await, before we publish the session.
  //
  // When we already verified against an existing session, reuse its identity
  // hash (and scrypt fields when present) so multi-device sessions stay
  // consistent. Otherwise mint a fresh record.
  let passCodeHash = identityHash
  let passCodeVerifyHash: string | undefined
  let passCodeSalt: string | undefined
  let passCodeAlgo: 'sha256' | 'scrypt' = 'scrypt'
  if (sameNodeSessions.length > 0) {
    const donor = sameNodeSessions[0]
    passCodeHash = donor.passCodeHash
    passCodeVerifyHash = donor.passCodeVerifyHash
    passCodeSalt = donor.passCodeSalt
    passCodeAlgo = donor.passCodeAlgo ?? 'scrypt'
    // If the donor still lacks scrypt (legacy), mint a fresh record.
    if (!passCodeVerifyHash || !passCodeSalt) {
      const pcRecord = await newPassCodeRecord(passCode)
      passCodeHash = pcRecord.passCodeHash
      passCodeVerifyHash = pcRecord.passCodeVerifyHash
      passCodeSalt = pcRecord.passCodeSalt
      passCodeAlgo = pcRecord.passCodeAlgo
    }
  } else {
    const pcRecord = await newPassCodeRecord(passCode)
    passCodeHash = pcRecord.passCodeHash
    passCodeVerifyHash = pcRecord.passCodeVerifyHash
    passCodeSalt = pcRecord.passCodeSalt
    passCodeAlgo = pcRecord.passCodeAlgo
  }

  // Post-await re-check: a concurrent register may have claimed the nodeId
  // with a different identity while we were hashing. Treat that identity
  // conflict as a real failed attempt — same charge + strict-flush contract
  // as the ordinary occupied-node wrong-passcode path. Returning an uncharged
  // 409 here would give racing distinct passcodes unlimited free guesses
  // (including while durable writes are impossible).
  for (const s of nodes.values()) {
    if (s.nodeId === nodeId && s.passCodeHash !== passCodeHash) {
      if (!lock) {
        lock = { attempts: 0, lockedUntil: 0, lastAttemptAt: now }
        attemptLocks.set(lockKey, lock)
      }
      lock.attempts++
      lock.lastAttemptAt = now
      recordFailedPasscodeAttempt(nodeId, ip, now)
      if (lock.attempts >= MAX_ATTEMPTS) {
        lock.lockedUntil = now + LOCK_DURATION_MS
      }
      if (!(await persistSecurityOr503(res))) return
      if (lock.attempts >= MAX_ATTEMPTS) {
        res.status(423).json({ error: 'NODE_LOCKED', reason: 'WRONG_PASSCODE', unlockAt: lock.lockedUntil })
      } else {
        const remaining = MAX_ATTEMPTS - lock.attempts
        res.status(409).json({ error: 'NODE_OCCUPIED', message: '该节点编号的通行码错误，请重新输入', remaining })
      }
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

  // BUG-003: this is the commit point. Everything that can reject admission
  // has completed, including the async scrypt work and the post-await shared
  // state checks. JavaScript executes the grant check + consume + insert
  // without another await, so two concurrent registrations cannot both win.
  if (admissionRecord) {
    if (admissionRecord.used
      || admissionRecord.expiresAt < Date.now()
      || admissionRecord.admissionGrant !== parsed.data.admissionGrant) {
      res.status(400).json({ error: 'INVALID_ADMISSION_GRANT' })
      return
    }
    admissionRecord.used = true
  }

  const session: NodeSession = {
    sessionId,
    nodeId,
    passCodeHash,
    passCodeVerifyHash,
    passCodeSalt,
    passCodeAlgo,
    token,
    reRegisterProof,
    turnPrincipal: deriveTurnPrincipal(nodeId, passCodeHash),
    socket: null,
    lastSeen: now,
    channelId: null,
    blockedIds: new Set(),
    failedAttempts: 0,
    lockedUntil: 0,
    joinedAt: now,
    // SECURITY-001: the TTL we advertise below is now also the one we store
    // and enforce. Absolute; only POST /api/session-renew extends it.
    expiresAt: now + SESSION_TTL_MS,
    ip,
  }

  nodes.set(sessionId, session)
  indexReRegisterProof(reRegisterProof, sessionId)

  // A successful register from this (ip, nodeId) means the caller knows the
  // right passcode, so clear any prior lockout we'd been tracking against
  // this attempter.
  attemptLocks.delete(lockKey)
  clearNodeFreezeOnSuccess(nodeId)

  broadcast({ type: 'join', nodeId, message: `御坂 ${nodeId} 号已接入网络` })

  res.json({
    sessionId,
    token,
    expiresAt: session.expiresAt,
    reRegisterProof,
    resumed: false,
  })
}))

// POST /api/re-register (Contract 1)
//
// Authenticates with the opaque reRegisterProof issued at register/renew.
// Reuses the same nodeId + passcode material, mints a new sessionId/token/
// proof, and terminates the old session through terminateSession().
router.post('/re-register', asyncRoute(async (req, res) => {
  if (!enforceOrigin(req, res)) return
  if (!requireLocksReady(res)) return

  const parsed = z.object({
    proof: z.string().min(32).max(128),
  }).safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'INVALID_INPUT' })
    return
  }

  const ip = getClientIP(req)
  const now = Date.now()
  const resolved = resolveReRegisterProof(parsed.data.proof)

  // Failure path counts toward the same lock/freeze budget as a wrong passcode
  // so a stolen-or-guessed proof cannot be brute-forced cheaply. When the
  // owning nodeId is known (expired session, rotated tombstone) charge THAT
  // identity — never a synthetic node 0 that never freezes the owner.
  if (resolved.status !== 'ok') {
    const chargeNodeId = resolved.nodeId ?? 0
    const lockKey = attemptKey(ip, chargeNodeId)
    let lock = attemptLocks.get(lockKey)
    if (!lock) {
      lock = { attempts: 0, lockedUntil: 0, lastAttemptAt: now }
      attemptLocks.set(lockKey, lock)
    }
    if (now < lock.lockedUntil) {
      res.status(423).json({ error: 'NODE_LOCKED', reason: 'WRONG_PASSCODE', unlockAt: lock.lockedUntil })
      return
    }
    // Per-node freeze (same as wrong passcode) when we know the owner.
    const frozen = chargeNodeId > 0 ? isNodeFrozen(chargeNodeId, now) : { frozen: false as const }
    if (frozen.frozen) {
      res.status(423).json({ error: 'NODE_LOCKED', reason: 'NODE_FROZEN', unlockAt: frozen.until })
      return
    }
    lock.attempts++
    lock.lastAttemptAt = now
    const froze = chargeNodeId > 0 ? recordFailedPasscodeAttempt(chargeNodeId, ip, now) : false
    if (lock.attempts >= MAX_ATTEMPTS) {
      lock.lockedUntil = now + LOCK_DURATION_MS
    }
    // Persist every security-counter mutation, not only threshold crossings.
    if (!(await persistSecurityOr503(res))) return
    if (froze) {
      res.status(423).json({
        error: 'NODE_LOCKED',
        reason: 'NODE_FROZEN',
        unlockAt: nodeFreezes.get(chargeNodeId)?.frozenUntil ?? now + NODE_FREEZE_DURATION_MS,
      })
      return
    }
    res.status(401).json({ error: 'INVALID_PROOF' })
    return
  }

  const old = resolved.session
  const lockKey = attemptKey(ip, old.nodeId)
  let lock = attemptLocks.get(lockKey)
  if (lock && now < lock.lockedUntil) {
    res.status(423).json({ error: 'NODE_LOCKED', reason: 'WRONG_PASSCODE', unlockAt: lock.lockedUntil })
    return
  }

  if (nodes.size >= MAX_NODES) {
    // Replacing one session with another is net-zero, but only after we delete
    // the old one. Check against MAX_NODES - 0 since we free one first.
  }
  if (countNodesByIp(ip) >= MAX_NODES_PER_IP && old.ip !== ip) {
    // Moving identity to a new IP that is already at the cap.
    const others = countNodesByIp(ip)
    if (others >= MAX_NODES_PER_IP) {
      res.status(429).json({ error: 'IP_LIMITED', message: '此 IP 地址节点数已达上限' })
      return
    }
  }

  // Capture identity material before terminate wipes the session.
  const { nodeId, passCodeHash, passCodeVerifyHash, passCodeSalt, passCodeAlgo, turnPrincipal } = old

  // Terminate old session first (Contract 5) — frees the proof index, channel
  // membership, token and per-IP slot. Tombstone retains nodeId for freeze.
  terminateSession(old, { closeCode: 1000, closeReason: 'RE_REGISTERED', broadcastLeave: false })

  const sessionId = nanoid(16)
  const token = randomBytes(32).toString('hex')
  const reRegisterProof = mintReRegisterProof()
  const session: NodeSession = {
    sessionId,
    nodeId,
    passCodeHash,
    passCodeVerifyHash,
    passCodeSalt,
    passCodeAlgo,
    token,
    reRegisterProof,
    turnPrincipal: turnPrincipal || deriveTurnPrincipal(nodeId, passCodeHash),
    socket: null,
    lastSeen: now,
    channelId: null,
    blockedIds: new Set(),
    failedAttempts: 0,
    lockedUntil: 0,
    joinedAt: now,
    expiresAt: now + SESSION_TTL_MS,
    ip,
  }
  nodes.set(sessionId, session)
  indexReRegisterProof(reRegisterProof, sessionId)
  attemptLocks.delete(lockKey)

  res.json({
    sessionId,
    token,
    expiresAt: session.expiresAt,
    reRegisterProof,
    resumed: false,
  })
}))

// POST /api/session-renew (Contract 2)
//
// Bearer-authenticated seamless renewal. Keeps the SAME sessionId so transfer
// ownership (peerSessionId, epoch) and the client network epoch survive.
// Mints a new token + reRegisterProof and extends expiresAt.
router.post('/session-renew', asyncRoute(async (req, res) => {
  if (!enforceOrigin(req, res)) return

  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'UNAUTHORIZED' })
    return
  }
  const session = findSessionByToken(authHeader.slice(7))
  if (!session) {
    res.status(401).json({ error: 'UNAUTHORIZED' })
    return
  }

  const now = Date.now()
  session.token = randomBytes(32).toString('hex')
  session.expiresAt = now + SESSION_TTL_MS
  const reRegisterProof = rotateReRegisterProof(session)
  session.lastSeen = now

  res.json({
    sessionId: session.sessionId,
    token: session.token,
    expiresAt: session.expiresAt,
    reRegisterProof,
  })
}))

// Loopback check for the E2E escape hatch (SECURITY-016). The Playwright
// harness always talks to 127.0.0.1; a real deployment's clients never do.
function isLoopbackAddress(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip.startsWith('127.')
}

// POST /api/release-by-ip
router.post('/release-by-ip', asyncRoute(async (req, res) => {
  if (!enforceOrigin(req, res)) return
  if (!requireLocksReady(res)) return

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
      const { ok, upgrade } = await verifyAndMaybeUpgrade(parsed.data.passCode, s)
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
      // Record freeze BEFORE flush so both lock and freeze land together.
      const froze = recordFailedPasscodeAttempt(parsed.data.nodeId, ip, now)
      if (lock.attempts >= MAX_ATTEMPTS) {
        lock.lockedUntil = now + LOCK_DURATION_MS
      }
      if (lock.attempts >= MAX_ATTEMPTS || froze) {
        if (!(await persistSecurityOr503(res))) return
      }
      res.status(401).json({ error: 'UNAUTHORIZED' })
      return
    }
    scopeNodeId = parsed.data.nodeId
    scopePassHash = identity
    attemptLocks.delete(lockKey)
    clearNodeFreezeOnSuccess(parsed.data.nodeId)
  }

  // Snapshot first — terminateSession mutates the map.
  const toRelease: NodeSession[] = []
  for (const session of nodes.values()) {
    if (session.ip !== ip) continue
    if (scopeNodeId !== null && (session.nodeId !== scopeNodeId || session.passCodeHash !== scopePassHash)) continue
    toRelease.push(session)
  }
  for (const session of toRelease) {
    terminateSession(session, { closeCode: 1000, closeReason: 'RELEASED' })
  }
  res.json({ released: toRelease.length })
}))

// POST /api/release
//
// Contract 5: must make the old token genuinely unusable (Bearer + WS AUTH
// both fail afterwards) and notify channel peers via PEER_LEFT. The previous
// implementation only nulled the socket and broadcast activity leave, so the
// WS close guard then skipped cleanup and the session/token stayed live.
router.post('/release', (req, res) => {
  const parsed = z.object({ token: z.string() }).safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ error: 'INVALID_INPUT' }); return }

  const session = findSessionByToken(parsed.data.token)
  if (session) {
    terminateSession(session, { closeCode: 1000, closeReason: 'RELEASED' })
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

  const result = await issueCredentials(session.sessionId, session.ip, session.turnPrincipal)
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
    ...(E2E_BUILD_NONCE ? { e2eBuildNonce: E2E_BUILD_NONCE } : {}),
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

// POST /api/qr-token
//
// SECURITY-011: invitation creation is a state-changing, bearer-authenticated
// POST. The owner's identity is already bound to the session, so no passcode
// is accepted in a query string (browser/proxy/access logs) or request body.
router.post('/qr-token', (req, res) => {
  if (!enforceOrigin(req, res)) return
  const emptyBody = z.object({}).strict().safeParse(req.body ?? {})
  if (!emptyBody.success) { res.status(400).json({ error: 'INVALID_INPUT' }); return }
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) { res.status(401).json({ error: 'UNAUTHORIZED' }); return }
  const token = authHeader.slice(7)

  const ownerSession = findSessionByToken(token)
  if (!ownerSession) { res.status(401).json({ error: 'UNAUTHORIZED' }); return }

  const qrToken = nanoid(32)
  const channelId = nanoid(8)
  const expiresAt = Date.now() + QR_TOKEN_TTL_MS
  const record: QrTokenRecord = {
    token: qrToken,
    ownerNodeId: ownerSession.nodeId,
    type: 'node',
    channelId,
    passCodeHash: ownerSession.passCodeHash,
    createdAt: Date.now(),
    expiresAt,
    used: false,
  }
  qrTokens.set(qrToken, record)
  res.set('Cache-Control', 'no-store')
  res.json({ qrToken, channelId, expiresAt })
})

// POST /api/qr-redeem
router.post('/qr-redeem', asyncRoute(async (req, res) => {
  if (!enforceOrigin(req, res)) return
  if (!requireLocksReady(res)) return

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
    // Timing-safe compare of the keyed identity representations.
    const provided = Buffer.from(hashPassCodeIdentity(parsed.data.myPassCode))
    const expected = Buffer.from(record.passCodeHash)
    const match = provided.length === expected.length && timingSafeEqual(provided, expected)
    if (!match) {
      // A wrong guess used to neither burn the single-use token nor feed any
      // lockout, so the same token could be retried across the full 6-digit
      // keyspace for its 5-min TTL. Now: count the failure into the per-nodeId
      // freeze AND burn the token after MAX_ATTEMPTS wrong guesses. Strict-
      // flush before the response so a crash cannot lose the freeze/burn.
      record.failedAttempts = (record.failedAttempts ?? 0) + 1
      const froze = recordFailedPasscodeAttempt(record.ownerNodeId, ip, now)
      if (record.failedAttempts >= MAX_ATTEMPTS) record.used = true
      // Persist every failure mutation before the response (not only freeze/burn).
      if (!(await persistSecurityOr503(res))) return
      if (froze) {
        res.status(423).json({
          error: 'NODE_LOCKED',
          reason: 'NODE_FROZEN',
          unlockAt: nodeFreezes.get(record.ownerNodeId)?.frozenUntil ?? now + NODE_FREEZE_DURATION_MS,
        })
        return
      }
      res.status(401).json({ error: 'WRONG_PASSCODE' })
      return
    }
  } else {
    res.status(403).json({ error: 'QR_REQUIRES_PASSCODE' })
    return
  }

  clearNodeFreezeOnSuccess(record.ownerNodeId)
  const channelId = record.channelId ?? nanoid(8)
  // Idempotent until register commits it. A retry after an IP_LIMITED or
  // NETWORK_FULL response gets the same grant and cannot mint unbounded
  // capabilities from one invitation.
  record.admissionGrant ??= randomBytes(32).toString('hex')
  res.set('Cache-Control', 'no-store')
  res.json({
    targetNodeId: record.ownerNodeId,
    channelId,
    admissionGrant: record.admissionGrant,
  })
}))

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
