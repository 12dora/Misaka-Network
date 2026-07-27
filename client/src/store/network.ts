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
  whenSignalingStable, endOfCandidateMarkersFor, endOfCandidatesFor, installIceErrorListener,
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
interface PendingRemoteIceGroup {
  epoch: number
  incarnation: number
  negotiationToken: number
  key: string
  ufrag: string | null
  localOfferToken: number | null
  candidates: RTCIceCandidateInit[]
  endOfCandidates: Array<RTCIceCandidateInit | null>
  sequence: number
}
interface PendingRemoteIceHint {
  epoch: number
  incarnation: number
  negotiationToken: number
  key: string
  ufrag: string | null
}
export interface PendingRemoteIceOverflowState {
  groupDrops: number
  candidateDrops: number
  lastKind: 'group' | 'candidate'
}
const MAX_PENDING_REMOTE_ICE_GROUPS = 8
const MAX_PENDING_REMOTE_ICE_CANDIDATES_PER_GROUP = 256
const pendingRemoteIce = new Map<string, Map<string, PendingRemoteIceGroup>>()
const pendingRemoteNegotiationTokens = new Map<string, number>()
const pendingRemoteTokenReservations = new Map<string, Map<string, number>>()
const peerRemoteNegotiationCounters = new Map<string, number>()
const pendingRemoteIceHints = new Map<string, PendingRemoteIceHint>()
const installedRemoteNegotiationTokens = new Map<string, number>()
const pendingRemoteIceOverflow = new Map<string, PendingRemoteIceOverflowState>()
let pendingRemoteIceSequence = 0
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
// Chromium can occasionally remain in ICE "checking" forever even after
// both sides accepted host candidates. No failed/disconnected event means
// the normal recovery path never runs. Exactly one deterministic side owns
// a bounded initial ICE restart so both peers cannot create glare.
const initialIceRecoveryTimers = new Map<string, ReturnType<typeof setTimeout>>()
const initialEncryptedSessionRebuilds = new Set<string>()
const INITIAL_ICE_RECOVERY_MS = 8_000
const INITIAL_ICE_REOBSERVE_MS = 8_000
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
interface DownloadArtifactLifecycle {
  cleanup?: () => Promise<void>
  started: boolean
}
const artifactLifecycleByUrl = new Map<string, DownloadArtifactLifecycle>()
export function getTransferDeliveryState(transferId: string): DeliveryState | undefined {
  return transferDelivery.get(transferId)
}
export function markDownloadArtifactStarted(url: string) {
  const lifecycle = artifactLifecycleByUrl.get(url)
  if (lifecycle) lifecycle.started = true
}

/** Explicit acknowledgement that the browser has finished saving the file. */
export async function releaseDownloadArtifact(url: string) {
  try { URL.revokeObjectURL(url) } catch { /* ignore */ }
  const lifecycle = artifactLifecycleByUrl.get(url)
  artifactLifecycleByUrl.delete(url)
  await lifecycle?.cleanup?.()
}

/**
 * Automatic UI retirement may clean an artefact only if no download started.
 * Once clicked, browsers expose no completion signal; deleting a lazy OPFS
 * entry at that point can cancel a legitimate slow download.
 */
