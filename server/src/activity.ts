import { WebSocketServer } from 'ws'
import { nanoid } from 'nanoid'
import type { ActivityEvent } from './types.js'

let wss: WebSocketServer | null = null

export function setWSS(server: WebSocketServer) {
  wss = server
}

export function broadcast(event: Omit<ActivityEvent, 'id' | 'timestamp'>) {
  if (!wss) return
  const msg: ActivityEvent = {
    ...event,
    id: nanoid(8),
    timestamp: Date.now(),
  }
  const payload = JSON.stringify({ t: 'ACTIVITY', event: msg })
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(payload)
    }
  }
}
