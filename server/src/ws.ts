import { WebSocketServer, WebSocket } from 'ws'
import { IncomingMessage } from 'http'
import { z } from 'zod'
import {
  nodes, channels, clusterChannelId, updatePeakConcurrent,
  markSocketAuthenticated, unmarkSocket, isSessionExpired,
} from './store.js'
import { broadcast } from './activity.js'
import { authMiddleware } from './http.js'
import {
  WS_AUTH_GRACE_MS, TRUST_PROXY_ENABLED,
  WS_MAX_MESSAGE_BYTES, WS_MAX_OVERSIZE_STRIKES,
  WS_MSG_BURST, WS_MSG_RATE_PER_SEC, WS_MAX_RATE_VIOLATIONS,
  WS_MAX_BUFFERED_BYTES, WS_MAX_BUFFERED_HARD_BYTES, WS_SLOW_CONSUMER_GRACE_MS,
} from './config.js'
import type { NodeSession } from './types.js'

// Upper bound on how many peers a single session may block. Without a cap a
// hostile authenticated client can stream unbounded BLOCK frames each carrying
// a fresh 64-char id and grow this Set until the process OOMs. A few thousand
// is far above any legitimate use.
const MAX_BLOCKED_IDS = 2000

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

/**
 * Outbound backpressure (SECURITY-003).
 *
 * `ws.send()` never blocks: anything the peer isn't reading piles up in the
 * socket's send queue, and `bufferedAmount` is the only signal that it is
 * happening. A peer that stops draining (mobile going through a tunnel, a
 * deliberately-paused attacker socket) therefore used to make the server
 * accumulate every forwarded SDP/ICE frame and every activity broadcast for
 * it, without limit.
 *
 * Three marks:
 *   - soft (WS_MAX_BUFFERED_BYTES): stop enqueueing for this socket, drop the
 *     frame. Signaling frames are re-sent by the peers' own retry paths and a
 *     stale ICE candidate is worthless anyway.
 *   - stuck (WS_SLOW_CONSUMER_GRACE_MS above the soft mark): the peer is not
 *     recovering. Dropping frames is what keeps the queue from growing, so
 *     without this clock a permanently-stuck socket would never trip the hard
 *     mark and would hold its slot forever.
 *   - hard (WS_MAX_BUFFERED_HARD_BYTES): one burst already blew past the soft
 *     mark by a wide margin — don't wait out the grace period.
 *
 * A shed socket gets a courtesy 1008 close frame, then is terminated: a peer
 * that isn't reading will never answer the closing handshake, and `ws` would
 * otherwise hold the connection for its full 30 s close timeout.
 *
 * Returns whether the frame was actually enqueued.
 */
const slowConsumerSince = new WeakMap<WebSocket, number>()

function shedSlowConsumer(ws: WebSocket) {
  slowConsumerSince.delete(ws)
  try { ws.close(1008, 'SLOW_CONSUMER') } catch { /* already gone */ }
  const t = setTimeout(() => {
    try { ws.terminate() } catch { /* already gone */ }
  }, 1000)
  t.unref?.()
}

export function sendWithBackpressure(ws: WebSocket, payload: string): boolean {
  if (ws.readyState !== WebSocket.OPEN) return false
  const buffered = ws.bufferedAmount
  if (buffered >= WS_MAX_BUFFERED_BYTES) {
    const now = Date.now()
    const since = slowConsumerSince.get(ws)
    if (since === undefined) {
      slowConsumerSince.set(ws, now)
    } else if (buffered >= WS_MAX_BUFFERED_HARD_BYTES || now - since >= WS_SLOW_CONSUMER_GRACE_MS) {
      shedSlowConsumer(ws)
    }
    return false
  }
  slowConsumerSince.delete(ws)
  ws.send(payload)
  return true
}