function retireDownloadArtifact(url: string) {
  const lifecycle = artifactLifecycleByUrl.get(url)
  if (lifecycle?.started) return
  void releaseDownloadArtifact(url)
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
    if (m.downloadUrl) retireDownloadArtifact(m.downloadUrl)
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
// Receipt-time incarnation for queued SDP/ICE. Peer generation alone is not
// enough here: a closure parked behind an old task used to capture generation
// only when it eventually started, at which point it could mistake a
// replacement PC for the frame's original target.
const peerSignalingIncarnations = new Map<string, number>()
// Token of the most recently published local SDP offer on the current PC.
// Answers are stamped with this at receipt so an old queued answer cannot be
// applied to a later ICE-restart offer on the same still-live PC.
const peerLocalOfferTokens = new Map<string, number>()
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

interface PeerGenerationAttempt {
  peerSessionId: string
  epoch: number
  gen: number
}

interface PeerConnectionAttempt extends PeerGenerationAttempt {
  pc: RTCPeerConnection
}

function captureGenerationAttempt(peerSessionId: string, gen = peerGeneration(peerSessionId)): PeerGenerationAttempt {
  return { peerSessionId, epoch: networkEpoch, gen }
}

function capturePeerConnectionAttempt(
  peerSessionId: string,
  pc: RTCPeerConnection,
  gen = peerGeneration(peerSessionId),
): PeerConnectionAttempt {
  return { ...captureGenerationAttempt(peerSessionId, gen), pc }
}

function isPeerGenerationAttemptCurrent(attempt: PeerGenerationAttempt): boolean {
  return attempt.epoch === networkEpoch
    && isCurrentGeneration(attempt.peerSessionId, attempt.gen)
    && useNetworkStore.getState().peers.some(peer => peer.sessionId === attempt.peerSessionId)
}

function isPeerConnectionAttemptCurrent(attempt: PeerConnectionAttempt): boolean {
  return isPeerGenerationAttemptCurrent(attempt)
    && peerConnections.get(attempt.peerSessionId) === attempt.pc
}

interface SignalReceipt {
  peerSessionId: string
  epoch: number
  incarnation: number
  gen: number
  originatingPc: RTCPeerConnection | null
  localOfferToken: number | null
  pendingRemoteNegotiationToken: number | null
  remoteIceGroupKey: string | null
  remoteIceUfrag: string | null
  remoteIceReservationKey: string | null
  remoteIceEndCandidate: RTCIceCandidateInit | null
}

function peerSignalingIncarnation(peerSessionId: string): number {
  return peerSignalingIncarnations.get(peerSessionId) ?? 0
}

function invalidatePeerSignalingIncarnation(peerSessionId: string) {
  peerSignalingIncarnations.set(
    peerSessionId,
    peerSignalingIncarnation(peerSessionId) + 1,
  )
  peerLocalOfferTokens.delete(peerSessionId)
  pendingRemoteIce.delete(peerSessionId)
  pendingRemoteNegotiationTokens.delete(peerSessionId)
  pendingRemoteTokenReservations.delete(peerSessionId)
  pendingRemoteIceHints.delete(peerSessionId)
  installedRemoteNegotiationTokens.delete(peerSessionId)
  pendingRemoteIceOverflow.delete(peerSessionId)
  // The active promise cannot be cancelled, but detaching the chain lets the
  // replacement incarnation process new frames immediately. Every closure
  // still retained by the old promise carries the invalid receipt stamp.
  peerTaskQueues.delete(peerSessionId)
}

function ensurePendingRemoteNegotiationToken(peerSessionId: string): number {
  const current = pendingRemoteNegotiationTokens.get(peerSessionId)
  if (current !== undefined) return current
  const next = (peerRemoteNegotiationCounters.get(peerSessionId) ?? 0) + 1
  peerRemoteNegotiationCounters.set(peerSessionId, next)
  pendingRemoteNegotiationTokens.set(peerSessionId, next)
  return next
}

function remoteNegotiationIdentityKey(
  epoch: number,
  incarnation: number,
  token: number,
): string {
  return `${epoch}:${incarnation}:${token}`
}

function reservePendingRemoteNegotiationToken(
  peerSessionId: string,
  identityKey: string,
): void {
  let reservations = pendingRemoteTokenReservations.get(peerSessionId)
  if (!reservations) {
    reservations = new Map()
    pendingRemoteTokenReservations.set(peerSessionId, reservations)
  }
  reservations.set(identityKey, (reservations.get(identityKey) ?? 0) + 1)
}

function releasePendingRemoteNegotiationToken(receipt: SignalReceipt): void {
  if (receipt.remoteIceReservationKey === null) return
  const reservations = pendingRemoteTokenReservations.get(receipt.peerSessionId)
  const count = reservations?.get(receipt.remoteIceReservationKey)
  if (count === undefined) return
  if (count > 1) {
    reservations!.set(receipt.remoteIceReservationKey, count - 1)
  } else {
    reservations!.delete(receipt.remoteIceReservationKey)
    if (reservations!.size === 0) pendingRemoteTokenReservations.delete(receipt.peerSessionId)
  }
}

function hasPendingRemoteTokenReservation(receipt: SignalReceipt): boolean {
  if (receipt.pendingRemoteNegotiationToken === null) return false
  const identityKey = remoteNegotiationIdentityKey(
    receipt.epoch,
    receipt.incarnation,
    receipt.pendingRemoteNegotiationToken,
  )
  return (pendingRemoteTokenReservations.get(receipt.peerSessionId)?.get(identityKey) ?? 0) > 0
}

function captureSignalReceipt(
  peerSessionId: string,
  options: {
    preparePendingRemoteIce?: boolean
    candidate?: RTCIceCandidateInit
    endOfCandidates?: RTCIceCandidateInit | null
  } = {},
): SignalReceipt {
  const pc = peerConnections.get(peerSessionId) ?? null
  const epoch = networkEpoch
  const incarnation = peerSignalingIncarnation(peerSessionId)
  let pendingRemoteNegotiationToken = pendingRemoteNegotiationTokens.get(peerSessionId) ?? null
  let remoteIceGroupKey: string | null = null
  let remoteIceUfrag: string | null = null

  if (options.preparePendingRemoteIce) {
    const currentHint = pendingRemoteIceHints.get(peerSessionId)
    const hint = currentHint
      && currentHint.epoch === epoch
      && currentHint.incarnation === incarnation
      ? currentHint
      : null
    const iceInput = options.candidate ?? options.endOfCandidates ?? undefined
    const candidateUfrag = options.candidate?.usernameFragment
      ?? options.endOfCandidates?.usernameFragment
      ?? null
    const iceInputMatchesInstalled = Boolean(
      iceInput
      && pc?.remoteDescription
      && candidateCompatibleWithRemoteSdp(iceInput, pc.remoteDescription, {
        groupUfrag: hint?.ufrag ?? null,
      }),
    )

    if (candidateUfrag !== null && !iceInputMatchesInstalled) {
      const token = ensurePendingRemoteNegotiationToken(peerSessionId)
      pendingRemoteNegotiationToken = token
      remoteIceUfrag = candidateUfrag
      remoteIceGroupKey = `${token}:ufrag:${candidateUfrag}`
      pendingRemoteIceHints.set(peerSessionId, {
        epoch, incarnation, negotiationToken: token,
        key: remoteIceGroupKey, ufrag: candidateUfrag,
      })
    } else if (
      candidateUfrag === null
      &&
      (
        options.endOfCandidates !== undefined
        || (options.candidate && candidateUfrag === null)
      )
      && hint
    ) {
      pendingRemoteNegotiationToken = hint.negotiationToken
      remoteIceGroupKey = hint.key
      remoteIceUfrag = hint.ufrag
    } else if (
      options.endOfCandidates !== undefined
      && iceInput
      && pc?.remoteDescription
      && !iceInputMatchesInstalled
    ) {
      const token = ensurePendingRemoteNegotiationToken(peerSessionId)
      pendingRemoteNegotiationToken = token
      remoteIceGroupKey = `${token}:negotiation`
      pendingRemoteIceHints.set(peerSessionId, {
        epoch, incarnation, negotiationToken: token,
        key: remoteIceGroupKey, ufrag: null,
      })
    } else if (!pc?.remoteDescription) {
      const token = ensurePendingRemoteNegotiationToken(peerSessionId)
      pendingRemoteNegotiationToken = token
      remoteIceGroupKey = `${token}:negotiation`
      pendingRemoteIceHints.set(peerSessionId, {
        epoch, incarnation, negotiationToken: token,
        key: remoteIceGroupKey, ufrag: null,
      })
    }
  }
  const remoteIceReservationKey = (
    options.preparePendingRemoteIce
    && pendingRemoteNegotiationToken !== null
    && remoteIceGroupKey !== null
  )
    ? remoteNegotiationIdentityKey(epoch, incarnation, pendingRemoteNegotiationToken)
    : null
  if (remoteIceReservationKey !== null) {
    reservePendingRemoteNegotiationToken(peerSessionId, remoteIceReservationKey)
  }
  return {
    peerSessionId,
    epoch,
    incarnation,
    gen: peerGeneration(peerSessionId),
    originatingPc: pc,
    localOfferToken: peerLocalOfferTokens.get(peerSessionId) ?? null,
    pendingRemoteNegotiationToken,
    remoteIceGroupKey,
    remoteIceUfrag,
    remoteIceReservationKey,
    remoteIceEndCandidate: options.endOfCandidates ?? null,
  }
}

function hasPendingRemoteIceForReceipt(receipt: SignalReceipt): boolean {
  if (receipt.pendingRemoteNegotiationToken === null) return false
  const groups = pendingRemoteIce.get(receipt.peerSessionId)
  return Boolean(groups && [...groups.values()].some(group => (
    group.epoch === receipt.epoch
    && group.incarnation === receipt.incarnation
    && group.negotiationToken === receipt.pendingRemoteNegotiationToken
  )))
}

function retireUnusedPendingRemoteToken(receipt: SignalReceipt) {
  if (
    receipt.pendingRemoteNegotiationToken !== null
    && receipt.epoch === networkEpoch
    && receipt.incarnation === peerSignalingIncarnation(receipt.peerSessionId)
    && !hasPendingRemoteIceForReceipt(receipt)
    && !hasPendingRemoteTokenReservation(receipt)
    && pendingRemoteNegotiationTokens.get(receipt.peerSessionId) === receipt.pendingRemoteNegotiationToken
  ) {
    pendingRemoteNegotiationTokens.delete(receipt.peerSessionId)
    const hint = pendingRemoteIceHints.get(receipt.peerSessionId)
    if (hint?.negotiationToken === receipt.pendingRemoteNegotiationToken) {
      pendingRemoteIceHints.delete(receipt.peerSessionId)
    }
  }
}

function isSignalReceiptCurrent(
  receipt: SignalReceipt,
  options: {
    requireOriginatingPc?: boolean
    requireLocalOfferToken?: boolean
    bindLocalOfferToken?: boolean
    allowMissingPeer?: boolean
  } = {},
): boolean {
  const {
    requireOriginatingPc = false,
    requireLocalOfferToken = false,
    bindLocalOfferToken = false,
    allowMissingPeer = false,
  } = options
  if (
    receipt.epoch !== networkEpoch
    || receipt.incarnation !== peerSignalingIncarnation(receipt.peerSessionId)
    || (
      !allowMissingPeer
      && !useNetworkStore.getState().peers.some(peer => peer.sessionId === receipt.peerSessionId)
    )
  ) return false
  if (requireLocalOfferToken && receipt.localOfferToken === null) return false
  if (
    (requireLocalOfferToken || bindLocalOfferToken)
    && receipt.localOfferToken !== null
    && peerLocalOfferTokens.get(receipt.peerSessionId) !== receipt.localOfferToken
  ) return false
  if (!receipt.originatingPc) return !requireOriginatingPc
  return receipt.gen === peerGeneration(receipt.peerSessionId)
    && peerConnections.get(receipt.peerSessionId) === receipt.originatingPc
}

export function getPendingSignalingQueueCount(): number {
  return peerTaskQueues.size
}

export function getPendingRemoteIceCount(): number {
  let count = 0
  for (const groups of pendingRemoteIce.values()) count += groups.size
  return count
}

export function getPendingRemoteIceCandidateCount(): number {
  let count = 0
  for (const groups of pendingRemoteIce.values()) {
    for (const group of groups.values()) count += group.candidates.length
  }
  return count
}

export function getPendingRemoteIceReservationCount(): number {
  let count = 0
  for (const reservations of pendingRemoteTokenReservations.values()) {
    for (const reservationCount of reservations.values()) count += reservationCount
  }
  return count
}

export function getPendingRemoteIceOverflowState(
  peerSessionId: string,
): PendingRemoteIceOverflowState | null {
  const state = pendingRemoteIceOverflow.get(peerSessionId)
  return state ? { ...state } : null
}

/**
 * Run `fn` after every previously queued task for this peer. Rejections are
 * logged and contained: they must neither escape as an unhandled rejection
 * nor poison the rest of the queue.
 */
function enqueuePeerTask(
  receipt: SignalReceipt,
  what: string,
  fn: () => Promise<void>,
  options: {
    requireOriginatingPc?: boolean
    requireLocalOfferToken?: boolean
    bindLocalOfferToken?: boolean
    allowMissingPeer?: boolean
  } = {},
): Promise<void> {
  const { peerSessionId } = receipt
  const previous = peerTaskQueues.get(peerSessionId) ?? Promise.resolve()
  const next = previous.then(async () => {
    try {
      if (!isSignalReceiptCurrent(receipt, options)) return
      await fn()
    } finally {
      releasePendingRemoteNegotiationToken(receipt)
      retireUnusedPendingRemoteToken(receipt)
    }
  }).catch(err => {
    console.warn(`[net] ${what} failed`, peerSessionId, err)
  })
  peerTaskQueues.set(peerSessionId, next)
  void next.then(() => {
    // Delete only our own settled tail. Cleanup may already have detached it,
    // or a later frame may have extended the current incarnation's chain.
    if (peerTaskQueues.get(peerSessionId) === next) peerTaskQueues.delete(peerSessionId)
  })
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
  const attempt = capturePeerConnectionAttempt(peerSessionId, pc)
  // Nothing to migrate on a connection that hasn't picked a path yet — its
  // first gathering round already uses the new config.
  if (pc.iceConnectionState !== 'connected' && pc.iceConnectionState !== 'completed') return
  try {
    if (pc.signalingState !== 'stable') {
      await whenSignalingStable(pc, { timeoutMs: 10_000 })
    }
    // Re-verify everything the awaits could have invalidated.
    if (!isPeerConnectionAttemptCurrent(attempt)) return
    if (!isSignalingReady()) return
    const offer = await pc.createOffer({ iceRestart: true })
    if (!isPeerConnectionAttemptCurrent(attempt)) return
    await pc.setLocalDescription(offer)
    if (!isPeerConnectionAttemptCurrent(attempt)) return
    sendLocalOffer(peerSessionId, pc, pc.localDescription!.toJSON())
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
      useNetworkStore.setState({ autoTurnAvailable: status.available })
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
  peerSignalingIncarnations.clear()
  peerLocalOfferTokens.clear()
  pendingRemoteIce.clear()
  pendingRemoteNegotiationTokens.clear()
  pendingRemoteTokenReservations.clear()
  peerRemoteNegotiationCounters.clear()
  pendingRemoteIceHints.clear()
  installedRemoteNegotiationTokens.clear()
  pendingRemoteIceOverflow.clear()
  pendingRemoteIceSequence = 0
  initialEncryptedSessionRebuilds.clear()
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
      if (m.downloadUrl) retireDownloadArtifact(m.downloadUrl)
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
  connectedPeers: Set<string>                      // sessionIds with an encrypted-ready primary DC
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
            // Discovery is not a usable encrypted channel. Keep the peer in
            // connecting until the ECDH public-key exchange has installed an
            // AES key; otherwise UI enables file send and can immediately
            // fail with "加密协商超时".
            const newPeer: Peer = { sessionId, nodeId, status: 'connecting', channelType: 'direct', joinedAt }
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
            set(s => ({
              peers: s.peers.map(p =>
                p.sessionId === sid ? { ...p, status: 'reconnecting' as const } : p,
              ),
            }))
            break
          }

          const droppedMsgs = useNetworkStore.getState().chatMessages[sid] ?? []
          for (const m of droppedMsgs) {
            if (m.downloadUrl) retireDownloadArtifact(m.downloadUrl)
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
      // Chromium does not promise a traversal order for webkitdirectory.
      // Normalise folder batches by relative path so the queue, transfer
      // cards and receiver artifacts have a stable order. Preserve the
      // user's picker order for ordinary multi-file batches.
      const orderedFiles = files.some(file =>
        Boolean((file as File & { webkitRelativePath?: string }).webkitRelativePath),
      )
        ? [...files].sort((a, b) => {
            const aPath = (a as File & { webkitRelativePath?: string }).webkitRelativePath || a.name
            const bPath = (b as File & { webkitRelativePath?: string }).webkitRelativePath || b.name
            return aPath.localeCompare(bPath)
          })
        : files
      const incoming = orderedFiles.map(file => ({
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
    // Recipients may run in parallel, but each recipient observes the file
    // picker order. A flat Promise.all raced same-recipient files and let a
    // smaller later file arrive first (or hide a dropped/duplicated sibling).
    const failures = (await Promise.all(targets.map(async sid => {
      const peerFailures: Array<{ sid: string; file: File }> = []
      for (const file of files) {
        try {
          if (!await sendFileToPeer(file, sid)) peerFailures.push({ sid, file })
        } catch {
          peerFailures.push({ sid, file })
        }
      }
      return peerFailures
    }))).flat()
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
    // Finding 2 (13th independent review): a local teardown must retire the
    // one-shot encrypted-session-rebuild guard along with everything else —
    // `cleanupPeerConnection` bumps the peer generation (which correctly
    // fails any in-flight rebuild's later checks) but deliberately never
    // touches this set itself, because the rebuild branch above adds to it
    // and THEN calls `cleanupPeerConnection` as part of arming its own
    // one-shot attempt; clearing it inside `cleanupPeerConnection` would
    // erase that guard the instant it was set. So every OTHER teardown path
    // (PEER_LEFT, reconnectPeer, and this one) clears it explicitly instead.
    // Without this, a stale guard survives a block and a later
    // rejoin/unblock under the same sessionId could never arm recovery
    // again.
    initialEncryptedSessionRebuilds.delete(sessionId)
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
    const epoch = networkEpoch
    initialEncryptedSessionRebuilds.delete(sessionId)
    // Tear the dead PC down explicitly — recoverConnections() rate-limits to
    // 1.5s and may no-op if the user is mashing the button. This path is
    // explicit user intent, so bypass the throttle for this specific peer.
    cleanupPeerConnection(sessionId, { failQueuedMessages: false })
    useNetworkStore.setState(s => ({
      peers: s.peers.map(p =>
        p.sessionId === sessionId ? { ...p, status: 'connecting' as const } : p,
      ),
    }))
    const task = initiateWebRTC(sessionId)
    const attempt: PeerGenerationAttempt = {
      peerSessionId: sessionId,
      epoch,
      gen: peerGeneration(sessionId),
    }
    try {
      await task
    } catch (err) {
      if (!isPeerGenerationAttemptCurrent(attempt)) return
      console.warn('[net] reconnectPeer failed', err)
      useNetworkStore.setState(s => {
        if (!isPeerGenerationAttemptCurrent(attempt)) return s
        return {
          peers: s.peers.map(p =>
            p.sessionId === sessionId ? { ...p, status: 'offline' as const } : p,
          ),
        }
      })
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
      undefined, networkEpoch, displayName,
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
  if (peerConnections.get(peerSessionId) === pc) {
    peerConnections.delete(peerSessionId)
    invalidatePeerSignalingIncarnation(peerSessionId)
  }
  try { pc.close() } catch { /* already dead */ }
}

function installIceCandidateHandler(attempt: PeerConnectionAttempt) {
  const { pc, peerSessionId } = attempt
  pc.onicecandidate = (event) => {
    if (!isPeerConnectionAttemptCurrent(attempt)) return
    if (event.candidate) {
      wsSend({
        t: 'SIGNAL_ICE',
        targetSessionId: peerSessionId,
        candidate: event.candidate.toJSON(),
      })
    } else {
      // null marks end-of-candidates — tell peer so its ICE agent can stop
      // waiting for stragglers and finalize connectivity checks faster. An
      // empty candidate is scoped to one media description, so preserve every
      // local m-line locator instead of implicitly selecting the first one.
      for (const candidate of endOfCandidateMarkersFor(pc)) {
        wsSend({ t: 'SIGNAL_ICE_END', targetSessionId: peerSessionId, candidate })
      }
    }
  }
}

function sendLocalOffer(
  peerSessionId: string,
  pc: RTCPeerConnection,
  sdp: RTCSessionDescriptionInit,
) {
  if (peerConnections.get(peerSessionId) !== pc) return
  const localOfferToken = (peerLocalOfferTokens.get(peerSessionId) ?? 0) + 1
  peerLocalOfferTokens.set(peerSessionId, localOfferToken)
  const pendingGroups = pendingRemoteIce.get(peerSessionId)
  if (pendingGroups) {
    for (const pending of pendingGroups.values()) {
      if (
        pending.epoch === networkEpoch
        && pending.incarnation === peerSignalingIncarnation(peerSessionId)
        && pending.localOfferToken === null
      ) {
        // No-ufrag candidates that preceded a local fallback are bound to its
        // first published offer. A later restart offer on the same PC cannot
        // accidentally consume them.
        pending.localOfferToken = localOfferToken
      }
    }
  }
  wsSend({ t: 'SIGNAL_SDP', targetSessionId: peerSessionId, sdp })
}

async function initiateWebRTCInner(peerSessionId: string, gen: number) {
  if (peerConnections.has(peerSessionId)) return
  const generationAttempt = captureGenerationAttempt(peerSessionId, gen)

  // BUG-004: never build a PC (and burn an offer) before signaling is
  // authenticated AND joined — `wsSend` drops silently while the socket is
  // down, and the residual PC then blocked every later attempt.
  if (!await whenSignalingReady()) {
    throw new Error('信令尚未就绪，暂时无法建立连接')
  }
  if (!isPeerGenerationAttemptCurrent(generationAttempt)) return

  // Without this, the first PC after WELCOME is built before the auto-TURN
  // credential fetch resolves — symmetric-NAT peers get a non-relay PC,
  // first ICE round fails, only the second restart attempt (~5s later) has
  // TURN. Wait briefly for credentials so the very first handshake has them.
  await ensureAutoTurnReady()
  if (!isPeerGenerationAttemptCurrent(generationAttempt)) return
  if (peerConnections.has(peerSessionId)) return

  const pc = createPeerConnection()
  installIceErrorListener(pc)
  peerConnections.set(peerSessionId, pc)
  const attempt = capturePeerConnectionAttempt(peerSessionId, pc, gen)

  const dc = createDataChannel(pc)
  dataChannels.set(peerSessionId, dc)
  notifyPrimaryChannel(peerSessionId)
  setupDataChannel(dc, attempt)
  for (let i = 0; i < TRANSFER_LANE_COUNT; i++) {
    const lane = createDataChannel(pc, `misaka-transfer-${i}`)
    const lanes = transferLanes.get(peerSessionId) ?? []
    lanes.push(lane)
    transferLanes.set(peerSessionId, lanes)
    setupDataChannel(lane, attempt)
  }

  // Install guarded trickle/state callbacks and the bounded watchdog before
  // key generation. A slow/failing WebCrypto operation must not leave an
  // otherwise-created PC outside the same actionable recovery deadline.
  installIceCandidateHandler(attempt)
  pc.oniceconnectionstatechange = () => handleIceStateChange(attempt)
  scheduleInitialIceRecovery(pc, peerSessionId)

  await generateECDHKeyPair(peerSessionId)
  if (!isPeerConnectionAttemptCurrent(attempt)) {
    abandonPeerConnection(peerSessionId, pc)
    return
  }

  const offer = await createOffer(pc, () => isPeerConnectionAttemptCurrent(attempt))
  // Superseded while the browser was building the offer: the SDP belongs to a
  // connection nobody routes through any more, so publishing it would make
  // the remote answer the wrong PC.
  if (!isPeerConnectionAttemptCurrent(attempt)) {
    abandonPeerConnection(peerSessionId, pc)
    return
  }
  sendLocalOffer(peerSessionId, pc, offer)
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

interface RemoteIceDescription {
  ufrags: Set<string>
  byMid: Map<string, string>
  byMLineIndex: Map<number, string>
  indexByMid: Map<string, number>
  midByMLineIndex: Map<number, string | null>
}

function remoteIceDescription(sdp: RTCSessionDescriptionInit): RemoteIceDescription {
  const ufrags = new Set<string>()
  const byMid = new Map<string, string>()
  const byMLineIndex = new Map<number, string>()
  const indexByMid = new Map<string, number>()
  const midByMLineIndex = new Map<number, string | null>()
  let sessionUfrag: string | null = null
  let current: { index: number; mid: string | null; ufrag: string | null } | null = null
  const media: Array<{ index: number; mid: string | null; ufrag: string | null }> = []

  for (const rawLine of sdp.sdp?.split(/\r?\n/) ?? []) {
    const line = rawLine.trim()
    if (line.startsWith('m=')) {
      current = { index: media.length, mid: null, ufrag: null }
      media.push(current)
    } else if (line.startsWith('a=mid:') && current) {
      current.mid = line.slice('a=mid:'.length).trim() || null
    } else if (line.startsWith('a=ice-ufrag:')) {
      const ufrag = line.slice('a=ice-ufrag:'.length).trim()
      if (!ufrag) continue
      ufrags.add(ufrag)
      if (current) current.ufrag = ufrag
      else sessionUfrag = ufrag
    }
  }

  if (sessionUfrag) ufrags.add(sessionUfrag)
  for (const section of media) {
    midByMLineIndex.set(section.index, section.mid)
    if (section.mid !== null) indexByMid.set(section.mid, section.index)
    const ufrag = section.ufrag ?? sessionUfrag
    if (!ufrag) continue
    ufrags.add(ufrag)
    byMLineIndex.set(section.index, ufrag)
    if (section.mid !== null) byMid.set(section.mid, ufrag)
  }
  return { ufrags, byMid, byMLineIndex, indexByMid, midByMLineIndex }
}

type CanonicalEndMarker =
  | { status: 'match'; key: string; marker: RTCIceCandidateInit | null }
  | { status: 'unknown' | 'conflict' }

function canonicalEndOfCandidatesMarker(
  marker: RTCIceCandidateInit | null,
  description: RemoteIceDescription,
): CanonicalEndMarker {
  if (marker === null) {
    return { status: 'match', key: 'legacy', marker: null }
  }
  const mid = marker.sdpMid ?? null
  const suppliedIndex = marker.sdpMLineIndex ?? null
  const midIndex = mid === null ? null : description.indexByMid.get(mid)
  const indexKnown = suppliedIndex === null
    ? false
    : description.midByMLineIndex.has(suppliedIndex)

  if (mid !== null && midIndex === undefined) return { status: 'unknown' }
  if (suppliedIndex !== null && !indexKnown) return { status: 'unknown' }
  if (midIndex != null && suppliedIndex !== null && midIndex !== suppliedIndex) {
    return { status: 'conflict' }
  }

  const index = suppliedIndex ?? midIndex
  if (index == null) return { status: 'unknown' }
  return {
    status: 'match',
    key: `mline:${index}`,
    marker: {
      candidate: '',
      sdpMid: description.midByMLineIndex.get(index) ?? mid,
      sdpMLineIndex: index,
      ...(marker.usernameFragment != null
        ? { usernameFragment: marker.usernameFragment }
        : {}),
    },
  }
}

function candidateCompatibleWithRemoteSdp(
  candidate: RTCIceCandidateInit,
  sdp: RTCSessionDescriptionInit,
  options: {
    groupBindingProven?: boolean
    groupUfrag?: string | null
  } = {},
): boolean {
  const ufrag = candidate.usernameFragment
  const description = remoteIceDescription(sdp)
  const locatorUfrags: string[] = []
  if (candidate.sdpMid != null && candidate.sdpMLineIndex != null) {
    const locatedIndex = description.indexByMid.get(candidate.sdpMid)
    if (locatedIndex === undefined || locatedIndex !== candidate.sdpMLineIndex) return false
  }
  if (candidate.sdpMid != null) {
    const expected = description.byMid.get(candidate.sdpMid)
    if (expected === undefined) return false
    locatorUfrags.push(expected)
  }
  if (candidate.sdpMLineIndex != null) {
    const expected = description.byMLineIndex.get(candidate.sdpMLineIndex)
    if (expected === undefined) return false
    locatorUfrags.push(expected)
  }
  if (ufrag != null) {
    return locatorUfrags.length > 0
      ? locatorUfrags.every(expected => expected === ufrag)
      : description.ufrags.has(ufrag)
  }
  if (locatorUfrags.length === 0) return options.groupBindingProven === true
  const locatedUfrag = locatorUfrags[0]
  if (!locatorUfrags.every(expected => expected === locatedUfrag)) return false
  return options.groupUfrag == null || options.groupUfrag === locatedUfrag
}

function recordPendingRemoteIceOverflow(
  peerSessionId: string,
  kind: 'group' | 'candidate',
): void {
  const previous = pendingRemoteIceOverflow.get(peerSessionId)
  const next: PendingRemoteIceOverflowState = {
    groupDrops: (previous?.groupDrops ?? 0) + (kind === 'group' ? 1 : 0),
    candidateDrops: (previous?.candidateDrops ?? 0) + (kind === 'candidate' ? 1 : 0),
    lastKind: kind,
  }
  pendingRemoteIceOverflow.set(peerSessionId, next)
  console.warn('[net] pending remote ICE overflow', peerSessionId, {
    kind,
    limit: kind === 'group'
      ? MAX_PENDING_REMOTE_ICE_GROUPS
      : MAX_PENDING_REMOTE_ICE_CANDIDATES_PER_GROUP,
  })
}

function pendingRemoteIceGroup(receipt: SignalReceipt): PendingRemoteIceGroup | null {
  const negotiationToken = receipt.pendingRemoteNegotiationToken
  const key = receipt.remoteIceGroupKey
  if (negotiationToken === null || key === null) return null
  let groups = pendingRemoteIce.get(receipt.peerSessionId)
  if (!groups) {
    groups = new Map()
    pendingRemoteIce.set(receipt.peerSessionId, groups)
  }
  const existing = groups.get(key)
  if (existing) return existing

  if (groups.size >= MAX_PENDING_REMOTE_ICE_GROUPS) {
    recordPendingRemoteIceOverflow(receipt.peerSessionId, 'group')
    return null
  }
  const group: PendingRemoteIceGroup = {
    epoch: receipt.epoch,
    incarnation: receipt.incarnation,
    negotiationToken,
    key,
    ufrag: receipt.remoteIceUfrag,
    // Usually null here and bound by sendLocalOffer. If a no-PC receipt was
    // delayed in the per-peer queue until after fallback published, bind it
    // to that already-current offer rather than an arbitrary later restart.
    localOfferToken: receipt.originatingPc === null
      ? peerLocalOfferTokens.get(receipt.peerSessionId) ?? null
      : receipt.localOfferToken,
    candidates: [],
    endOfCandidates: [],
    sequence: ++pendingRemoteIceSequence,
  }
  groups.set(key, group)
  return group
}

function exactPendingRemoteIceGroup(receipt: SignalReceipt): PendingRemoteIceGroup | null {
  if (
    receipt.remoteIceGroupKey === null
    || receipt.pendingRemoteNegotiationToken === null
  ) return null
  const group = pendingRemoteIce.get(receipt.peerSessionId)?.get(receipt.remoteIceGroupKey)
  if (
    !group
    || group.epoch !== receipt.epoch
    || group.incarnation !== receipt.incarnation
    || group.negotiationToken !== receipt.pendingRemoteNegotiationToken
  ) return null
  return group
}

function recordPendingEndOfCandidates(
  group: PendingRemoteIceGroup,
  marker: RTCIceCandidateInit | null,
): void {
  if (marker === null) {
    if (!group.endOfCandidates.includes(null)) group.endOfCandidates.push(null)
    return
  }

  let merged = marker
  const retained: Array<RTCIceCandidateInit | null> = []
  for (const current of group.endOfCandidates) {
    if (current === null) {
      retained.push(current)
      continue
    }
    const sharesMid = merged.sdpMid != null
      && current.sdpMid != null
      && merged.sdpMid === current.sdpMid
    const sharesIndex = merged.sdpMLineIndex != null
      && current.sdpMLineIndex != null
      && merged.sdpMLineIndex === current.sdpMLineIndex
    const midConflict = merged.sdpMid != null
      && current.sdpMid != null
      && merged.sdpMid !== current.sdpMid
    const indexConflict = merged.sdpMLineIndex != null
      && current.sdpMLineIndex != null
      && merged.sdpMLineIndex !== current.sdpMLineIndex
    if ((sharesMid || sharesIndex) && !midConflict && !indexConflict) {
      merged = {
        candidate: '',
        sdpMid: merged.sdpMid ?? current.sdpMid ?? null,
        sdpMLineIndex: merged.sdpMLineIndex ?? current.sdpMLineIndex ?? null,
        usernameFragment: merged.usernameFragment ?? current.usernameFragment ?? null,
      }
    } else {
      retained.push(current)
    }
  }
  retained.push(merged)
  group.endOfCandidates = retained
}

function receiptGroupMatchesInstalledSdp(
  receipt: SignalReceipt,
  pc: RTCPeerConnection,
): boolean {
  if (!pc.remoteDescription || receipt.pendingRemoteNegotiationToken === null) return false
  if (receipt.remoteIceUfrag !== null) {
    return remoteIceDescription(pc.remoteDescription).ufrags.has(receipt.remoteIceUfrag)
  }
  return installedRemoteNegotiationTokens.get(receipt.peerSessionId)
    === receipt.pendingRemoteNegotiationToken
}

function rebindPendingRemoteOfferIce(
  receipt: SignalReceipt,
  remoteSdp: RTCSessionDescriptionInit,
): void {
  if (
    receipt.pendingRemoteNegotiationToken === null
    || receipt.localOfferToken === null
  ) return
  const groups = pendingRemoteIce.get(receipt.peerSessionId)
  if (!groups) return
  const description = remoteIceDescription(remoteSdp)
  for (const group of groups.values()) {
    if (
      group.epoch !== receipt.epoch
      || group.incarnation !== receipt.incarnation
      || group.negotiationToken !== receipt.pendingRemoteNegotiationToken
      || group.ufrag === null
      || !description.ufrags.has(group.ufrag)
      || !group.candidates.every(candidate => (
        candidateCompatibleWithRemoteSdp(candidate, remoteSdp, {
          groupBindingProven: true,
          groupUfrag: group.ufrag,
        })
      ))
    ) continue
    group.localOfferToken = receipt.localOfferToken
  }
}

async function drainPendingRemoteIce(
  receipt: SignalReceipt,
  remoteSdp: RTCSessionDescriptionInit,
  attempt: PeerConnectionAttempt,
) {
  const groups = pendingRemoteIce.get(receipt.peerSessionId)
  const negotiationToken = receipt.pendingRemoteNegotiationToken
  if (negotiationToken !== null) {
    installedRemoteNegotiationTokens.set(receipt.peerSessionId, negotiationToken)
  }
  if (!groups || negotiationToken === null) {
    retireUnusedPendingRemoteToken(receipt)
    return
  }
  const receiptStillCurrent = () => (
    receipt.epoch === networkEpoch
    && receipt.incarnation === peerSignalingIncarnation(receipt.peerSessionId)
  )

  const description = remoteIceDescription(remoteSdp)
  const orderedGroups = [...groups.values()].sort((a, b) => a.sequence - b.sequence)
  for (const group of orderedGroups) {
    if (
      group.epoch !== receipt.epoch
      || group.incarnation !== receipt.incarnation
      || group.negotiationToken !== negotiationToken
      || (
        group.localOfferToken !== null
        && receipt.localOfferToken !== group.localOfferToken
      )
    ) continue
    const groupMatches = group.ufrag !== null
      ? description.ufrags.has(group.ufrag)
      : group.negotiationToken === negotiationToken
    if (!groupMatches) continue
    if (!receiptStillCurrent() || !isPeerConnectionAttemptCurrent(attempt)) return

    const matchingCandidates = group.candidates.filter(candidate => (
      candidateCompatibleWithRemoteSdp(candidate, remoteSdp, {
        groupBindingProven: true,
        groupUfrag: group.ufrag,
      })
    ))
    group.candidates = group.candidates.filter(candidate => !matchingCandidates.includes(candidate))
    for (const candidate of matchingCandidates) {
      if (!receiptStillCurrent() || !isPeerConnectionAttemptCurrent(attempt)) return
      try {
        await addIceCandidate(attempt.pc, candidate)
      } catch (err) {
        if (!receiptStillCurrent() || !isPeerConnectionAttemptCurrent(attempt)) return
        console.warn('[net] addIceCandidate failed', err)
      }
    }
    if (
      group.endOfCandidates.length > 0
      && group.candidates.length === 0
      && receiptStillCurrent()
      && isPeerConnectionAttemptCurrent(attempt)
    ) {
      const matchingMarkers = group.endOfCandidates.filter(marker => (
        marker === null
        || candidateCompatibleWithRemoteSdp(marker, remoteSdp, {
          groupBindingProven: true,
          groupUfrag: group.ufrag,
        })
      ))
      const conflictingMarkers = group.endOfCandidates.filter(marker => (
        canonicalEndOfCandidatesMarker(marker, description).status === 'conflict'
      ))
      group.endOfCandidates = group.endOfCandidates.filter(marker => (
        !matchingMarkers.includes(marker) && !conflictingMarkers.includes(marker)
      ))
      const canonicalMarkers = new Map<string, RTCIceCandidateInit | null>()
      for (const marker of matchingMarkers) {
        const canonical = canonicalEndOfCandidatesMarker(marker, description)
        if (canonical.status === 'match' && !canonicalMarkers.has(canonical.key)) {
          canonicalMarkers.set(canonical.key, canonical.marker)
        }
      }
      for (const marker of canonicalMarkers.values()) {
        if (!receiptStillCurrent() || !isPeerConnectionAttemptCurrent(attempt)) return
        try {
          await attempt.pc.addIceCandidate(endOfCandidatesFor(attempt.pc, marker ?? undefined))
        } catch { /* some browsers reject the marker; harmless */ }
      }
    }
    if (group.candidates.length === 0 && group.endOfCandidates.length === 0) {
      groups.delete(group.key)
    }
  }
  if (groups.size === 0) pendingRemoteIce.delete(receipt.peerSessionId)
  retireUnusedPendingRemoteToken(receipt)
}

async function handleRemoteSDP(receipt: SignalReceipt, fromNodeId: number, sdp: RTCSessionDescriptionInit) {
  const { peerSessionId: fromSessionId } = receipt
  const receivedEpoch = networkEpoch
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
      if (receivedEpoch !== networkEpoch) return
    }
    if (useNetworkStore.getState().mySessionId === null) {
      console.warn('[net] handleRemoteSDP gave up waiting for WELCOME — dropping', fromSessionId, sdp.type)
      return
    }
  }
  if (receivedEpoch !== networkEpoch) return

  // A valid inbound offer is also authoritative evidence that this session is
  // in our cluster. Publish the roster row before the TURN/key awaits so every
  // continuation can use the same peer-attempt predicate.
  if (sdp.type === 'offer') {
    useNetworkStore.setState(s => {
      if (receivedEpoch !== networkEpoch || s.peers.some(p => p.sessionId === fromSessionId)) return s
      const peer: Peer = {
        sessionId: fromSessionId,
        nodeId: fromNodeId,
        status: 'connecting',
        channelType: 'direct',
        joinedAt: Date.now(),
      }
      return { peers: [...s.peers, peer] }
    })
  }
  if (!useNetworkStore.getState().peers.some(peer => peer.sessionId === fromSessionId)) return

  let pc = peerConnections.get(fromSessionId)
  if (sdp.type === 'offer') remoteInitiatingPeers.delete(fromSessionId)

  if (pc && sdp.type === 'offer' && !hasAESKey(fromSessionId)) {
    const peerStatus = useNetworkStore.getState().peers
      .find(peer => peer.sessionId === fromSessionId)?.status
    const transportReadyButUnencrypted = pc.signalingState === 'stable'
      && (
        pc.iceConnectionState === 'connected'
        || pc.iceConnectionState === 'completed'
      )
    if (
      peerStatus === 'offline'
      || peerStatus === 'reconnecting'
      || transportReadyButUnencrypted
    ) {
      // A manual reconnect creates a new PC/generation on the initiator. If
      // this side keeps its earlier ICE-connected-but-unencrypted PC, the new
      // SDP can restart ICE while retaining the wedged SCTP/ECDH association,
      // and both UIs fall back to offline again. Treat a fresh offer from an
      // already failed encrypted channel as a generation boundary here too.
      cleanupPeerConnection(fromSessionId, { failQueuedMessages: false })
      pc = undefined
    }
  }

  if (!pc && sdp.type !== 'offer') {
    console.warn('[net] ignoring SDP without peer connection', fromSessionId, sdp.type)
    return
  }

  if (!pc) {
    // Inbound offer from a peer who joined before us — accept it.
    // Same pre-warm rationale as initiateWebRTC: ensures the answerer
    // also has TURN servers in its first PC.
    const gen = bumpPeerGeneration(fromSessionId)
    const generationAttempt: PeerGenerationAttempt = {
      peerSessionId: fromSessionId,
      epoch: receivedEpoch,
      gen,
    }
    await ensureAutoTurnReady()
    if (!isPeerGenerationAttemptCurrent(generationAttempt)) return
    if (peerConnections.has(fromSessionId)) return
    pc = createPeerConnection()
    installIceErrorListener(pc)
    peerConnections.set(fromSessionId, pc)
    const createdAttempt: PeerConnectionAttempt = { ...generationAttempt, pc }

    pc.ondatachannel = (e) => {
      if (!isPeerConnectionAttemptCurrent(createdAttempt)) return
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
      setupDataChannel(e.channel, createdAttempt)
    }

    installIceCandidateHandler(createdAttempt)

    pc.oniceconnectionstatechange = () => handleIceStateChange(createdAttempt)
    // The answerer can wedge before ICE emits `checking` too; cover the whole
    // initial negotiation window on both sides.
    scheduleInitialIceRecovery(pc, fromSessionId)

    await generateECDHKeyPair(fromSessionId)
    if (!isPeerConnectionAttemptCurrent(createdAttempt)) {
      abandonPeerConnection(fromSessionId, pc)
      return
    }
  }

  const attempt = capturePeerConnectionAttempt(fromSessionId, pc)
  if (!isPeerConnectionAttemptCurrent(attempt)) return

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
          if (!isPeerConnectionAttemptCurrent(attempt)) return
          rebindPendingRemoteOfferIce(receipt, sdp)
        } catch (err) {
          if (!isPeerConnectionAttemptCurrent(attempt)) return
          console.warn('[net] glare rollback failed', err)
          return
        }
      } else {
        // Impolite: drop the colliding offer; our outstanding offer wins.
        console.warn('[net] ignoring colliding offer (impolite side)', fromSessionId)
        return
      }
    }
    const answer = await createAnswer(pc, sdp, () => isPeerConnectionAttemptCurrent(attempt))
    if (!isPeerConnectionAttemptCurrent(attempt)) return
    wsSend({ t: 'SIGNAL_SDP', targetSessionId: fromSessionId, sdp: answer })
  } else {
    if (!isPeerConnectionAttemptCurrent(attempt)) return
    if (pc.signalingState !== 'have-local-offer') {
      console.warn('[net] ignoring stale SDP answer', fromSessionId, pc.signalingState)
      return
    }
    await applyAnswer(pc, sdp, () => isPeerConnectionAttemptCurrent(attempt))
    if (!isPeerConnectionAttemptCurrent(attempt)) return
  }

  if (!isPeerConnectionAttemptCurrent(attempt)) return
  await drainPendingRemoteIce(receipt, sdp, attempt)
}

async function handleRemoteICE(receipt: SignalReceipt, candidate: RTCIceCandidateInit) {
  const { peerSessionId: fromSessionId } = receipt
  const pc = peerConnections.get(fromSessionId)
  const groupMatchesInstalled = Boolean(
    pc?.remoteDescription && receiptGroupMatchesInstalledSdp(receipt, pc),
  )
  const matchesInstalled = Boolean(
    pc?.remoteDescription
    && candidateCompatibleWithRemoteSdp(candidate, pc.remoteDescription, {
      groupBindingProven: groupMatchesInstalled || receipt.remoteIceGroupKey === null,
      groupUfrag: receipt.remoteIceUfrag,
    }),
  )
  if (pc?.remoteDescription && matchesInstalled) {
    const attempt = capturePeerConnectionAttempt(fromSessionId, pc)
    if (!isPeerConnectionAttemptCurrent(attempt)) return
    // Wrap: addIceCandidate throws on closed pc / malformed candidate / unknown
    // sdpMid. Without try/catch the dispatch loop's forEach swallows the
    // rejection (unhandledrejection), and we'd never know one peer's bad IPv6
    // candidate was poisoning the whole session.
    try {
      await addIceCandidate(pc, candidate)
      if (!isPeerConnectionAttemptCurrent(attempt)) return
    } catch (err) {
      if (!isPeerConnectionAttemptCurrent(attempt)) return
      console.warn('[net] addIceCandidate failed', err)
    }
    retireUnusedPendingRemoteToken(receipt)
  } else {
    const pending = pendingRemoteIceGroup(receipt)
    if (!pending) return
    if (pending.candidates.length >= MAX_PENDING_REMOTE_ICE_CANDIDATES_PER_GROUP) {
      recordPendingRemoteIceOverflow(fromSessionId, 'candidate')
      return
    }
    pending.candidates.push(candidate)
  }
}

async function handleRemoteICEEnd(receipt: SignalReceipt) {
  const { peerSessionId: fromSessionId } = receipt
  const pc = peerConnections.get(fromSessionId)
  if (!pc?.remoteDescription) {
    const pending = pendingRemoteIceGroup(receipt)
    if (pending) recordPendingEndOfCandidates(pending, receipt.remoteIceEndCandidate)
    return
  }

  const pending = exactPendingRemoteIceGroup(receipt)
  if (pending) {
    recordPendingEndOfCandidates(pending, receipt.remoteIceEndCandidate)
    const groupMatchesInstalled = receiptGroupMatchesInstalledSdp(receipt, pc)
    const candidatesMatchInstalled = pending.candidates.every(candidate => (
      candidateCompatibleWithRemoteSdp(candidate, pc.remoteDescription!, {
        groupBindingProven: true,
        groupUfrag: pending.ufrag,
      })
    ))
    if (!groupMatchesInstalled || !candidatesMatchInstalled) return

    const attempt = capturePeerConnectionAttempt(fromSessionId, pc)
    if (!isPeerConnectionAttemptCurrent(attempt)) return
    await drainPendingRemoteIce(receipt, pc.remoteDescription, attempt)
    return
  }

  if (
    receipt.remoteIceGroupKey !== null
    && !receiptGroupMatchesInstalledSdp(receipt, pc)
  ) {
    const deferred = pendingRemoteIceGroup(receipt)
    if (deferred) recordPendingEndOfCandidates(deferred, receipt.remoteIceEndCandidate)
    return
  }

  const attempt = capturePeerConnectionAttempt(fromSessionId, pc)
  if (!isPeerConnectionAttemptCurrent(attempt)) return
  // Empty-candidate marker per RFC 8445 §8.1.2 — signals the peer has
  // finished gathering. Browsers accept this to short-circuit waits.
  // Firefox rejects sdpMid:'' — endOfCandidatesFor reads a real mid from
  // the PC's first transceiver so both Chrome and FF accept the marker.
  try {
    await pc.addIceCandidate(endOfCandidatesFor(pc, receipt.remoteIceEndCandidate ?? undefined))
    if (!isPeerConnectionAttemptCurrent(attempt)) return
  }
  catch { /* some browsers still reject the marker; harmless */ }
  retireUnusedPendingRemoteToken(receipt)
}

function handleIceStateChange(attempt: PeerConnectionAttempt) {
  const { pc, peerSessionId } = attempt
  // A closed/replaced PC may still dispatch a queued state callback. It must
  // not reset retry state or schedule work against the replacement.
  if (!isPeerConnectionAttemptCurrent(attempt)) return
  const state = pc.iceConnectionState
  if (state === 'connected' || state === 'completed') {
    // ICE alone is not a usable channel: the DataChannel/ECDH exchange can
    // still wedge after a candidate pair is selected. Keep the first-
    // connection watchdog alive until the AES key is actually installed.
    if (hasAESKey(peerSessionId)) clearInitialIceRecovery(peerSessionId)
    else scheduleInitialIceRecovery(pc, peerSessionId)
    clearDisconnectedTimer(peerSessionId)
    iceRestartAttempts.set(peerSessionId, 0)
    void onIceConnected(attempt)
  } else if (state === 'checking') {
    scheduleInitialIceRecovery(pc, peerSessionId)
  } else if (state === 'disconnected') {
    clearInitialIceRecovery(peerSessionId)
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
        if (!isPeerConnectionAttemptCurrent(attempt)) return
        if (pc.iceConnectionState !== 'disconnected' && pc.iceConnectionState !== 'failed') return
        const prevStatus = useNetworkStore.getState().peers.find(p => p.sessionId === peerSessionId)?.status
        useNetworkStore.setState(s => {
          if (!isPeerConnectionAttemptCurrent(attempt)) return s
          return {
            peers: s.peers.map(p =>
              p.sessionId === peerSessionId ? { ...p, status: 'reconnecting' as NodeStatus } : p,
            ),
          }
        })
        if (!isPeerConnectionAttemptCurrent(attempt)) return
        if (prevStatus === 'online' || prevStatus === 'transferring') {
          appendSystemChat(peerSessionId, '⚠ 连接中断，尝试恢复中…')
        }
        attemptIceRestart(peerSessionId)
      }, ICE_DISCONNECTED_RESTART_DELAY_MS)
      disconnectedTimers.set(peerSessionId, t)
    }
  } else if (state === 'failed') {
    clearInitialIceRecovery(peerSessionId)
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

function scheduleInitialIceRecovery(pc: RTCPeerConnection, peerSessionId: string) {
  if (initialIceRecoveryTimers.has(peerSessionId)) return
  const epoch = networkEpoch
  const gen = peerGeneration(peerSessionId)
  const timer = setTimeout(async () => {
    initialIceRecoveryTimers.delete(peerSessionId)
    if (!isInitialIceRecoveryCurrent(pc, peerSessionId, epoch, gen)) return
    // Both sides observe the same bounded window, but only the deterministic
    // polite side sends the restart offer. The other side merely re-observes,
    // so a stalled pair can never create symmetric glare.
    if (!isPolite(peerSessionId)) {
      scheduleInitialIceReobservation(pc, peerSessionId, epoch, gen)
      return
    }
    if (
      pc.iceConnectionState === 'connected'
      || pc.iceConnectionState === 'completed'
    ) {
      // ICE restart retains SCTP. Once transport is connected, a missing AES
      // key means the DataChannel/ECDH layer is what wedged, so rebuild the
      // entire session once instead of repeating an ineffective ICE restart.
      if (initialEncryptedSessionRebuilds.has(peerSessionId)) {
        markInitialIceRecoveryFailed(pc, peerSessionId, epoch, gen)
        return
      }
      initialEncryptedSessionRebuilds.add(peerSessionId)
      cleanupPeerConnection(peerSessionId, { failQueuedMessages: false })
      useNetworkStore.setState(s => ({
        peers: s.peers.map(peer =>
          peer.sessionId === peerSessionId
            ? { ...peer, status: 'connecting' as NodeStatus }
            : peer,
        ),
      }))
      // Freeze this rebuild attempt's identity the instant it starts.
      // `initiateWebRTC` bumps the peer generation SYNCHRONOUSLY (before its
      // first await — see its own contract comment), so reading
      // `peerGeneration()` right after the call, and never again, captures
      // exactly the generation this specific attempt owns. The `.catch()`
      // below must judge the rejection against THIS frozen snapshot, never
      // against `networkEpoch` / `peerGeneration()` read at rejection time —
      // a late rejection would otherwise always look "current" (it's being
      // compared against itself) and could misjudge a newer or manually
      // rebuilt connection that has since taken over this peer.
      const rebuildTask = initiateWebRTC(peerSessionId)
      const rebuildAttempt: PeerGenerationAttempt = {
        peerSessionId,
        epoch: networkEpoch,
        gen: peerGeneration(peerSessionId),
      }
      rebuildTask.catch(err => {
        console.warn('[net] initial encrypted-session rebuild failed', peerSessionId, err)
        // Stale rejection: the epoch ended, a newer attempt/generation has
        // already superseded this one, the peer left the roster, or AES came
        // up (through this or any other path) in the meantime. None of that
        // is this rebuild attempt's business to react to.
        if (!isRebuildRecoveryCurrent(rebuildAttempt)) return
        const replacement = peerConnections.get(peerSessionId)
        if (replacement) {
          // A PC exists for this still-current attempt (built, but never
          // finished negotiating) — reuse the normal PC-bound terminal path.
          markInitialIceRecoveryFailed(replacement, peerSessionId, rebuildAttempt.epoch, rebuildAttempt.gen)
        } else {
          // `initiateWebRTC` rejected before it ever created a replacement PC
          // (e.g. signaling never became ready again). There is no PC for the
          // PC-bound path to check against, so without this branch the peer
          // was left stuck at 'connecting' forever with no watchdog and no
          // actionable retry. Transition directly instead.
          markPeerRecoveryTerminal(peerSessionId)
        }
      })
      return
    }
    if (pc.signalingState !== 'stable' || !isSignalingReady()) {
      markInitialIceRecoveryFailed(pc, peerSessionId, epoch, gen)
      return
    }
    try {
      const offer = await pc.createOffer({ iceRestart: true })
      if (!isInitialIceRecoveryCurrent(pc, peerSessionId, epoch, gen)) return
      await pc.setLocalDescription(offer)
      if (!isInitialIceRecoveryCurrent(pc, peerSessionId, epoch, gen)) return
      sendLocalOffer(peerSessionId, pc, pc.localDescription!.toJSON())
      scheduleInitialIceReobservation(pc, peerSessionId, epoch, gen)
    } catch (err) {
      console.warn('[net] initial ICE recovery failed', peerSessionId, err)
      markInitialIceRecoveryFailed(pc, peerSessionId, epoch, gen)
    }
  }, INITIAL_ICE_RECOVERY_MS)
  initialIceRecoveryTimers.set(peerSessionId, timer)
}

function isInitialIceRecoveryCurrent(
  pc: RTCPeerConnection,
  peerSessionId: string,
  epoch: number,
  gen: number,
): boolean {
  return epoch === networkEpoch
    && isCurrentGeneration(peerSessionId, gen)
    && useNetworkStore.getState().peers.some(peer => peer.sessionId === peerSessionId)
    && peerConnections.get(peerSessionId) === pc
    && !hasAESKey(peerSessionId)
    && (
      pc.iceConnectionState === 'new'
      || pc.iceConnectionState === 'checking'
      || pc.iceConnectionState === 'connected'
      || pc.iceConnectionState === 'completed'
    )
}

function scheduleInitialIceReobservation(
  pc: RTCPeerConnection,
  peerSessionId: string,
  epoch: number,
  gen: number,
) {
  clearInitialIceRecovery(peerSessionId)
  const timer = setTimeout(() => {
    initialIceRecoveryTimers.delete(peerSessionId)
    if (!isInitialIceRecoveryCurrent(pc, peerSessionId, epoch, gen)) return
    markInitialIceRecoveryFailed(pc, peerSessionId, epoch, gen)
  }, INITIAL_ICE_REOBSERVE_MS)
  initialIceRecoveryTimers.set(peerSessionId, timer)
}

function markInitialIceRecoveryFailed(
  pc: RTCPeerConnection,
  peerSessionId: string,
  epoch: number,
  gen: number,
) {
  if (!isInitialIceRecoveryCurrent(pc, peerSessionId, epoch, gen)) return
  markPeerRecoveryTerminal(peerSessionId)
}

/**
 * PC-independent terminal transition: same "give up, surface a real retry
 * affordance" semantics as `markInitialIceRecoveryFailed`, but callable when
 * there is no RTCPeerConnection to check identity against — e.g. a rebuild
 * attempt (Finding 1) whose `initiateWebRTC()` call rejected before it ever
 * created a replacement PC. Callers are responsible for verifying the
 * attempt is still current (there is no PC to compare against here).
 */
function markPeerRecoveryTerminal(peerSessionId: string) {
  clearInitialIceRecovery(peerSessionId)
  useNetworkStore.setState(s => {
    const connectedPeers = new Set(s.connectedPeers)
    connectedPeers.delete(peerSessionId)
    return {
      peers: s.peers.map(p =>
        p.sessionId === peerSessionId ? { ...p, status: 'offline' as NodeStatus } : p,
      ),
      connectedPeers,
    }
  })
}

/**
 * Current-ness check for a rebuild attempt that may not have a PC to compare
 * against (see `markPeerRecoveryTerminal`). Same identity fields as
 * `isPeerConnectionAttemptCurrent` minus the PC-identity check, plus the
 * same "AES already ready" bail-out `isInitialIceRecoveryCurrent` uses.
 */
function isRebuildRecoveryCurrent(attempt: PeerGenerationAttempt): boolean {
  return isPeerGenerationAttemptCurrent(attempt) && !hasAESKey(attempt.peerSessionId)
}

function clearInitialIceRecovery(peerSessionId: string) {
  const timer = initialIceRecoveryTimers.get(peerSessionId)
  if (timer) clearTimeout(timer)
  initialIceRecoveryTimers.delete(peerSessionId)
}

async function onIceConnected(attempt: PeerConnectionAttempt) {
  const { pc, peerSessionId } = attempt
  const stillCurrent = () => isPeerConnectionAttemptCurrent(attempt)
  if (!stillCurrent()) return

  const selectedPath = await getSelectedIcePath(pc)
  if (!stillCurrent()) return
  let ct = selectedPath?.channelType
  if (!ct) {
    ct = await getSelectedChannelType(pc)
    if (!stillCurrent()) return
  }
  const encryptionReady = hasAESKey(peerSessionId)
  useNetworkStore.setState(s => {
    if (!stillCurrent()) return s
    const connectedPeers = new Set(s.connectedPeers)
    if (encryptionReady) connectedPeers.add(peerSessionId)
    else connectedPeers.delete(peerSessionId)
    return {
      peers: s.peers.map(p =>
        p.sessionId === peerSessionId
          ? {
              ...p,
              // ICE diagnostics may be shown while ECDH is pending, but the
              // terminal online state belongs to the encrypted channel.
              status: (encryptionReady ? 'online' : 'connecting') as NodeStatus,
              channelType: ct ?? 'stun',
              icePath: selectedPath?.pathText,
              icePathMeasuredAt: selectedPath?.pathText ? Date.now() : p.icePathMeasuredAt,
            }
          : p,
      ),
      connectedPeers,
    }
  })
}

function setupDataChannel(dc: RTCDataChannel, attempt: PeerConnectionAttempt) {
  const { pc, peerSessionId } = attempt
  // Idempotency guard: in reconnect races the same channel instance may flow
  // through setup twice; avoid duplicate listeners / duplicate side effects.
  if (configuredDataChannels.has(dc)) return
  configuredDataChannels.add(dc)
  const isTransferLane = dc.label.startsWith('misaka-transfer-')
  const stillCurrent = () => {
    if (!isPeerConnectionAttemptCurrent(attempt)) return false
    return isTransferLane
      ? (transferLanes.get(peerSessionId)?.includes(dc) ?? false)
      : dataChannels.get(peerSessionId) === dc
  }
  let recoveryNoticePending = false

  const publishEncryptedReady = () => {
    if (!stillCurrent() || !hasAESKey(peerSessionId)) return false
    initialEncryptedSessionRebuilds.delete(peerSessionId)
    clearInitialIceRecovery(peerSessionId)
    useNetworkStore.setState(s => {
      if (!stillCurrent() || !hasAESKey(peerSessionId)) return s
      return {
        peers: s.peers.map(p =>
          p.sessionId === peerSessionId ? { ...p, status: 'online' as const } : p,
        ),
        connectedPeers: new Set([...s.connectedPeers, peerSessionId]),
      }
    })
    if (recoveryNoticePending) {
      recoveryNoticePending = false
      appendSystemChat(peerSessionId, '✓ 连接已恢复')
    }
    return true
  }

  // Without this, incoming chunk bodies arrive as Blob and the
  // `instanceof ArrayBuffer` check below skips them silently.
  dc.binaryType = 'arraybuffer'

  dc.onclose = () => {
    if (!stillCurrent()) return
    if (dc.readyState === 'closed') {
      if (pc.connectionState !== 'closed') {
        attemptIceRestart(peerSessionId)
      }
    }
  }

  const handleOpen = async () => {
    if (!stillCurrent()) return
    // Show reconnection notice if there was prior chat activity.
    const prevMsgs = useNetworkStore.getState().chatMessages[peerSessionId] ?? []
    const isReconnect = prevMsgs.some(m => m.type !== 'system')
    if (!isTransferLane) {
      recoveryNoticePending = isReconnect
      useNetworkStore.setState(s => {
        if (!stillCurrent()) return s
        const connectedPeers = new Set(s.connectedPeers)
        if (!hasAESKey(peerSessionId)) connectedPeers.delete(peerSessionId)
        return {
          peers: s.peers.map(p =>
            p.sessionId === peerSessionId
              ? { ...p, status: hasAESKey(peerSessionId) ? 'online' as const : 'connecting' as const }
              : p,
          ),
          connectedPeers,
        }
      })
      publishEncryptedReady()
      try {
        // Protocol handshake first: `hello` tells the peer which delivery
        // semantics we implement. A v1 peer ignores the unknown message and
        // both sides fall back to v1 (see negotiatedProtocolVersion).
        dc.send(makeHelloMessage())
      } catch { /* channel may already be dying */ }
      try {
        const pub = await getMyPublicKey(peerSessionId)
        if (!stillCurrent()) return
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
    if (!stillCurrent()) return
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
          if (!stillCurrent() || !hasAESKey(peerSessionId)) return
          // The encrypted channel, rather than ICE/DataChannel alone, is the
          // terminal success and recovery-publication boundary.
          publishEncryptedReady()
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
      undefined, peerBitmap, owner.epoch, record?.fileName ?? file.name,
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
  const generationAttempt = captureGenerationAttempt(peerSessionId, gen)
  const stillCurrent = () => isPeerGenerationAttemptCurrent(generationAttempt)
  let pcAttempt: PeerConnectionAttempt | null = null

  const attempts = iceRestartAttempts.get(peerSessionId) ?? 0
  if (attempts >= MAX_ICE_RESTART_ATTEMPTS) {
    useNetworkStore.setState(s => {
      if (!stillCurrent()) return s
      return {
        peers: s.peers.map(p =>
          p.sessionId === peerSessionId ? { ...p, status: 'offline' as NodeStatus } : p,
        ),
      }
    })
    if (!stillCurrent()) return
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

    useNetworkStore.setState(s => {
      if (!stillCurrent()) return s
      return {
        peers: s.peers.map(p =>
          p.sessionId === peerSessionId ? { ...p, status: 'reconnecting' as NodeStatus } : p,
        ),
      }
    })

    const pc = peerConnections.get(peerSessionId)
    if (!pc || pc.connectionState === 'closed' || pc.connectionState === 'failed') {
      cleanupPeerConnection(peerSessionId, { failQueuedMessages: false })
      // initiateWebRTC IS a real restart attempt — count it. (cleanup bumped
      // the generation, so from here on we're driving the new one.)
      iceRestartAttempts.set(peerSessionId, attempts + 1)
      await initiateWebRTC(peerSessionId)
      return
    }
    pcAttempt = capturePeerConnectionAttempt(peerSessionId, pc, gen)
    const pcStillCurrent = () => pcAttempt !== null && isPeerConnectionAttemptCurrent(pcAttempt)

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
      if (!pcStillCurrent()) return
    }
    // Signaling must be back up, otherwise the restart offer is dropped by
    // `wsSend` and we've burned an attempt for nothing (BUG-004).
    if (!isSignalingReady()) return

    iceRestartAttempts.set(peerSessionId, attempts + 1)
    const offer = await pc.createOffer({ iceRestart: true })
    if (!pcStillCurrent()) return
    await pc.setLocalDescription(offer)
    if (!pcStillCurrent()) return
    // Trickle — candidates will stream via onicecandidate. (Same fix as
    // createOffer/createAnswer: the `{ once: true }` gathering wait could
    // miss the `complete` event and hang the restart forever.)
    sendLocalOffer(peerSessionId, pc, pc.localDescription!.toJSON())
  } catch {
    const attemptCurrent = pcAttempt
      ? isPeerConnectionAttemptCurrent(pcAttempt)
      : stillCurrent()
    if (attemptCurrent) {
      useNetworkStore.setState(s => {
        const current = pcAttempt
          ? isPeerConnectionAttemptCurrent(pcAttempt)
          : stillCurrent()
        if (!current) return s
        return {
          peers: s.peers.map(p =>
            p.sessionId === peerSessionId ? { ...p, status: 'offline' as NodeStatus } : p,
          ),
        }
      })
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
    const { file, bytes, cleanup } = await finalizeReceive(transferId)
    const url = URL.createObjectURL(file)
    artifactLifecycleByUrl.set(url, { cleanup, started: false })
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
  invalidatePeerSignalingIncarnation(sessionId)
  // Anything still parked on an await for this peer (initiation, delayed ICE
  // restart, config migration) is now working on a dead connection — bumping
  // the generation is how those tasks learn to abort (BUG-005 / BUG-007).
  bumpPeerGeneration(sessionId)
  iceRestartAttempts.delete(sessionId)
  iceRestarting.delete(sessionId)
  pendingIceMigration.delete(sessionId)
  clearDisconnectedTimer(sessionId)
  clearInitialIceRecovery(sessionId)
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
  pendingRemoteIce.delete(sessionId)
  pendingRemoteNegotiationTokens.delete(sessionId)
  pendingRemoteTokenReservations.delete(sessionId)
  peerRemoteNegotiationCounters.delete(sessionId)
  pendingRemoteIceHints.delete(sessionId)
  installedRemoteNegotiationTokens.delete(sessionId)
  pendingRemoteIceOverflow.delete(sessionId)
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
