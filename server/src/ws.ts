import { WebSocketServer, WebSocket } from 'ws'
import { IncomingMessage } from 'http'
import { z } from 'zod'
import { nodes, channels, clusterChannelId, updatePeakConcurrent } from './store.js'
import { broadcast } from './activity.js'
import { authMiddleware } from './http.js'
import type { NodeSession } from './types.js'

const MAX_MESSAGE_SIZE = 64 * 1024
// After this many oversize messages, drop the socket — the client is buggy or
// abusing the connection. The ERROR-only loop used to let an attacker hold a
// slot forever at zero cost.
const MAX_OVERSIZE_VIOLATIONS = 3

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

function forwardToSession(targetSessionId: string, msg: object, fromSessionId?: string) {
  const target = nodes.get(targetSessionId)
  if (!target?.socket) return
  // Block enforcement: if the target has blocked the sender, drop the message
  // silently. (Server-side guard — the client may also drop, but malicious /
  // older clients would otherwise bypass the block UI entirely.)
  if (fromSessionId && target.blockedIds.has(fromSessionId)) return
  send(target.socket, msg)
}

function getWSIP(req: IncomingMessage): string {
  const xff = req.headers['x-forwarded-for']
  if (typeof xff === 'string') return xff.split(',')[0].trim()
  return req.socket.remoteAddress ?? 'unknown'
}

export function setupWS(wss: WebSocketServer) {
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    let session: NodeSession | null = null
    let oversizeViolations = 0

    ws.on('message', (raw) => {
      const rawStr = raw.toString()
      if (Buffer.byteLength(rawStr) > MAX_MESSAGE_SIZE) {
        oversizeViolations++
        send(ws, { t: 'ERROR', code: 'MESSAGE_TOO_LARGE', message: '消息过大' })
        if (oversizeViolations >= MAX_OVERSIZE_VIOLATIONS) {
          ws.close(1009, 'TOO_MANY_OVERSIZE')
        }
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
        // Don't introduce blocked peers to each other in either direction.
        if (peer.blockedIds.has(session.sessionId) || session.blockedIds.has(peer.sessionId)) continue
        forwardToSession(peerSid, {
          t: 'PEER_JOINED',
          peer: { sessionId: session.sessionId, nodeId: session.nodeId, joinedAt: session.joinedAt },
          shouldInitiate: false,
        }, session.sessionId)
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
      // Drop if either side has blocked the other. We also check the sender's
      // own blocklist so a stale UI doesn't keep talking to someone the user
      // explicitly blocked.
      if (session.blockedIds.has(msg.targetSessionId)) return
      forwardToSession(msg.targetSessionId, {
        t: 'SIGNAL_SDP',
        fromSessionId: session.sessionId,
        fromNodeId: session.nodeId,
        sdp: msg.sdp,
      }, session.sessionId)
      break

    case 'SIGNAL_ICE':
      if (!assertSameChannel(session, msg.targetSessionId)) return
      if (session.blockedIds.has(msg.targetSessionId)) return
      forwardToSession(msg.targetSessionId, {
        t: 'SIGNAL_ICE',
        fromSessionId: session.sessionId,
        fromNodeId: session.nodeId,
        candidate: msg.candidate,
      }, session.sessionId)
      break

    case 'SIGNAL_ICE_END':
      if (!assertSameChannel(session, msg.targetSessionId)) return
      if (session.blockedIds.has(msg.targetSessionId)) return
      forwardToSession(msg.targetSessionId, {
        t: 'SIGNAL_ICE_END',
        fromSessionId: session.sessionId,
        fromNodeId: session.nodeId,
      }, session.sessionId)
      break

    case 'BLOCK': {
      session.blockedIds.add(msg.sessionId)
      // Also tell the blocked peer to drop us — otherwise their UI keeps a
      // stale entry pointing at us. We send a synthetic PEER_LEFT (this
      // message type already exists on the client cleanup path).
      forwardToSession(msg.sessionId, {
        t: 'PEER_LEFT',
        sessionId: session.sessionId,
        nodeId: session.nodeId,
      })
      break
    }
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
