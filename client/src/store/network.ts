import { create } from 'zustand'
import type { Peer, Transfer, NodeStatus, ChannelMessage, MessageStatus, PendingFileItem } from '@/types'
import {
  connect as wsConnect, disconnect as wsDisconnect, send as wsSend,
  onMessage, onConnect, onDisconnect, reconnectNow,
} from '@/lib/signaling'
import {
  createPeerConnection, createDataChannel, createOffer, createAnswer,
  applyAnswer, addIceCandidate, getSelectedChannelType, getSelectedIcePath,
  ensureAutoTurnReady, applyIceConfigToAll,
} from '@/lib/webrtc'
import {
  generateECDHKeyPair, getMyPublicKey, setPeerPublicKey,
  resetCrypto, hasAESKey,
} from '@/lib/crypto'
import {
  sendFileParallel as engineSendFileParallel, handleMetaMessage, receiveChunk,
  completeReceive, cancelReceive, createTransferId, buildResumeRequest,
  pauseTransfer, resumeTransfer, cancelTransfer as engineCancelTransfer,
  supportsFileSystemAccess, streamChunkToDisk,
  finalizeStreamedFile, cancelStreamWrite, getWriteHandle,
  supportsOPFS, createOPFSReceiveFile, writeChunkToOPFS, getOPFSFile, getOPFSHandle, cleanupOPFS,
  decodeChunkFrame, decodeResumeRequest, checkMetaOOMGuard,
  type MetaMessage, type SendCallbacks, type ResumeRequest,
} from '@/lib/transfer'
import { getTransfer, getActiveTransfers } from '@/lib/db'
import { playSound } from '@/lib/sound'
import { notifyIncomingFile } from '@/lib/notify'
import { refreshAutoTurn, clearAutoTurn, onTurnConfigChange, fetchTurnStatus, getAutoTurnState, loadTurnSettings } from '@/lib/turn'
import { detectNatType, onNatTypeChange, getDetectedNatType, type NatType } from '@/lib/nat'
import {
  MAX_ICE_RESTART_ATTEMPTS, ICE_RESTART_BACKOFF_MS, ICE_DISCONNECTED_RESTART_DELAY_MS,
  DC_OPEN_TIMEOUT_MS, ENCRYPTION_TIMEOUT_MS,
  TRANSFER_LANE_COUNT,
} from '@/constants'

// ── Non-reactive WebRTC state ────────────────────────────────────────
// All routing is per-session (one device = one sessionId). Multiple devices
// may share a nodeId; sessionId is the unique key.
const peerConnections = new Map<string, RTCPeerConnection>()
const dataChannels = new Map<string, RTCDataChannel>()
const transferLanes = new Map<string, RTCDataChannel[]>()
const configuredDataChannels = new WeakSet<RTCDataChannel>()
const pendingIceCandidates = new Map<string, RTCIceCandidateInit[]>()
const ecdhResolvers: Map<string, () => void> = new Map()
const connectingPeers = new Map<string, Promise<RTCDataChannel>>()
const remoteInitiatingPeers = new Set<string>()
const primaryChannelResolvers = new Map<string, Set<() => void>>()
const iceRestarting = new Set<string>()
const iceRestartAttempts = new Map<string, number>()
// Schedule an ICE restart when state is 'disconnected' for too long. The
// browser fires 'failed' very lazily (~30s), so we stop waiting and try
// to recover proactively.
const disconnectedTimers = new Map<string, ReturnType<typeof setTimeout>>()
const sendingFiles = new Map<string, File>()  // transferId → File
// Per-peer mapping from the compact shortId embedded in binary chunk frames
// to the full transferId. Registered when a `meta` message arrives and
// consulted on every incoming chunk so the receiver can demux multiple
// concurrent transfers without a JSON header per frame.
const shortIdToTransferId = new Map<string, Map<number, string>>()
let initialized = false   // see init() — prevents StrictMode double-registration
const deliveredTransfers = new Set<string>()  // one file card per transferId
const transferSpeedSamples = new Map<string, { bytes: number; at: number }>()
let currentToken = ''

// Messages typed before the DC fully opened, flushed in dc.onopen.
const outgoingQueue = new Map<string, string[]>()
// Track msgIds in outgoingQueue so we can update their status on flush or failure.
const queuedMessageIds = new Map<string, Set<string>>()

function queueOutgoing(peerSessionId: string, payload: string, msgId?: string) {
  const q = outgoingQueue.get(peerSessionId) ?? []
  q.push(payload)
  outgoingQueue.set(peerSessionId, q)
  if (msgId) {
    const ids = queuedMessageIds.get(peerSessionId) ?? new Set<string>()
    ids.add(msgId)
    queuedMessageIds.set(peerSessionId, ids)
  }
}
function flushOutgoing(peerSessionId: string, dc: RTCDataChannel) {
  const q = outgoingQueue.get(peerSessionId)
  if (!q?.length) return
  for (const p of q) {
    try { dc.send(p) } catch { /* ignore */ }
  }
  outgoingQueue.delete(peerSessionId)
  // All queued messages are now in-flight → mark as 'sent'.
  const ids = queuedMessageIds.get(peerSessionId)
  if (ids) {
    for (const id of ids) updateMessageStatus(peerSessionId, id, 'sent')
    queuedMessageIds.delete(peerSessionId)
  }
}

function updateMessageStatus(peerSessionId: string, msgId: string, status: MessageStatus) {
  useNetworkStore.setState(s => ({
    chatMessages: {
      ...s.chatMessages,
      [peerSessionId]: (s.chatMessages[peerSessionId] ?? []).map(m =>
        m.id === msgId ? { ...m, status } : m,
      ),
    },
  }))
}

// Mark queued messages as failed (e.g. peer went offline before DC opened).
function failPendingMessages(peerSessionId: string) {
  const ids = queuedMessageIds.get(peerSessionId)
  if (!ids?.size) return
  for (const id of ids) updateMessageStatus(peerSessionId, id, 'failed')
  queuedMessageIds.delete(peerSessionId)
  outgoingQueue.delete(peerSessionId)
}

function startQueuedDelivery(peerSessionId: string) {
  ensureConnected(peerSessionId)
    .then(dc => flushOutgoing(peerSessionId, dc))
    .catch(() => failPendingMessages(peerSessionId))
}

function notifyPrimaryChannel(peerSessionId: string) {
  const resolvers = primaryChannelResolvers.get(peerSessionId)
  if (!resolvers) return
  primaryChannelResolvers.delete(peerSessionId)
  for (const resolve of resolvers) resolve()
}

function waitForPrimaryChannel(peerSessionId: string, timeoutMs = 10_000): Promise<void> {
  const dc = dataChannels.get(peerSessionId)
  if (dc && dc.readyState !== 'closed' && dc.readyState !== 'closing') return Promise.resolve()
  return new Promise(resolve => {
    const resolvers = primaryChannelResolvers.get(peerSessionId) ?? new Set<() => void>()
    let timeout: ReturnType<typeof setTimeout>
    const done = () => {
      clearTimeout(timeout)
      resolvers.delete(done)
      if (resolvers.size === 0) primaryChannelResolvers.delete(peerSessionId)
      resolve()
    }
    timeout = setTimeout(done, timeoutMs)
    resolvers.add(done)
    primaryChannelResolvers.set(peerSessionId, resolvers)
  })
}

let recoveryInstalled = false
let lastRecoverAt = 0
let turnConfigUnsubscribe: (() => void) | null = null
let natConfigUnsubscribe: (() => void) | null = null
// P1-1: NAT probe + TURN status fetch are fire-and-forget at most once
// per page lifetime (the result rarely changes within a session — the
// user can force a re-probe from Settings if they actually move network).
let natProbeStarted = false
let natStoreUnsubscribe: (() => void) | null = null

function installTurnConfigPropagation() {
  if (turnConfigUnsubscribe) return
  turnConfigUnsubscribe = onTurnConfigChange(() => {
    // Apply current TURN config (new auto creds, toggled force-relay, manual
    // server changes) to every live RTCPeerConnection. Without this, an
    // existing connection's ICE config is frozen at the moment of
    // construction and any later credential rotation or settings change is
    // ignored until the PC is torn down and re-built.
    applyIceConfigToAll(peerConnections.values())
  })
  // P1: also rebuild config when NAT type changes (e.g. user clicks the
  // detect button in Settings and we discover symmetric NAT). Same rationale
  // as TURN config — existing PCs would otherwise stay on the old policy.
  if (!natConfigUnsubscribe) {
    natConfigUnsubscribe = onNatTypeChange((t) => {
      // Mirror the published NAT type into the store so the UI banner can
      // react without imperatively polling `getDetectedNatType()`.
      useNetworkStore.setState({ myNatType: t })
      applyIceConfigToAll(peerConnections.values())
    })
  }
  if (!natStoreUnsubscribe) {
    // Convenience: a separate slot so destroy() can rip out both
    // subscriptions cleanly without juggling references.
    natStoreUnsubscribe = natConfigUnsubscribe
  }
}

