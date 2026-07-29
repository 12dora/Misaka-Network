/**
 * peer-runtime.ts — PC/DC/lane registry, ECDH waiters, ensureConnected, cleanup.
 *
 * Ports: deps for negotiation / ice-recovery / data-channel-router / session / chat / transfer.
 * Store access: store-access only (no useNetworkStore).
 */

import {
  createPeerConnection, createDataChannel, createOffer,
  ensureAutoTurnReady,
  endOfCandidateMarkersFor, installIceErrorListener,
} from '@/lib/webrtc'
import {
  generateECDHKeyPair,
  resetCrypto, hasAESKey,
} from '@/lib/crypto'
import { send as wsSend } from '@/lib/signaling'
import {
  DC_OPEN_TIMEOUT_MS, ENCRYPTION_TIMEOUT_MS,
  TRANSFER_LANE_COUNT,
} from '@/constants'
import { storeGet, storeSet } from './store-access'
import { deps } from './deps'

export const peerConnections = new Map<string, RTCPeerConnection>()
/** Cleanup owner: peer-runtime.cleanupPeerConnection */
export const dataChannels = new Map<string, RTCDataChannel>()
/** Cleanup owner: peer-runtime.cleanupPeerConnection */
export const transferLanes = new Map<string, RTCDataChannel[]>()
export const configuredDataChannels = new WeakSet<RTCDataChannel>()
interface EcdhResolverEntry {
  generation: number
  timer: ReturnType<typeof setTimeout>
  resolve: () => void
  reject: (err: Error) => void
}
export const ecdhResolvers: Map<string, EcdhResolverEntry> = new Map()
export const connectingPeers = new Map<string, Promise<RTCDataChannel>>()
export const remoteInitiatingPeers = new Set<string>()
export const primaryChannelResolvers = new Map<string, Set<() => void>>()

export const peerGenerations = new Map<string, number>()
// In-flight initiations, keyed by peer and tagged with the generation they
// were started for. Registered SYNCHRONOUSLY (before the first await) so two
// entry points can never both create a PeerConnection.
export const initiatingPeers = new Map<string, { gen: number; task: Promise<void> }>()

export function peerGeneration(peerSessionId: string): number {
  return peerGenerations.get(peerSessionId) ?? 0
}

export function bumpPeerGeneration(peerSessionId: string): number {
  const next = peerGeneration(peerSessionId) + 1
  peerGenerations.set(peerSessionId, next)
  return next
}

export function isCurrentGeneration(peerSessionId: string, gen: number): boolean {
  return peerGeneration(peerSessionId) === gen
}

export interface PeerGenerationAttempt {
  peerSessionId: string
  epoch: number
  gen: number
}

export interface PeerConnectionAttempt extends PeerGenerationAttempt {
  pc: RTCPeerConnection
}

export function captureGenerationAttempt(peerSessionId: string, gen = peerGeneration(peerSessionId)): PeerGenerationAttempt {
  return { peerSessionId, epoch: deps.getNetworkEpoch(), gen }
}

export function capturePeerConnectionAttempt(
  peerSessionId: string,
  pc: RTCPeerConnection,
  gen = peerGeneration(peerSessionId),
): PeerConnectionAttempt {
  return { ...captureGenerationAttempt(peerSessionId, gen), pc }
}

export function isPeerGenerationAttemptCurrent(attempt: PeerGenerationAttempt): boolean {
  return attempt.epoch === deps.getNetworkEpoch()
    && isCurrentGeneration(attempt.peerSessionId, attempt.gen)
    && storeGet().peers.some(peer => peer.sessionId === attempt.peerSessionId)
}

export function isPeerConnectionAttemptCurrent(attempt: PeerConnectionAttempt): boolean {
  return isPeerGenerationAttemptCurrent(attempt)
    && peerConnections.get(attempt.peerSessionId) === attempt.pc
}


