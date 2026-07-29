import express from 'express'
import cors from 'cors'
import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import { router, getClientIP, installTestInstanceHeader } from './http.js'
import { setupWS, setTrustProxyFn, checkPendingAuthAdmission } from './ws.js'
import { setWSS } from './activity.js'
import { startCleanupTask, stopCleanupTask } from './cleanup.js'
import {
  loadTurnState, startPersistFlusher, stopPersistFlusher,
  flushTurnState, loadPersistedLocks, flushPersistedLocks,
} from './persist.js'
import { startTurnPollers, stopTurnPollers, startTurnRevokeRetry, stopTurnRevokeRetry } from './turn.js'
import { allowedOrigins, isOriginAllowed, isOriginAllowedForRequest, isWildcardOriginMode, setOriginTrustProxyFn } from './origin.js'
import { PORT, SHUTDOWN_TIMEOUT_MS, TURN_CF_TIMEOUT_MS, TRUST_PROXY, WS_MAX_PAYLOAD_BYTES, validateStartupConfig } from './config.js'
import { checkRateLimit } from './ratelimit.js'
import { RATE_LIMIT_PER_MIN, RATE_WINDOW_MS } from './config.js'

// Deployment errors must fail before listeners, cleanup timers or provider
// pollers are created. In particular, an "enabled" automatic TURN service
// without provider credentials is not a healthy degraded mode.
validateStartupConfig()

const app = express()

// Default OFF so a directly internet-facing deployment can't be tricked by a
// spoofed X-Forwarded-For header (which would defeat every per-IP defence).
// Operators behind a reverse proxy set TRUST_PROXY (see config.ts).
app.set('trust proxy', TRUST_PROXY)

// SECURITY-005: hand Express' *compiled* trust predicate to the WS layer so
// the upgrade handshake resolves the client IP through exactly the same hop
// rules as `req.ip`. Before this the WS side took the left-most (i.e.
// client-controlled) X-Forwarded-For entry and could be handed a forged IP.
// Origin scheme resolution uses the same predicate so X-Forwarded-Proto is
// only trusted from a peer that the configured hop/CIDR policy allows.
const trustProxyFn = app.get('trust proxy fn')
setTrustProxyFn(trustProxyFn)
setOriginTrustProxyFn(trustProxyFn)

// CORS policy:
//   - ALLOWED_ORIGINS=* → wildcard mode (echo any Origin). Intended for the
//     canonical public signaling deployment (GitHub Pages frontend + this
//     server) where any fork's origin should work zero-config.
//   - Otherwise → strict allowlist + same-origin auto-allow. Private
//     deployments stay locked down.
// Implemented as middleware (rather than the cors() callback) because we
// need the full Request to compare Origin against Host for same-origin.
app.use((req, res, next) => {
  const origin = req.headers.origin
  if (!origin) return cors({ origin: false, credentials: false })(req, res, next)
  if (isWildcardOriginMode()) {
    return cors({ origin, credentials: false })(req, res, next)
  }
  const ok = allowedOrigins().includes(origin) || isOriginAllowedForRequest(req)
  return cors({ origin: ok ? origin : false, credentials: false })(req, res, next)
})

// Graceful-shutdown gate: once SIGTERM lands we refuse new business before
// the final security flush, so a credential issued during serialisation can
// never miss the snapshot.
let shuttingDown = false
/** In-flight non-health HTTP requests — shutdown waits for these to finish. */
let inFlightRequests = 0
export function isShuttingDown(): boolean {
  return shuttingDown
}
/** Test hook. */
export function _inFlightForTest(): number {
  return inFlightRequests
}

app.use((req, res, next) => {
  if (shuttingDown) {
    // Health stays up so the orchestrator can still observe the draining pod.
    if (req.path === '/api/health' || req.path === '/api/ready') return next()
    res.status(503).json({ error: 'SHUTTING_DOWN', message: '服务器正在关闭' })
    return
  }
  // Track work that may mutate security/money state so shutdown can wait for
  // a real drain instead of racing a fixed 2s timer against an 8s provider.
  if (req.path.startsWith('/api')) {
    inFlightRequests++
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      inFlightRequests = Math.max(0, inFlightRequests - 1)
    }
    res.on('finish', done)
    res.on('close', done)
  }
  next()
})

// Test-instance header must be set on EVERY /api response — including those
// short-circuited by the pre-parser rate limit below — so the integration
// harness can reject a stale process on a fixed port.
installTestInstanceHeader(app)

