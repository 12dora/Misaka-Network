import { WebSocketServer, WebSocket } from 'ws'
import { nanoid } from 'nanoid'
import { nodes } from './store.js'
import type { ActivityEvent } from './types.js'

let wss: WebSocketServer | null = null

export function setWSS(server: WebSocketServer) {
  wss = server
}

// Resolve the session a given WebSocket currently belongs to. We don't keep
// a reverse map because the auth path on the same socket already stores the
// socket onto the session — walking the (small) sessions map per broadcast
// is cheap and avoids two sources of truth getting out of sync.
function isAuthenticated(client: WebSocket): boolean {
  for (const s of nodes.values()) {
    if (s.socket === client) return true
  }
  return false
}

/**
 * Push an ACTIVITY event to every CURRENTLY AUTHENTICATED client. Anonymous
 * sockets (post-connect, pre-AUTH) deliberately don't receive activity
 * frames — they have no business knowing about the active membership, and
 * a quick reconnect-loop probe could otherwise sample the network without
 * ever proving an identity.
 */
export function broadcast(event: Omit<ActivityEvent, 'id' | 'timestamp'>) {
  if (!wss) return
  const msg: ActivityEvent = {
    ...event,
    id: nanoid(8),
    timestamp: Date.now(),
  }
  const payload = JSON.stringify({ t: 'ACTIVITY', event: msg })
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue
    if (!isAuthenticated(client)) continue
    client.send(payload)
  }
}
