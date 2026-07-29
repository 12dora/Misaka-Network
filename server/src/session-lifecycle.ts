// ── Single terminal session API (Contract 5) ─────────────────────────
//
// Exactly one path tears a session down. Every exit route — WS close,
// POST /api/release, POST /api/release-by-ip, the cleanup task, and
// /api/re-register supersede — MUST go through terminateSession so peers
// always receive PEER_LEFT, channels stay consistent, and the token is
// genuinely unusable afterwards.
//
// Fixed order (idempotent at every step):
//   1. Broadcast PEER_LEFT to channel peers
//   2. Remove from channel
//   3. unmarkSocket + close socket
//   4. nodes.delete(sessionId)

import type { WebSocket } from 'ws'
import { nodes, channels, unmarkSocket, unindexReRegisterProof } from './store.js'
import { broadcast } from './activity.js'
import type { NodeSession } from './types.js'

function peerSend(ws: WebSocket, payload: string): void {
  if (ws.readyState !== 1 /* OPEN */) return
  try { ws.send(payload) } catch { /* peer gone */ }
}

export interface TerminateOpts {
  /** WS close code. Default 1000. Use 4002 for expiry. */
  closeCode?: number
  /** WS close reason string. */
  closeReason?: string
  /**
   * When false, skip the global activity "leave" broadcast (e.g. a
   * re-register supersede that immediately re-joins the same nodeId).
   * Channel PEER_LEFT is still sent so peers drop the dead sessionId.
   * Default true.
   */
  broadcastLeave?: boolean
  /**
   * When set, only act if session.socket still points at this socket.
   * Used by the WS 'close' handler so a superseded socket does not tear
   * down a live reconnect.
   */
  onlyIfSocket?: WebSocket | null
  /**
   * When true, leave the session in `nodes` so the client can reconnect with
   * the same token (clean WS disconnect). Channel leave + PEER_LEFT still
   * run; only map eviction is skipped. Default false (full teardown).
   */
  preserveSession?: boolean
  /**
   * When false, do not call socket.close() — the socket is already closing
   * (WS 'close' handler). Default true.
   */
  closeSocket?: boolean
}

/**
 * Single terminal / departure API (Contract 5). Every exit route — WS close,
 * HTTP release, cleanup, re-register supersede — must call this so channel
 * leave, PEER_LEFT, socket index and (when applicable) map eviction never
 * drift. Safe to call more than once.
 */
export function terminateSession(session: NodeSession, opts: TerminateOpts = {}): void {
  if (opts.onlyIfSocket !== undefined && session.socket !== opts.onlyIfSocket) {
    // Superseded path: still drop the dead socket from the auth index.
    if (opts.onlyIfSocket) unmarkSocket(opts.onlyIfSocket)
    return
  }

  const sessionId = session.sessionId
  // Already gone?
  if (!nodes.has(sessionId) && session.socket === null && session.channelId === null) {
    return
  }

  // 1 + 2. Channel leave + PEER_LEFT before we drop the socket, so peers
  // that are still reading get the notification while the map is consistent.
  if (session.channelId) {
    const ch = channels.get(session.channelId)
    if (ch) {
      for (const peerSid of ch) {
        if (peerSid === sessionId) continue
        const peer = nodes.get(peerSid)
        if (peer?.socket) {
          peerSend(
            peer.socket,
            JSON.stringify({ t: 'PEER_LEFT', sessionId, nodeId: session.nodeId }),
          )
        }
      }
      ch.delete(sessionId)
      if (ch.size === 0) channels.delete(session.channelId)
    }
    session.channelId = null
  }

  // 3. Socket index + optional close.
  const sock = session.socket
  if (sock) {
    unmarkSocket(sock)
    session.socket = null
    if (opts.closeSocket !== false) {
      const code = opts.closeCode ?? 1000
      const reason = opts.closeReason ?? ''
      try {
        if (sock.readyState === 0 /* CONNECTING */ || sock.readyState === 1 /* OPEN */) {
          sock.close(code, reason)
        }
      } catch { /* already gone */ }
    }
  }

  // 4. Evict from the session map (full teardown). Clean WS disconnect uses
  // preserveSession so the token remains usable for reconnect.
  if (!opts.preserveSession) {
    unindexReRegisterProof(session.reRegisterProof, session.nodeId)
    nodes.delete(sessionId)
  }
  session.lastSeen = Date.now()

  if (opts.broadcastLeave !== false) {
    broadcast({
      type: 'leave',
      nodeId: session.nodeId,
      message: `御坂 ${session.nodeId} 号通信终止`,
    })
  }
}
