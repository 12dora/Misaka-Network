import express from 'express'
import cors from 'cors'
import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import { router } from './http.js'
import { setupWS } from './ws.js'
import { setWSS } from './activity.js'
import { startCleanupTask, stopCleanupTask } from './cleanup.js'
import { loadTurnState, startPersistFlusher, stopPersistFlusher, flushTurnState } from './persist.js'
import { startTurnPollers, stopTurnPollers } from './turn.js'
import { PORT, SHUTDOWN_TIMEOUT_MS } from './config.js'

const app = express()

app.set('trust proxy', 1)
app.use(cors())
app.use(express.json())
app.use('/api', router)

// Catch-all for non-API routes — always return JSON
app.all('*', (_req, res) => {
  res.status(404).json({ error: 'NOT_FOUND' })
})

const httpServer = createServer(app)
const wss = new WebSocketServer({ server: httpServer, path: '/ws' })

setWSS(wss)
setupWS(wss)
startCleanupTask()

// TURN auto-provisioning: persist + pollers. Loaded async at boot so the HTTP
// server still binds even if the filesystem is slow. Pollers self-start only
// when Cloudflare credentials are configured (see turn.turnConfigured()).
loadTurnState().then(() => {
  startPersistFlusher()
  startTurnPollers()
}).catch(err => {
  console.error('[boot] TURN init failed; running without auto TURN:', err.message)
})

httpServer.listen(PORT, () => {
  console.log(`御坂信令服务器 listening on :${PORT}`)
})

// Graceful shutdown: notify all connected nodes before exiting
function gracefulShutdown(signal: string) {
  console.log(`\n收到 ${signal}，正在通知所有节点并关闭...`)

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

  // 3. Stop TURN pollers and flush persisted state synchronously.
  stopCleanupTask()
  stopTurnPollers()
  stopPersistFlusher()
  flushTurnState(true).catch(err => console.error('[shutdown] flush error:', err.message))

  // 4. Stop accepting new connections, then exit
  httpServer.close(() => {
    console.log('信令服务器已安全关闭')
    process.exit(0)
  })

  setTimeout(() => {
    console.log('强制退出')
    process.exit(1)
  }, SHUTDOWN_TIMEOUT_MS)
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))
