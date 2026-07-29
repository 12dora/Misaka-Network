/**
 * session-scope.ts — networkEpoch, token, initialized, signaling-ready barrier,
 * epoch teardown, ordered disposers.
 *
 * Ports: peer-runtime / negotiation / ice / connectivity / transfer / chat via
 * imports or deps. Store access: store-access only (no useNetworkStore).
 */

import {
  cancelTransfer as engineCancelTransfer,
  clearTransferSignal,
  abortInboundTransfer,
  resetTransferModuleState, forgetTransfer,
  neutralizeSendTask,
  type TransferOwner,
} from '@/lib/transfer'
import { resetCrypto } from '@/lib/crypto'
import { pruneTerminalTransfers } from '@/lib/db'
import type { Transfer } from '@/types'
import type { EpochTransferTeardown } from './contracts'
import { storeGet, storeSet } from './store-access'
import {
  peerConnections,
  remoteInitiatingPeers,
  peerGenerations,
  initiatingPeers,
  cleanupPeerConnection,
} from './peer-runtime'
import { clearAllNegotiationState } from './negotiation-controller'
import {
  initialEncryptedSessionRebuilds,
} from './ice-recovery'
import {
  pendingIceMigration,
  clearIceMigrationTimer,
} from './connectivity-controller'
import {
  sendingFiles,
  transferSpeedSamples,
  deliveredTransfers,
  shortIdToTransferId,
  transferDelivery,
  pendingDurableAcks,
} from './transfer-controller'
import { seenInboundChatIds } from './chat-controller'
import { retireDownloadArtifact } from './download-artifacts'

/** True after the first successful init(); StrictMode re-init is a no-op re-register. */
export let initialized = false

/** Current auth token for the open signaling session (empty when destroyed). */
export let currentToken = ''

/** Reload-guard probe disposer registered by init(). */
export let activeWorkProbeUnsub: (() => void) | null = null

// ── Session epoch (BUG-001 / BUG-002) ────────────────────────────────
// One epoch = one authenticated signaling session. A new token, a new
// `WELCOME.sessionId`, or an explicit logout ends the current epoch: peer
// connections, data channels, ECDH keys, in-flight transfers and chat all
// belong to the identity that created them and must never survive into the
// next one. `networkEpoch` is monotonic so async work started under a dead
// epoch can detect that it has been superseded.
export let networkEpoch = 0
export function getNetworkEpoch(): number { return networkEpoch }

// Unsubscribers for everything init() registered on the signaling module.
// `signaling.disconnect()` deliberately no longer wipes the global handler
// sets (the auth store's onAuthInvalid contract lives in the same sets), so
// destroy() has to remove exactly what it added — otherwise a second init()
// would process every signal twice.
export const unsubscribeSignaling: Array<() => void> = []

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
export let signalingJoined = false
const signalingReadyWaiters = new Set<(ready: boolean) => void>()

export function isSignalingReady(): boolean {
  const s = storeGet()
  return s.signalingStatus === 'online' && s.mySessionId !== null && signalingJoined
}

export function notifySignalingReady() {
  if (!isSignalingReady()) return
  for (const settle of [...signalingReadyWaiters]) settle(true)
}

/** Epoch end / logout: settle every waiter as "not ready" instead of
 *  leaving them parked until their timeout fires. */
export function abortSignalingReadyWaiters() {
  for (const settle of [...signalingReadyWaiters]) settle(false)
  signalingReadyWaiters.clear()
}

export function whenSignalingReady(timeoutMs = SIGNALING_READY_TIMEOUT_MS): Promise<boolean> {
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

export function setInitialized(v: boolean): void {
  initialized = v
}

export function setCurrentToken(token: string): void {
  currentToken = token
}

export function setSignalingJoined(v: boolean): void {
  signalingJoined = v
}

export function setActiveWorkProbeUnsub(fn: (() => void) | null): void {
  activeWorkProbeUnsub = fn
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
function defaultEpochTransferTeardown(transfers: Transfer[]) {
  for (const t of transfers) {
    if (t.status === 'completed') continue
    try { engineCancelTransfer(t.id) } catch { /* engine may not know it */ }
    // Neutralise the send path so a mid-slice engine cannot transmit after
    // we wipe module state below.
    try { neutralizeSendTask(t.id) } catch { /* no send task */ }
    // Single abnormal terminal API — never the old delete-first cancelReceive.
    void abortInboundTransfer(t.id, 'epoch-teardown')
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
  // Per-peer chat dedupe is epoch-scoped (and per departed session elsewhere).
  seenInboundChatIds.clear()
  // Durable ACK queue is epoch-scoped: a transfer-done for the previous
  // identity must never be flushed on the next session.
  pendingDurableAcks.clear()
  // Hard-gates every live/parked/unlisted send engine (not only store cards),
  // then wipes epoch-scoped module maps. Irrevocable attempt gates survive
  // until those engines settle — cancel-then-epoch must not resurrect wire.
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
export function endNetworkEpoch(reason: string) {
  networkEpoch++
  signalingJoined = false
  // Unblock anything parked on the readiness barrier: this epoch will never
  // become ready, so those attempts must fail fast rather than time out.
  abortSignalingReadyWaiters()

  const state = storeGet()
  const scopedIds = new Set<string>([
    ...peerConnections.keys(),
    ...remoteInitiatingPeers,
    ...state.peers.map(p => p.sessionId),
  ])
  for (const sid of scopedIds) cleanupPeerConnection(sid)
  peerGenerations.clear()
  initiatingPeers.clear()
  clearAllNegotiationState()
  initialEncryptedSessionRebuilds.clear()
  pendingIceMigration.clear()
  clearIceMigrationTimer()

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
  storeSet({
    mySessionId: null, channelId: null,
    peers: [], selectedSessionId: null, transfers: [],
    chatMessages: {}, pendingFiles: {}, connectedPeers: new Set(), unreadByPeer: {},
    sendingPeers: new Set(),
  })
}

/** The `(peerSessionId, epoch)` pair every control message is checked against. */
export function ownerFor(peerSessionId: string): TransferOwner {
  return { peerSessionId, epoch: networkEpoch }
}
