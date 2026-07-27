import { WebSocketServer, WebSocket } from 'ws'
import { nanoid } from 'nanoid'
import { authenticatedSockets } from './store.js'
import { sendWithBackpressure } from './ws.js'
import { ACTIVITY_MAX_PER_SEC } from './config.js'
import type { ActivityEvent } from './types.js'

let wss: WebSocketServer | null = null

export function setWSS(server: WebSocketServer) {
  wss = server
}

// Broadcast budget (SECURITY-014). Every event fans out to every
// authenticated socket, so a join/leave/report storm multiplies straight into
// serialize-and-send work. Events above the per-second budget are dropped —
// activity is a decorative live feed, not a protocol guarantee.
let windowStartedAt = 0
let windowCount = 0
let droppedSinceLastLog = 0

function withinBudget(now: number): boolean {
  if (now - windowStartedAt >= 1000) {
    if (droppedSinceLastLog > 0) {
      console.warn(`[activity] 丢弃 ${droppedSinceLastLog} 条广播（超过 ${ACTIVITY_MAX_PER_SEC}/秒 预算）`)
      droppedSinceLastLog = 0
    }
    windowStartedAt = now
    windowCount = 0
  }
  if (windowCount >= ACTIVITY_MAX_PER_SEC) {
    droppedSinceLastLog++
    return false
  }
  windowCount++
  return true
}

/**
 * Push an ACTIVITY event to every CURRENTLY AUTHENTICATED client. Anonymous
 * sockets (post-connect, pre-AUTH) deliberately don't receive activity
 * frames — they have no business knowing about the active membership, and
 * a quick reconnect-loop probe could otherwise sample the network without
 * ever proving an identity.
 *
 * SECURITY-014: membership used to be answered by re-scanning every session
 * for every connected client, making one broadcast O(clients × sessions) —
 * tens of millions of comparisons at a few thousand nodes, all on the event
 * loop. `authenticatedSockets()` is the O(1)-per-socket index maintained by
 * the WS AUTH/close paths, so a broadcast is now O(n) and iterates only the
 * sockets that are actually eligible.
 */
export function broadcast(event: Omit<ActivityEvent, 'id' | 'timestamp'>) {
  if (!wss) return
  const now = Date.now()
  if (!withinBudget(now)) return

  const msg: ActivityEvent = {
    ...event,
    id: nanoid(8),
    timestamp: now,
  }
  const payload = JSON.stringify({ t: 'ACTIVITY', event: msg })
  for (const client of authenticatedSockets()) {
    if (client.readyState !== WebSocket.OPEN) continue
    // Slow readers must not accumulate the whole feed (SECURITY-003).
    sendWithBackpressure(client, payload)
  }
}
