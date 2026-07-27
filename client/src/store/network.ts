import { create } from 'zustand'
import type { Peer, Transfer, NodeStatus, ChannelMessage, MessageStatus, PendingFileItem } from '@/types'
import {
  connect as wsConnect, disconnect as wsDisconnect, send as wsSend,
  onMessage, onConnect, onDisconnect, onSessionEnd, reconnectNow,
} from '@/lib/signaling'
import {
  createPeerConnection, createDataChannel, createOffer, createAnswer,
  applyAnswer, addIceCandidate, getSelectedChannelType, getSelectedIcePath,
  ensureAutoTurnReady, applyIceConfigToAll, isRelayAllowed,
  whenSignalingStable, endOfCandidatesFor, installIceErrorListener,
} from '@/lib/webrtc'
import {
  generateECDHKeyPair, getMyPublicKey, setPeerPublicKey,
  resetCrypto, hasAESKey,
} from '@/lib/crypto'
import {
  sendFileParallel as engineSendFileParallel, handleMetaMessage, receiveChunk,
  cancelReceive, createTransferId, buildResumeRequest,
  pauseTransfer, resumeTransfer, cancelTransfer as engineCancelTransfer,
  cancelStreamWrite,
  cleanupOPFS,
  decodeChunkFrame, decodeResumeRequest,
  clearTransferSignal,
  TransferCancelledError,
  // P0 delivery-semantics group (protocol v2).
  makeHelloMessage, setPeerProtocolVersion,
  validateMetaMessage, prepareReceiveBackend, finalizeReceive,
  buildRepairRequest, applyRepairRequest, markReceiverReady, markReceiverRejected,
  markTransferAcked, hasLiveSendTask,
  applyPeerPause, applyPeerResume, applyPeerCancel,
  resetTransferModuleState, forgetTransfer,
  TransferOwnershipError,
  type SendCallbacks, type ResumeRequest,
  type TransferOwner, type DeliveryState,
} from '@/lib/transfer'
import { getTransfer, getActiveTransfers, pruneTerminalTransfers } from '@/lib/db'
import { playSound } from '@/lib/sound'
import { notifyIncomingFile } from '@/lib/notify'
import { refreshAutoTurn, clearAutoTurn, onTurnConfigChange, fetchTurnStatus, getAutoTurnState, loadTurnSettings } from '@/lib/turn'
import { detectNatType, onNatTypeChange, getDetectedNatType, invalidateDetectedNatType, type NatType } from '@/lib/nat'
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
// peerSessionId → the peer generation the in-flight restart belongs to. A Map
// (not a Set) so a stale restart can only release the lock it took itself —
// otherwise it cleared the lock of the connection that replaced it (BUG-007).
const iceRestarting = new Map<string, number>()
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
// BUG-016: how far each transfer really got. `Transfer.status` stays the
// coarse UI state; this map carries the durable-delivery truth
// (queued → delivered → saved) that the ✓ badge must not overstate.
const transferDelivery = new Map<string, DeliveryState>()
export function getTransferDeliveryState(transferId: string): DeliveryState | undefined {
  return transferDelivery.get(transferId)
}
let currentToken = ''

// ── Bounded terminal retention (QUALITY-001) ─────────────────────────
// Nothing in the app reads a completed transfer card, a delivered chat
// message or a finished receive session after the user has moved on, yet all
// three grew without limit for the lifetime of a tab. The store keeps a short
// tail so the UI still shows recent history; `pruneTerminalTransfers()` does
// the same for the IndexedDB rows.
const MAX_TERMINAL_TRANSFER_CARDS = 30
const MAX_CHAT_MESSAGES_PER_PEER = 300

function isTerminalTransfer(t: Transfer): boolean {
  return t.status === 'completed' || t.status === 'failed' || t.status === 'failed:unsupported'
}

/**
 * Drop the oldest terminal transfer cards beyond the retention window. Active,
 * pending and paused transfers are never touched — they are live state.
 */
export function pruneTerminalTransferCards(transfers: Transfer[]): Transfer[] {
  const terminalCount = transfers.reduce((n, t) => n + (isTerminalTransfer(t) ? 1 : 0), 0)
  if (terminalCount <= MAX_TERMINAL_TRANSFER_CARDS) return transfers
  let toDrop = terminalCount - MAX_TERMINAL_TRANSFER_CARDS
  const kept: Transfer[] = []
  for (const t of transfers) {
    if (toDrop > 0 && isTerminalTransfer(t)) {
      toDrop--
      transferSpeedSamples.delete(t.id)
      transferDelivery.delete(t.id)
      deliveredTransfers.delete(t.id)
      continue
    }
    kept.push(t)
  }
  return kept
}

/** Bound one peer's chat log, revoking object URLs the dropped entries pinned. */
export function pruneChatMessages(msgs: ChannelMessage[]): ChannelMessage[] {
  if (msgs.length <= MAX_CHAT_MESSAGES_PER_PEER) return msgs
  const dropped = msgs.slice(0, msgs.length - MAX_CHAT_MESSAGES_PER_PEER)
  for (const m of dropped) {
    if (m.downloadUrl) { try { URL.revokeObjectURL(m.downloadUrl) } catch { /* ignore */ } }
  }
  return msgs.slice(msgs.length - MAX_CHAT_MESSAGES_PER_PEER)
}

// ── Session epoch (BUG-001 / BUG-002) ────────────────────────────────
// One epoch = one authenticated signaling session. A new token, a new
// `WELCOME.sessionId`, or an explicit logout ends the current epoch: peer
// connections, data channels, ECDH keys, in-flight transfers and chat all
// belong to the identity that created them and must never survive into the
// next one. `networkEpoch` is monotonic so async work started under a dead
// epoch can detect that it has been superseded.
let networkEpoch = 0
export function getNetworkEpoch(): number { return networkEpoch }

// Per-peer monotonic generation. Every teardown or fresh initiation bumps it,
// so any task that parked on an await can tell whether the connection it was
// working on is still the current one (BUG-005 / BUG-007).
const peerGenerations = new Map<string, number>()
// In-flight initiations, keyed by peer and tagged with the generation they
// were started for. Registered SYNCHRONOUSLY (before the first await) so two
// entry points can never both create a PeerConnection.
const initiatingPeers = new Map<string, { gen: number; task: Promise<void> }>()
// Per-peer serialization chain for inbound signaling (BUG-006).
const peerTaskQueues = new Map<string, Promise<void>>()
// Unsubscribers for everything init() registered on the signaling module.
// `signaling.disconnect()` deliberately no longer wipes the global handler
// sets (the auth store's onAuthInvalid contract lives in the same sets), so
// destroy() has to remove exactly what it added — otherwise a second init()
// would process every signal twice.
const unsubscribeSignaling: Array<() => void> = []

function peerGeneration(peerSessionId: string): number {
  return peerGenerations.get(peerSessionId) ?? 0
}

function bumpPeerGeneration(peerSessionId: string): number {
  const next = peerGeneration(peerSessionId) + 1
  peerGenerations.set(peerSessionId, next)
  return next
}

function isCurrentGeneration(peerSessionId: string, gen: number): boolean {
  return peerGeneration(peerSessionId) === gen
}

/**
 * Run `fn` after every previously queued task for this peer. Rejections are
 * logged and contained: they must neither escape as an unhandled rejection
 * nor poison the rest of the queue.
 */
function enqueuePeerTask(peerSessionId: string, what: string, fn: () => Promise<void>): Promise<void> {
  const previous = peerTaskQueues.get(peerSessionId) ?? Promise.resolve()
  const next = previous.then(fn).catch(err => {
    console.warn(`[net] ${what} failed`, peerSessionId, err)
  })
  peerTaskQueues.set(peerSessionId, next)
  return next
}

// Messages typed before the DC fully opened, flushed in dc.onopen. Each entry
// keeps its msgId so a partial flush can report exactly which messages made it
// (BUG-020) instead of marking the whole batch 'sent'.
interface OutgoingItem { payload: string; msgId?: string }
const outgoingQueue = new Map<string, OutgoingItem[]>()
// Track msgIds in outgoingQueue so we can update their status on flush or failure.
const queuedMessageIds = new Map<string, Set<string>>()

function queueOutgoing(peerSessionId: string, payload: string, msgId?: string) {
  const q = outgoingQueue.get(peerSessionId) ?? []
  q.push({ payload, msgId })
  outgoingQueue.set(peerSessionId, q)
  if (msgId) {
    const ids = queuedMessageIds.get(peerSessionId) ?? new Set<string>()
    ids.add(msgId)
    queuedMessageIds.set(peerSessionId, ids)
  }
}

/** Per-message outcome of one flush attempt (BUG-020). */
export interface FlushResult {
  sent: string[]
  failed: string[]
}

