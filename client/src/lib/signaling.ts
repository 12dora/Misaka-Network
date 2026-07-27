import type { WSServerMessage, WSMessage } from '@/types'
import { wsUrl } from '@/config'
import { HEARTBEAT_INTERVAL_MS, RECONNECT_DELAYS_MS } from '@/constants'

// BUG-006: handlers are allowed to be async. Previously the type said
// `void`, every network.ts signaling handler was `async`, and the returned
// promise was dropped on the floor — a rejected SDP application surfaced as
// an `unhandledrejection` with no context instead of a scoped warning.
type MessageHandler = (msg: WSServerMessage) => void | Promise<void>
type ConnectionHandler = () => void | Promise<void>

let ws: WebSocket | null = null
const handlers = new Set<MessageHandler>()
const connectHandlers = new Set<ConnectionHandler>()
const disconnectHandlers = new Set<ConnectionHandler>()
const authInvalidHandlers = new Set<ConnectionHandler>()
// Registered by the network layer; invoked by `endSession()` so an explicit
// logout tears the whole network epoch down through one idempotent path.
const sessionEndHandlers = new Set<ConnectionHandler>()
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let token = ''
let reconnectAttempts = 0
let serverShutdown = false

// Invoke a set of subscribers so that one bad handler — throwing synchronously
// or rejecting later — can neither abort the dispatch loop nor escape as an
// unhandled rejection.
function dispatch<T>(subscribers: Iterable<(arg: T) => void | Promise<void>>, arg: T, what: string) {
  for (const handler of [...subscribers]) {
    try {
      const result = handler(arg)
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch(err => console.warn(`[signaling] ${what} handler rejected`, err))
      }
    } catch (err) {
      console.warn(`[signaling] ${what} handler threw`, err)
    }
  }
}

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

/**
 * BUG-001: subscribe to "the authenticated session has ended for good"
 * (explicit Disconnect). The network layer uses this to destroy every
 * session-scoped artefact — peer connections, data channels, ECDH keys,
 * in-flight transfers — instead of leaving them alive on a released token.
 *
 * Lives here (rather than as a store↔store import) because signaling.ts is
 * the one module both the auth store and the network store already depend on.
 */
export function onSessionEnd(handler: ConnectionHandler) {
  sessionEndHandlers.add(handler)
  return () => { sessionEndHandlers.delete(handler) }
}

export function connect(t: string) {
  // Auth recovery (4001/4002 close → fresh token) re-enters this function.
  // The old socket is still attached to its onclose; if we leave it alone the
  // new doConnect() bails on the OPEN/CONNECTING guard and the new token is
  // never sent. Force-detach + close the old socket first.
  const tokenChanged = token !== t
  if (tokenChanged && ws) {
    ws.onclose = null
    ws.onerror = null
    ws.onmessage = null
    ws.onopen = null
    try { ws.close() } catch { /* ignore */ }
    ws = null
  }
  token = t
  reconnectAttempts = 0
  serverShutdown = false
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
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
    dispatch(connectHandlers, undefined, 'connect')
  }

  sock.onclose = (e) => {
    stopHeartbeat()
    dispatch(disconnectHandlers, undefined, 'disconnect')
    // Server-side sessions are in-memory; after a server restart our cached
    // token comes back as 4002 INVALID_TOKEN. Stop reconnecting with the
    // dead token and let the auth store re-register from sessionStorage.
    if (e.code === 4001 || e.code === 4002) {
      serverShutdown = true
      dispatch(authInvalidHandlers, undefined, 'authInvalid')
      return
    }
    scheduleReconnect()
  }

  sock.onerror = () => {
    sock.close()
  }

  sock.onmessage = (e) => {
    let msg: WSServerMessage
    try {
      msg = JSON.parse(e.data as string) as WSServerMessage
    } catch {
      return   // ignore invalid messages
    }
    if (msg.t === 'SERVER_SHUTDOWN') serverShutdown = true
    // Note: previously the whole dispatch sat inside the try, so a handler
    // that threw was silently swallowed by the "invalid JSON" catch.
    dispatch(handlers, msg, 'message')
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
  const idx = Math.min(reconnectAttempts, RECONNECT_DELAYS_MS.length - 1)
  const delay = RECONNECT_DELAYS_MS[idx]
  // Bound the counter so it doesn't increment forever on a flaky network.
  // Stops being meaningful past the table length anyway.
  if (reconnectAttempts < RECONNECT_DELAYS_MS.length) reconnectAttempts++
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
  // BUG-001: the token used to survive disconnect(), so the module-level
  // `online` listener (or any reconnectNow() caller) happily re-opened a
  // socket with a token we had just released — the UI said "未接入" while a
  // live signaling session kept the node registered. Forget it here.
  token = ''
  reconnectAttempts = 0
  serverShutdown = false
  // NOTE: handler sets are deliberately NOT cleared. They belong to their
  // registrars (the auth store subscribes to onAuthInvalid exactly once at
  // module scope); wiping them here permanently disabled auth recovery after
  // the first logout. Registrars call the returned unsubscribe instead.
  stopHeartbeat()
  if (ws) {
    ws.onclose = null // prevent reconnect
    ws.close()
    ws = null
  }
}

/**
 * Idempotent end-of-session: stop reconnecting, drop the token, close the
 * socket, then let every registered network-layer teardown run. Safe to call
 * repeatedly and safe to call when nothing was ever connected.
 */
export function endSession() {
  disconnect()
  dispatch(sessionEndHandlers, undefined, 'sessionEnd')
}

export function send(msg: WSMessage) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg))
  }
}

export function isConnected(): boolean {
  return ws?.readyState === WebSocket.OPEN
}
