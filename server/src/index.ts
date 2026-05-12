import express from 'express'
import cors from 'cors'
import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import { router } from './http.js'
import { setupWS } from './ws.js'
import { setWSS } from './activity.js'
import { startCleanupTask } from './cleanup.js'

const PORT = parseInt(process.env.PORT ?? '8080', 10)

const app = express()

app.set('trust proxy', 1)
app.use(cors())
app.use(express.json())
app.use('/api', router)

const httpServer = createServer(app)
const wss = new WebSocketServer({ server: httpServer, path: '/ws' })

setWSS(wss)
setupWS(wss)
startCleanupTask()

httpServer.listen(PORT, () => {
  console.log(`御坂信令服务器 listening on :${PORT}`)
})