// Messages typed before the DC fully opened, flushed in dc.onopen. Each entry
// keeps its msgId so a partial flush can report exactly which messages made it
// (BUG-020) instead of marking the whole batch 'sent'.

/** Per-message outcome of one flush attempt (BUG-020). */

export function notifyPrimaryChannel(peerSessionId: string) {
  const resolvers = primaryChannelResolvers.get(peerSessionId)
  if (!resolvers) return
  primaryChannelResolvers.delete(peerSessionId)
  for (const resolve of resolvers) resolve()
}

export function waitForPrimaryChannel(peerSessionId: string, timeoutMs = 10_000): Promise<void> {
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

export async function ensureConnected(peerSessionId: string): Promise<RTCDataChannel> {
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
      const generation = peerGeneration(peerSessionId)
      const timeout = setTimeout(() => {
        const cur = ecdhResolvers.get(peerSessionId)
        // Only delete/reject if we still own this entry — a newer generation
        // may have replaced the resolver; the old timer must not steal it.
        if (cur && cur.generation === generation) {
          ecdhResolvers.delete(peerSessionId)
          reject(new Error('加密协商超时'))
        }
      }, ENCRYPTION_TIMEOUT_MS)
      const entry: EcdhResolverEntry = {
        generation,
        timer: timeout,
        resolve: () => {
          clearTimeout(timeout)
          resolve()
        },
        reject: (err) => {
          clearTimeout(timeout)
          reject(err)
        },
      }
      // Supersede any prior waiter for this peer.
      const prior = ecdhResolvers.get(peerSessionId)
      if (prior) {
        clearTimeout(prior.timer)
        try { prior.reject(new DOMException('Superseded', 'AbortError')) } catch { /* ignore */ }
      }
      ecdhResolvers.set(peerSessionId, entry)
      if (hasAESKey(peerSessionId)) {
        const cur = ecdhResolvers.get(peerSessionId)
        if (cur && cur.generation === generation) {
          ecdhResolvers.delete(peerSessionId)
          entry.resolve()
        }
      }
    })
  }
  return dc
}

