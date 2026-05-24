import { WebSocketServer, WebSocket } from 'ws'
import { IncomingMessage } from 'http'
import { z } from 'zod'
import { nodes, channels, clusterChannelId, updatePeakConcurrent } from './store.js'
import { broadcast } from './activity.js'
import { authMiddleware } from './http.js'
import { WS_AUTH_GRACE_MS } from './config.js'
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

/**
 * Forward `msg` to the target's WS. If the target is offline (no session in
 * the map, or its socket is null/dead), we call `onMissing(targetSessionId)`
 * so the caller can report PEER_OFFLINE back to the sender. We don't send
 * anything to the sender from here directly because some forwards are
 * fire-and-forget broadcasts.
 */
function forwardToSession(
  targetSessionId: string,
  msg: object,
  fromSessionId?: string,
  onMissing?: (targetSessionId: string) => void,
) {
  const target = nodes.get(targetSessionId)
  if (!target?.socket || target.socket.readyState !== WebSocket.OPEN) {
    if (onMissing) onMissing(targetSessionId)
    return
  }
  // Block enforcement: if the target has blocked the sender, drop the message
  // silently. (Server-side guard — the client may also drop, but malicious /
  // older clients would otherwise bypass the block UI entirely.)
  if (fromSessionId && target.blockedIds.has(fromSessionId)) return
  send(target.socket, msg)
}

// Canonical client-IP extractor for WS — mirrors http.getClientIP semantics
// but operates on the upgrade request. We trust the first x-forwarded-for
// hop (matching `app.set('trust proxy', 1)` on the HTTP side); without a
// proxy we use the raw socket address. Exported so tests can probe it.
export function getWSIP(req: IncomingMessage): string {
  const xff = req.headers['x-forwarded-for']
  if (typeof xff === 'string') return xff.split(',')[0].trim()
  if (Array.isArray(xff) && xff.length > 0) return xff[0].split(',')[0].trim()
  return req.socket.remoteAddress ?? 'unknown'
}

export function setupWS(wss: WebSocketServer) {
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    let session: NodeSession | null = null
    let oversizeViolations = 0

    // AUTH grace timer: a freshly-opened WS has WS_AUTH_GRACE_MS to send a
    // valid AUTH frame. If it doesn't, we close 4001 AUTH_TIMEOUT. This
    // prevents an attacker from cheaply holding idle sockets forever.
    const authTimer = setTimeout(() => {
      if (session) return  // raced an AUTH right before the timer fired; no-op
      try { ws.close(4001, 'AUTH_TIMEOUT') } catch { /* already gone */ }
    }, WS_AUTH_GRACE_MS)
    authTimer.unref?.()

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
          clearTimeout(authTimer)
          ws.close(4001, 'AUTH_REQUIRED')
          return
        }
        const s = authMiddleware(msg.token)
        if (!s) {
          clearTimeout(authTimer)
          ws.close(4002, 'INVALID_TOKEN')
          return
        }
        clearTimeout(authTimer)
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
      clearTimeout(authTimer)
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
  // Helper that reports back to the SENDER when the target peer was offline.
  // The client uses this to drop stale entries from its peer list instead
  // of sitting on a half-open transfer forever waiting for SDP.
  const replyPeerOffline = (targetSessionId: string) => {
    send(ws, { t: 'PEER_OFFLINE', targetSessionId })
  }

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

      for (const peerSid of ch) {
        const peer = nodes.get(peerSid)
        if (!peer) continue
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

    case 'SIGNAL_SDP': {
      // Order matters: a target that is offline (no session, no socket)
      // must surface PEER_OFFLINE so the sender can drop the stale peer
      // from its UI. If we ran assertSameChannel first, an offline target
      // would degrade to ERROR NOT_IN_CHANNEL (because their channelId is
      // null on disconnect), which the client treats as a stay-and-retry
      // signal — exactly the half-open hang we're trying to fix.
      if (!isTargetReachable(msg.targetSessionId)) {
        replyPeerOffline(msg.targetSessionId)
        return
      }
      if (!assertSameChannel(session, msg.targetSessionId)) {
        send(ws, { t: 'ERROR', code: 'NOT_IN_CHANNEL', message: '不在同一实验批次' })
        return
      }
      if (session.blockedIds.has(msg.targetSessionId)) return
      forwardToSession(msg.targetSessionId, {
        t: 'SIGNAL_SDP',
        fromSessionId: session.sessionId,
        fromNodeId: session.nodeId,
        sdp: msg.sdp,
      }, session.sessionId, replyPeerOffline)
      break
    }

    case 'SIGNAL_ICE': {
      if (!isTargetReachable(msg.targetSessionId)) {
        replyPeerOffline(msg.targetSessionId)
        return
      }
      if (!assertSameChannel(session, msg.targetSessionId)) return
      if (session.blockedIds.has(msg.targetSessionId)) return
      forwardToSession(msg.targetSessionId, {
        t: 'SIGNAL_ICE',
        fromSessionId: session.sessionId,
        fromNodeId: session.nodeId,
        candidate: msg.candidate,
      }, session.sessionId, replyPeerOffline)
      break
    }

    case 'SIGNAL_ICE_END': {
      if (!isTargetReachable(msg.targetSessionId)) {
        replyPeerOffline(msg.targetSessionId)
        return
      }
      if (!assertSameChannel(session, msg.targetSessionId)) return
      if (session.blockedIds.has(msg.targetSessionId)) return
      forwardToSession(msg.targetSessionId, {
        t: 'SIGNAL_ICE_END',
        fromSessionId: session.sessionId,
        fromNodeId: session.nodeId,
      }, session.sessionId, replyPeerOffline)
      break
    }

    case 'BLOCK': {
      session.blockedIds.add(msg.sessionId)
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

// "Reachable" = the target session is still in the map AND has an open WS.
// If either condition is missing the peer is effectively offline and the
// sender should be told so they can clean up their UI state.
function isTargetReachable(targetSessionId: string): boolean {
  const target = nodes.get(targetSessionId)
  if (!target) return false
  if (!target.socket) return false
  return target.socket.readyState === WebSocket.OPEN
}