// Body-independent /api IP rate limit MUST run before express.json().
// Malformed / oversized bodies previously burned parse resources outside every
// IP budget, and with NODE_ENV=development returned Express's default HTML
// error page instead of a stable JSON error.
// Health/ready are excluded so orchestrator probes and test readiness polls
// never starve the business budget.
app.use('/api', (req, res, next) => {
  if (req.path === '/health' || req.path === '/ready') return next()
  const ip = getClientIP(req)
  if (!checkRateLimit(`api:${ip}`, RATE_LIMIT_PER_MIN, RATE_WINDOW_MS)) {
    res.status(429).json({ error: 'RATE_LIMITED', message: '请求过于频繁，请稍后再试' })
    return
  }
  next()
})

// 64kb body cap — same ceiling as the WS frame guard, so a single bad
// request can't burn a megabyte of buffer.
app.use(express.json({ limit: '64kb' }))

// Map body-parser failures to stable JSON in EVERY environment (including
// development, where Express would otherwise return an HTML stack page).
app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (!err || typeof err !== 'object') return next(err)
  const e = err as { type?: string; status?: number; statusCode?: number; message?: string }
  if (e.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'INVALID_JSON', message: '请求体不是合法 JSON' })
    return
  }
  if (e.type === 'entity.too.large') {
    res.status(413).json({ error: 'BODY_TOO_LARGE', message: '请求体过大' })
    return
  }
  // status 400 from body-parser on other parse issues
  if (e.status === 400 || e.statusCode === 400) {
    res.status(400).json({ error: 'BAD_REQUEST', message: e.message ?? '请求无效' })
    return
  }
  next(err)
})

app.use('/api', router)

// Catch-all for non-API routes — always return JSON
app.all('*', (_req, res) => {
  res.status(404).json({ error: 'NOT_FOUND' })
})

const httpServer = createServer(app)

// WebSocket upgrade verification. We refuse the upgrade if the Origin (which
// browsers always send on WS) is missing/disallowed. Non-browser callers
// without an Origin header are still allowed — they cannot be tricked by a
// malicious page, and the AUTH frame is still required within 5s of connect
// (enforced in ws.ts). Pending-auth caps run here so we never allocate a
// socket for a connection that will only be rejected for capacity.
const wss = new WebSocketServer({
  server: httpServer,
  path: '/ws',
  // SECURITY-002: the transport-level ceiling. The application check in ws.ts
  // only ran after `ws` had already buffered the entire message and turned it
  // into a string, so an unauthenticated client could make the process
  // allocate arbitrarily much before being told "too large". With maxPayload
  // set, the receiver aborts the connection (close 1009) as soon as the
  // accumulated frame length crosses the limit — including across
  // continuation frames — so nothing oversize is ever fully buffered.
  maxPayload: WS_MAX_PAYLOAD_BYTES,
  verifyClient: (info, done) => {
    if (shuttingDown) {
      done(false, 503, 'SHUTTING_DOWN')
      return
    }
    const origin = info.req.headers.origin
    // No Origin (non-browser); allowlist hit; or same-origin (Origin matches
    // our own Host). Reject otherwise — the upgrade fails before the WS
    // handshake completes so no socket is left dangling.
    if (!origin || isOriginAllowed(origin) || isOriginAllowedForRequest(info.req)) {
      const admission = checkPendingAuthAdmission(info.req)
      if (!admission.ok) {
        done(false, 503, admission.reason)
        return
      }
      done(true)
      return
    }
    done(false, 403, 'BAD_ORIGIN')
  },
})

setWSS(wss)
setupWS(wss)
startCleanupTask()

// SECURITY-009: AWAIT both persisted snapshots before we bind. These used to
// be fire-and-forget, so between `listen()` and the load completing the process
// served requests against EMPTY security state — persisted brute-force locks
// and node freezes were not in force, the persisted TURN kill switch was off,
// and any TURN reservation made inside that window was thrown away the moment
// the snapshot replaced the state object. Both loaders validate their file and
// report a readiness state (see /api/ready); an unreadable TURN snapshot makes
// issuance fail CLOSED rather than start a fresh 0-byte month.
try {
  await loadPersistedLocks()
} catch (err) {
  console.error('[boot] persist load (locks) failed:', (err as Error).message)
}
try {
  await loadTurnState()
} catch (err) {
  console.error('[boot] TURN state load failed; issuance will fail closed:', (err as Error).message)
}