/**
 * P1-1: fire-and-forget NAT type probe + auto-TURN reachability check
 * once per page lifetime. The probe is gated to a single call because
 * - the cost is several STUN packets to public servers (small but real)
 * - the result rarely changes within a session
 * The Settings modal still has a manual re-probe button for users who
 * actually changed networks.
 *
 * Both calls are wrapped in try/catch — a failure (firewall blocks STUN,
 * /api/turn-credentials 503'd) just leaves the corresponding store field
 * at its conservative default and the UI suppresses the warning.
 */
function startNatAndTurnProbes() {
  if (natProbeStarted) return
  natProbeStarted = true

  // NAT probe — fire-and-forget. The shared module state in nat.ts will
  // re-emit through onNatTypeChange listeners, which is what writes the
  // store; we still set it here as a fallback in case the listener was
  // subscribed after the probe resolves (shouldn't happen with current
  // ordering but cheap insurance).
  void (async () => {
    try {
      const result = await detectNatType()
      useNetworkStore.setState({ myNatType: result.type })
    } catch (err) {
      console.warn('[nat] probe failed', err)
      useNetworkStore.setState({ myNatType: 'unknown' })
    }
  })()

  // Auto-TURN status: server may report disabled / quota-exceeded / not
  // configured. We treat any "not enabled" reply as `autoTurnAvailable=false`.
  void (async () => {
    try {
      const status = await fetchTurnStatus()
      if (!status) {
        useNetworkStore.setState({ autoTurnAvailable: false })
        return
      }
      const available = status.enabled && status.configured && !status.killSwitchActive
      useNetworkStore.setState({ autoTurnAvailable: available })
    } catch {
      useNetworkStore.setState({ autoTurnAvailable: false })
    }
  })()
}

/**
 * Derived selector: are we likely to fail to connect to peers given our
 * local conditions? Symmetric NAT + no usable TURN = no hole punch
 * possible. The UI uses this to show a single banner instead of letting
 * users wait ~30 s for the ICE-restart loop to bail out.
 *
 * Stays narrow: NAT type must be the strong "symmetric" verdict (NOT
 * 'unknown', which would over-warn in firewalled corporate networks
 * where the probe just timed out). Requires both auto and manual TURN
 * to be unavailable — having either is enough to potentially relay.
 */
export function isLikelyUnreachable(s: Pick<NetworkState, 'myNatType' | 'autoTurnAvailable'>): boolean {
  if (s.myNatType !== 'symmetric') return false
  if (s.autoTurnAvailable) return false
  const settings = loadTurnSettings()
  const hasManualTurn = settings.enabled && settings.servers.some(srv => srv.enabled)
  return !hasManualTurn
}

// Re-export the auto-TURN state inspector so the page can decide whether
// to call out "TURN unavailable" explicitly. Cheap wrapper, no state copy.
export function getAutoTurnSnapshot() {
  return getAutoTurnState()
}

function installForegroundRecovery() {
  if (recoveryInstalled || typeof window === 'undefined') return
  recoveryInstalled = true
  const recover = () => {
    if (document.visibilityState && document.visibilityState !== 'visible') return
    recoverConnections()
  }
  window.addEventListener('online', recover)
  window.addEventListener('focus', recover)
  window.addEventListener('pageshow', recover)
  document.addEventListener('visibilitychange', recover)
  // P3: iOS Safari freezes the page on pagehide (entering BFCache); the WS
  // and any TURN-relayed PC will drop. We don't tear anything down here —
  // the resume path runs on `pageshow` — but we *do* want to make sure no
  // stale timers race during the freeze, so push a recovery as soon as the
  // page becomes visible again. (pageshow + visibilitychange + online are
  // already wired; pagehide just covers the bf-cache-restore edge.)
  window.addEventListener('pagehide', () => {
    // Best-effort cleanup of speed sample timers — they don't run during
    // BFCache anyway, but the entries linger and pollute the next session's
    // speed calculation if we restore without clearing them.
    transferSpeedSamples.clear()
  })
}

function recoverConnections() {
  const now = Date.now()
  if (now - lastRecoverAt < 1_500) return
  lastRecoverAt = now
  if (currentToken) {
    reconnectNow()
    void refreshAutoTurn()
  }
  for (const peer of useNetworkStore.getState().peers) {
    const pc = peerConnections.get(peer.sessionId)
    const dc = dataChannels.get(peer.sessionId)
    const needsReconnect =
      peer.status === 'offline' ||
      peer.status === 'reconnecting' ||
      !pc ||
      pc.connectionState === 'closed' ||
      pc.connectionState === 'failed' ||
      pc.iceConnectionState === 'failed' ||
      !dc ||
      dc.readyState === 'closed'

    if (needsReconnect) {
      cleanupPeerConnection(peer.sessionId)
      initiateWebRTC(peer.sessionId).catch(() => {})
    } else if (pc.iceConnectionState === 'disconnected') {
      attemptIceRestart(peer.sessionId).catch(() => {})
    }
  }
}

function genMsgId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

interface NetworkState {
  wsConnected: boolean
  mySessionId: string | null
  channelId: string | null
  peers: Peer[]
  selectedSessionId: string | null
  transfers: Transfer[]
  chatMessages: Record<string, ChannelMessage[]>   // keyed by peer sessionId
  pendingFiles: Record<string, PendingFileItem[]>  // peer sessionId -> files awaiting send
  connectedPeers: Set<string>                      // sessionIds with open DC
  unreadByPeer: Record<string, { message: number; file: number }>
  sendingPeers: Set<string>                        // sessionIds currently flushing pendingFiles
  // P1-1: surfaced so the UI can warn ahead of a 30s ICE failure cycle.
  // `myNatType` starts null and resolves once the post-WELCOME probe
  // returns (or times out → 'unknown'). `autoTurnAvailable` flips false
  // when /api/turn-credentials replied 503 (disabled / quota) on the
  // most recent attempt.
  myNatType: NatType | null
  autoTurnAvailable: boolean

  init: (token: string) => void
  destroy: () => void
  selectPeer: (sessionId: string | null) => void
  addPendingFiles: (sessionId: string, files: File[]) => void
  removePendingFile: (sessionId: string, itemId: string) => void
  clearPendingFiles: (sessionId: string) => void
  sendPendingFile: (sessionId: string) => Promise<void>
  sendFile: (file: File) => Promise<void>
  sendFilesToAll: (files: File[]) => Promise<void>
  pauseTransfer: (transferId: string) => void
  resumeTransfer: (transferId: string, peerSessionId: string) => Promise<void>
  cancelTransferAction: (transferId: string) => void
  sendChatMessage: (peerSessionId: string, text: string) => void
  retryChatMessage: (peerSessionId: string, msgId: string) => void
  blockPeer: (sessionId: string) => void
  recoverConnections: () => void
}

