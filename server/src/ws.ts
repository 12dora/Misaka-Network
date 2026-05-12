import { WebSocketServer, WebSocket } from 'ws'
import { IncomingMessage } from 'http'
import { z } from 'zod'
import { nodes, channels } from './store.js'
import { broadcast } from './activity.js'
import { authMiddleware } from './http.js'
import type { NodeSession } from './types.js'

const MAX_CHANNELS_PER_NODE = 3
const MAX_MESSAGE_SIZE = 64 * 1024

const wsMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('JOIN_CHANNEL'),  channelId:    z.string().min(1).max(64) }),
  z.object({ t: z.literal('LEAVE_CHANNEL') }),
  z.object({ t: z.literal('CONNECT_REQ'),  targetNodeId: z.number().int().min(1).max(20001) }),
  z.object({ t: z.literal('SIGNAL_SDP'),   targetNodeId: z.number().int().min(1).max(20001), sdp: z.object({}).passthrough() }),
  z.object({ t: z.literal('SIGNAL_ICE'),   targetNodeId: z.number().int().min(1).max(20001), candidate: z.object({}).passthrough() }),
  z.object({ t: z.literal('PING') }),
  z.object({ t: z.literal('BLOCK'),         nodeId:       z.number().int().min(1).max(20001) }),
])

function send(ws: WebSocket, msg: object) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg))
  }
}

function forwardToNode(targetNodeId: number, msg: object) {
  const target = nodes.get(targetNodeId)
  if (target?.socket) send(target.socket, msg)
}

function getWSIP(req: IncomingMessage): string {
  const xff = req.headers['x-forwarded-for']
  if (typeof xff === 'string') return xff.split(',')[0].trim()
  return req.socket.remoteAddress ?? 'unknown'
}

function countChannelsForNode(nodeId: number): number {
  let count = 0
  for (const ch of channels.values()) {
    if (ch.has(nodeId)) count++
  }
  return count
}

export function setupWS(wss: WebSocketServer) {
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    // Check message size before parsing
    const url = new URL(req.url ?? '', 'http://localhost')
    const token = url.searchParams.get('token')
    if (!token) { ws.close(4001, 'MISSING_TOKEN'); return }

    const session = authMiddleware(token)
    if (!session) { ws.close(4002, 'INVALID_TOKEN'); return }

    // Attach socket and update IP
    session.socket = ws
    session.lastSeen = Date.now()
    session.ip = getWSIP(req)

    send(ws, {
      t: 'WELCOME',
      myNodeId: session.nodeId,
      sessionExpiresAt: Date.now() + 30 * 60 * 1000,
    })

    ws.on('message', (raw) => {
      // Enforce max message size
      const rawStr = raw.toString()
      if (Buffer.byteLength(rawStr) > MAX_MESSAGE_SIZE) {
        send(ws, { t: 'ERROR', code: 'MESSAGE_TOO_LARGE', message: '消息过大' })
        return
      }

      // Validate with zod
      let msg: z.infer<typeof wsMessageSchema>
      try {
        const parsed = JSON.parse(rawStr)
        msg = wsMessageSchema.parse(parsed)
      } catch {
        // Silently drop invalid messages
        return
      }

      session.lastSeen = Date.now()
      handleMessage(ws, session, msg)
    })

    ws.on('close', () => {
      session.socket = null
      session.lastSeen = Date.now()

      // Notify channel peers
      if (session.channelId) {
        const ch = channels.get(session.channelId)
        if (ch) {
          for (const peerId of ch) {
            if (peerId !== session.nodeId) {
              forwardToNode(peerId, { t: 'PEER_LEFT', nodeId: session.nodeId })
            }
          }
        }
      }

      broadcast({ type: 'leave', nodeId: session.nodeId, message: `御坂 ${session.nodeId} 号通信终止` })
    })

    ws.on('error', () => { /* swallow */ })
  })
}

function handleMessage(ws: WebSocket, session: NodeSession, msg: z.infer<typeof wsMessageSchema>) {
  switch (msg.t) {
    case 'PING':
      send(ws, { t: 'PONG' })
      break

    case 'JOIN_CHANNEL': {
      // Leave existing channel
      if (session.channelId) leaveChannel(session)

      // Enforce max channels per node
      if (countChannelsForNode(session.nodeId) >= MAX_CHANNELS_PER_NODE) {
        send(ws, { t: 'ERROR', code: 'TOO_MANY_CHANNELS', message: '频道数已达上限' })
        return
      }

      const ch = channels.get(msg.channelId) ?? new Set<number>()
      channels.set(msg.channelId, ch)

      // Notify existing members
      for (const peerId of ch) {
        forwardToNode(peerId, { t: 'PEER_JOINED', node: { nodeId: session.nodeId, joinedAt: session.joinedAt } })
        const peer = nodes.get(peerId)
        if (peer) {
          send(ws, { t: 'PEER_JOINED', node: { nodeId: peerId, joinedAt: peer.joinedAt } })
        }
      }

      ch.add(session.nodeId)
      session.channelId = msg.channelId
      broadcast({ type: 'channel', message: `新实验批次 ${msg.channelId} 建立` })
      break
    }

    case 'LEAVE_CHANNEL':
      leaveChannel(session)
      break

    case 'CONNECT_REQ': {
      const target = nodes.get(msg.targetNodeId)
      if (!target?.socket) {
        send(ws, { t: 'ERROR', code: 'NODE_OFFLINE', message: '目标节点不在线' })
        return
      }
      if (session.blockedIds.has(msg.targetNodeId)) {
        send(ws, { t: 'ERROR', code: 'BLOCKED', message: '目标节点已被屏蔽' })
        return
      }
      forwardToNode(msg.targetNodeId, { t: 'CONNECT_REQ_IN', fromNodeId: session.nodeId, requestId: Date.now().toString() })
      break
    }

    case 'SIGNAL_SDP':
      if (!assertSameChannel(session, msg.targetNodeId)) {
        send(ws, { t: 'ERROR', code: 'NOT_IN_CHANNEL', message: '不在同一实验批次' })
        return
      }
      forwardToNode(msg.targetNodeId, { t: 'SIGNAL_SDP', fromNodeId: session.nodeId, sdp: msg.sdp })
      break

    case 'SIGNAL_ICE':
      if (!assertSameChannel(session, msg.targetNodeId)) return
      forwardToNode(msg.targetNodeId, { t: 'SIGNAL_ICE', fromNodeId: session.nodeId, candidate: msg.candidate })
      break

    case 'BLOCK':
      session.blockedIds.add(msg.nodeId)
      break
  }
}

function leaveChannel(session: NodeSession) {
  if (!session.channelId) return
  const ch = channels.get(session.channelId)
  if (ch) {
    ch.delete(session.nodeId)
    for (const peerId of ch) {
      forwardToNode(peerId, { t: 'PEER_LEFT', nodeId: session.nodeId })
    }
    if (ch.size === 0) channels.delete(session.channelId)
  }
  session.channelId = null
}

function assertSameChannel(session: NodeSession, targetNodeId: number): boolean {
  if (!session.channelId) return false
  const target = nodes.get(targetNodeId)
  return target?.channelId === session.channelId
}
