import express from 'express'
import cors from 'cors'
import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import { router } from './http.js'
import { setupWS } from './ws.js'
import { setWSS } from './activity.js'
import { startCleanupTask, stopCleanupTask } from './cleanup.js'
import { loadTurnState, startPersistFlusher, stopPersistFlusher, flushTurnState, loadPersistedLocks, flushPersistedLocks } from './persist.js'
import { startTurnPollers, stopTurnPollers, startTurnRevokeRetry, stopTurnRevokeRetry } from './turn.js'
import { allowedOrigins, isOriginAllowed, isOriginAllowedForRequest, isWildcardOriginMode } from './origin.js'
import { PORT, SHUTDOWN_TIMEOUT_MS, TRUST_PROXY } from './config.js'

const app = express()

// Default OFF so a directly internet-facing deployment can't be tricked by a
// spoofed X-Forwarded-For header (which would defeat every per-IP defence).
// Operators behind a reverse proxy set TRUST_PROXY (see config.ts).
app.set('trust proxy', TRUST_PROXY)

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

// 64kb body cap — same ceiling as the WS frame guard, so a single bad
// request can't burn a megabyte of buffer.
app.use(express.json({ limit: '64kb' }))
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
// (enforced in ws.ts).
const wss = new WebSocketServer({
  server: httpServer,
  path: '/ws',
  verifyClient: (info, done) => {
    const origin = info.req.headers.origin
    // No Origin (non-browser); allowlist hit; or same-origin (Origin matches
    // our own Host). Reject otherwise — the upgrade fails before the WS
    // handshake completes so no socket is left dangling.
    if (!origin || isOriginAllowed(origin) || isOriginAllowedForRequest(info.req)) {
      done(true)
      return
    }
    done(false, 403, 'BAD_ORIGIN')
  },
})

setWSS(wss)
setupWS(wss)
startCleanupTask()

// Load persisted brute-force locks + node freezes BEFORE we accept the first
// request. Without this an attacker mid-lockout could just wait for the
// process to restart and resume.
loadPersistedLocks().catch(err => {
  console.error('[boot] persist load (locks) failed:', err.message)
})

// TURN auto-provisioning: persist + pollers. Loaded async at boot so the HTTP
// server still binds even if the filesystem is slow. Pollers self-start only
// when Cloudflare credentials are configured (see turn.turnConfigured()).
loadTurnState().then(() => {
  startPersistFlusher()
  startTurnPollers()
  startTurnRevokeRetry()
}).catch(err => {
  console.error('[boot] TURN init failed; running without auto TURN:', err.message)
})

httpServer.listen(PORT, () => {
  console.log(`御坂信令服务器 listening on :${PORT}`)
})

// Graceful shutdown: notify all connected nodes before exiting
let shuttingDown = false
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

  // 1. Broadcast SHUTDOWN to every connected client
  const shutdownMsg = JSON.stringify({ t: 'SERVER_SHUTDOWN', reason: '服务器维护中，请稍后重连' })
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(shutdownMsg)
    }
  }

  // 2. Close all WS connections with code 1001 (going away)
  for (const client of wss.clients) {
    client.close(1001, 'SERVER_SHUTDOWN')
  }

  // 3. Stop TURN pollers and flush persisted state. AWAIT the flush — the
  // money-critical monthly byte tally (and the brute-force locks) must hit
  // disk before we exit. Fire-and-forget here used to lose the final delta
  // whenever httpServer.close resolved before the async write/rename landed.
  stopCleanupTask()
  stopTurnPollers()
  stopTurnRevokeRetry()
  stopPersistFlusher()
  await Promise.allSettled([flushTurnState(true), flushPersistedLocks()])

  // 4. Stop accepting new connections, then exit
  httpServer.close(() => {
    console.log('信令服务器已安全关闭')
    process.exit(0)
  })
}

process.on('SIGTERM', () => void gracefulShutdown('SIGTERM').catch(() => process.exit(1)))
process.on('SIGINT', () => void gracefulShutdown('SIGINT').catch(() => process.exit(1)))
