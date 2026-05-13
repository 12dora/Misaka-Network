import type { WSServerMessage, WSMessage } from '@/types'
import { wsUrl } from '@/config'

type MessageHandler = (msg: WSServerMessage) => void
type ConnectionHandler = () => void

let ws: WebSocket | null = null
let handlers = new Set<MessageHandler>()
let connectHandlers = new Set<ConnectionHandler>()
let disconnectHandlers = new Set<ConnectionHandler>()
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let token = ''
let reconnectAttempts = 0

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

export function connect(t: string) {
  token = t
  reconnectAttempts = 0
  doConnect()
}

function doConnect() {
  if (ws?.readyState === WebSocket.OPEN) return

  ws = new WebSocket(wsUrl())

  ws.onopen = () => {
    ws!.send(JSON.stringify({ t: 'AUTH', token }))
    reconnectAttempts = 0
    connectHandlers.forEach(h => h())
  }

  ws.onclose = () => {
    disconnectHandlers.forEach(h => h())
    scheduleReconnect()
  }

  ws.onerror = () => {
    ws?.close()
  }

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data as string) as WSServerMessage
      handlers.forEach(h => h(msg))
    } catch {
      // ignore invalid messages
    }
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return
  const delays = [1000, 2000, 4000, 8000, 16000] // max 5 attempts with exponential backoff
  const delay = delays[Math.min(reconnectAttempts, delays.length - 1)]
  reconnectAttempts++
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    doConnect()
  }, delay)
}

export function disconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  handlers.clear()
  connectHandlers.clear()
  disconnectHandlers.clear()
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