export async function ensureTransferLanes(peerSessionId: string): Promise<RTCDataChannel[]> {
  const primary = await ensureConnected(peerSessionId)
  let lanes = transferLanes.get(peerSessionId) ?? []
  lanes = lanes.filter(dc => dc.readyState !== 'closed')
  transferLanes.set(peerSessionId, lanes)

  const openLanes = lanes.filter(dc => dc.readyState === 'open')
  if (openLanes.length > 0) return openLanes
  return [primary]
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
export function initiateWebRTC(peerSessionId: string): Promise<void> {
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
export function abandonPeerConnection(peerSessionId: string, pc: RTCPeerConnection) {
  if (peerConnections.get(peerSessionId) === pc) {
    peerConnections.delete(peerSessionId)
    deps.invalidatePeerSignalingIncarnation(peerSessionId)
  }
  try { pc.close() } catch { /* already dead */ }
}

export function installIceCandidateHandler(attempt: PeerConnectionAttempt) {
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


async function initiateWebRTCInner(peerSessionId: string, gen: number) {
  if (peerConnections.has(peerSessionId)) return
  const generationAttempt = captureGenerationAttempt(peerSessionId, gen)

  // BUG-004: never build a PC (and burn an offer) before signaling is
  // authenticated AND joined — `wsSend` drops silently while the socket is
  // down, and the residual PC then blocked every later attempt.
  if (!await deps.whenSignalingReady()) {
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
  deps.setupDataChannel(dc, attempt)
  for (let i = 0; i < TRANSFER_LANE_COUNT; i++) {
    const lane = createDataChannel(pc, `misaka-transfer-${i}`)
    const lanes = transferLanes.get(peerSessionId) ?? []
    lanes.push(lane)
    transferLanes.set(peerSessionId, lanes)
    deps.setupDataChannel(lane, attempt)
  }

  // Install guarded trickle/state callbacks and the bounded watchdog before
  // key generation. A slow/failing WebCrypto operation must not leave an
  // otherwise-created PC outside the same actionable recovery deadline.
  installIceCandidateHandler(attempt)
  pc.oniceconnectionstatechange = () => deps.handleIceStateChange(attempt)
  deps.scheduleInitialIceRecovery(pc, peerSessionId)

  await generateECDHKeyPair(peerSessionId)
  if (!isPeerConnectionAttemptCurrent(attempt)) {
    abandonPeerConnection(peerSessionId, pc)
    return
  }

  const offerToken = deps.beginLocalOffer(peerSessionId)
  let offer: RTCSessionDescriptionInit
  try {
    offer = await createOffer(pc, () => isPeerConnectionAttemptCurrent(attempt))
  } finally {
    if (deps.isLocalOfferCurrent(peerSessionId, offerToken)) {
      deps.negState(peerSessionId).makingOffer = false
    }
  }
  // Superseded while the browser was building the offer: the SDP belongs to a
  // connection nobody routes through any more, so publishing it would make
  // the remote answer the wrong PC.
  if (!isPeerConnectionAttemptCurrent(attempt)) {
    abandonPeerConnection(peerSessionId, pc)
    return
  }
  // Polite glare accepted a remote offer while createOffer was pending —
  // publishing this stale local offer would break the negotiated session.
  if (!deps.isLocalOfferCurrent(peerSessionId, offerToken)) {
    return
  }
  deps.sendLocalOffer(peerSessionId, pc, offer)
}


export function cleanupPeerConnection(sessionId: string, options: { failQueuedMessages?: boolean } = {}) {
  const { failQueuedMessages = true } = options
  if (failQueuedMessages) deps.failPendingMessages(sessionId)
  deps.clearPeerNegotiationState(sessionId)
  // Anything still parked on an await for this peer (initiation, delayed ICE
  // restart, config migration) is now working on a dead connection — bumping
  // the generation is how those tasks learn to abort (BUG-005 / BUG-007).
  bumpPeerGeneration(sessionId)
  deps.iceRestartAttempts.delete(sessionId)
  deps.iceRestarting.delete(sessionId)
  deps.pendingIceMigration.delete(sessionId)
  deps.clearDisconnectedTimer(sessionId)
  deps.clearInitialIceRecovery(sessionId)
  // Detach dc.onclose BEFORE calling dc.close(). Otherwise the listener set in
  // deps.setupDataChannel sees pc still alive (we close dc first, pc second) and
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
  const ecdh = ecdhResolvers.get(sessionId)
  if (ecdh) {
    clearTimeout(ecdh.timer)
    ecdhResolvers.delete(sessionId)
    try { ecdh.reject(new DOMException('Peer connection cleaned up', 'AbortError')) } catch { /* ignore */ }
  }
  connectingPeers.delete(sessionId)
  remoteInitiatingPeers.delete(sessionId)
  const retryTimer = deps.iceRestartRetryTimers.get(sessionId)
  if (retryTimer) {
    clearTimeout(retryTimer)
    deps.iceRestartRetryTimers.delete(sessionId)
  }
  const resolvers = primaryChannelResolvers.get(sessionId)
  if (resolvers) {
    primaryChannelResolvers.delete(sessionId)
    for (const resolve of resolvers) resolve()
  }
  resetCrypto(sessionId)
  deps.shortIdToTransferId.delete(sessionId)
  // Without this, when an ICE-failed peer is cleaned up but PEER_LEFT is
  // never received (unilateral local teardown), `connectedPeers` keeps the
  // stale sessionId. Downstream code that consults it for "is this peer
  // reachable?" then takes the wrong branch.
  storeSet(s => {
    if (!s.connectedPeers.has(sessionId)) return s
    const next = new Set(s.connectedPeers)
    next.delete(sessionId)
    return { connectedPeers: next }
  })
}

