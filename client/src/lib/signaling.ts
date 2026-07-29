import type { WSServerMessage, WSMessage } from '@/types'
import { wsUrl } from '@/config'
import { HEARTBEAT_INTERVAL_MS, RECONNECT_DELAYS_MS, WS_CONNECT_TIMEOUT_MS } from '@/constants'

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
let connectWatchdogTimer: ReturnType<typeof setTimeout> | null = null
let token = ''
let reconnectAttempts = 0
let serverShutdown = false
// Monotonic generation so a stale close/error/message from a detached socket
// cannot stop the NEW socket's heartbeat, broadcast disconnect, or clear auth.
let socketGeneration = 0

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

/**
 * Detach every callback and close `sock`. If it is still the module's current
 * socket, clear `ws` so a later stale event cannot be mistaken for the live one.
 * Does NOT schedule reconnect — callers that want backoff do that themselves.
 */
function detachAndClose(sock: WebSocket | null) {
  if (!sock) return
  sock.onclose = null
  sock.onerror = null
  sock.onmessage = null
  sock.onopen = null
  if (connectWatchdogTimer && ws === sock) {
    clearTimeout(connectWatchdogTimer)
    connectWatchdogTimer = null
  }
  try { sock.close() } catch { /* already closed / closing */ }
  if (ws === sock) ws = null
}

function clearConnectWatchdog() {
  if (connectWatchdogTimer) {
    clearTimeout(connectWatchdogTimer)
    connectWatchdogTimer = null
  }
}

/** Per-socket connect watchdog: a black-holing firewall can leave CONNECTING forever. */
function armConnectWatchdog(sock: WebSocket, generation: number) {
  clearConnectWatchdog()
  connectWatchdogTimer = setTimeout(() => {
    connectWatchdogTimer = null
    // Only the socket that armed this timer may be closed.
    if (ws !== sock || generation !== socketGeneration) return
    if (sock.readyState === WebSocket.CONNECTING) {
      detachAndClose(sock)
      scheduleReconnect()
    }
  }, WS_CONNECT_TIMEOUT_MS)
}

export function connect(t: string) {
  // Auth recovery (4001/4002 close → fresh token) re-enters this function.
  // The old socket is still attached to its onclose; if we leave it alone the
  // new doConnect() bails on the OPEN/CONNECTING guard and the new token is
  // never sent. Force-detach + close the old socket first.
  const tokenChanged = token !== t
  if (tokenChanged && ws) {
    detachAndClose(ws)
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
    // Nulling without detach left a CLOSING socket able to deliver a stale
    // close that stopped the NEW socket's heartbeat / cleared auth. Detach.
    detachAndClose(ws)
  }
  if (ws?.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ t: 'PING' }))
      return
    } catch {
      // OPEN-but-half-dead: PING threw. Fall through and replace the socket.
      detachAndClose(ws)
    }
  }
  // Explicit reconnect may also replace a CONNECTING socket stuck behind a
  // black hole — doConnect would otherwise refuse to open a second one.
  if (ws?.readyState === WebSocket.CONNECTING) {
    detachAndClose(ws)
  }
  doConnect()
}

function doConnect() {
  // Don't replace a socket that's already open *or* still connecting —
  // overwriting it leaves the old socket's `onopen` referencing the new ws
  // via closure, which then calls `ws.send` on a still-CONNECTING socket.
  // Stuck CONNECTING is handled by the per-socket watchdog / reconnectNow.
  if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return

  const sock = new WebSocket(wsUrl())
  const generation = ++socketGeneration
  ws = sock
  armConnectWatchdog(sock, generation)

  sock.onopen = () => {
    if (ws !== sock) return
    clearConnectWatchdog()
    sock.send(JSON.stringify({ t: 'AUTH', token }))
    startHeartbeat(sock)
    reconnectAttempts = 0
    dispatch(connectHandlers, undefined, 'connect')
  }

  sock.onclose = (e) => {
    // Generation / identity check: a detached socket's late close must not
    // touch the live connection's heartbeat or auth state.
    if (ws !== sock) return
    clearConnectWatchdog()
    stopHeartbeat()
    ws = null
    dispatch(disconnectHandlers, undefined, 'disconnect')
    // Server-side sessions are in-memory; after a server restart our cached
    // token comes back as 4002 INVALID_TOKEN. Stop reconnecting with the
    // dead token and let the auth store re-register from sessionStorage.
    // Contract 3: 4001/4002 → onAuthInvalid (hard contract). 4003 is a
    // transient AUTH timeout / non-AUTH first frame — reconnect with the
    // SAME token through exponential backoff; do NOT burn a new session.
    if (e.code === 4001 || e.code === 4002) {
      serverShutdown = true
      dispatch(authInvalidHandlers, undefined, 'authInvalid')
      return
    }
    scheduleReconnect()
  }

  sock.onerror = () => {
    if (ws !== sock) return
    try { sock.close() } catch { /* ignore */ }
  }

  sock.onmessage = (e) => {
    if (ws !== sock) return
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
    try {
      sock.send(JSON.stringify({ t: 'PING' }))
    } catch {
      // Half-dead OPEN socket: stop hammering and let ownership-aware close
      // (or the next reconnectNow) replace it.
      stopHeartbeat()
    }
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
  clearConnectWatchdog()
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
    detachAndClose(ws)
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
