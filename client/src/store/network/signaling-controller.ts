/**
 * signaling-controller.ts — init/destroy, WELCOME/roster/SIGNAL_* handlers.
 *
 * Owns the signaling module subscriptions and cluster roster side-effects.
 * Store access: store-access only (no useNetworkStore).
 */

import type { Peer, NodeStatus } from '@/types'
import {
  connect as wsConnect, disconnect as wsDisconnect, send as wsSend,
  onMessage, onConnect, onDisconnect, onSessionEnd,
} from '@/lib/signaling'
import { hasAESKey } from '@/lib/crypto'
import { resumeTerminalCleanupIntents } from '@/lib/transfer'
import { registerActiveWorkProbe } from '@/hooks/activeWork'
import { refreshAutoTurn, clearAutoTurn } from '@/lib/turn'
import { storeGet, storeSet } from './store-access'
import {
  initialized,
  currentToken,
  activeWorkProbeUnsub,
  unsubscribeSignaling,
  endNetworkEpoch,
  notifySignalingReady,
  setInitialized,
  setCurrentToken,
  setSignalingJoined,
  setActiveWorkProbeUnsub,
} from './session-scope'
import {
  peerConnections,
  dataChannels,
  remoteInitiatingPeers,
  connectingPeers,
  initiateWebRTC,
  cleanupPeerConnection,
} from './peer-runtime'
import {
  captureSignalReceipt,
  enqueuePeerTask,
  handleRemoteSDP,
  handleRemoteICE,
  handleRemoteICEEnd,
} from './negotiation-controller'
import { initialEncryptedSessionRebuilds } from './ice-recovery'
import {
  installForegroundRecovery,
  installTurnConfigPropagation,
  startNatAndTurnProbes,
  renegotiateOrphanPeers,
  clearConnectivityOnDestroy,
} from './connectivity-controller'
import { sendingFiles, hasLiveSendTaskAny } from './transfer-controller'
import { seenInboundChatIds } from './chat-controller'
import { retireDownloadArtifact } from './download-artifacts'

