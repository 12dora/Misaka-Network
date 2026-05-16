import type { WSServerMessage, WSMessage } from '@/types'
import { wsUrl } from '@/config'
import { HEARTBEAT_INTERVAL_MS, RECONNECT_DELAYS_MS } from '@/constants'

type MessageHandler = (msg: WSServerMessage) => void
type ConnectionHandler = () => void

let ws: WebSocket | null = null
let handlers = new Set<MessageHandler>()
let connectHandlers = new Set<ConnectionHandler>()
let disconnectHandlers = new Set<ConnectionHandler>()
let authInvalidHandlers = new Set<ConnectionHandler>()
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let token = ''
let reconnectAttempts = 0
let serverShutdown = false

export function onMessage(handler: MessageHandler) {
  handlers.add(handler)
  return () => { handlers.delete(handler) }
}

export function onConnect(handler: ConnectionHandler) {
  connectHandlers.add(handler)
  return () => { connectHandlers.delete(handler) }
}

export function onDisconnect(handler: ConnectionHandler) {
  disconnectHandlers.add(handler)
  return () => { disconnectHandlers.delete(handler) }
}

export function onAuthInvalid(handler: ConnectionHandler) {
  authInvalidHandlers.add(handler)
  return () => { authInvalidHandlers.delete(handler) }
}

export function connect(t: string) {
  token = t
  reconnectAttempts = 0
  serverShutdown = false
  doConnect()
}

export function reconnectNow() {
  if (!token) return
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  reconnectAttempts = 0
  serverShutdown = false
  if (ws && (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED)) {
    ws = null
  }
  if (ws?.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify({ t: 'PING' })) } catch { /* reconnect below */ }
    return
  }
  doConnect()
}

function doConnect() {
  // Don't replace a socket that's already open *or* still connecting —
  // overwriting it leaves the old socket's `onopen` referencing the new ws
  // via closure, which then calls `ws.send` on a still-CONNECTING socket.
  if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return

  const sock = new WebSocket(wsUrl())
  ws = sock

  sock.onopen = () => {
    sock.send(JSON.stringify({ t: 'AUTH', token }))
    startHeartbeat(sock)
    reconnectAttempts = 0
    connectHandlers.forEach(h => h())
  }

  sock.onclose = (e) => {
    stopHeartbeat()
    disconnectHandlers.forEach(h => h())
    // Server-side sessions are in-memory; after a server restart our cached
    // token comes back as 4002 INVALID_TOKEN. Stop reconnecting with the
    // dead token and let the auth store re-register from sessionStorage.
    if (e.code === 4001 || e.code === 4002) {
      serverShutdown = true
      authInvalidHandlers.forEach(h => h())
      return
    }
    scheduleReconnect()
  }

  sock.onerror = () => {
    sock.close()
  }

  sock.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data as string) as WSServerMessage
      if (msg.t === 'SERVER_SHUTDOWN') serverShutdown = true
      handlers.forEach(h => h(msg))
    } catch {
      // ignore invalid messages
    }
  }
}

function startHeartbeat(sock: WebSocket) {
  stopHeartbeat()
  heartbeatTimer = setInterval(() => {
    if (ws !== sock || sock.readyState !== WebSocket.OPEN) {
      stopHeartbeat()
      return
    }
    sock.send(JSON.stringify({ t: 'PING' }))
  }, HEARTBEAT_INTERVAL_MS)
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

function scheduleReconnect() {
  if (reconnectTimer || serverShutdown) return
  const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempts, RECONNECT_DELAYS_MS.length - 1)]
  reconnectAttempts++
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    doConnect()
  }, delay)
}

// Network change auto-reconnect
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    reconnectNow()
  })
}

export function disconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  handlers.clear()
  connectHandlers.clear()
  disconnectHandlers.clear()
  authInvalidHandlers.clear()
  stopHeartbeat()
  if (ws) {
    ws.onclose = null // prevent reconnect
    ws.close()
    ws = null
  }
}

export function send(msg: WSMessage) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg))
  }
}

export function isConnected(): boolean {
  return ws?.readyState === WebSocket.OPEN
}