function send(ws: WebSocket, msg: object): boolean {
  return sendWithBackpressure(ws, JSON.stringify(msg))
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

// Express' compiled `trust proxy fn`, installed from index.ts right after
// `app.set('trust proxy', …)`. Keeping the *same* predicate object on both
// sides is the point: HTTP and the WS upgrade must never disagree about which
// hop is trusted (SECURITY-005).
type TrustFn = (addr: string, hopIndex: number) => boolean
let trustProxyFn: TrustFn | null = null

export function setTrustProxyFn(fn: TrustFn) {
  trustProxyFn = fn
}

/**
 * Canonical client-IP extractor for WS upgrades — now with the same
 * proxy-addr semantics Express applies to `req.ip`.
 *
 * The old implementation took the LEFT-MOST X-Forwarded-For entry whenever
 * TRUST_PROXY was on. That is the attacker-controlled end of the chain: a
 * proxy *appends* the peer it saw, so with `XFF: <forged>, <real>` the server
 * picked `<forged>` and stamped it onto the session — poisoning the per-IP
 * node cap, the brute-force lock, rate limits and TURN byte attribution, and
 * disagreeing with `req.ip` for the very same client.
 *
 * The correct walk starts at the socket address and steps left through the
 * header only while each hop is trusted, i.e. from the trusted side inward.
 * This mirrors proxy-addr's algorithm (address list = [socket, ...XFF
 * right-to-left]) using Express' own compiled trust predicate, so hop counts,
 * CIDRs and presets like `loopback` behave identically on both transports.
 */
export function getWSIP(req: IncomingMessage): string {
  const socketAddr = req.socket.remoteAddress ?? 'unknown'
  if (!TRUST_PROXY_ENABLED || !trustProxyFn) return socketAddr

  const raw = req.headers['x-forwarded-for']
  const header = Array.isArray(raw) ? raw.join(',') : (raw ?? '')
  const forwarded = header.split(',').map(s => s.trim()).filter(s => s.length > 0).reverse()

  const chain = [socketAddr, ...forwarded]
  let addr = chain[0]
  for (let i = 0; i < chain.length - 1; i++) {
    if (!trustProxyFn(addr, i)) break
    addr = chain[i + 1]
  }
  return addr
}

/**
 * Per-socket inbound token bucket (SECURITY-003).
 *
 * Even with a payload ceiling, a registered node could stream well-formed
 * SDP/ICE frames as fast as the kernel would deliver them: every one costs a
 * JSON.parse, a zod discriminated-union parse and a map lookup, and every
 * forwarded one costs a serialize plus an enqueue on someone else's socket.
 * There was no budget of any kind. Over-budget frames are dropped (dropping a
 * signaling frame is safe — the peers retry), and a socket that keeps
 * overrunning is closed.
 */
class RateBucket {
  private tokens = WS_MSG_BURST
  private last = Date.now()
  violations = 0

  take(now = Date.now()): boolean {
    const elapsedSec = (now - this.last) / 1000
    if (elapsedSec > 0) {
      this.tokens = Math.min(WS_MSG_BURST, this.tokens + elapsedSec * WS_MSG_RATE_PER_SEC)
      this.last = now
    }
    if (this.tokens < 1) {
      this.violations++
      return false
    }
    this.tokens -= 1
    return true
  }
}

export function setupWS(wss: WebSocketServer) {
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    let session: NodeSession | null = null
    let oversizeViolations = 0
    const bucket = new RateBucket()
    // Only one ERROR reply per second while a socket is over budget — the
    // reply itself must not become the amplification.
    let lastRateNoticeAt = 0

    // AUTH grace timer: a freshly-opened WS has WS_AUTH_GRACE_MS to send a
    // valid AUTH frame. If it doesn't, we close 4001 AUTH_TIMEOUT. This
    // prevents an attacker from cheaply holding idle sockets forever.
    const authTimer = setTimeout(() => {
      if (session) return  // raced an AUTH right before the timer fired; no-op
      try { ws.close(4001, 'AUTH_TIMEOUT') } catch { /* already gone */ }
    }, WS_AUTH_GRACE_MS)
    authTimer.unref?.()

    ws.on('message', (raw) => {
      const now = Date.now()

      // Inbound budget first: it must gate the JSON/zod work, not follow it.
      if (!bucket.take(now)) {
        if (bucket.violations >= WS_MAX_RATE_VIOLATIONS) {
          try { ws.close(1008, 'RATE_LIMITED') } catch { /* already gone */ }
          return
        }
        if (now - lastRateNoticeAt >= 1000) {
          lastRateNoticeAt = now
          send(ws, { t: 'ERROR', code: 'RATE_LIMITED', message: '消息发送过于频繁' })
        }
        return
      }

      // Defence-in-depth size check. The transport `maxPayload` (SECURITY-002,
      // set in index.ts) already aborts anything larger before it is buffered,
      // so this only fires when an operator raised WS_MAX_PAYLOAD_BYTES above
      // the application policy limit.
      const rawStr = raw.toString()
      if (Buffer.byteLength(rawStr) > WS_MAX_MESSAGE_BYTES) {
        oversizeViolations++
        send(ws, { t: 'ERROR', code: 'MESSAGE_TOO_LARGE', message: '消息过大' })
        if (oversizeViolations >= WS_MAX_OVERSIZE_STRIKES) {
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
        // Reconnect (mobile network handoff, sleep/wake) re-sends AUTH with the
        // same cached token, so `s` is the SAME shared NodeSession and its old
        // socket is still half-open. Close it BEFORE re-pointing, otherwise the
        // old socket lingers until an OS TCP timeout and its late 'close' event
        // would tear down this now-live session (see the guard in ws.on('close')).
        if (s.socket && s.socket !== ws) {
          unmarkSocket(s.socket)
          try { s.socket.close(1000, 'SUPERSEDED') } catch { /* already gone */ }
        }
        s.socket = ws
        s.lastSeen = now
        s.ip = getWSIP(req)
        session = s
        markSocketAuthenticated(ws, s.sessionId)

        send(ws, {
          t: 'WELCOME',
          sessionId: session.sessionId,
          myNodeId: session.nodeId,
          // SECURITY-001: the real stored deadline, not a fresh 30 minutes
          // computed at connect time (which silently renewed on every
          // reconnect and never matched what the server enforced).
          sessionExpiresAt: session.expiresAt,
        })
        updatePeakConcurrent()
        return
      }

      // The session may have expired while this socket was connected. Close
      // with 4002 so the client's existing onAuthInvalid path clears the
      // cached session and re-registers.
      if (isSessionExpired(session, now)) {
        try { ws.close(4002, 'SESSION_EXPIRED') } catch { /* already gone */ }
        return
      }

      session.lastSeen = now
      handleMessage(ws, session, msg)
    })

    ws.on('close', () => {
      clearTimeout(authTimer)
      // Always drop the index entry, even on a superseded socket — the guard
      // below returns early for those and would otherwise leak them.
      unmarkSocket(ws)
      if (!session) return
      // A superseded socket (a reconnect already re-attached a newer ws to this
      // shared session) must NOT tear the session down. Without this guard the
      // stale socket's late close nulls session.socket — which now points at the
      // live reconnected ws — deletes it from its channel, and broadcasts
      // PEER_LEFT, rendering a fully-connected peer invisible/unreachable.
      if (session.socket !== ws) return
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
      // Bound the set so a flood of BLOCK frames with distinct ids can't grow
      // it without limit (there is no per-message WS rate limit). Re-blocking an
      // id already present is always allowed.
      if (session.blockedIds.size >= MAX_BLOCKED_IDS && !session.blockedIds.has(msg.sessionId)) {
        return
      }
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