// TURN auto-provisioning: persist + pollers. Pollers self-start only when
// Cloudflare credentials are configured (see turn.turnConfigured()).
startPersistFlusher()
startTurnPollers()
startTurnRevokeRetry()

httpServer.listen(PORT, () => {
  const addr = httpServer.address()
  const actualPort = typeof addr === 'object' && addr ? addr.port : PORT
  console.log(`御坂信令服务器 listening on :${actualPort}`)
  // Always emit the real port so PORT=0 test helpers can parse it (even when
  // TEST_INSTANCE_NONCE is unset by a custom spawn).
  console.log(`MISAKA_LISTEN_PORT=${actualPort}`)
})

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Graceful shutdown: gate → stop accepting → drain in-flight → strict flush →
// re-check / re-flush → exit. Never exit 0 with mutations after the final
// snapshot.
async function gracefulShutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`\n收到 ${signal}，正在通知所有节点并关闭...`)

  // Hard backstop: if any await below wedges, still exit. Armed FIRST so the
  // process can never hang on shutdown. unref so it isn't itself a live handle.
  const hardExit = setTimeout(() => {
    console.log('强制退出')
    process.exit(1)
  }, SHUTDOWN_TIMEOUT_MS)
  hardExit.unref?.()

  // 1. Stop accepting NEW connections immediately. In-flight requests keep
  // running until they finish (or the hard backstop fires).
  const closeHttp = new Promise<void>((resolve) => {
    httpServer.close(() => resolve())
  })

  // 2. Broadcast SHUTDOWN to every connected client
  const shutdownMsg = JSON.stringify({ t: 'SERVER_SHUTDOWN', reason: '服务器维护中，请稍后重连' })
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(shutdownMsg)
    }
  }

  // 3. Close all WS connections with code 1001 (going away)
  for (const client of wss.clients) {
    client.close(1001, 'SERVER_SHUTDOWN')
  }

  // 4. Stop background work so no more dirty state is produced during flush.
  stopCleanupTask()
  stopTurnPollers()
  stopTurnRevokeRetry()
  stopPersistFlusher()

  // 5. Real drain: wait for in-flight HTTP handlers up to the provider
  // deadline budget (not a fixed 2s race that loses mutations).
  const drainBudgetMs = Math.min(
    SHUTDOWN_TIMEOUT_MS - 1500,
    Math.max(TURN_CF_TIMEOUT_MS + 500, 3000),
  )
  const drainDeadline = Date.now() + Math.max(500, drainBudgetMs)
  while (inFlightRequests > 0 && Date.now() < drainDeadline) {
    await sleep(25)
  }
  await Promise.race([
    closeHttp,
    sleep(Math.max(0, drainDeadline - Date.now())),
  ])

  // 6. Strict security flush. force=true REJECTS on failure so we never claim
  // "安全关闭" with the month's tally / deny list / locks unwritten.
  async function strictFlush(): Promise<string | null> {
    let flushFailed: string | null = null
    try {
      await flushTurnState(true)
    } catch (err) {
      flushFailed = (err as Error).message
      console.error('[shutdown] TURN state flush failed:', flushFailed)
    }
    try {
      await flushPersistedLocks(true)
    } catch (err) {
      const msg = (err as Error).message
      flushFailed = flushFailed ? `${flushFailed}; ${msg}` : msg
      console.error('[shutdown] locks flush failed:', msg)
    }
    return flushFailed
  }

  let flushFailed = await strictFlush()

  // 7. If a late handler is still mutating (or finished after flush), wait
  // briefly and flush again so we never exit 0 with an absent mutation.
  if (inFlightRequests > 0) {
    const extraDeadline = Date.now() + 500
    while (inFlightRequests > 0 && Date.now() < extraDeadline) {
      await sleep(20)
    }
    const second = await strictFlush()
    if (second) flushFailed = flushFailed ? `${flushFailed}; ${second}` : second
  }

  clearTimeout(hardExit)
  if (flushFailed) {
    console.error(`信令服务器关闭时持久化失败: ${flushFailed}`)
    process.exit(1)
  }
  if (inFlightRequests > 0) {
    console.error(`信令服务器关闭时仍有 ${inFlightRequests} 个在途请求，拒绝声明安全关闭`)
    process.exit(1)
  }
  console.log('信令服务器已安全关闭')
  process.exit(0)
}

process.on('SIGTERM', () => void gracefulShutdown('SIGTERM').catch(() => process.exit(1)))
process.on('SIGINT', () => void gracefulShutdown('SIGINT').catch(() => process.exit(1)))