export const useNetworkStore = create<NetworkState>((set, get) => ({
  wsConnected: false,
  mySessionId: null,
  channelId: null,
  peers: [],
  selectedSessionId: null,
  transfers: [],
  chatMessages: {},
  pendingFiles: {},
  connectedPeers: new Set(),
  unreadByPeer: {},
  sendingPeers: new Set(),
  // Default to whatever was last detected (may still be 'unknown' across
  // a session) and to "auto TURN reachable" until proven otherwise — that
  // way the warning banner only shows after we have firm evidence.
  myNatType: getDetectedNatType(),
  autoTurnAvailable: true,

  init(token: string) {
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
        currentToken = token
        wsConnect(token)
      }
      return
    }
    initialized = true
    currentToken = token
    onMessage(async (msg) => {
      switch (msg.t) {
        case 'WELCOME': {
          set({ wsConnected: true, mySessionId: msg.sessionId })
          // Auto-join the identity-scoped cluster channel.
          wsSend({ t: 'JOIN_CLUSTER' })
          break
        }

        case 'PEER_JOINED': {
          const { sessionId, nodeId, joinedAt } = msg.peer
          set(s => {
            const exists = s.peers.find(p => p.sessionId === sessionId)
            if (exists) return s
            const newPeer: Peer = { sessionId, nodeId, status: 'online', channelType: 'direct', joinedAt }
            return { peers: [...s.peers, newPeer] }
          })
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
            set(s => ({
              peers: s.peers.map(p =>
                p.sessionId === sid ? { ...p, status: 'reconnecting' as const } : p,
              ),
            }))
            break
          }

          const droppedMsgs = useNetworkStore.getState().chatMessages[sid] ?? []
          for (const m of droppedMsgs) {
            if (m.downloadUrl) { try { URL.revokeObjectURL(m.downloadUrl) } catch { /* ignore */ } }
          }
          set(s => {
            const { [sid]: _omit, ...restChat } = s.chatMessages
            const { [sid]: _f, ...restFiles } = s.pendingFiles
            const { [sid]: _u, ...restUnread } = s.unreadByPeer
            const nextConnected = new Set(s.connectedPeers); nextConnected.delete(sid)
            return {
              peers: s.peers.map(p => p.sessionId === sid ? { ...p, status: 'offline' as const } : p),
              chatMessages: restChat,
              pendingFiles: restFiles,
              connectedPeers: nextConnected,
              unreadByPeer: restUnread,
              selectedSessionId: s.selectedSessionId === sid ? null : s.selectedSessionId,
            }
          })
          cleanupPeerConnection(sid)
          break
        }

        case 'SIGNAL_SDP':
          await handleRemoteSDP(msg.fromSessionId, msg.fromNodeId, msg.sdp)
          break

        case 'SIGNAL_ICE':
          await handleRemoteICE(msg.fromSessionId, msg.candidate)
          break

        case 'SIGNAL_ICE_END':
          await handleRemoteICEEnd(msg.fromSessionId)
          break

        case 'SERVER_SHUTDOWN':
          console.warn(`[Signaling] 服务器关闭: ${msg.reason}`)
          set({ wsConnected: false })
          break

        case 'ERROR':
          console.warn(`[Signaling] ${msg.code}: ${msg.message}`)
          break

        default:
          break
      }
    })

    onConnect(() => {
      set({ wsConnected: true })
      // Prefetch auto TURN once authed. Server may reply 503 if disabled —
      // that's fine, we just fall back to STUN + manual TURN. Re-fetch on
      // every reconnect because credentials are short-lived.
      void refreshAutoTurn().then(servers => {
        // P1-1: if the cred fetch yielded ICE servers, auto-TURN is
        // reachable for this session — we'd otherwise need the user to
        // toggle Settings → 立即获取凭证 to learn the truth.
        useNetworkStore.setState({ autoTurnAvailable: servers.length > 0 })
      }).catch(() => {})
      // Kick off the NAT probe + TURN status check exactly once. These are
      // cheap and informational — the UI uses the result to warn ahead of
      // a 30s ICE-failure cycle when both sides are symmetric NAT.
      startNatAndTurnProbes()
    })
    onDisconnect(() => set({ wsConnected: false }))

    wsConnect(token)
    installForegroundRecovery()
    installTurnConfigPropagation()
  },

  destroy() {
    wsDisconnect()
    for (const sid of peerConnections.keys()) cleanupPeerConnection(sid)
    resetCrypto()
    clearAutoTurn()
    if (turnConfigUnsubscribe) { turnConfigUnsubscribe(); turnConfigUnsubscribe = null }
    if (natConfigUnsubscribe) { natConfigUnsubscribe(); natConfigUnsubscribe = null }
    natStoreUnsubscribe = null
    // P1-1: allow the next init() to re-probe (e.g. user logged out and
    // back in on a different network). The cached `lastNatType` in nat.ts
    // stays — it's still the best prior we have until a new probe lands.
    natProbeStarted = false
    initialized = false
    currentToken = ''
    // Revoke every cached download URL — these point at File/Blob objects
    // held in chatMessages, which otherwise stay alive (and keep the file
    // bytes resident in memory / OPFS) forever.
    const state = get()
    for (const msgs of Object.values(state.chatMessages)) {
      for (const m of msgs) {
        if (m.downloadUrl) { try { URL.revokeObjectURL(m.downloadUrl) } catch { /* ignore */ } }
      }
    }
    set({
      wsConnected: false, mySessionId: null, channelId: null,
      peers: [], selectedSessionId: null, transfers: [],
      chatMessages: {}, pendingFiles: {}, connectedPeers: new Set(), unreadByPeer: {},
      sendingPeers: new Set(),
      // Preserve the last detected NAT type — it's still a useful prior
      // until the next init() probes again. Reset autoTurnAvailable
      // because the new session may target a different signaling server.
      autoTurnAvailable: true,
    })
  },

  selectPeer(sessionId) {
    if (!sessionId) {
      set({ selectedSessionId: null })
      return
    }
    set(s => {
      const { [sessionId]: _seen, ...rest } = s.unreadByPeer
      return { selectedSessionId: sessionId, unreadByPeer: rest }
    })
  },

  addPendingFiles(sessionId, files) {
    set(s => {
      const current = s.pendingFiles[sessionId] ?? []
      const incoming = files.map(file => ({
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        file,
        displayName: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
      }))
      return { pendingFiles: { ...s.pendingFiles, [sessionId]: [...current, ...incoming] } }
    })
  },

  removePendingFile(sessionId, itemId) {
    set(s => {
      const next = (s.pendingFiles[sessionId] ?? []).filter(item => item.id !== itemId)
      if (next.length === 0) {
        const { [sessionId]: _drop, ...rest } = s.pendingFiles
        return { pendingFiles: rest }
      }
      return { pendingFiles: { ...s.pendingFiles, [sessionId]: next } }
    })
  },

  clearPendingFiles(sessionId) {
    set(s => {
      const { [sessionId]: _drop, ...rest } = s.pendingFiles
      return { pendingFiles: rest }
    })
  },

  async sendPendingFile(sessionId) {
    const items = get().pendingFiles[sessionId] ?? []
    if (items.length === 0) return
    // Guard against double-click / spam: if a send is already in flight for
    // this peer, drop the second call. Previously the second click re-queued
    // the same items (they're only removed after `allOk`), producing
    // duplicate transfers.
    if (get().sendingPeers.has(sessionId)) return
    set(s => {
      const next = new Set(s.sendingPeers)
      next.add(sessionId)
      return { sendingPeers: next }
    })
    let allOk = true
    try {
      for (const item of items) {
        const ok = await sendFileToPeer(item.file, sessionId, item.displayName)
        if (!ok) allOk = false
      }
    } finally {
      set(s => {
        const next = new Set(s.sendingPeers)
        next.delete(sessionId)
        return { sendingPeers: next }
      })
    }
    if (allOk) {
      set(s => {
        const { [sessionId]: _drop, ...rest } = s.pendingFiles
        return { pendingFiles: rest }
      })
    }
    // On failure leave the staged queue in place so the user can retry / prune.
  },

  async sendFile(file) {
    const sid = get().selectedSessionId
    if (!sid) throw new Error('未选择目标节点')
    await sendFileToPeer(file, sid)
  },

  async sendFilesToAll(files) {
    const targets = get().peers.filter(p => p.status !== 'offline').map(p => p.sessionId)
    if (targets.length === 0) throw new Error('没有可用的目标节点')
    await Promise.allSettled(targets.flatMap(sid => files.map(file => sendFileToPeer(file, sid))))
  },

  sendChatMessage(peerSessionId, text) {
    // P2-3: enforce a sane chat-message size. The DataChannel SCTP max is
    // 256 KB; without a cap, `dc.send` threw "Message too large" and the
    // UI showed "failed" with no explanation. The server-side WS cap is
    // 64 KB but chat messages go P2P not via WS — still keep symmetric.
    // 16 KB is well under the SCTP / WS caps and more than any sane human
    // message; longer payloads belong in a file transfer.
    const CHAT_MAX_BYTES = 16 * 1024
    const trimmedText = text.length > CHAT_MAX_BYTES ? text.slice(0, CHAT_MAX_BYTES) : text
    const msg: ChannelMessage = {
      id: genMsgId(), type: 'text', content: trimmedText, timestamp: Date.now(),
      direction: 'sent', status: 'sending',
    }
    set(s => ({
      chatMessages: { ...s.chatMessages, [peerSessionId]: [...(s.chatMessages[peerSessionId] ?? []), msg] },
    }))

    const payload = JSON.stringify({ type: 'chat', id: msg.id, content: msg.content, timestamp: msg.timestamp })
    const dc = dataChannels.get(peerSessionId)
    if (dc?.readyState === 'open') {
      try {
        dc.send(payload)
        updateMessageStatus(peerSessionId, msg.id, 'sent')
      } catch {
        updateMessageStatus(peerSessionId, msg.id, 'failed')
      }
    } else {
      // Queued — will be flushed and marked 'sent' when the DC opens.
      queueOutgoing(peerSessionId, payload, msg.id)
      startQueuedDelivery(peerSessionId)
    }
  },

  retryChatMessage(peerSessionId, msgId) {
    const msg = get().chatMessages[peerSessionId]?.find(m => m.id === msgId)
    if (!msg || msg.type !== 'text') return
    updateMessageStatus(peerSessionId, msgId, 'sending')
    const payload = JSON.stringify({ type: 'chat', id: msg.id, content: msg.content, timestamp: msg.timestamp })
    const dc = dataChannels.get(peerSessionId)
    if (dc?.readyState === 'open') {
      try {
        dc.send(payload)
        updateMessageStatus(peerSessionId, msgId, 'sent')
      } catch {
        updateMessageStatus(peerSessionId, msgId, 'failed')
      }
    } else {
      queueOutgoing(peerSessionId, payload, msgId)
      startQueuedDelivery(peerSessionId)
    }
  },

  blockPeer(sessionId) {
    wsSend({ t: 'BLOCK', sessionId })
    set(s => {
      const { [sessionId]: _omit, ...rest } = s.chatMessages
      return {
        peers: s.peers.filter(p => p.sessionId !== sessionId),
        chatMessages: rest,
        selectedSessionId: s.selectedSessionId === sessionId ? null : s.selectedSessionId,
      }
    })
    cleanupPeerConnection(sessionId)
  },

  recoverConnections() {
    recoverConnections()
  },

  pauseTransfer(transferId) {
    pauseTransfer(transferId)
    set(s => ({
      transfers: s.transfers.map(t => t.id === transferId ? { ...t, status: 'paused' as const } : t),
    }))
    // Receiver-driven pause: tell the sender to stop. The local signal we
    // just set causes in-flight chunks to be dropped in receiveChunk; this
    // upstream notice prevents the sender from continuing to encrypt + ship
    // bytes that the receiver will throw away.
    const t = get().transfers.find(tr => tr.id === transferId)
    if (t && t.direction === 'recv') {
      const dc = dataChannels.get(t.peerSessionId)
      if (dc?.readyState === 'open') {
        try { dc.send(JSON.stringify({ type: 'transfer-pause', transferId })) } catch { /* ignore */ }
      }
    }
  },

  async resumeTransfer(transferId, peerSessionId) {
    resumeTransfer(transferId)
    set(s => ({
      transfers: s.transfers.map(t => t.id === transferId ? { ...t, status: 'transferring' as const } : t),
    }))
    const t = get().transfers.find(tr => tr.id === transferId)
    // Receiver-driven resume: tell the sender to start shipping again. The
    // sender's lane loop is waiting in waitWhilePaused for transferSignals to
    // flip back, but the sender's local signal only reflects what the SENDER
    // toggled — when the user paused from the receive side the sender's
    // signal was set via 'transfer-pause' below. We undo that here.
    if (t && t.direction === 'recv') {
      const dc = dataChannels.get(peerSessionId)
      if (dc?.readyState === 'open') {
        try { dc.send(JSON.stringify({ type: 'transfer-resume', transferId })) } catch { /* ignore */ }
      }
      // Receiver side: nothing else to do — the sender owns the send loop.
      return
    }
    const dc = dataChannels.get(peerSessionId)
    const file = sendingFiles.get(transferId)
    if (dc && file && dc.readyState === 'open') {
      const record = await getTransfer(transferId)
      if (record) {
        const request = await buildResumeRequest(transferId)
        const peerNodeId = get().peers.find(p => p.sessionId === peerSessionId)?.nodeId ?? 0
        const lanes = await ensureTransferLanes(peerSessionId)
        const peerBitmap = request ? decodeResumeRequest(request, record.totalChunks) : undefined
        engineSendFileParallel(lanes, file, transferId, peerNodeId, peerSessionId, record, undefined, peerBitmap)
          .then(() => sendingFiles.delete(transferId))
          .catch(() => {})
      }
    }
  },

  cancelTransferAction(transferId) {
    // Tell the other side to stop before we tear our own state down — once we
    // drop the receive session / sending file, a late notice is a no-op on
    // our side but the peer still needs to know.
    const t = get().transfers.find(tr => tr.id === transferId)
    if (t) {
      const dc = dataChannels.get(t.peerSessionId)
      if (dc?.readyState === 'open') {
        try { dc.send(JSON.stringify({ type: 'transfer-cancel', transferId })) } catch { /* ignore */ }
      }
    }
    engineCancelTransfer(transferId)
    cancelReceive(transferId)
    cancelStreamWrite(transferId)
    cleanupOPFS(transferId).catch(() => {})
    sendingFiles.delete(transferId)
    transferSpeedSamples.delete(transferId)
    set(s => ({ transfers: s.transfers.filter(t => t.id !== transferId) }))
  },
}))