/**
 * BUG-020: the flush used to `try { dc.send(p) } catch { /* ignore *​/ }` every
 * queued payload, then unconditionally delete the queue and mark EVERY queued
 * id as 'sent'. A channel that closed mid-flush therefore reported success for
 * messages that never left the tab, and the payloads were gone — no retry set,
 * no failure surfaced.
 *
 * Now each payload is tracked individually: only what actually reached
 * `dc.send()` is removed and marked 'sent'; the rest stay queued and are
 * marked 'failed' so the ↺ affordance is truthful.
 */
function flushOutgoing(peerSessionId: string, dc: RTCDataChannel): FlushResult {
  const result: FlushResult = { sent: [], failed: [] }
  const q = outgoingQueue.get(peerSessionId)
  if (!q?.length) return result

  const remaining: OutgoingItem[] = []
  for (const item of q) {
    if (dc.readyState !== 'open') {
      remaining.push(item)
      if (item.msgId) result.failed.push(item.msgId)
      continue
    }
    try {
      dc.send(item.payload)
      if (item.msgId) result.sent.push(item.msgId)
    } catch {
      remaining.push(item)
      if (item.msgId) result.failed.push(item.msgId)
    }
  }

  if (remaining.length > 0) outgoingQueue.set(peerSessionId, remaining)
  else outgoingQueue.delete(peerSessionId)

  const ids = queuedMessageIds.get(peerSessionId)
  if (ids) {
    for (const id of result.sent) { updateMessageStatus(peerSessionId, id, 'sent'); ids.delete(id) }
    for (const id of result.failed) updateMessageStatus(peerSessionId, id, 'failed')
    if (ids.size === 0) queuedMessageIds.delete(peerSessionId)
  }
  return result
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

// ── Signaling readiness barrier (BUG-004) ────────────────────────────
// `wsSend()` silently drops anything written before the socket is OPEN, and
// the server discards SIGNAL_* frames until the sender is authenticated and
// in a channel. A recovery sweep that fired while the WS was still coming
// back therefore built a PeerConnection, created an offer nobody received,
// and left that PC parked in `peerConnections` — where it then blocked every
// later initiate (`if (peerConnections.has(...)) return`).
//
// Readiness = socket open AND WELCOME processed AND JOIN_CLUSTER sent.
// JOIN needs no ack: the socket is ordered, so anything we send after it is
// processed by the server after the join.
const SIGNALING_READY_TIMEOUT_MS = 8_000
let signalingJoined = false
const signalingReadyWaiters = new Set<(ready: boolean) => void>()

function isSignalingReady(): boolean {
  const s = useNetworkStore.getState()
  return s.signalingStatus === 'online' && s.mySessionId !== null && signalingJoined
}

function notifySignalingReady() {
  if (!isSignalingReady()) return
  for (const settle of [...signalingReadyWaiters]) settle(true)
}

/** Epoch end / logout: settle every waiter as "not ready" instead of
 *  leaving them parked until their timeout fires. */
function abortSignalingReadyWaiters() {
  for (const settle of [...signalingReadyWaiters]) settle(false)
  signalingReadyWaiters.clear()
}

function whenSignalingReady(timeoutMs = SIGNALING_READY_TIMEOUT_MS): Promise<boolean> {
  if (isSignalingReady()) return Promise.resolve(true)
  return new Promise<boolean>(resolve => {
    const settle = (ready: boolean) => {
      clearTimeout(timer)
      signalingReadyWaiters.delete(settle)
      resolve(ready)
    }
    const timer = setTimeout(() => settle(false), timeoutMs)
    signalingReadyWaiters.add(settle)
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

// BUG-009: `setConfiguration()` only affects the NEXT gathering round — the
// already-selected candidate pair keeps carrying traffic on the old path, so
// toggling relay (or rotating credentials) left the actual route disagreeing
// with the Settings UI. `applyIceConfigToAll` reports which live PCs saw a
// materially different config; we migrate those with an ICE restart once
// signaling is stable and the connection is still the current one.
//
// Changes are coalesced: a settings edit can emit several notifications in a
// row (server list + master switch + force relay) and we only want one
// restart per peer.
const ICE_MIGRATION_DEBOUNCE_MS = 300
let iceMigrationTimer: ReturnType<typeof setTimeout> | null = null
const pendingIceMigration = new Set<string>()

function sessionIdForPc(pc: RTCPeerConnection): string | null {
  for (const [sid, candidate] of peerConnections) {
    if (candidate === pc) return sid
  }
  return null
}

function propagateIceConfig() {
  const changed = applyIceConfigToAll(peerConnections.values()) ?? []
  for (const pc of changed) {
    const sid = sessionIdForPc(pc)
    if (sid) pendingIceMigration.add(sid)
  }
  if (pendingIceMigration.size === 0 || iceMigrationTimer) return
  iceMigrationTimer = setTimeout(() => {
    iceMigrationTimer = null
    const targets = [...pendingIceMigration]
    pendingIceMigration.clear()
    for (const sid of targets) void migrateIcePath(sid)
  }, ICE_MIGRATION_DEBOUNCE_MS)
}

async function migrateIcePath(peerSessionId: string) {
  const pc = peerConnections.get(peerSessionId)
  if (!pc) return
  const gen = peerGeneration(peerSessionId)
  const epoch = networkEpoch
  // Nothing to migrate on a connection that hasn't picked a path yet — its
  // first gathering round already uses the new config.
  if (pc.iceConnectionState !== 'connected' && pc.iceConnectionState !== 'completed') return
  try {
    if (pc.signalingState !== 'stable') {
      await whenSignalingStable(pc, { timeoutMs: 10_000 })
    }
    // Re-verify everything the awaits could have invalidated.
    if (epoch !== networkEpoch || !isCurrentGeneration(peerSessionId, gen)) return
    if (peerConnections.get(peerSessionId) !== pc) return
    if (!isSignalingReady()) return
    const offer = await pc.createOffer({ iceRestart: true })
    if (epoch !== networkEpoch || peerConnections.get(peerSessionId) !== pc) return
    await pc.setLocalDescription(offer)
    wsSend({ t: 'SIGNAL_SDP', targetSessionId: peerSessionId, sdp: pc.localDescription!.toJSON() })
  } catch (err) {
    console.warn('[net] ICE path migration failed', peerSessionId, err)
  }
}

function installTurnConfigPropagation() {
  if (turnConfigUnsubscribe) return
  turnConfigUnsubscribe = onTurnConfigChange(() => {
    // Apply current TURN config (new auto creds, toggled force-relay, manual
    // server changes) to every live RTCPeerConnection. Without this, an
    // existing connection's ICE config is frozen at the moment of
    // construction and any later credential rotation or settings change is
    // ignored until the PC is torn down and re-built.
    propagateIceConfig()
  })
  // P1: also rebuild config when NAT type changes (e.g. user clicks the
  // detect button in Settings and we discover symmetric NAT). Same rationale
  // as TURN config — existing PCs would otherwise stay on the old policy.
  if (!natConfigUnsubscribe) {
    natConfigUnsubscribe = onNatTypeChange((t) => {
      // Mirror the published NAT type into the store so the UI banner can
      // react without imperatively polling `getDetectedNatType()`.
      useNetworkStore.setState({ myNatType: t })
      propagateIceConfig()
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
  // BUG-008: the master switch gates auto TURN too. With relaying turned off
  // there is no relay of either kind, so a symmetric NAT really is a dead end.
  if (!isRelayAllowed()) return true
  if (s.autoTurnAvailable) return false
  const settings = loadTurnSettings()
  const hasManualTurn = settings.enabled && settings.servers.some(srv => srv.enabled)
  return !hasManualTurn
}

// ── Four-layer status model (UX-COPY-003) ────────────────────────────
// The UI used to collapse four independent facts into one badge, so a dead
// signaling socket still read "已接入" and an idle-but-healthy peer read
// "数据流注入中". They are modelled separately:
//
//   1. auth      — the auth store's session token (is our identity valid?)
//   2. signaling — `signalingStatus` below (can we reach the coordinator?)
//   3. peer transport — per-peer `Peer.status` + `connectedPeers`
//   4. transfer  — `transfers[]`
//
// `deriveNetworkStatus` folds layers 2–4 into the single badge the header
// shows, picking the layer that actually explains the current situation.

export type SignalingStatus = 'idle' | 'connecting' | 'online' | 'reconnecting' | 'offline'
export type NetworkStatusKey = 'online' | 'transferring' | 'connecting' | 'reconnecting' | 'offline'

const NETWORK_STATUS_LABELS: Record<NetworkStatusKey, string> = {
  online: '在线',
  transferring: '正在传输',
  connecting: '正在连接',
  reconnecting: '正在重新连接',
  offline: '已离线',
}

export function networkStatusLabel(key: NetworkStatusKey): string {
  return NETWORK_STATUS_LABELS[key]
}

function isActiveTransfer(t: Transfer): boolean {
  return t.status === 'transferring' || t.status === 'pending'
}

export function deriveNetworkStatus(
  s: Pick<NetworkState, 'signalingStatus' | 'peers' | 'transfers'>,
): NetworkStatusKey {
  // Signaling first: if the coordinator is unreachable, that is the fact the
  // user needs (and the one with a retry affordance), whatever the peers say.
  if (s.signalingStatus === 'idle' || s.signalingStatus === 'offline') return 'offline'
  if (s.signalingStatus === 'reconnecting') return 'reconnecting'
  if (s.signalingStatus === 'connecting') return 'connecting'

  const connectedPeers = s.peers.filter(p => p.status === 'online' || p.status === 'transferring')
  if (connectedPeers.length > 0) {
    const busy = s.transfers.some(t => isActiveTransfer(t)
      && connectedPeers.some(p => p.sessionId === t.peerSessionId))
    return busy ? 'transferring' : 'online'
  }
  if (s.peers.some(p => p.status === 'reconnecting')) return 'reconnecting'
  // Signaling is up but no peer transport is established yet.
  return 'connecting'
}

/**
 * Display status for one peer row. The store keeps `Peer.status` as pure
 * transport state; "正在传输" is a property of the transfer layer, so it is
 * derived here instead of being written into the peer record.
 */
export function peerDisplayStatus(peer: Peer, transfers: Transfer[]): NodeStatus {
  if (peer.status !== 'online') return peer.status
  const busy = transfers.some(t => t.peerSessionId === peer.sessionId && isActiveTransfer(t))
  return busy ? 'transferring' : 'online'
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

/**
 * BUG-004: after signaling comes back (fresh WELCOME + JOIN), re-negotiate
 * every peer we still know about whose connection did not survive. Attempts
 * made while signaling was down were refused by the readiness barrier, so
 * something has to pick them up again — and the generation check makes this
 * safe to run alongside the server's own PEER_JOINED-driven initiations.
 */
function renegotiateOrphanPeers() {
  for (const peer of useNetworkStore.getState().peers) {
    if (remoteInitiatingPeers.has(peer.sessionId)) continue
    const pc = peerConnections.get(peer.sessionId)
    const dc = dataChannels.get(peer.sessionId)
    const alive = pc && pc.connectionState !== 'closed' && pc.connectionState !== 'failed'
      && dc && dc.readyState !== 'closed'
    if (alive) continue
    cleanupPeerConnection(peer.sessionId, { failQueuedMessages: false })
    initiateWebRTC(peer.sessionId).catch(err => console.warn('[net] orphan renegotiate failed', err))
  }
}

function recoverConnections() {
  const now = Date.now()
  if (now - lastRecoverAt < 1_500) return
  lastRecoverAt = now
  // Network environment may have changed (Wi-Fi ↔ cellular, VPN flip) — cached
  // NAT classification is stale; force a re-probe on the next request so
  // buildIceConfig picks the right relay policy.
  invalidateDetectedNatType()
  natProbeStarted = false
  if (currentToken) {
    reconnectNow()
    void refreshAutoTurn()
    startNatAndTurnProbes()
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

/**
 * BUG-020: raised by `sendFilesToAll` when SOME targets failed. Carries the
 * exact (peer, file) pairs so the UI can offer a scoped retry instead of the
 * old "all-or-silence" behaviour.
 */
export class PartialFanoutError extends Error {
  failures: Array<{ peerSessionId: string; fileName: string }>
  constructor(message: string, failures: Array<{ peerSessionId: string; fileName: string }>) {
    super(message)
    this.name = 'PartialFanoutError'
    this.failures = failures
  }
}

// ── Epoch teardown ───────────────────────────────────────────────────

/**
 * Hook for the transfer layer's epoch teardown.
 *
 * Ending an epoch must also stop every in-flight send/receive engine, but the
 * transfer lifecycle lives in `lib/transfer.ts` and is owned separately — so
 * the epoch code calls exactly this one named hook instead of reaching into
 * transfer internals. Replace it with `setEpochTransferTeardown()` to extend
 * the behaviour (e.g. flush partial receives, keep resumable records) without
 * touching any epoch logic.
 */
export type EpochTransferTeardown = (transfers: Transfer[]) => void

function defaultEpochTransferTeardown(transfers: Transfer[]) {
  for (const t of transfers) {
    if (t.status === 'completed') continue
    try { engineCancelTransfer(t.id) } catch { /* engine may not know it */ }
    void cancelReceive(t.id)
    try { cancelStreamWrite(t.id) } catch { /* no stream writer */ }
    cleanupOPFS(t.id).catch(() => {})
    clearTransferSignal(t.id)
    // Ownership, ready-barrier, buffered frames and any live send task belong
    // to the epoch that is ending (SECURITY-015).
    forgetTransfer(t.id)
  }
  sendingFiles.clear()
  transferSpeedSamples.clear()
  deliveredTransfers.clear()
  shortIdToTransferId.clear()
  transferDelivery.clear()
  // The transfer module also holds per-peer negotiated protocol versions,
  // in-flight backend preparations and owner records for transfers that never
  // made it into `state.transfers`. All of it is epoch-scoped.
  resetTransferModuleState()
  // QUALITY-001: an epoch boundary is the natural moment to retire terminal
  // DB rows — nothing in the next epoch can resume them.
  void pruneTerminalTransfers().catch(() => {})
}

let epochTransferTeardown: EpochTransferTeardown = defaultEpochTransferTeardown

export function setEpochTransferTeardown(fn: EpochTransferTeardown | null) {
  epochTransferTeardown = fn ?? defaultEpochTransferTeardown
}

/**
 * End the current network epoch: everything scoped to the authenticated
 * session is destroyed and the epoch counter is bumped so any async work
 * still parked on an await can detect that it has been superseded.
 *
 * Idempotent and safe to call when nothing was ever connected.
 */
function endNetworkEpoch(reason: string) {
  networkEpoch++
  signalingJoined = false
  // Unblock anything parked on the readiness barrier: this epoch will never
  // become ready, so those attempts must fail fast rather than time out.
  abortSignalingReadyWaiters()

  const state = useNetworkStore.getState()
  const scopedIds = new Set<string>([
    ...peerConnections.keys(),
    ...remoteInitiatingPeers,
    ...state.peers.map(p => p.sessionId),
  ])
  for (const sid of scopedIds) cleanupPeerConnection(sid)
  peerGenerations.clear()
  initiatingPeers.clear()
  peerTaskQueues.clear()
  pendingIceMigration.clear()
  if (iceMigrationTimer) { clearTimeout(iceMigrationTimer); iceMigrationTimer = null }

  epochTransferTeardown(state.transfers)
  // Drop every ECDH/AES key: they were negotiated by the identity that just
  // went away and must never be reused for the next one.
  resetCrypto()

  // Revoke cached object URLs — they pin File/Blob bytes (and OPFS handles)
  // in memory for as long as the chatMessages entries live.
  for (const msgs of Object.values(state.chatMessages)) {
    for (const m of msgs) {
      if (m.downloadUrl) { try { URL.revokeObjectURL(m.downloadUrl) } catch { /* ignore */ } }
    }
  }

  console.warn(`[net] network epoch ended (${reason}) → ${networkEpoch}`)
  useNetworkStore.setState({
    mySessionId: null, channelId: null,
    peers: [], selectedSessionId: null, transfers: [],
    chatMessages: {}, pendingFiles: {}, connectedPeers: new Set(), unreadByPeer: {},
    sendingPeers: new Set(),
  })
}

interface NetworkState {
  // Layer 2 of the four-layer status model (UX-COPY-003). `wsConnected` is
  // the raw socket fact; `signalingStatus` is the authenticated+joined view
  // the UI should render.
  wsConnected: boolean
  signalingStatus: SignalingStatus
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
  // Convenience wrappers for receiver-side controls. The receiver UI only knows
  // the transferId; these look up the peerSessionId from the live transfer record
  // and delegate to pauseTransfer/resumeTransfer/cancelTransferAction.
  pauseReceiveTransfer: (transferId: string) => void
  resumeReceiveTransfer: (transferId: string) => Promise<void>
  cancelReceiveTransfer: (transferId: string) => void
  sendChatMessage: (peerSessionId: string, text: string) => void
  retryChatMessage: (peerSessionId: string, msgId: string) => void
  blockPeer: (sessionId: string) => void
  recoverConnections: () => void
  // Force-rebuild a peer connection (used by the "立即重连此节点" button on the
  // offline-peer banner). Resolves once the rebuild attempt has been kicked off
  // — the actual ICE handshake completes asynchronously.
  reconnectPeer: (sessionId: string) => Promise<void>
}

export const useNetworkStore = create<NetworkState>((set, get) => ({
  wsConnected: false,
  signalingStatus: 'idle',
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
        // BUG-002: a different token is a different authenticated identity.
        // Everything the previous epoch built (peers, PC/DC, ECDH keys,
        // transfers, chat) belongs to that identity — end the epoch BEFORE
        // the new session can start routing through the same maps.
        endNetworkEpoch('token-changed')
        currentToken = token
        set({ signalingStatus: 'connecting' })
        wsConnect(token)
      }
      return
    }
    initialized = true
    currentToken = token
    unsubscribeSignaling.push(onMessage((msg) => {
      switch (msg.t) {
        case 'WELCOME': {
          // BUG-002: the server may hand us a *different* sessionId on a
          // reconnect (our old session was GC'd / released). Peers, keys and
          // transfers keyed to the previous sessionId are dead — start a
          // fresh epoch instead of letting the two coexist. A repeated
          // WELCOME for the SAME session is just a transient WS drop and must
          // keep the live peer connections (that is what makes resume fast).
          const previousSessionId = get().mySessionId
          if (previousSessionId !== null && previousSessionId !== msg.sessionId) {
            endNetworkEpoch('session-id-changed')
          }
          set({ wsConnected: true, signalingStatus: 'online', mySessionId: msg.sessionId })
          // Auto-join the identity-scoped cluster channel.
          wsSend({ t: 'JOIN_CLUSTER' })
          // The socket is ordered, so anything sent after JOIN_CLUSTER is
          // processed by the server after the join: signaling is now "ready"
          // for SDP/ICE (BUG-004).
          signalingJoined = true
          notifySignalingReady()
          // Re-negotiate orphans: peers we still know about that have no live
          // connection (their PC died while signaling was down).
          renegotiateOrphanPeers()
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
        case 'SIGNAL_SDP':
          void enqueuePeerTask(msg.fromSessionId, 'handleRemoteSDP',
            () => handleRemoteSDP(msg.fromSessionId, msg.fromNodeId, msg.sdp))
          break

        case 'SIGNAL_ICE':
          void enqueuePeerTask(msg.fromSessionId, 'handleRemoteICE',
            () => handleRemoteICE(msg.fromSessionId, msg.candidate))
          break

        case 'SIGNAL_ICE_END':
          void enqueuePeerTask(msg.fromSessionId, 'handleRemoteICEEnd',
            () => handleRemoteICEEnd(msg.fromSessionId))
          break

        case 'PEER_OFFLINE': {
          // Server-side hint that our outbound SIGNAL_SDP / SIGNAL_ICE never
          // reached the target — they have no live socket. Mark the peer
          // 'offline' so the UI can offer the "立即重连" affordance instead
          // of letting the user stare at a silent 30s ICE failure timeout.
          const sid = msg.targetSessionId
          set(s => ({
            peers: s.peers.map(p =>
              p.sessionId === sid ? { ...p, status: 'offline' as NodeStatus } : p,
            ),
          }))
          break
        }

        case 'SERVER_SHUTDOWN':
          console.warn(`[Signaling] 服务器关闭: ${msg.reason}`)
          signalingJoined = false
          set({ wsConnected: false, signalingStatus: 'offline' })
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
      set({ wsConnected: true, signalingStatus: 'connecting' })
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
    }))
    unsubscribeSignaling.push(onDisconnect(() => {
      signalingJoined = false
      set({
        wsConnected: false,
        // The socket dropped but we still hold a token, so signaling.ts is
        // already scheduling a retry — that is 'reconnecting', not 'offline'.
        signalingStatus: currentToken ? 'reconnecting' : 'offline',
      })
    }))
    // BUG-001: an explicit logout must end the epoch even when this page
    // isn't mounted — the auth store calls endSession() and we tear down.
    unsubscribeSignaling.push(onSessionEnd(() => {
      useNetworkStore.getState().destroy()
    }))

    set({ signalingStatus: 'connecting' })
    wsConnect(token)
    installForegroundRecovery()
    installTurnConfigPropagation()
  },

  destroy() {
    // Order: stop signaling first so nothing re-enters while we tear the
    // epoch down, then destroy every session-scoped artefact.
    wsDisconnect()
    for (const off of unsubscribeSignaling.splice(0)) {
      try { off() } catch { /* ignore */ }
    }
    endNetworkEpoch('destroy')
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
    set({
      wsConnected: false, signalingStatus: 'idle',
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
    // BUG-021: remember exactly WHICH staged ids succeeded. The old code
    // snapshotted `items` at entry and, on `allOk`, deleted the whole
    // `pendingFiles[sessionId]` bucket — so anything the user added while the
    // snapshot was in flight was silently destroyed without ever being sent.
    const sentIds: string[] = []
    try {
      for (const item of items) {
        const ok = await sendFileToPeer(item.file, sessionId, item.displayName)
        if (ok) sentIds.push(item.id)
      }
    } finally {
      set(s => {
        const next = new Set(s.sendingPeers)
        next.delete(sessionId)
        return { sendingPeers: next }
      })
    }
    if (sentIds.length > 0) {
      const done = new Set(sentIds)
      set(s => {
        const remaining = (s.pendingFiles[sessionId] ?? []).filter(item => !done.has(item.id))
        if (remaining.length === 0) {
          const { [sessionId]: _drop, ...rest } = s.pendingFiles
          return { pendingFiles: rest }
        }
        return { pendingFiles: { ...s.pendingFiles, [sessionId]: remaining } }
      })
    }
    // Failures (and anything staged mid-flight) stay put so the user can retry.
  },

  async sendFile(file) {
    const sid = get().selectedSessionId
    if (!sid) throw new Error('未选择目标节点')
    await sendFileToPeer(file, sid)
  },

  async sendFilesToAll(files) {
    const targets = get().peers.filter(p => p.status !== 'offline').map(p => p.sessionId)
    if (targets.length === 0) throw new Error('没有可用的目标节点')
    // BUG-020: a fanout used to `allSettled` and discard every result, so a
    // broadcast where every peer failed looked identical to one where every
    // peer succeeded. Keep the per-(peer, file) outcome and surface a partial
    // success to the caller.
    const jobs = targets.flatMap(sid => files.map(file => ({ sid, file })))
    const settled = await Promise.allSettled(
      jobs.map(job => sendFileToPeer(job.file, job.sid)),
    )
    const failures = jobs.filter((_job, i) => {
      const r = settled[i]
      return r.status === 'rejected' || r.value === false
    })
    if (failures.length === jobs.length) {
      throw new Error(`群发失败：${jobs.length} 个目标全部未送达`)
    }
    if (failures.length > 0) {
      const peers = new Set(failures.map(f => f.sid))
      throw new PartialFanoutError(
        `部分节点未送达：${failures.length}/${jobs.length} 个任务失败（${peers.size} 个节点）`,
        failures.map(f => ({ peerSessionId: f.sid, fileName: f.file.name })),
      )
    }
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
    // Receiver-driven pause: tell the sender to stop. Chunks already inside
    // the SCTP queue keep arriving for a moment and are recorded (not just
    // dropped) by `receiveChunk` so `buildRepairRequest` can ask for them back
    // on resume — see BUG-013 and the resume path below.
    const t = get().transfers.find(tr => tr.id === transferId)
    if (t && t.direction === 'recv') {
      const dc = dataChannels.get(t.peerSessionId)
      if (dc?.readyState === 'open') {
        try { dc.send(JSON.stringify({ type: 'transfer-pause', transferId })) } catch { /* ignore */ }
      }
    }
  },

  async resumeTransfer(transferId, peerSessionId) {
    const t = get().transfers.find(tr => tr.id === transferId)
    // BUG-019: a failed transfer's Retry used to flip the card to
    // "transferring" and then silently return when the source file, the DB
    // record or the DataChannel was gone. Validate every precondition BEFORE
    // touching the status, and surface a structured failure otherwise.
    const precondition = await checkResumePreconditions(transferId, peerSessionId, t)
    if (!precondition.ok) {
      failTransferRecord(transferId, precondition.message)
      appendSystemChat(peerSessionId, `无法继续传输：${precondition.message}`)
      throw new TransferResumeError(precondition.code, precondition.message)
    }

    resumeTransfer(transferId)
    set(s => ({
      transfers: s.transfers.map(t => t.id === transferId ? { ...t, status: 'transferring' as const } : t),
    }))

    if (t && t.direction === 'recv') {
      const dc = dataChannels.get(peerSessionId)
      if (dc?.readyState === 'open') {
        try { dc.send(JSON.stringify({ type: 'transfer-resume', transferId })) } catch { /* ignore */ }
        // BUG-013: everything the pause discarded (plus anything else still
        // missing) goes back on the wire as an explicit repair request. Without
        // it the sender considers those chunks sent and the transfer can never
        // reach 100 % again.
        const repair = buildRepairRequest(transferId)
        if (repair) {
          try { dc.send(JSON.stringify(repair)) } catch { /* ignore */ }
        }
      }
      // Receiver side: nothing else to do — the sender owns the send loop.
      return
    }

    // Send side. `engineSendFileParallel` wakes the LIVE task when one exists
    // (BUG-014) and only starts a fresh engine when the previous one has fully
    // settled, so this can no longer produce two engines for one id.
    const owner = ownerFor(peerSessionId)
    const file = sendingFiles.get(transferId)!
    const record = await getTransfer(transferId)
    const request = await buildResumeRequest(transferId, owner)
    const peerNodeId = get().peers.find(p => p.sessionId === peerSessionId)?.nodeId ?? 0
    const lanes = await ensureTransferLanes(peerSessionId)
    const peerBitmap = request && record ? decodeResumeRequest(request, record.totalChunks) : undefined
    await runSendEngine(lanes, file, transferId, peerNodeId, peerSessionId, record, peerBitmap, owner)
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
    // cancelReceive is now async (P0-2 fix): it awaits in-flight saveChunk
    // ops before clearing IDB chunks to avoid orphan rows. Fire-and-forget
    // here is intentional — the UI removes the card synchronously below.
    void cancelReceive(transferId)
    cancelStreamWrite(transferId)
    cleanupOPFS(transferId).catch(() => {})
    sendingFiles.delete(transferId)
    transferSpeedSamples.delete(transferId)
    transferDelivery.delete(transferId)
    forgetTransfer(transferId)
    set(s => ({ transfers: s.transfers.filter(t => t.id !== transferId) }))
  },

  pauseReceiveTransfer(transferId) {
    get().pauseTransfer(transferId)
  },

  async resumeReceiveTransfer(transferId) {
    const t = get().transfers.find(tr => tr.id === transferId)
    // BUG-019: a missing transfer is a real failure, not a silent no-op — the
    // caller has a button that must report why nothing happened.
    if (!t) throw new TransferResumeError('unknown-transfer', '该传输记录已不存在')
    await get().resumeTransfer(transferId, t.peerSessionId)
  },

  cancelReceiveTransfer(transferId) {
    get().cancelTransferAction(transferId)
  },

  async reconnectPeer(sessionId) {
    // Tear the dead PC down explicitly — recoverConnections() rate-limits to
    // 1.5s and may no-op if the user is mashing the button. This path is
    // explicit user intent, so bypass the throttle for this specific peer.
    cleanupPeerConnection(sessionId, { failQueuedMessages: false })
    useNetworkStore.setState(s => ({
      peers: s.peers.map(p =>
        p.sessionId === sessionId ? { ...p, status: 'connecting' as const } : p,
      ),
    }))
    try {
      await initiateWebRTC(sessionId)
    } catch (err) {
      console.warn('[net] reconnectPeer failed', err)
      useNetworkStore.setState(s => ({
        peers: s.peers.map(p =>
          p.sessionId === sessionId ? { ...p, status: 'offline' as const } : p,
        ),
      }))
    }
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
  useNetworkStore.setState(s => ({ transfers: pruneTerminalTransferCards([...s.transfers, transfer]) }))
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
    onDeliveryState(state) {
      transferDelivery.set(transferId, state)
    },
  }

  try {
    sendingFiles.set(transferId, file)
    const outcome = await engineSendFileParallel(
      dcs, file, transferId, peerNodeId, peerSessionId, undefined, callbacks,
      undefined, networkEpoch,
    )
    transferDelivery.set(transferId, outcome.state)
    // BUG-016: hold the source File until the receiver confirms a DURABLE
    // write. A v1 peer can never confirm, so legacy semantics still release it
    // — but for a v2 peer, "the last dc.send() returned" is not a reason to
    // throw away the only thing a retry could use.
    if (outcome.state === 'saved' || outcome.legacyPeer) sendingFiles.delete(transferId)
    clearTransferSignal(transferId)
    useNetworkStore.setState(s => ({
      transfers: s.transfers.map(t =>
        t.id === transferId ? { ...t, progress: 1, status: 'completed' as const } : t,
      ),
    }))
    appendSystemChat(
      peerSessionId,
      outcome.state === 'saved'
        ? `已发送文件 ${displayName}`
        : `已送出文件 ${displayName}（等待对方确认落盘）`,
      'sent',
    )
    playSound('complete')
    transferSpeedSamples.delete(transferId)
    return true
  } catch (e) {
    sendingFiles.delete(transferId)
    transferDelivery.delete(transferId)
    clearTransferSignal(transferId)
    transferSpeedSamples.delete(transferId)
    // A cancel (local or peer-driven) is not a failure: the transfer card is
    // already 'failed' via checkSignals; show a neutral notice, no error tone.
    if (e instanceof TransferCancelledError) {
      appendSystemChat(peerSessionId, `已取消发送 ${displayName}`, 'sent')
      return false
    }
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
    const msgs = pruneChatMessages([...(s.chatMessages[peerSessionId] ?? []), m])
    return { chatMessages: { ...s.chatMessages, [peerSessionId]: msgs } }
  })
}

/**
 * Start (or join) the outbound negotiation for one peer.
 *
 * BUG-005: the in-flight task is registered SYNCHRONOUSLY, before the first
 * await, and tagged with the peer generation it belongs to. Two entry points
 * (auto-initiate, manual reconnect, recovery sweep, queued send) therefore
 * either share one attempt or supersede it — they can no longer both build a
 * PeerConnection, overwrite each other in `peerConnections` and leave one of
 * them alive but unreachable by any cleanup path.
 */
function initiateWebRTC(peerSessionId: string): Promise<void> {
  const inFlight = initiatingPeers.get(peerSessionId)
  // Only reuse an attempt that belongs to the CURRENT generation — a
  // cleanup/teardown in between means the caller wants a genuinely new
  // connection, and the old task is about to abort itself.
  if (inFlight && inFlight.gen === peerGeneration(peerSessionId)) return inFlight.task

  const gen = bumpPeerGeneration(peerSessionId)
  const task = initiateWebRTCInner(peerSessionId, gen).finally(() => {
    const current = initiatingPeers.get(peerSessionId)
    if (current && current.gen === gen) initiatingPeers.delete(peerSessionId)
  })
  initiatingPeers.set(peerSessionId, { gen, task })
  return task
}

/** Close a PeerConnection this attempt built but is no longer allowed to use. */
function abandonPeerConnection(peerSessionId: string, pc: RTCPeerConnection) {
  if (peerConnections.get(peerSessionId) === pc) peerConnections.delete(peerSessionId)
  try { pc.close() } catch { /* already dead */ }
}

async function initiateWebRTCInner(peerSessionId: string, gen: number) {
  if (peerConnections.has(peerSessionId)) return
  const epoch = networkEpoch

  // BUG-004: never build a PC (and burn an offer) before signaling is
  // authenticated AND joined — `wsSend` drops silently while the socket is
  // down, and the residual PC then blocked every later attempt.
  if (!await whenSignalingReady()) {
    throw new Error('信令尚未就绪，暂时无法建立连接')
  }
  if (epoch !== networkEpoch || !isCurrentGeneration(peerSessionId, gen)) return

  // Without this, the first PC after WELCOME is built before the auto-TURN
  // credential fetch resolves — symmetric-NAT peers get a non-relay PC,
  // first ICE round fails, only the second restart attempt (~5s later) has
  // TURN. Wait briefly for credentials so the very first handshake has them.
  await ensureAutoTurnReady()
  if (epoch !== networkEpoch || !isCurrentGeneration(peerSessionId, gen)) return
  if (peerConnections.has(peerSessionId)) return

  const pc = createPeerConnection()
  installIceErrorListener(pc)
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
  if (epoch !== networkEpoch || peerConnections.get(peerSessionId) !== pc) {
    abandonPeerConnection(peerSessionId, pc)
    return
  }

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
  // Superseded while the browser was building the offer: the SDP belongs to a
  // connection nobody routes through any more, so publishing it would make
  // the remote answer the wrong PC.
  if (epoch !== networkEpoch || peerConnections.get(peerSessionId) !== pc) {
    abandonPeerConnection(peerSessionId, pc)
    return
  }
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
    installIceErrorListener(pc)
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
  // Firefox rejects sdpMid:'' — endOfCandidatesFor reads a real mid from
  // the PC's first transceiver so both Chrome and FF accept the marker.
  try { await pc.addIceCandidate(endOfCandidatesFor(pc)) }
  catch { /* some browsers still reject the marker; harmless */ }
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
        if (prevStatus === 'online' || prevStatus === 'transferring') {
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
            // UX-COPY-003: `Peer.status` is TRANSPORT state only. A healthy
            // idle peer is 'online' — it used to be written as 'transferring'
            // ("数据流注入中") the instant ICE connected, with no transfer in
            // sight. The transfer layer is derived via `peerDisplayStatus()`.
            status: 'online' as NodeStatus,
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
      // Transport is up — see the UX-COPY-003 note in onIceConnected.
      peers: s.peers.map(p =>
        p.sessionId === peerSessionId ? { ...p, status: 'online' as const } : p,
      ),
      connectedPeers: new Set([...s.connectedPeers, peerSessionId]),
    }))
    // Only the primary channel announces reconnection. setupDataChannel also
    // runs for all TRANSFER_LANE_COUNT lane channels; without this guard each
    // of the 5 'open' handlers appended its own '✓ 连接已恢复' on one reconnect.
    if (isReconnect && !dc.label.startsWith('misaka-transfer-')) {
      appendSystemChat(peerSessionId, '✓ 连接已恢复')
    }
    if (!dc.label.startsWith('misaka-transfer-')) {
      try {
        // Protocol handshake first: `hello` tells the peer which delivery
        // semantics we implement. A v1 peer ignores the unknown message and
        // both sides fall back to v1 (see negotiatedProtocolVersion).
        dc.send(makeHelloMessage())
      } catch { /* channel may already be dying */ }
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
    const owner = ownerFor(peerSessionId)
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
        // BUG-017: `receiveChunk` now owns the whole decrypt → DURABLE WRITE →
        // bitmap → persist → progress sequence. This handler used to perform
        // the OPFS / FSA write itself AFTER receiveChunk had already recorded
        // and persisted the chunk, so a crash in between left a resume bitmap
        // claiming bytes that were never on disk. Nothing writes out here any
        // more, and `result.done` is only true once the last byte is durable.
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

        if (result?.done) await deliverCompletedFile(transferId, peerSessionId)
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

        // Protocol handshake (v2). Must be processed before anything that
        // depends on the negotiated version.
        if (msg.type === 'hello') {
          setPeerProtocolVersion(peerSessionId, msg.v)
          return
        }

        if (msg.type === 'ecdh-pub') {
          await setPeerPublicKey(peerSessionId, msg.pub)
          ecdhResolvers.get(peerSessionId)?.()
          flushOutgoing(peerSessionId, dc)
          sendResumeRequests(peerSessionId, dc)
          return
        }

        if (msg.type === 'meta') {
          await handleIncomingMeta(msg, peerSessionId, dc, owner)
          return
        }

        if (msg.type === 'resume') {
          await handleResumeRequest(msg as ResumeRequest, peerSessionId, owner)
          return
        }

        // BUG-011: the receiver has committed a writable backend — the sender
        // may start shipping payload.
        if (msg.type === 'transfer-ready' && typeof msg.transferId === 'string') {
          markReceiverReady(msg.transferId, owner)
          return
        }
        // Receiver refused before any payload moved.
        if (msg.type === 'transfer-reject' && typeof msg.transferId === 'string') {
          if (markReceiverRejected(msg.transferId, owner)) {
            sendingFiles.delete(msg.transferId)
            failTransferRecord(msg.transferId, String(msg.message ?? '接收端拒绝了该传输'))
          }
          return
        }
        // BUG-013: receiver lost in-flight chunks to a pause — re-queue exactly
        // those indexes into the LIVE send task (never a second engine).
        if (msg.type === 'transfer-repair' && typeof msg.transferId === 'string') {
          const requeued = applyRepairRequest(msg, owner)
          if (requeued < 0) await restartSendForRepair(msg.transferId, peerSessionId, owner)
          return
        }
        // BUG-016: the receiver has the file durably written.
        if (msg.type === 'transfer-done' && typeof msg.transferId === 'string') {
          if (markTransferAcked(msg.transferId, owner)) {
            transferDelivery.set(msg.transferId, 'saved')
            sendingFiles.delete(msg.transferId)
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
            const msgs = pruneChatMessages([...(s.chatMessages[peerSessionId] ?? []), chatMsg])
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
        // SECURITY-015: every one of them is ownership-checked. `peerNodeId`
        // is shared by all devices of an identity, so without the
        // (peerSessionId, epoch) check a third device in the cluster could
        // pause or cancel a transfer between two others.
        if (msg.type === 'transfer-pause' && typeof msg.transferId === 'string') {
          if (!applyPeerPause(msg.transferId, owner)) return
          useNetworkStore.setState(s => ({
            transfers: s.transfers.map(t =>
              t.id === msg.transferId ? { ...t, status: 'paused' as const } : t,
            ),
          }))
          return
        }
        if (msg.type === 'transfer-resume' && typeof msg.transferId === 'string') {
          if (!applyPeerResume(msg.transferId, owner)) return
          useNetworkStore.setState(s => ({
            transfers: s.transfers.map(t =>
              t.id === msg.transferId ? { ...t, status: 'transferring' as const } : t,
            ),
          }))
          return
        }
        if (msg.type === 'transfer-cancel' && typeof msg.transferId === 'string') {
          if (!applyPeerCancel(msg.transferId, owner)) return
          cancelReceive(msg.transferId)
          cancelStreamWrite(msg.transferId)
          cleanupOPFS(msg.transferId).catch(() => {})
          sendingFiles.delete(msg.transferId)
          transferSpeedSamples.delete(msg.transferId)
          transferDelivery.delete(msg.transferId)
          forgetTransfer(msg.transferId)
          useNetworkStore.setState(s => ({
            transfers: s.transfers.filter(t => t.id !== msg.transferId),
          }))
          return
        }
      } catch { /* not JSON */ }
    }
  }
}

/** The `(peerSessionId, epoch)` pair every control message is checked against. */
function ownerFor(peerSessionId: string): TransferOwner {
  return { peerSessionId, epoch: networkEpoch }
}

// ── Resume / retry preconditions (BUG-019) ───────────────────────────
// Retry on a failed send used to be optimistic: it flipped the card to
// "transferring", then hit one of several silent early returns (no live
// DataChannel, no persisted record, source File already released) and left a
// permanently fake in-progress card with no bytes moving and no way back.

export type ResumeFailureCode =
  | 'unknown-transfer'
  | 'not-resumable'
  | 'source-missing'
  | 'record-missing'
  | 'channel-unavailable'

export class TransferResumeError extends Error {
  code: ResumeFailureCode
  constructor(code: ResumeFailureCode, message: string) {
    super(message)
    this.name = 'TransferResumeError'
    this.code = code
  }
}

type PreconditionResult =
  | { ok: true }
  | { ok: false; code: ResumeFailureCode; message: string }

export async function checkResumePreconditions(
  transferId: string,
  peerSessionId: string,
  transfer: Transfer | undefined,
): Promise<PreconditionResult> {
  if (!transfer) {
    return { ok: false, code: 'unknown-transfer', message: '该传输记录已不存在' }
  }
  if (transfer.status === 'completed') {
    return { ok: false, code: 'not-resumable', message: '该传输已完成' }
  }
  const dc = dataChannels.get(peerSessionId)
  if (!dc || dc.readyState !== 'open') {
    return { ok: false, code: 'channel-unavailable', message: '与该节点的数据信道尚未就绪' }
  }
  // Receiver side needs nothing else — the sender owns the send loop.
  if (transfer.direction === 'recv') return { ok: true }

  if (!sendingFiles.has(transferId)) {
    return {
      ok: false,
      code: 'source-missing',
      message: '源文件已释放，请重新选择该文件后再发送',
    }
  }
  const record = await getTransfer(transferId)
  if (!record) {
    return { ok: false, code: 'record-missing', message: '传输记录已丢失，请重新发送该文件' }
  }
  return { ok: true }
}

/**
 * Inbound `meta`, end to end:
 *
 *   validate (SECURITY-007) → ownership (SECURITY-015) → register demux →
 *   register session → prepare + PROVE a writable backend, deduplicated per
 *   (peer, transfer) (BUG-011) → apply the size cap to the COMMITTED backend
 *   (BUG-012) → ACK `transfer-ready` so the sender may ship payload.
 *
 * Nothing may write a byte before the ACK; chunks that a legacy (v1) sender
 * pushes early are buffered inside the receive session and replayed in index
 * order once the backend commits.
 */
async function handleIncomingMeta(
  raw: unknown,
  peerSessionId: string,
  dc: RTCDataChannel,
  owner: TransferOwner,
) {
  const validated = validateMetaMessage(raw)
  if (!validated.ok) {
    console.warn('[net] rejecting malformed meta', validated.code, validated.message)
    const badId = (raw as { transferId?: unknown })?.transferId
    if (typeof badId === 'string' && badId.length > 0 && badId.length <= 256) {
      try {
        dc.send(JSON.stringify({
          type: 'transfer-reject', transferId: badId,
          reason: validated.code, message: validated.message,
        }))
      } catch { /* peer DC might already be dying */ }
    }
    appendSystemChat(peerSessionId, `已拒绝一个非法的传输请求：${validated.message}`)
    return
  }
  const meta = validated.meta
  setPeerProtocolVersion(peerSessionId, meta.v)
  const peerNodeId = useNetworkStore.getState().peers.find(p => p.sessionId === peerSessionId)?.nodeId ?? 0

  // Register shortId → transferId BEFORE any await. If a chunk for this
  // transfer arrives while the session is still being created (very common —
  // meta + chunk are queued back-to-back on the lane), the binary-frame
  // handler MUST already see the demux entry.
  let peerMap = shortIdToTransferId.get(peerSessionId)
  if (!peerMap) {
    peerMap = new Map()
    shortIdToTransferId.set(peerSessionId, peerMap)
  }
  peerMap.set(meta.shortId, meta.transferId)

  try {
    await handleMetaMessage(meta, peerNodeId, owner)
  } catch (err) {
    // Ownership / immutable-metadata mismatch: never touch existing state.
    peerMap.delete(meta.shortId)
    const message = err instanceof TransferOwnershipError ? err.message : String(err)
    console.warn('[net] rejecting meta', message)
    try {
      dc.send(JSON.stringify({
        type: 'transfer-reject', transferId: meta.transferId,
        reason: 'owner-mismatch', message,
      }))
    } catch { /* ignore */ }
    appendSystemChat(peerSessionId, `已拒绝接收 ${meta.fileName}：${message}`)
    return
  }

  const prepared = await prepareReceiveBackend({
    transferId: meta.transferId,
    fileName: meta.fileName,
    totalChunks: meta.totalChunks,
    size: meta.fileSize,
  }, owner).catch((err): { ok: false; rejection: { reason: string; message: string } } => ({
    ok: false,
    rejection: { reason: 'no-writable-backend', message: String(err) },
  }))

  if (!prepared.ok) {
    // BUG-012: the cap is applied to the backend we actually committed, so a
    // Chromium tab that lost the save picker and fell back to IndexedDB is
    // refused here rather than OOM-ing halfway through.
    try {
      dc.send(JSON.stringify({ type: 'transfer-reject', transferId: meta.transferId, reason: prepared.rejection.reason, message: prepared.rejection.message }))
      dc.send(JSON.stringify({ type: 'transfer-cancel', transferId: meta.transferId }))
    } catch { /* peer DC might already be dying — ignore */ }
    peerMap.delete(meta.shortId)
    await cancelReceive(meta.transferId).catch(() => {})
    useNetworkStore.setState(s => {
      if (s.transfers.some(t => t.id === meta.transferId)) return s
      return {
        transfers: pruneTerminalTransferCards([...s.transfers, {
          id: meta.transferId, direction: 'recv' as const,
          peerSessionId, peerNodeId,
          fileName: meta.fileName, fileSize: meta.fileSize,
          progress: 0, speedBps: 0,
          status: 'failed:unsupported' as const,
          error: prepared.rejection.message,
          startedAt: Date.now(),
        }]),
      }
    })
    appendSystemChat(peerSessionId, `已拒绝接收 ${meta.fileName}：${prepared.rejection.message}`)
    playSound('error')
    return
  }

  useNetworkStore.setState(s => {
    if (s.transfers.some(t => t.id === meta.transferId)) return s
    return {
      transfers: pruneTerminalTransferCards([...s.transfers, {
        id: meta.transferId, direction: 'recv' as const,
        peerSessionId, peerNodeId,
        fileName: meta.fileName, fileSize: meta.fileSize,
        progress: 0, speedBps: 0, status: 'transferring' as const,
        startedAt: Date.now(),
        storageMode: prepared.mode,
      }]),
    }
  })

  // The ACK is what unparks the sender (BUG-011). Sent only after the backend
  // is committed and the card exists.
  try {
    dc.send(JSON.stringify({ type: 'transfer-ready', transferId: meta.transferId, shortId: meta.shortId }))
  } catch { /* the sender's own timeout covers this */ }

  const alreadyAnnounced = useNetworkStore.getState().chatMessages[peerSessionId]
    ?.some(m => m.type === 'system' && m.content === `正在接收文件 ${meta.fileName}`)
  if (!alreadyAnnounced) appendSystemChat(peerSessionId, `正在接收文件 ${meta.fileName}`)
  // #16: surface an OS notification at start-of-transfer so a tab-backgrounded
  // recipient can decline a big incoming file early.
  notifyIncomingFile({ peerNodeId, fileName: meta.fileName, fileSize: meta.fileSize })

  // #5: zero-byte files send no chunks at all (totalChunks=0). The chunk-driven
  // completion gate never fires; deliver synthetically and clean up.
  if (meta.totalChunks === 0 && meta.fileSize === 0) {
    const emptyFile = new File([new Blob([], { type: meta.mime })], meta.fileName, { type: meta.mime })
    const url = URL.createObjectURL(emptyFile)
    appendFileChat(peerSessionId, meta.fileName, 0, url)
    playSound('complete')
    useNetworkStore.setState(s => ({
      transfers: s.transfers.map(t =>
        t.id === meta.transferId ? { ...t, progress: 1, status: 'completed' as const } : t,
      ),
    }))
    sendDurableAck(peerSessionId, meta.transferId, 0)
    peerMap.delete(meta.shortId)
    forgetTransfer(meta.transferId)
  }
}

/**
 * A peer asks us to resume sending. SECURITY-015: only the session that owns
 * the transfer may ask, and BUG-014: a live task is woken, never duplicated.
 */
async function handleResumeRequest(
  req: ResumeRequest,
  peerSessionId: string,
  owner: TransferOwner,
) {
  if (typeof req.transferId !== 'string') return
  const file = sendingFiles.get(req.transferId)
  const record = await getTransfer(req.transferId)
  if (!file || !record) return
  if (record.peerSessionId && record.peerSessionId !== peerSessionId) {
    console.warn('[net] refusing resume for a transfer owned by another session', req.transferId)
    return
  }
  const peerNodeId = useNetworkStore.getState().peers.find(p => p.sessionId === peerSessionId)?.nodeId ?? 0
  const lanes = await ensureTransferLanes(peerSessionId)
  // decodeResumeRequest handles both legacy (`receivedChunks`) and new
  // (`receivedRanges`) wire formats, capped at totalChunks so a malformed
  // peer can't trigger an oversize bitmap alloc.
  const peerBitmap = decodeResumeRequest(req, record.totalChunks)
  // engineSendFileParallel itself dedupes against the live task (BUG-014).
  void runSendEngine(lanes, file, req.transferId, peerNodeId, peerSessionId, record, peerBitmap, owner)
}

/**
 * A repair request arrived for a transfer whose send engine already finished.
 * Restart it from the persisted record — the requested indexes come back via
 * the resume bitmap path.
 */
async function restartSendForRepair(transferId: string, peerSessionId: string, owner: TransferOwner) {
  if (hasLiveSendTask(transferId)) return
  const file = sendingFiles.get(transferId)
  const record = await getTransfer(transferId)
  if (!file || !record) return
  if (record.peerSessionId && record.peerSessionId !== peerSessionId) return
  const peerNodeId = useNetworkStore.getState().peers.find(p => p.sessionId === peerSessionId)?.nodeId ?? 0
  const lanes = await ensureTransferLanes(peerSessionId)
  void runSendEngine(lanes, file, transferId, peerNodeId, peerSessionId, record, undefined, owner)
}

/** Shared tail for every resume/repair-driven send restart. */
async function runSendEngine(
  lanes: RTCDataChannel[],
  file: File,
  transferId: string,
  peerNodeId: number,
  peerSessionId: string,
  record: Awaited<ReturnType<typeof getTransfer>>,
  peerBitmap: Uint8Array | undefined,
  owner: TransferOwner,
) {
  try {
    const outcome = await engineSendFileParallel(
      lanes, file, transferId, peerNodeId, peerSessionId, record ?? undefined,
      undefined, peerBitmap, owner.epoch,
    )
    transferDelivery.set(transferId, outcome.state)
    // BUG-016: only release the retry source once the receiver confirmed a
    // durable write (or the peer is v1 and can never confirm).
    if (outcome.state === 'saved' || outcome.legacyPeer) sendingFiles.delete(transferId)
  } catch (err) {
    if (!(err instanceof TransferCancelledError)) {
      console.warn('[net] resume send failed', transferId, err)
    }
  }
}

/** Tell the sender their file is durably written (BUG-016). */
function sendDurableAck(peerSessionId: string, transferId: string, bytes: number) {
  const dc = dataChannels.get(peerSessionId)
  if (dc?.readyState !== 'open') return
  try {
    dc.send(JSON.stringify({ type: 'transfer-done', transferId, bytes }))
  } catch { /* the sender's ACK timeout covers this */ }
}

/**
 * BUG-007: an ICE restart sleeps through an exponential backoff (up to 16 s)
 * and may then wait for `signalingState === 'stable'`. During that window the
 * peer can leave, be blocked, or have its PeerConnection replaced by a manual
 * reconnect. The old code resumed against whatever was in the maps by then —
 * resurrecting departed peers, restarting a brand-new connection, and
 * clearing the *new* attempt's in-progress lock on the way out.
 *
 * Every await is therefore followed by a re-check of: the epoch, the peer
 * generation, the peer still being in the roster, and the exact PC identity.
 */
async function attemptIceRestart(peerSessionId: string) {
  if (iceRestarting.has(peerSessionId)) return
  const gen = peerGeneration(peerSessionId)
  const epoch = networkEpoch
  const stillCurrent = () =>
    epoch === networkEpoch
    && isCurrentGeneration(peerSessionId, gen)
    && useNetworkStore.getState().peers.some(p => p.sessionId === peerSessionId)

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

  // Tagged with the generation we took it for, so a superseded attempt can
  // only ever release its OWN lock.
  iceRestarting.set(peerSessionId, gen)
  // P2-5: previously incremented BEFORE the early-out checks below. A
  // restart that hit `signalingState !== 'stable'` and aborted at line ~1390
  // still burned an attempt, so 5 fast aborts marked the peer offline
  // without a single real retry. Defer the +1 until we're past the early
  // exits.

  try {
    // Exponential backoff: spread out retries so we don't hammer the signaling
    // server when the network is genuinely down.
    const delay = ICE_RESTART_BACKOFF_MS[Math.min(attempts, ICE_RESTART_BACKOFF_MS.length - 1)]
    if (delay > 0) await new Promise(r => setTimeout(r, delay))
    // The peer may have left / been blocked / been rebuilt while we slept.
    if (!stillCurrent()) return

    useNetworkStore.setState(s => ({
      peers: s.peers.map(p =>
        p.sessionId === peerSessionId ? { ...p, status: 'reconnecting' as NodeStatus } : p,
      ),
    }))

    const pc = peerConnections.get(peerSessionId)
    if (!pc || pc.connectionState === 'closed' || pc.connectionState === 'failed') {
      cleanupPeerConnection(peerSessionId, { failQueuedMessages: false })
      // initiateWebRTC IS a real restart attempt — count it. (cleanup bumped
      // the generation, so from here on we're driving the new one.)
      iceRestartAttempts.set(peerSessionId, attempts + 1)
      await initiateWebRTC(peerSessionId)
      return
    }

    // If we're not in 'stable', a restart offer would collide with an outstanding
    // local or inbound offer. Wait briefly for stable rather than skipping outright —
    // if perfect-negotiation rollback recovers us first, signalingState returns to
    // stable and the restart still goes through. If glare wedges us, the 10s
    // timeout caps the wait and we yield to the normal recovery path.
    if (pc.signalingState !== 'stable') {
      try {
        await whenSignalingStable(pc, { timeoutMs: 10_000 })
      } catch (err) {
        console.warn('[net] iceRestart wait-for-stable timed out', err)
        return
      }
      // Same re-check after the second await, plus PC identity: a manual
      // reconnect may have replaced the connection we were waiting on.
      if (!stillCurrent() || peerConnections.get(peerSessionId) !== pc) return
    }
    // Signaling must be back up, otherwise the restart offer is dropped by
    // `wsSend` and we've burned an attempt for nothing (BUG-004).
    if (!isSignalingReady()) return

    iceRestartAttempts.set(peerSessionId, attempts + 1)
    const offer = await pc.createOffer({ iceRestart: true })
    if (!stillCurrent() || peerConnections.get(peerSessionId) !== pc) return
    await pc.setLocalDescription(offer)
    if (!stillCurrent() || peerConnections.get(peerSessionId) !== pc) return
    // Trickle — candidates will stream via onicecandidate. (Same fix as
    // createOffer/createAnswer: the `{ once: true }` gathering wait could
    // miss the `complete` event and hang the restart forever.)
    wsSend({ t: 'SIGNAL_SDP', targetSessionId: peerSessionId, sdp: pc.localDescription!.toJSON() })
  } catch {
    if (stillCurrent()) {
      useNetworkStore.setState(s => ({
        peers: s.peers.map(p =>
          p.sessionId === peerSessionId ? { ...p, status: 'offline' as NodeStatus } : p,
        ),
      }))
    }
  } finally {
    if (iceRestarting.get(peerSessionId) === gen) iceRestarting.delete(peerSessionId)
  }
}

/**
 * BUG-018: ONE terminal completion path for every receive backend.
 *
 * There used to be three ad-hoc branches here (FSA handle / OPFS handle /
 * IDB assemble), each with its own partial cleanup. The OPFS one dropped the
 * file-name handle inside `getOPFSFile` before it could `removeEntry`, so the
 * origin-private copy survived, and none of them retired the `active` DB row,
 * the receive session or the resume bitmap. `finalizeReceive` in lib/transfer
 * now owns all of it — closing the backend, verifying the artefact is exactly
 * `fileSize` bytes, deleting chunks, removing the OPFS entry, marking the
 * record completed and dropping the session, signal and owner record.
 *
 * This function is the UI half: object URL, chat card, sound, transfer card,
 * demux cleanup and the receiver's durable-write ACK (BUG-016).
 */
async function deliverCompletedFile(transferId: string, peerSessionId: string) {
  if (deliveredTransfers.has(transferId)) return
  deliveredTransfers.add(transferId)

  try {
    const { file, bytes } = await finalizeReceive(transferId)
    const url = URL.createObjectURL(file)
    appendFileChat(peerSessionId, file.name, file.size, url)
    playSound('complete')
    cleanupTransferRecord(transferId)
    // BUG-016: tell the sender the bytes are durably written. Only now may it
    // report "saved" and release the retry source.
    sendDurableAck(peerSessionId, transferId, bytes)
  } catch (err) {
    failTransferRecord(transferId, String(err))
    deliveredTransfers.delete(transferId)
    playSound('error')
    // A failed finalize can leave a partial IndexedDB chunk set behind.
    import('@/lib/db').then(({ deleteChunks }) => deleteChunks(transferId).catch(() => {}))
    cleanupOPFS(transferId).catch(() => {})
  }
  // Common cleanup: drop the control signal (a receiver pause/resume creates
  // one) and the demux entry for any peer's map that pointed at this
  // transferId. Otherwise long sessions accumulate stale entries forever.
  clearTransferSignal(transferId)
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
  const owner = ownerFor(peerSessionId)
  const peerNodeId = useNetworkStore.getState().peers.find(p => p.sessionId === peerSessionId)?.nodeId ?? 0
  for (const record of active) {
    if (record.direction !== 'recv') continue
    // SECURITY-015: `peerNodeId` alone is not an owner — every device of one
    // identity shares it, so matching on it would have broadcast one device's
    // resume bitmap to a sibling device. Prefer the recorded session id and
    // only fall back to nodeId for records written before ownership existed.
    const belongs = record.peerSessionId
      ? record.peerSessionId === peerSessionId
      : record.peerNodeId === peerNodeId
    if (!belongs) continue
    const req = await buildResumeRequest(record.transferId, record.peerSessionId ? owner : undefined)
    if (req && dc.readyState === 'open') dc.send(JSON.stringify(req))
  }
}

function cleanupPeerConnection(sessionId: string, options: { failQueuedMessages?: boolean } = {}) {
  const { failQueuedMessages = true } = options
  if (failQueuedMessages) failPendingMessages(sessionId)
  // Anything still parked on an await for this peer (initiation, delayed ICE
  // restart, config migration) is now working on a dead connection — bumping
  // the generation is how those tasks learn to abort (BUG-005 / BUG-007).
  bumpPeerGeneration(sessionId)
  iceRestartAttempts.delete(sessionId)
  iceRestarting.delete(sessionId)
  pendingIceMigration.delete(sessionId)
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
