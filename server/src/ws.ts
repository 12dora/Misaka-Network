import { WebSocketServer, WebSocket } from 'ws'
import { IncomingMessage } from 'http'
import { z } from 'zod'
import { nodes, channels, clusterChannelId, updatePeakConcurrent } from './store.js'
import { broadcast } from './activity.js'
import { authMiddleware } from './http.js'
import type { NodeSession } from './types.js'

const MAX_MESSAGE_SIZE = 64 * 1024

const wsMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('AUTH'),         token:           z.string() }),
  z.object({ t: z.literal('JOIN_CLUSTER') }),
  z.object({ t: z.literal('LEAVE_CHANNEL') }),
  z.object({ t: z.literal('SIGNAL_SDP'),   targetSessionId: z.string().min(1).max(64), sdp:       z.object({}).passthrough() }),
  z.object({ t: z.literal('SIGNAL_ICE'),     targetSessionId: z.string().min(1).max(64), candidate: z.object({}).passthrough() }),
  z.object({ t: z.literal('SIGNAL_ICE_END'), targetSessionId: z.string().min(1).max(64) }),
  z.object({ t: z.literal('PING') }),
  z.object({ t: z.literal('BLOCK'),        sessionId:       z.string().min(1).max(64) }),
])

function send(ws: WebSocket, msg: object) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg))
  }
}

function forwardToSession(targetSessionId: string, msg: object) {
  const target = nodes.get(targetSessionId)
  if (target?.socket) send(target.socket, msg)
}

function getWSIP(req: IncomingMessage): string {
  const xff = req.headers['x-forwarded-for']
  if (typeof xff === 'string') return xff.split(',')[0].trim()
  return req.socket.remoteAddress ?? 'unknown'
}

export function setupWS(wss: WebSocketServer) {
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    let session: NodeSession | null = null

    ws.on('message', (raw) => {
      const rawStr = raw.toString()
      if (Buffer.byteLength(rawStr) > MAX_MESSAGE_SIZE) {
        send(ws, { t: 'ERROR', code: 'MESSAGE_TOO_LARGE', message: '消息过大' })
        return
      }

      let msg: z.infer<typeof wsMessageSchema>
      try {
        const parsed = JSON.parse(rawStr)
        msg = wsMessageSchema.parse(parsed)
      } catch {
        return
      }

      if (!session) {
        if (msg.t !== 'AUTH') {
          ws.close(4001, 'AUTH_REQUIRED')
          return
        }
        const s = authMiddleware(msg.token)
        if (!s) {
          ws.close(4002, 'INVALID_TOKEN')
          return
        }
        s.socket = ws
        s.lastSeen = Date.now()
        s.ip = getWSIP(req)
        session = s

        send(ws, {
          t: 'WELCOME',
          sessionId: session.sessionId,
          myNodeId: session.nodeId,
          sessionExpiresAt: Date.now() + 30 * 60 * 1000,
        })
        updatePeakConcurrent()
        return
      }

      session.lastSeen = Date.now()
      handleMessage(ws, session, msg)
    })

    ws.on('close', () => {
      if (!session) return
      session.socket = null
      session.lastSeen = Date.now()

      // Notify channel peers — by sessionId
      if (session.channelId) {
        const ch = channels.get(session.channelId)
        if (ch) {
          for (const peerSid of ch) {
            if (peerSid !== session.sessionId) {
              forwardToSession(peerSid, { t: 'PEER_LEFT', sessionId: session.sessionId, nodeId: session.nodeId })
            }
          }
          ch.delete(session.sessionId)
          if (ch.size === 0) channels.delete(session.channelId)
        }
        session.channelId = null
      }

      broadcast({ type: 'leave', nodeId: session.nodeId, message: `御坂 ${session.nodeId} 号通信终止` })
      updatePeakConcurrent()
    })

    ws.on('error', () => { /* swallow */ })
  })
}

function handleMessage(ws: WebSocket, session: NodeSession, msg: z.infer<typeof wsMessageSchema>) {
  switch (msg.t) {
    case 'PING':
      send(ws, { t: 'PONG' })
      break

    case 'JOIN_CLUSTER': {
      // Identity-scoped channel: same nodeId + passcode → same cluster.
      const channelId = clusterChannelId(session.nodeId, session.passCodeHash)
      if (session.channelId === channelId) return  // already there

      if (session.channelId) leaveChannel(session)

      const ch = channels.get(channelId) ?? new Set<string>()
      channels.set(channelId, ch)

      // Tell each existing peer about the newcomer (they wait for the offer).
      // Tell the newcomer about each existing peer with shouldInitiate=true
      // so the newcomer drives offer creation — no glare.
      for (const peerSid of ch) {
        const peer = nodes.get(peerSid)
        if (!peer) continue
        forwardToSession(peerSid, {
          t: 'PEER_JOINED',
          peer: { sessionId: session.sessionId, nodeId: session.nodeId, joinedAt: session.joinedAt },
          shouldInitiate: false,
        })
        send(ws, {
          t: 'PEER_JOINED',
          peer: { sessionId: peer.sessionId, nodeId: peer.nodeId, joinedAt: peer.joinedAt },
          shouldInitiate: true,
        })
      }

      ch.add(session.sessionId)
      session.channelId = channelId
      break
    }

    case 'LEAVE_CHANNEL':
      leaveChannel(session)
      break

    case 'SIGNAL_SDP':
      if (!assertSameChannel(session, msg.targetSessionId)) {
        send(ws, { t: 'ERROR', code: 'NOT_IN_CHANNEL', message: '不在同一实验批次' })
        return
      }
      forwardToSession(msg.targetSessionId, {
        t: 'SIGNAL_SDP',
        fromSessionId: session.sessionId,
        fromNodeId: session.nodeId,
        sdp: msg.sdp,
      })
      break

    case 'SIGNAL_ICE':
      if (!assertSameChannel(session, msg.targetSessionId)) return
      forwardToSession(msg.targetSessionId, {
        t: 'SIGNAL_ICE',
        fromSessionId: session.sessionId,
        fromNodeId: session.nodeId,
        candidate: msg.candidate,
      })
      break

    case 'SIGNAL_ICE_END':
      if (!assertSameChannel(session, msg.targetSessionId)) return
      forwardToSession(msg.targetSessionId, {
        t: 'SIGNAL_ICE_END',
        fromSessionId: session.sessionId,
        fromNodeId: session.nodeId,
      })
      break

    case 'BLOCK':
      session.blockedIds.add(msg.sessionId)
      break
  }
}

function leaveChannel(session: NodeSession) {
  if (!session.channelId) return
  const ch = channels.get(session.channelId)
  if (ch) {
    ch.delete(session.sessionId)
    for (const peerSid of ch) {
      forwardToSession(peerSid, { t: 'PEER_LEFT', sessionId: session.sessionId, nodeId: session.nodeId })
    }
    if (ch.size === 0) channels.delete(session.channelId)
  }
  session.channelId = null
}

function assertSameChannel(session: NodeSession, targetSessionId: string): boolean {
  if (!session.channelId) return false
  const target = nodes.get(targetSessionId)
  return target?.channelId === session.channelId
}