// ── WebRTC helpers ────────────────────────────────────────────────────

async function ensureConnected(peerSessionId: string): Promise<RTCDataChannel> {
  const existing = connectingPeers.get(peerSessionId)
  if (existing) return existing

  const task = ensureConnectedInner(peerSessionId)
  connectingPeers.set(peerSessionId, task)
  try {
    return await task
  } finally {
    if (connectingPeers.get(peerSessionId) === task) connectingPeers.delete(peerSessionId)
  }
}

async function ensureConnectedInner(peerSessionId: string): Promise<RTCDataChannel> {
  if ((remoteInitiatingPeers.has(peerSessionId) || peerConnections.has(peerSessionId)) && !dataChannels.has(peerSessionId)) {
    await waitForPrimaryChannel(peerSessionId)
  }
  let dc = dataChannels.get(peerSessionId)
  if (!dc || dc.readyState === 'closed' || dc.readyState === 'closing') {
    cleanupPeerConnection(peerSessionId, { failQueuedMessages: false })
    await initiateWebRTC(peerSessionId)
    dc = dataChannels.get(peerSessionId)
    if (!dc) throw new Error('无法建立连接')
  }
  if (dc.readyState !== 'open') {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup()
        reject(new Error('DataChannel 打开超时'))
      }, DC_OPEN_TIMEOUT_MS)
      const cleanup = () => {
        clearTimeout(timeout)
        dc!.removeEventListener('open', onOpen)
        dc!.removeEventListener('close', onClose)
        dc!.removeEventListener('error', onError)
      }
      const onOpen = () => { cleanup(); resolve() }
      const onClose = () => { cleanup(); reject(new Error('DataChannel 已关闭')) }
      const onError = () => { cleanup(); reject(new Error('DataChannel 连接失败')) }
      dc!.addEventListener('open', onOpen)
      dc!.addEventListener('close', onClose)
      dc!.addEventListener('error', onError)
    })
  }
  if (!hasAESKey(peerSessionId)) {
    await new Promise<void>((resolve, reject) => {
      if (hasAESKey(peerSessionId)) {
        resolve()
        return
      }
      const timeout = setTimeout(() => {
        ecdhResolvers.delete(peerSessionId)
        reject(new Error('加密协商超时'))
      }, ENCRYPTION_TIMEOUT_MS)
      ecdhResolvers.set(peerSessionId, () => {
        clearTimeout(timeout)
        ecdhResolvers.delete(peerSessionId)
        resolve()
      })
      if (hasAESKey(peerSessionId)) {
        ecdhResolvers.get(peerSessionId)?.()
      }
    })
  }
  return dc
}

async function ensureTransferLanes(peerSessionId: string): Promise<RTCDataChannel[]> {
  const primary = await ensureConnected(peerSessionId)
  let lanes = transferLanes.get(peerSessionId) ?? []
  lanes = lanes.filter(dc => dc.readyState !== 'closed')
  transferLanes.set(peerSessionId, lanes)

  const openLanes = lanes.filter(dc => dc.readyState === 'open')
  if (openLanes.length > 0) return openLanes
  return [primary]
}

async function sendFileToPeer(file: File, peerSessionId: string, displayName = file.name): Promise<boolean> {
  const peer = useNetworkStore.getState().peers.find(p => p.sessionId === peerSessionId)
  const peerNodeId = peer?.nodeId ?? 0

  let dcs: RTCDataChannel[]
  try {
    dcs = await ensureTransferLanes(peerSessionId)
  } catch (e) {
    appendSystemChat(peerSessionId, `发送失败：${String((e as Error).message ?? e)}`)
    return false
  }

  const transferId = createTransferId()
  const transfer: Transfer = {
    id: transferId, direction: 'send',
    peerSessionId, peerNodeId,
    fileName: displayName, fileSize: file.size,
    progress: 0, speedBps: 0, status: 'pending', startedAt: Date.now(),
  }
  useNetworkStore.setState(s => ({ transfers: [...s.transfers, transfer] }))
  // Surface the send intent in the chat history immediately.
  appendSystemChat(peerSessionId, `开始发送文件 ${displayName}`, 'sent')

  const callbacks: SendCallbacks = {
    onProgress(sent, total) {
      const now = performance.now()
      const bytes = Math.min(file.size, Math.round((sent / total) * file.size))
      const prev = transferSpeedSamples.get(transferId) ?? { bytes: 0, at: now }
      const elapsed = Math.max(1, now - prev.at)
      const speedBps = now === prev.at ? 0 : ((bytes - prev.bytes) * 1000) / elapsed
      transferSpeedSamples.set(transferId, { bytes, at: now })
      useNetworkStore.setState(s => ({
        transfers: s.transfers.map(t =>
          t.id === transferId ? { ...t, progress: sent / total, speedBps, status: 'transferring' as const } : t,
        ),
      }))
    },
    onError(error) {
      useNetworkStore.setState(s => ({
        transfers: s.transfers.map(t =>
          t.id === transferId ? { ...t, status: 'failed' as const, error } : t,
        ),
      }))
    },
  }

  try {
    sendingFiles.set(transferId, file)
    await engineSendFileParallel(dcs, file, transferId, peerNodeId, peerSessionId, undefined, callbacks)
    sendingFiles.delete(transferId)
    useNetworkStore.setState(s => ({
      transfers: s.transfers.map(t =>
        t.id === transferId ? { ...t, progress: 1, status: 'completed' as const } : t,
      ),
    }))
    appendSystemChat(peerSessionId, `已发送文件 ${displayName}`, 'sent')
    playSound('complete')
    transferSpeedSamples.delete(transferId)
    return true
  } catch (e) {
    transferSpeedSamples.delete(transferId)
    useNetworkStore.setState(s => ({
      transfers: s.transfers.map(t =>
        t.id === transferId ? { ...t, status: 'failed' as const, error: String(e) } : t,
      ),
    }))
    appendSystemChat(peerSessionId, `发送失败：${displayName} · ${String((e as Error).message ?? e)}`, 'sent')
    playSound('error')
    return false
  }
}