export function initNetwork(token: string) {
  // React 18 StrictMode double-mounts effects in dev, which would register
  // a second onMessage handler (every signal would be processed twice,
  // tripping `setLocalDescription: wrong state: stable` on the second
  // application) and spawn a second WebSocket. Guard with a module flag.
  if (initialized) {
    // Auth recovery (server restart → 4002 close → re-register) ends up
    // here with a fresh token. The flag is still set from the first init,
    // so we don't re-register handlers, but we MUST reconnect the WS with
    // the new token — otherwise signaling stays dead on the stale token.
    if (currentToken !== token) {
      // BUG-002: a different token is a different authenticated identity.
      // Everything the previous epoch built (peers, PC/DC, ECDH keys,
      // transfers, chat) belongs to that identity — end the epoch BEFORE
      // the new session can start routing through the same maps.
      endNetworkEpoch('token-changed')
      setCurrentToken(token)
      storeSet({ signalingStatus: 'connecting' })
      wsConnect(token)
    }
    return
  }
  setInitialized(true)
  setCurrentToken(token)
  // Re-arm terminal cleanup jobs that only lived in memory before a tab close.
  try { resumeTerminalCleanupIntents() } catch { /* ignore */ }
  // Reload-guard probe: real transfers / handshakes must block UpdateBanner.
  if (!activeWorkProbeUnsub) {
    setActiveWorkProbeUnsub(registerActiveWorkProbe(() => {
      if (sendingFiles.size > 0) return true
      if (hasLiveSendTaskAny()) return true
      if (storeGet().transfers.some(t =>
        t.status === 'transferring' || t.status === 'paused' || t.status === 'pending',
      )) return true
      if (connectingPeers.size > 0) return true
      return false
    }))
  }
  unsubscribeSignaling.push(onMessage((msg) => {
    switch (msg.t) {
      case 'WELCOME': {
        // BUG-002: the server may hand us a *different* sessionId on a
        // reconnect (our old session was GC'd / released). Peers, keys and
        // transfers keyed to the previous sessionId are dead — start a
        // fresh epoch instead of letting the two coexist. A repeated
        // WELCOME for the SAME session is just a transient WS drop and must
        // keep the live peer connections (that is what makes resume fast).
        const previousSessionId = storeGet().mySessionId
        if (previousSessionId !== null && previousSessionId !== msg.sessionId) {
          endNetworkEpoch('session-id-changed')
        }
        storeSet({ wsConnected: true, signalingStatus: 'online', mySessionId: msg.sessionId })
        // Auto-join the identity-scoped cluster channel.
        wsSend({ t: 'JOIN_CLUSTER' })
        // The socket is ordered, so anything sent after JOIN_CLUSTER is
        // processed by the server after the join: signaling is now "ready"
        // for SDP/ICE (BUG-004).
        setSignalingJoined(true)
        notifySignalingReady()
        // Re-negotiate orphans: peers we still know about that have no live
        // connection (their PC died while signaling was down).
        renegotiateOrphanPeers()
        break
      }

      case 'PEER_JOINED': {
        const { sessionId, nodeId, joinedAt } = msg.peer
        const existing = storeGet().peers.find(p => p.sessionId === sessionId)
        if (existing) {
          // Same sessionId rejoin (e.g. after PEER_LEFT while P2P DC stayed
          // open). If the encrypted channel is still healthy, restore online
          // and do NOT tear down the working PC/DC on the next recovery sweep.
          const dc = dataChannels.get(sessionId)
          const dcHealthy = dc?.readyState === 'open' && hasAESKey(sessionId)
          if (dcHealthy) {
            storeSet(s => ({
              peers: s.peers.map(p =>
                p.sessionId === sessionId
                  ? { ...p, status: 'online' as NodeStatus, nodeId, joinedAt }
                  : p,
              ),
              connectedPeers: new Set([...s.connectedPeers, sessionId]),
            }))
          } else if (existing.status === 'reconnecting' || existing.status === 'offline') {
            storeSet(s => ({
              peers: s.peers.map(p =>
                p.sessionId === sessionId
                  ? { ...p, status: 'connecting' as NodeStatus, nodeId, joinedAt }
                  : p,
              ),
            }))
            if (msg.shouldInitiate) {
              initiateWebRTC(sessionId).catch(err => console.warn('[net] rejoin initiate failed', err))
            }
          }
          break
        }
        // Discovery is not a usable encrypted channel. Keep the peer in
        // connecting until the ECDH public-key exchange has installed an
        // AES key; otherwise UI enables file send and can immediately
        // fail with "加密协商超时".
        const newPeer: Peer = { sessionId, nodeId, status: 'connecting', channelType: 'direct', joinedAt }
        storeSet(s => ({ peers: [...s.peers, newPeer] }))
        // We're the newcomer — kick off the WebRTC offer to each existing peer.
        // The existing peers receive shouldInitiate=false and just wait.
        if (msg.shouldInitiate) {
          initiateWebRTC(sessionId).catch(err => console.warn('[net] auto-initiate failed', err))
        } else {
          remoteInitiatingPeers.add(sessionId)
          // #23: if the remote never actually sends its offer (their browser
          // crashed silently between PEER_JOINED and their initiate path),
          // we'd be stuck in remoteInitiatingPeers forever and every
          // ensureConnected() against this peer would block for the full
          // 15s DC_OPEN_TIMEOUT_MS. Try our own initiate as a fallback.
          setTimeout(() => {
            if (remoteInitiatingPeers.has(sessionId) && !peerConnections.has(sessionId)) {
              console.warn('[net] remote never initiated, fallback to local initiate', sessionId)
              remoteInitiatingPeers.delete(sessionId)
              initiateWebRTC(sessionId).catch(err => console.warn('[net] fallback initiate failed', err))
            }
          }, 7_000)
        }
        break
      }

      case 'PEER_LEFT': {
        const sid = msg.sessionId
        initialEncryptedSessionRebuilds.delete(sid)
        // P1-8: PEER_LEFT can arrive when the peer's WS dropped but the
        // P2P DataChannel is still alive (via TURN, or just a transient
        // signaling disconnect). In that case wiping chatMessages and
        // revoking every downloadUrl mid-flight breaks any in-progress
        // download click. Only do the cleanup when there's no live DC.
        const dcAlive = (() => {
          const dc = dataChannels.get(sid)
          return dc?.readyState === 'open' || dc?.readyState === 'connecting'
        })()
        if (dcAlive) {
          // Mark the peer offline at the WS level (signaling lost), but
          // KEEP downloadUrls, chat messages, and DC. The peer card
          // already reflects whatever the DC/ICE state says.
          storeSet(s => ({
            peers: s.peers.map(p =>
              p.sessionId === sid ? { ...p, status: 'reconnecting' as const } : p,
            ),
          }))
          break
        }

        const droppedMsgs = storeGet().chatMessages[sid] ?? []
        for (const m of droppedMsgs) {
          if (m.downloadUrl) retireDownloadArtifact(m.downloadUrl)
        }
        seenInboundChatIds.delete(sid)
        storeSet(s => {
          const { [sid]: _omit, ...restChat } = s.chatMessages
          const { [sid]: _u, ...restUnread } = s.unreadByPeer
          const nextConnected = new Set(s.connectedPeers); nextConnected.delete(sid)
          return {
            peers: s.peers.map(p => p.sessionId === sid ? { ...p, status: 'offline' as const } : p),
            chatMessages: restChat,
            // BUG-021: a peer that steps away (laptop lid, tunnel, brief WS
            // drop) must NOT destroy the files the user staged for them. The
            // `File` handles came from a picker/drop the user cannot silently
            // repeat — they stay until the user removes them or the epoch
            // ends. The peer card already shows 'offline'.
            pendingFiles: s.pendingFiles,
            connectedPeers: nextConnected,
            unreadByPeer: restUnread,
            selectedSessionId: s.selectedSessionId === sid ? null : s.selectedSessionId,
          }
        })
        cleanupPeerConnection(sid)
        break
      }

      // BUG-006: negotiation for one peer must not interleave with itself.
      // These used to be `await`ed inside the dispatch loop, which both
      // stalled every OTHER peer's messages behind a slow SDP round AND
      // let two offers from the same peer overlap (the dispatch loop calls
      // handlers synchronously, so the second message re-entered before the
      // first finished). Queue per peer, and swallow nothing silently.
      case 'SIGNAL_SDP': {
        const receipt = captureSignalReceipt(msg.fromSessionId)
        void enqueuePeerTask(receipt, 'handleRemoteSDP',
          () => handleRemoteSDP(receipt, msg.fromNodeId, msg.sdp),
          {
            requireOriginatingPc: msg.sdp.type !== 'offer',
            requireLocalOfferToken: msg.sdp.type !== 'offer',
            allowMissingPeer: msg.sdp.type === 'offer',
          })
        break
      }

      case 'SIGNAL_ICE': {
        const receipt = captureSignalReceipt(msg.fromSessionId, {
          preparePendingRemoteIce: true,
          candidate: msg.candidate,
        })
        void enqueuePeerTask(receipt, 'handleRemoteICE',
          () => handleRemoteICE(receipt, msg.candidate),
          { bindLocalOfferToken: true })
        break
      }

      case 'SIGNAL_ICE_END': {
        const receipt = captureSignalReceipt(msg.fromSessionId, {
          preparePendingRemoteIce: true,
          endOfCandidates: msg.candidate ?? null,
        })
        void enqueuePeerTask(receipt, 'handleRemoteICEEnd',
          () => handleRemoteICEEnd(receipt),
          { bindLocalOfferToken: true })
        break
      }

      case 'PEER_OFFLINE': {
        // Server-side hint that our outbound SIGNAL_SDP / SIGNAL_ICE never
        // reached the target — they have no live *signaling* socket. Do NOT
        // write this into the P2P transport status when the encrypted DC is
        // still open — broadcast would then skip a peer that is still
        // reachable over WebRTC.
        const sid = msg.targetSessionId
        const dc = dataChannels.get(sid)
        const p2pAlive = dc?.readyState === 'open' && hasAESKey(sid)
        if (p2pAlive) {
          // Keep peer online for P2P; signaling-only fact stays out of transport.
          break
        }
        storeSet(s => ({
          peers: s.peers.map(p =>
            p.sessionId === sid ? { ...p, status: 'offline' as NodeStatus } : p,
          ),
        }))
        break
      }

      case 'SERVER_SHUTDOWN':
        console.warn(`[Signaling] 服务器关闭: ${msg.reason}`)
        setSignalingJoined(false)
        storeSet({ wsConnected: false, signalingStatus: 'offline' })
        break

      case 'ERROR':
        console.warn(`[Signaling] ${msg.code}: ${msg.message}`)
        break

      default:
        break
    }
  }))

  unsubscribeSignaling.push(onConnect(() => {
    // Socket is open but not yet authenticated: WELCOME is what promotes us
    // to 'online' (UX-COPY-003 — "已接入" must not mean "TCP connected").
    storeSet({ wsConnected: true, signalingStatus: 'connecting' })
    // Prefetch auto TURN once authed. Server may reply 503 if disabled —
    // that's fine, we just fall back to STUN + manual TURN. Re-fetch on
    // every reconnect because credentials are short-lived.
    void refreshAutoTurn().then(servers => {
      // P1-1: if the cred fetch yielded ICE servers, auto-TURN is
      // reachable for this session — we'd otherwise need the user to
      // toggle Settings → 立即获取凭证 to learn the truth.
      storeSet({ autoTurnAvailable: servers.length > 0 })
    }).catch(() => {})
    // Kick off the NAT probe + TURN status check exactly once. These are
    // cheap and informational — the UI uses the result to warn ahead of
    // a 30s ICE-failure cycle when both sides are symmetric NAT.
    startNatAndTurnProbes()
  }))
  unsubscribeSignaling.push(onDisconnect(() => {
    setSignalingJoined(false)
    storeSet({
      wsConnected: false,
      // The socket dropped but we still hold a token, so signaling.ts is
      // already scheduling a retry — that is 'reconnecting', not 'offline'.
      signalingStatus: currentToken ? 'reconnecting' : 'offline',
    })
  }))
  // BUG-001: an explicit logout must end the epoch even when this page
  // isn't mounted — the auth store calls endSession() and we tear down.
  unsubscribeSignaling.push(onSessionEnd(() => {
    destroyNetwork()
  }))

  storeSet({ signalingStatus: 'connecting' })
  wsConnect(token)
  installForegroundRecovery()
  installTurnConfigPropagation()
}

export function destroyNetwork() {
  // Order: stop signaling first so nothing re-enters while we tear the
  // epoch down, then destroy every session-scoped artefact.
  wsDisconnect()
  for (const off of unsubscribeSignaling.splice(0)) {
    try { off() } catch { /* ignore */ }
  }
  endNetworkEpoch('destroy')
  clearAutoTurn()
  clearConnectivityOnDestroy()
  if (activeWorkProbeUnsub) {
    activeWorkProbeUnsub()
    setActiveWorkProbeUnsub(null)
  }
  // P1-1: allow the next init() to re-probe (e.g. user logged out and
  // back in on a different network). The cached `lastNatType` in nat.ts
  // stays — it's still the best prior we have until a new probe lands.
  setInitialized(false)
  setCurrentToken('')
  storeSet({
    wsConnected: false, signalingStatus: 'idle',
    // Preserve the last detected NAT type — it's still a useful prior
    // until the next init() probes again. Reset autoTurnAvailable
    // because the new session may target a different signaling server.
    autoTurnAvailable: true,
  })
}
