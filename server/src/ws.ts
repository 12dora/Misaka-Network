import { WebSocketServer, WebSocket } from 'ws'
import { IncomingMessage } from 'http'
import { nodes, channels } from './store.js'
import { broadcast } from './activity.js'
import { authMiddleware } from './http.js'
import type { WSClientMessage, NodeSession } from './types.js'

function send(ws: WebSocket, msg: object) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg))
  }
}

function forwardToNode(targetNodeId: number, msg: object) {
  const target = nodes.get(targetNodeId)
  if (target?.socket) send(target.socket, msg)
}

export function setupWS(wss: WebSocketServer) {
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? '', 'http://localhost')
    const token = url.searchParams.get('token')
    if (!token) { ws.close(4001, 'MISSING_TOKEN'); return }

    const session = authMiddleware(token)
    if (!session) { ws.close(4002, 'INVALID_TOKEN'); return }

    // Attach socket
    session.socket = ws
    session.lastSeen = Date.now()

    send(ws, {
      t: 'WELCOME',
      myNodeId: session.nodeId,
      sessionExpiresAt: Date.now() + 30 * 60 * 1000,
    })

    ws.on('message', (raw) => {
      let msg: WSClientMessage
      try { msg = JSON.parse(raw.toString()) as WSClientMessage }
      catch { return }

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

function handleMessage(ws: WebSocket, session: NodeSession, msg: WSClientMessage) {
  switch (msg.t) {
    case 'PING':
      send(ws, { t: 'PONG' })
      break

    case 'JOIN_CHANNEL': {
      // Leave existing channel
      if (session.channelId) leaveChannel(session)

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