function appendSystemChat(peerSessionId: string, content: string, direction: 'sent' | 'recv' | 'system' = 'system') {
  const m: ChannelMessage = { id: genMsgId(), type: 'system', content, timestamp: Date.now(), direction }
  useNetworkStore.setState(s => {
    const msgs = [...(s.chatMessages[peerSessionId] ?? []), m]
    return { chatMessages: { ...s.chatMessages, [peerSessionId]: msgs } }
  })
}

async function initiateWebRTC(peerSessionId: string) {
  if (peerConnections.has(peerSessionId)) return
  // Without this, the first PC after WELCOME is built before the auto-TURN
  // credential fetch resolves — symmetric-NAT peers get a non-relay PC,
  // first ICE round fails, only the second restart attempt (~5s later) has
  // TURN. Wait briefly for credentials so the very first handshake has them.
  await ensureAutoTurnReady()
  const pc = createPeerConnection()
  peerConnections.set(peerSessionId, pc)

  const dc = createDataChannel(pc)
  dataChannels.set(peerSessionId, dc)
  notifyPrimaryChannel(peerSessionId)
  setupDataChannel(dc, peerSessionId)
  for (let i = 0; i < TRANSFER_LANE_COUNT; i++) {
    const lane = createDataChannel(pc, `misaka-transfer-${i}`)
    const lanes = transferLanes.get(peerSessionId) ?? []
    lanes.push(lane)
    transferLanes.set(peerSessionId, lanes)
    setupDataChannel(lane, peerSessionId)
  }

  await generateECDHKeyPair(peerSessionId)

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      wsSend({ t: 'SIGNAL_ICE', targetSessionId: peerSessionId, candidate: e.candidate.toJSON() })
    } else {
      // null marks end-of-candidates — tell peer so its ICE agent can stop
      // waiting for stragglers and finalize connectivity checks faster.
      wsSend({ t: 'SIGNAL_ICE_END', targetSessionId: peerSessionId })
    }
  }

  pc.oniceconnectionstatechange = () => handleIceStateChange(pc, peerSessionId)

  const offer = await createOffer(pc)
  wsSend({ t: 'SIGNAL_SDP', targetSessionId: peerSessionId, sdp: offer })

  const pending = pendingIceCandidates.get(peerSessionId)
  if (pending) {
    pendingIceCandidates.delete(peerSessionId)
    for (const c of pending) await addIceCandidate(pc, c)
  }
}

// Perfect-negotiation tie-break: when both sides send offers at the same
// time (e.g. simultaneous ICE restart on LAN UDP flap), the side with the
// lexicographically smaller sessionId is "polite" and yields — rolls back
// its local offer and accepts the remote one. The impolite side ignores
// the incoming offer and keeps its own.
function isPolite(peerSessionId: string): boolean {
  const my = useNetworkStore.getState().mySessionId ?? ''
  return my < peerSessionId
}

async function handleRemoteSDP(fromSessionId: string, fromNodeId: number, sdp: RTCSessionDescriptionInit) {
  // P1-3: defer SDP processing until we know our own sessionId. The polite/
  // impolite tie-break is computed against mySessionId — if an SDP arrives
  // before WELCOME finishes processing, mySessionId is null and isPolite()
  // resolves "" < peerSessionId === true, making BOTH sides polite. The
  // result is that both peers roll back their offers and neither establishes.
  // Wait up to 3s for WELCOME; any longer and something is structurally
  // broken (signaling never authed) — let the SDP fall through, which will
  // be a no-op because there's no PC and the offer-without-pc branch logs.
  if (useNetworkStore.getState().mySessionId === null) {
    const start = Date.now()
    while (useNetworkStore.getState().mySessionId === null && Date.now() - start < 3000) {
      await new Promise(r => setTimeout(r, 20))
    }
    if (useNetworkStore.getState().mySessionId === null) {
      console.warn('[net] handleRemoteSDP gave up waiting for WELCOME — dropping', fromSessionId, sdp.type)
      return
    }
  }

  let pc = peerConnections.get(fromSessionId)
  if (sdp.type === 'offer') remoteInitiatingPeers.delete(fromSessionId)

  if (!pc && sdp.type !== 'offer') {
    console.warn('[net] ignoring SDP without peer connection', fromSessionId, sdp.type)
    return
  }

  if (!pc) {
    // Inbound offer from a peer who joined before us — accept it.
    // Same pre-warm rationale as initiateWebRTC: ensures the answerer
    // also has TURN servers in its first PC.
    await ensureAutoTurnReady()
    pc = createPeerConnection()
    peerConnections.set(fromSessionId, pc)

    pc.ondatachannel = (e) => {
      if (e.channel.label.startsWith('misaka-transfer-')) {
        // P2-9: de-duplicate. After an ICE restart the answerer's
        // ondatachannel fires again for the same labels; without this guard
        // each label accumulates additional channel entries and the same
        // chunk could be sent down two lanes.
        const lanes = transferLanes.get(fromSessionId) ?? []
        const existing = lanes.find(l => l.label === e.channel.label)
        if (existing) {
          // Replace the prior lane (it might be 'closing'/'closed' after a
          // restart). Tear down listeners on the old one if still around.
          const idx = lanes.indexOf(existing)
          try { existing.close() } catch { /* ignore */ }
          lanes[idx] = e.channel
        } else {
          lanes.push(e.channel)
        }
        transferLanes.set(fromSessionId, lanes)
      } else {
        dataChannels.set(fromSessionId, e.channel)
        notifyPrimaryChannel(fromSessionId)
      }
      setupDataChannel(e.channel, fromSessionId)
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        wsSend({ t: 'SIGNAL_ICE', targetSessionId: fromSessionId, candidate: e.candidate.toJSON() })
      } else {
        wsSend({ t: 'SIGNAL_ICE_END', targetSessionId: fromSessionId })
      }
    }

    pc.oniceconnectionstatechange = () => handleIceStateChange(pc!, fromSessionId)

    await generateECDHKeyPair(fromSessionId)

    // Make sure the peer is in our radar (PEER_JOINED may have arrived before
    // the SDP, but on race we surface them here too).
    useNetworkStore.setState(s => {
      if (s.peers.some(p => p.sessionId === fromSessionId)) return s
      const peer: Peer = {
        sessionId: fromSessionId, nodeId: fromNodeId,
        status: 'connecting', channelType: 'direct', joinedAt: Date.now(),
      }
      return { peers: [...s.peers, peer] }
    })
  }

  if (sdp.type === 'offer') {
    // Glare: an offer arrives while we already have a local offer outstanding
    // (typically simultaneous ICE restart on both sides after a UDP flap).
    // Without this branch, createAnswer → setRemoteDescription throws
    // InvalidStateError and both sides wedge until the long ICE failure timeout.
    if (pc.signalingState === 'have-local-offer') {
      if (isPolite(fromSessionId)) {
        // Polite: roll back our outstanding offer, then accept theirs.
        try {
          await pc.setLocalDescription({ type: 'rollback' } as RTCSessionDescriptionInit)
        } catch (err) {
          console.warn('[net] glare rollback failed', err)
          return
        }
      } else {
        // Impolite: drop the colliding offer; our outstanding offer wins.
        console.warn('[net] ignoring colliding offer (impolite side)', fromSessionId)
        return
      }
    }
    const answer = await createAnswer(pc, sdp)
    wsSend({ t: 'SIGNAL_SDP', targetSessionId: fromSessionId, sdp: answer })
  } else {
    if (pc.signalingState !== 'have-local-offer') {
      console.warn('[net] ignoring stale SDP answer', fromSessionId, pc.signalingState)
      return
    }
    await applyAnswer(pc, sdp)
  }

  const pending = pendingIceCandidates.get(fromSessionId)
  if (pending) {
    pendingIceCandidates.delete(fromSessionId)
    for (const c of pending) await addIceCandidate(pc, c)
  }
}

async function handleRemoteICE(fromSessionId: string, candidate: RTCIceCandidateInit) {
  const pc = peerConnections.get(fromSessionId)
  if (pc?.remoteDescription) {
    // Wrap: addIceCandidate throws on closed pc / malformed candidate / unknown
    // sdpMid. Without try/catch the dispatch loop's forEach swallows the
    // rejection (unhandledrejection), and we'd never know one peer's bad IPv6
    // candidate was poisoning the whole session.
    try {
      await addIceCandidate(pc, candidate)
    } catch (err) {
      console.warn('[net] addIceCandidate failed', err)
    }
  } else {
    const pending = pendingIceCandidates.get(fromSessionId) ?? []
    pending.push(candidate)
    pendingIceCandidates.set(fromSessionId, pending)
  }
}

async function handleRemoteICEEnd(fromSessionId: string) {
  const pc = peerConnections.get(fromSessionId)
  if (!pc) return
  // Empty-candidate marker per RFC 8445 §8.1.2 — signals the peer has
  // finished gathering. Browsers accept this to short-circuit waits.
  if (!pc.remoteDescription) return // marker before SDP is meaningless
  try { await pc.addIceCandidate({ candidate: '', sdpMid: '', sdpMLineIndex: 0 }) }
  catch { /* some browsers reject the marker; harmless */ }
}

function handleIceStateChange(pc: RTCPeerConnection, peerSessionId: string) {
  const state = pc.iceConnectionState
  if (state === 'connected' || state === 'completed') {
    clearDisconnectedTimer(peerSessionId)
    iceRestartAttempts.set(peerSessionId, 0)
    void onIceConnected(pc, peerSessionId)
  } else if (state === 'disconnected') {
    // Browsers (esp. mobile Safari + Chrome on Wi-Fi/cellular handoff) flap
    // ICE through 'disconnected' briefly before snapping back to 'connected'
    // on their own. Flipping status='reconnecting' synchronously caused a
    // visible "正在尝试重新协商连接…" banner the instant the user did anything
    // that woke the page (focusing the chat input, tapping send) even though
    // the channel was healthy. Defer the status update — let the same timer
    // that schedules the proactive restart also do the UI flip.
    if (!disconnectedTimers.has(peerSessionId)) {
      const t = setTimeout(() => {
        disconnectedTimers.delete(peerSessionId)
        const cur = peerConnections.get(peerSessionId)
        if (!cur) return
        if (cur.iceConnectionState !== 'disconnected' && cur.iceConnectionState !== 'failed') return
        const prevStatus = useNetworkStore.getState().peers.find(p => p.sessionId === peerSessionId)?.status
        useNetworkStore.setState(s => ({
          peers: s.peers.map(p =>
            p.sessionId === peerSessionId ? { ...p, status: 'reconnecting' as NodeStatus } : p,
          ),
        }))
        if (prevStatus === 'transferring') {
          appendSystemChat(peerSessionId, '⚠ 连接中断，尝试恢复中…')
        }
        attemptIceRestart(peerSessionId)
      }, ICE_DISCONNECTED_RESTART_DELAY_MS)
      disconnectedTimers.set(peerSessionId, t)
    }
  } else if (state === 'failed') {
    clearDisconnectedTimer(peerSessionId)
    attemptIceRestart(peerSessionId)
  }
}

function clearDisconnectedTimer(peerSessionId: string) {
  const t = disconnectedTimers.get(peerSessionId)
  if (t) {
    clearTimeout(t)
    disconnectedTimers.delete(peerSessionId)
  }
}

async function onIceConnected(pc: RTCPeerConnection, peerSessionId: string) {
  const selectedPath = await getSelectedIcePath(pc)
  const ct = selectedPath?.channelType ?? await getSelectedChannelType(pc)
  useNetworkStore.setState(s => ({
    peers: s.peers.map(p =>
      p.sessionId === peerSessionId
        ? {
            ...p,
            status: 'transferring' as NodeStatus,
            channelType: ct ?? 'stun',
            icePath: selectedPath?.pathText,
            icePathMeasuredAt: selectedPath?.pathText ? Date.now() : p.icePathMeasuredAt,
          }
        : p,
    ),
    connectedPeers: new Set([...s.connectedPeers, peerSessionId]),
  }))
}

function setupDataChannel(dc: RTCDataChannel, peerSessionId: string) {
  // Idempotency guard: in reconnect races the same channel instance may flow
  // through setup twice; avoid duplicate listeners / duplicate side effects.
  if (configuredDataChannels.has(dc)) return
  configuredDataChannels.add(dc)

  // Without this, incoming chunk bodies arrive as Blob and the
  // `instanceof ArrayBuffer` check below skips them silently.
  dc.binaryType = 'arraybuffer'

  dc.onclose = () => {
    if (dc.readyState === 'closed') {
      const pc = peerConnections.get(peerSessionId)
      if (pc && pc.connectionState !== 'closed') {
        attemptIceRestart(peerSessionId)
      }
    }
  }

  const handleOpen = async () => {
    // Show reconnection notice if there was prior chat activity.
    const prevMsgs = useNetworkStore.getState().chatMessages[peerSessionId] ?? []
    const isReconnect = prevMsgs.some(m => m.type !== 'system')
    useNetworkStore.setState(s => ({
      peers: s.peers.map(p =>
        p.sessionId === peerSessionId ? { ...p, status: 'transferring' as const } : p,
      ),
      connectedPeers: new Set([...s.connectedPeers, peerSessionId]),
    }))
    if (isReconnect) {
      appendSystemChat(peerSessionId, '✓ 连接已恢复')
    }
    if (!dc.label.startsWith('misaka-transfer-')) {
      try {
        const pub = await getMyPublicKey(peerSessionId)
        dc.send(JSON.stringify({ type: 'ecdh-pub', pub }))
      } catch (err) {
        console.warn('[net] ecdh-pub send failed', err)
      }
      if (hasAESKey(peerSessionId)) flushOutgoing(peerSessionId, dc)
    }
  }

  // Race: on the answerer side, the channel may already be open by the time
  // we attach the listener. addEventListener (vs `.onopen=`) doesn't help if
  // the event has already fired — guard explicitly.
  if (dc.readyState === 'open') {
    handleOpen()
  } else {
    dc.addEventListener('open', handleOpen, { once: true })
  }

  dc.onmessage = async (e) => {
    if (e.data instanceof ArrayBuffer) {
      const frame = decodeChunkFrame(e.data)
      if (!frame) return
      const transferId = shortIdToTransferId.get(peerSessionId)?.get(frame.shortId)
      if (!transferId) return  // meta hasn't arrived yet, or transfer was cleaned up

      // Wrap the whole receive path. decryptChunk can reject (wrong key, bad
      // auth tag, tampered ciphertext) — without a try/catch the rejection
      // becomes an unhandledrejection and the UI hangs at whatever % the last
      // good chunk left it at. Surface it as a failed transfer + error tone.
      try {
        const result = await receiveChunk(
          transferId, frame.index, frame.iv, frame.ciphertext, peerSessionId,
          {
            onProgress(received, total) {
              const now = performance.now()
              const transfer = useNetworkStore.getState().transfers.find(t => t.id === transferId)
              const fileSize = transfer?.fileSize ?? 0
              const bytes = fileSize > 0 ? Math.min(fileSize, Math.round((received / total) * fileSize)) : 0
              const prev = transferSpeedSamples.get(transferId) ?? { bytes: 0, at: now }
              const elapsed = Math.max(1, now - prev.at)
              const speedBps = now === prev.at ? 0 : ((bytes - prev.bytes) * 1000) / elapsed
              transferSpeedSamples.set(transferId, { bytes, at: now })
              useNetworkStore.setState(s => ({
                transfers: s.transfers.map(t =>
                  // #25: preserve 'paused' status if user paused mid-receive.
                  t.id === transferId
                    ? {
                        ...t,
                        progress: received / total,
                        speedBps,
                        status: t.status === 'paused' ? 'paused' as const : 'transferring' as const,
                      }
                    : t,
                ),
              }))
              if (received === total) deliverCompletedFile(transferId, peerSessionId)
            },
            onError(error) {
              useNetworkStore.setState(s => ({
                transfers: s.transfers.map(t =>
                  t.id === transferId ? { ...t, status: 'failed' as const, error } : t,
                ),
              }))
            },
          },
        )

        if (result) {
          const { decrypted: decryptedData, storageMode } = result
          if (storageMode === 'stream') {
            await Promise.all([
              streamChunkToDisk(transferId, frame.index, decryptedData),
              writeChunkToOPFS(transferId, frame.index, decryptedData),
            ])
          }
          // DataChannel is ordered + reliable — no application-level per-chunk
          // ack is needed. The sender uses the resume bitmap (built from the
          // session's received set) for recovery, not per-chunk acks.
        }
      } catch (err) {
        const errStr = err instanceof Error ? err.message : String(err)
        console.warn('[net] receiveChunk failed', errStr)
        failTransferRecord(transferId, errStr)
        playSound('error')
        appendSystemChat(peerSessionId, `接收失败：${errStr}`)
        // Drop the demux entry so subsequent stray chunks for this transfer
        // don't keep firing the catch.
        shortIdToTransferId.get(peerSessionId)?.delete(frame.shortId)
      }
      return
    }

    if (typeof e.data === 'string') {
      try {
        const msg = JSON.parse(e.data)

        if (msg.type === 'ecdh-pub') {
          await setPeerPublicKey(peerSessionId, msg.pub)
          ecdhResolvers.get(peerSessionId)?.()
          flushOutgoing(peerSessionId, dc)
          sendResumeRequests(peerSessionId, dc)
          return
        }

        if (msg.type === 'meta') {
          const meta = msg as MetaMessage
          const peerNodeId = useNetworkStore.getState().peers.find(p => p.sessionId === peerSessionId)?.nodeId ?? 0

          // P1-5: refuse files that would force an in-memory IDB assemble
          // larger than MAX_INMEMORY_RECEIVE_BYTES — for those, this tab
          // would OOM mid-receive on low-end devices. The check is BEFORE
          // shortId registration so we don't accidentally accept the
          // chunk stream that follows.
          const rejection = checkMetaOOMGuard(meta)
          if (rejection) {
            // Tell the sender to stop — they're about to ship hundreds of
            // megabytes that we'd throw away.
            try {
              dc.send(JSON.stringify({ type: 'transfer-cancel', transferId: meta.transferId }))
            } catch { /* peer DC might already be dying — ignore */ }
            useNetworkStore.setState(s => {
              if (s.transfers.some(t => t.id === meta.transferId)) return s
              return {
                transfers: [...s.transfers, {
                  id: meta.transferId, direction: 'recv' as const,
                  peerSessionId, peerNodeId,
                  fileName: meta.fileName, fileSize: meta.fileSize,
                  progress: 0, speedBps: 0,
                  status: 'failed:unsupported' as const,
                  error: rejection.message,
                  startedAt: Date.now(),
                }],
              }
            })
            appendSystemChat(peerSessionId, `已拒绝接收 ${meta.fileName}：${rejection.message}`)
            playSound('error')
            return
          }

          // Register shortId → transferId BEFORE any await. If a chunk for
          // this transfer arrives while handleMetaMessage is still in flight
          // (very common — meta + chunk are queued back-to-back on the lane),
          // the binary-frame handler MUST already see the demux entry,
          // otherwise the chunk is silently dropped at the `if (!transferId)`
          // early-return. Hit during the folder e2e test.
          let peerMap = shortIdToTransferId.get(peerSessionId)
          if (!peerMap) {
            peerMap = new Map()
            shortIdToTransferId.set(peerSessionId, peerMap)
          }
          peerMap.set(meta.shortId, meta.transferId)
          await handleMetaMessage(meta, peerNodeId)
          if (supportsOPFS() && !supportsFileSystemAccess()) {
            createOPFSReceiveFile(meta.transferId, meta.fileName, meta.totalChunks).catch(() => {})
          }
          useNetworkStore.setState(s => {
            if (s.transfers.some(t => t.id === meta.transferId)) return s
            return {
              transfers: [...s.transfers, {
                id: meta.transferId, direction: 'recv' as const,
                peerSessionId, peerNodeId,
                fileName: meta.fileName, fileSize: meta.fileSize,
                progress: 0, speedBps: 0, status: 'transferring' as const,
                startedAt: Date.now(),
              }],
            }
          })
          const alreadyAnnounced = useNetworkStore.getState().chatMessages[peerSessionId]
            ?.some(m => m.type === 'system' && m.content === `正在接收文件 ${meta.fileName}`)
          if (!alreadyAnnounced) appendSystemChat(peerSessionId, `正在接收文件 ${meta.fileName}`)
          // #16: surface an OS notification at start-of-transfer so a tab-
          // backgrounded recipient can decline a big incoming file early
          // rather than discovering it only after the entire payload lands.
          notifyIncomingFile({ peerNodeId, fileName: meta.fileName, fileSize: meta.fileSize })
          // #5: zero-byte files send no chunks at all (totalChunks=0). The
          // chunk-driven completion gate never fires; deliver synthetically
          // from the empty Blob and clean up. (#14 cleanup of demux map below.)
          if (meta.totalChunks === 0 && meta.fileSize === 0) {
            const emptyBlob = new Blob([], { type: meta.mime || 'application/octet-stream' })
            const emptyFile = new File([emptyBlob], meta.fileName, { type: meta.mime || 'application/octet-stream' })
            const url = URL.createObjectURL(emptyFile)
            appendFileChat(peerSessionId, meta.fileName, 0, url)
            playSound('complete')
            useNetworkStore.setState(s => ({
              transfers: s.transfers.map(t =>
                t.id === meta.transferId ? { ...t, progress: 1, status: 'completed' as const } : t,
              ),
            }))
            shortIdToTransferId.get(peerSessionId)?.delete(meta.shortId)
          }
          return
        }

        if (msg.type === 'resume') {
          const resumeRequest = msg as ResumeRequest
          const file = sendingFiles.get(resumeRequest.transferId)
          const record = await getTransfer(resumeRequest.transferId)
          if (file && record) {
            const peerNodeId = useNetworkStore.getState().peers.find(p => p.sessionId === peerSessionId)?.nodeId ?? 0
            const lanes = await ensureTransferLanes(peerSessionId)
            // decodeResumeRequest handles both legacy (`receivedChunks`)
            // and new (`receivedRanges`) wire formats, capped at totalChunks
            // so a malformed peer can't trigger an oversize bitmap alloc.
            const peerBitmap = decodeResumeRequest(resumeRequest, record.totalChunks)
            engineSendFileParallel(lanes, file, resumeRequest.transferId, peerNodeId, peerSessionId, record, undefined, peerBitmap)
              .then(() => sendingFiles.delete(resumeRequest.transferId))
              .catch(() => {})
          }
          return
        }

        if (msg.type === 'chat') {
          // P2-3: cap incoming chat payload defensively. A malicious / buggy
          // peer should not be able to wedge our chat panel with a megabyte
          // of text. Match the sender-side cap.
          const rawContent = String(msg.content ?? msg.text ?? '')
          const content = rawContent.length > 16 * 1024 ? rawContent.slice(0, 16 * 1024) : rawContent
          const chatMsg: ChannelMessage = {
            id: msg.id || genMsgId(),
            type: 'text',
            content,
            timestamp: msg.timestamp || Date.now(),
            direction: 'recv',
          }
          useNetworkStore.setState(s => {
            const msgs = [...(s.chatMessages[peerSessionId] ?? []), chatMsg]
            const shouldMarkUnread = s.selectedSessionId !== peerSessionId
            const prevUnread = s.unreadByPeer[peerSessionId] ?? { message: 0, file: 0 }
            return {
              chatMessages: { ...s.chatMessages, [peerSessionId]: msgs },
              unreadByPeer: shouldMarkUnread
                ? { ...s.unreadByPeer, [peerSessionId]: { ...prevUnread, message: prevUnread.message + 1 } }
                : s.unreadByPeer,
            }
          })
          // Acknowledge receipt so the sender's UI can show "delivered".
          try { dc.send(JSON.stringify({ type: 'msg-ack', id: msg.id })) } catch { /* ignore */ }
          return
        }

        if (msg.type === 'msg-ack') {
          updateMessageStatus(peerSessionId, msg.id, 'delivered')
          return
        }

        // Peer-driven transfer control plane — these arrive when the OTHER
        // side clicked pause / resume / cancel on the same transfer.
        // We mirror the local signal so the existing checkSignals / receiveChunk
        // paths handle it uniformly. Without these, "pause on the receiver"
        // was a UI lie: the sender kept blasting and the receiver kept saving.
        if (msg.type === 'transfer-pause' && typeof msg.transferId === 'string') {
          pauseTransfer(msg.transferId)
          useNetworkStore.setState(s => ({
            transfers: s.transfers.map(t =>
              t.id === msg.transferId ? { ...t, status: 'paused' as const } : t,
            ),
          }))
          return
        }
        if (msg.type === 'transfer-resume' && typeof msg.transferId === 'string') {
          resumeTransfer(msg.transferId)
          useNetworkStore.setState(s => ({
            transfers: s.transfers.map(t =>
              t.id === msg.transferId ? { ...t, status: 'transferring' as const } : t,
            ),
          }))
          return
        }
        if (msg.type === 'transfer-cancel' && typeof msg.transferId === 'string') {
          engineCancelTransfer(msg.transferId)
          cancelReceive(msg.transferId)
          cancelStreamWrite(msg.transferId)
          cleanupOPFS(msg.transferId).catch(() => {})
          sendingFiles.delete(msg.transferId)
          transferSpeedSamples.delete(msg.transferId)
          useNetworkStore.setState(s => ({
            transfers: s.transfers.filter(t => t.id !== msg.transferId),
          }))
          return
        }
      } catch { /* not JSON */ }
    }
  }
}

async function attemptIceRestart(peerSessionId: string) {
  if (iceRestarting.has(peerSessionId)) return
  const attempts = iceRestartAttempts.get(peerSessionId) ?? 0
  if (attempts >= MAX_ICE_RESTART_ATTEMPTS) {
    useNetworkStore.setState(s => ({
      peers: s.peers.map(p =>
        p.sessionId === peerSessionId ? { ...p, status: 'offline' as NodeStatus } : p,
      ),
    }))
    failPendingMessages(peerSessionId)
    appendSystemChat(peerSessionId, '连接已断开，未送达的消息可点击 ↺ 重试')
    return
  }

  iceRestarting.add(peerSessionId)
  // P2-5: previously incremented BEFORE the early-out checks below. A
  // restart that hit `signalingState !== 'stable'` and aborted at line ~1390
  // still burned an attempt, so 5 fast aborts marked the peer offline
  // without a single real retry. Defer the +1 until we're past the early
  // exits.

  // Exponential backoff: spread out retries so we don't hammer the signaling
  // server when the network is genuinely down.
  const delay = ICE_RESTART_BACKOFF_MS[Math.min(attempts, ICE_RESTART_BACKOFF_MS.length - 1)]
  if (delay > 0) await new Promise(r => setTimeout(r, delay))

  useNetworkStore.setState(s => ({
    peers: s.peers.map(p =>
      p.sessionId === peerSessionId ? { ...p, status: 'reconnecting' as NodeStatus } : p,
    ),
  }))

  try {
    const pc = peerConnections.get(peerSessionId)
    if (!pc || pc.connectionState === 'closed' || pc.connectionState === 'failed') {
      cleanupPeerConnection(peerSessionId, { failQueuedMessages: false })
      // initiateWebRTC IS a real restart attempt — count it.
      iceRestartAttempts.set(peerSessionId, attempts + 1)
      await initiateWebRTC(peerSessionId)
      return
    }

    // If we're not in 'stable', a restart offer would either collide with our
    // own outstanding offer or step on an inbound one. Skip — the
    // perfect-negotiation rollback in handleRemoteSDP will recover us.
    // Don't burn an attempt for a no-op.
    if (pc.signalingState !== 'stable') {
      console.warn('[net] skipping iceRestart, signalingState=', pc.signalingState)
      return
    }

    iceRestartAttempts.set(peerSessionId, attempts + 1)
    const offer = await pc.createOffer({ iceRestart: true })
    await pc.setLocalDescription(offer)
    // Trickle — candidates will stream via onicecandidate. (Same fix as
    // createOffer/createAnswer: the `{ once: true }` gathering wait could
    // miss the `complete` event and hang the restart forever.)
    wsSend({ t: 'SIGNAL_SDP', targetSessionId: peerSessionId, sdp: pc.localDescription!.toJSON() })
  } catch {
    useNetworkStore.setState(s => ({
      peers: s.peers.map(p =>
        p.sessionId === peerSessionId ? { ...p, status: 'offline' as NodeStatus } : p,
      ),
    }))
  } finally {
    iceRestarting.delete(peerSessionId)
  }
}

async function deliverCompletedFile(transferId: string, peerSessionId: string) {
  if (deliveredTransfers.has(transferId)) return
  deliveredTransfers.add(transferId)

  const handle = getWriteHandle(transferId)
  const opfsHandle = getOPFSHandle(transferId)

  if (handle) {
    try {
      const streamedFile = await finalizeStreamedFile(transferId)
      const url = URL.createObjectURL(streamedFile)
      appendFileChat(peerSessionId, streamedFile.name, streamedFile.size, url)
      playSound('complete')
      cleanupTransferRecord(transferId)
    } catch (err) {
      failTransferRecord(transferId, String(err))
      deliveredTransfers.delete(transferId)
      playSound('error')
    }
  } else if (opfsHandle && opfsHandle.written.size === opfsHandle.totalChunks) {
    try {
      const file = await getOPFSFile(transferId)
      const url = URL.createObjectURL(file)
      appendFileChat(peerSessionId, file.name, file.size, url)
      playSound('complete')
      cleanupTransferRecord(transferId)
      cleanupOPFS(transferId).catch(() => {})
    } catch (err) {
      failTransferRecord(transferId, String(err))
      deliveredTransfers.delete(transferId)
      playSound('error')
      cleanupOPFS(transferId).catch(() => {})
    }
  } else {
    try {
      const assembledFile = await completeReceive(transferId)
      const url = URL.createObjectURL(assembledFile)
      appendFileChat(peerSessionId, assembledFile.name, assembledFile.size, url)
      playSound('complete')
      cleanupTransferRecord(transferId)
    } catch (err) {
      failTransferRecord(transferId, String(err))
      deliveredTransfers.delete(transferId)
      playSound('error')
      // #15: assemble can throw with a partial IndexedDB chunk set ("Missing
      // chunk N"). Without this, the orphan chunk rows leak to disk forever.
      import('@/lib/db').then(({ deleteChunks }) => deleteChunks(transferId).catch(() => {}))
    }
  }
  // Common cleanup: drop the demux entry for any peer's map that pointed at
  // this transferId. Otherwise long sessions accumulate stale entries forever.
  for (const peerMap of shortIdToTransferId.values()) {
    for (const [shortId, tid] of peerMap) {
      if (tid === transferId) peerMap.delete(shortId)
    }
  }
}

function appendFileChat(peerSessionId: string, fileName: string, fileSize: number, downloadUrl: string) {
  const m: ChannelMessage = {
    id: genMsgId(), type: 'file', content: fileName,
    timestamp: Date.now(), direction: 'recv',
    fileName, fileSize, downloadUrl,
  }
  useNetworkStore.setState(s => {
    const msgs = [...(s.chatMessages[peerSessionId] ?? []), m]
    const shouldMarkUnread = s.selectedSessionId !== peerSessionId
    const prevUnread = s.unreadByPeer[peerSessionId] ?? { message: 0, file: 0 }
    return {
      chatMessages: { ...s.chatMessages, [peerSessionId]: msgs },
      unreadByPeer: shouldMarkUnread
        ? { ...s.unreadByPeer, [peerSessionId]: { ...prevUnread, file: prevUnread.file + 1 } }
        : s.unreadByPeer,
    }
  })
  // Nit fix: notifyIncomingFile already fired at transfer start (meta handler
  // line ~1258). Firing it again on completion produced two OS toasts per
  // received file. The start-of-transfer toast is the user-actionable one
  // ("decline before the big upload arrives") — the completion is signalled
  // visually by the file card itself.
}

function cleanupTransferRecord(transferId: string) {
  transferSpeedSamples.delete(transferId)
  import('@/lib/db').then(({ deleteChunks }) => deleteChunks(transferId).catch(() => {}))
  useNetworkStore.setState(s => ({
    transfers: s.transfers.map(t =>
      t.id === transferId ? { ...t, progress: 1, status: 'completed' as const } : t,
    ),
  }))
}

function failTransferRecord(transferId: string, error: string) {
  transferSpeedSamples.delete(transferId)
  useNetworkStore.setState(s => ({
    transfers: s.transfers.map(t =>
      t.id === transferId ? { ...t, status: 'failed' as const, error } : t,
    ),
  }))
}

async function sendResumeRequests(peerSessionId: string, dc: RTCDataChannel) {
  if (dc.label.startsWith('misaka-transfer-')) return
  const active = await getActiveTransfers()
  const peerNodeId = useNetworkStore.getState().peers.find(p => p.sessionId === peerSessionId)?.nodeId ?? 0
  for (const record of active) {
    if (record.direction === 'recv' && record.peerNodeId === peerNodeId) {
      const req = await buildResumeRequest(record.transferId)
      if (req && dc.readyState === 'open') dc.send(JSON.stringify(req))
    }
  }
}

function cleanupPeerConnection(sessionId: string, options: { failQueuedMessages?: boolean } = {}) {
  const { failQueuedMessages = true } = options
  if (failQueuedMessages) failPendingMessages(sessionId)
  iceRestartAttempts.delete(sessionId)
  iceRestarting.delete(sessionId)
  clearDisconnectedTimer(sessionId)
  // Detach dc.onclose BEFORE calling dc.close(). Otherwise the listener set in
  // setupDataChannel sees pc still alive (we close dc first, pc second) and
  // fires attemptIceRestart for a connection we're intentionally tearing down,
  // which flips the peer status to 'reconnecting' the moment the user does
  // anything that triggers a fresh ensureConnected() — the "click send → 重新协商中"
  // symptom on LAN peers.
  const dc = dataChannels.get(sessionId)
  if (dc) {
    dc.onclose = null
    dc.close()
    dataChannels.delete(sessionId)
  }
  const lanes = transferLanes.get(sessionId)
  if (lanes) {
    for (const lane of lanes) {
      lane.onclose = null
      lane.close()
    }
    transferLanes.delete(sessionId)
  }
  const pc = peerConnections.get(sessionId)
  if (pc) { pc.close(); peerConnections.delete(sessionId) }
  ecdhResolvers.delete(sessionId)
  connectingPeers.delete(sessionId)
  remoteInitiatingPeers.delete(sessionId)
  const resolvers = primaryChannelResolvers.get(sessionId)
  if (resolvers) {
    primaryChannelResolvers.delete(sessionId)
    for (const resolve of resolvers) resolve()
  }
  resetCrypto(sessionId)
  pendingIceCandidates.delete(sessionId)
  shortIdToTransferId.delete(sessionId)
  // Without this, when an ICE-failed peer is cleaned up but PEER_LEFT is
  // never received (unilateral local teardown), `connectedPeers` keeps the
  // stale sessionId. Downstream code that consults it for "is this peer
  // reachable?" then takes the wrong branch.
  useNetworkStore.setState(s => {
    if (!s.connectedPeers.has(sessionId)) return s
    const next = new Set(s.connectedPeers)
    next.delete(sessionId)
    return { connectedPeers: next }
  })
}
