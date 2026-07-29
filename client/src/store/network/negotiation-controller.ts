/**
 * negotiation-controller.ts — SignalReceipt, pending ICE, perfect negotiation,
 * per-peer task queue, offer/answer glare handling.
 *
 * Ports: deps for peer-runtime / session / ice-recovery / data-channel-router.
 * Store access: store-access only (no useNetworkStore).
 */

import {
  createPeerConnection, createAnswer,
  applyAnswer, addIceCandidate,
  ensureAutoTurnReady,
  endOfCandidatesFor, installIceErrorListener,
} from '@/lib/webrtc'
import { generateECDHKeyPair, hasAESKey } from '@/lib/crypto'
import { TRANSFER_LANE_COUNT } from '@/constants'
import { send as wsSend } from '@/lib/signaling'
import type { Peer } from '@/types'
import type { PendingRemoteIceOverflowState } from './contracts'
import { storeGet, storeSet } from './store-access'
import { deps } from './deps'

/** Structural attempt shapes — owned by peer-runtime; local to avoid cycles. */
interface PeerGenerationAttempt {
  peerSessionId: string
  epoch: number
  gen: number
}
interface PeerConnectionAttempt extends PeerGenerationAttempt {
  pc: RTCPeerConnection
}

export type { PendingRemoteIceOverflowState }

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
const MAX_PENDING_REMOTE_ICE_GROUPS = 8
const MAX_PENDING_REMOTE_ICE_CANDIDATES_PER_GROUP = 256
export const pendingRemoteIce = new Map<string, Map<string, PendingRemoteIceGroup>>()
export const pendingRemoteNegotiationTokens = new Map<string, number>()
export const pendingRemoteTokenReservations = new Map<string, Map<string, number>>()
export const peerRemoteNegotiationCounters = new Map<string, number>()
export const pendingRemoteIceHints = new Map<string, PendingRemoteIceHint>()
export const installedRemoteNegotiationTokens = new Map<string, number>()
export const pendingRemoteIceOverflow = new Map<string, PendingRemoteIceOverflowState>()
let pendingRemoteIceSequence = 0
/** Perfect-negotiation state per peer (store-side; webrtc.ts owned elsewhere). */
interface NegotiationState {
  makingOffer: boolean
  isSettingRemoteAnswerPending: boolean
  ignoreOffer: boolean
  /**
   * Monotonic token for the in-flight local createOffer. Bumped when a
   * polite glare accepts the remote offer so a later-resolving createOffer
   * does not publish a stale local SDP.
   */
  offerSeq: number
}
/** Cleanup owner: peer-runtime.cleanupPeerConnection (deletes negotiationState entry) */
export const negotiationState = new Map<string, NegotiationState>()
export function negState(peerSessionId: string): NegotiationState {
  let s = negotiationState.get(peerSessionId)
  if (!s) {
    s = {
      makingOffer: false,
      isSettingRemoteAnswerPending: false,
      ignoreOffer: false,
      offerSeq: 0,
    }
    negotiationState.set(peerSessionId, s)
  }
  return s
}

/** Begin a local offer; returns the token that must still match at publish. */
export function beginLocalOffer(peerSessionId: string): number {
  const neg = negState(peerSessionId)
  neg.makingOffer = true
  neg.offerSeq += 1
  return neg.offerSeq
}

/** Invalidate any in-flight local offer (polite glare accepted remote). */
export function invalidatePendingLocalOffer(peerSessionId: string): void {
  const neg = negState(peerSessionId)
  neg.offerSeq += 1
  neg.makingOffer = false
}

/** True iff the createOffer that produced `token` is still the current one. */
export function isLocalOfferCurrent(peerSessionId: string, token: number): boolean {
  return negState(peerSessionId).offerSeq === token
}

export const peerTaskQueues = new Map<string, Promise<void>>()
// Receipt-time incarnation for queued SDP/ICE. Peer generation alone is not
// enough here: a closure parked behind an old task used to capture generation
// only when it eventually started, at which point it could mistake a
// replacement PC for the frame's original target.
export const peerSignalingIncarnations = new Map<string, number>()
// Token of the most recently published local SDP offer on the current PC.
// Answers are stamped with this at receipt so an old queued answer cannot be
// applied to a later ICE-restart offer on the same still-live PC.
export const peerLocalOfferTokens = new Map<string, number>()

export interface SignalReceipt {
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

export function peerSignalingIncarnation(peerSessionId: string): number {
  return peerSignalingIncarnations.get(peerSessionId) ?? 0
}

export function invalidatePeerSignalingIncarnation(peerSessionId: string) {
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

export function captureSignalReceipt(
  peerSessionId: string,
  options: {
    preparePendingRemoteIce?: boolean
    candidate?: RTCIceCandidateInit
    endOfCandidates?: RTCIceCandidateInit | null
  } = {},
): SignalReceipt {
  const pc = deps.peerConnections.get(peerSessionId) ?? null
  const epoch = deps.getNetworkEpoch()
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
    gen: deps.peerGeneration(peerSessionId),
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
    && receipt.epoch === deps.getNetworkEpoch()
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

export function isSignalReceiptCurrent(
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
    receipt.epoch !== deps.getNetworkEpoch()
    || receipt.incarnation !== peerSignalingIncarnation(receipt.peerSessionId)
    || (
      !allowMissingPeer
      && !storeGet().peers.some(peer => peer.sessionId === receipt.peerSessionId)
    )
  ) return false
  if (requireLocalOfferToken && receipt.localOfferToken === null) return false
  if (
    (requireLocalOfferToken || bindLocalOfferToken)
    && receipt.localOfferToken !== null
    && peerLocalOfferTokens.get(receipt.peerSessionId) !== receipt.localOfferToken
  ) return false
  if (!receipt.originatingPc) return !requireOriginatingPc
  return receipt.gen === deps.peerGeneration(receipt.peerSessionId)
    && deps.peerConnections.get(receipt.peerSessionId) === receipt.originatingPc
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
export function enqueuePeerTask(
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

export function sendLocalOffer(
  peerSessionId: string,
  pc: RTCPeerConnection,
  sdp: RTCSessionDescriptionInit,
) {
  if (deps.peerConnections.get(peerSessionId) !== pc) return
  const localOfferToken = (peerLocalOfferTokens.get(peerSessionId) ?? 0) + 1
  peerLocalOfferTokens.set(peerSessionId, localOfferToken)
  const pendingGroups = pendingRemoteIce.get(peerSessionId)
  if (pendingGroups) {
    for (const pending of pendingGroups.values()) {
      if (
        pending.epoch === deps.getNetworkEpoch()
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

// Perfect-negotiation tie-break: when both sides send offers at the same
// time (e.g. simultaneous ICE restart on LAN UDP flap), the side with the
// lexicographically smaller sessionId is "polite" and yields — rolls back
// its local offer and accepts the remote one. The impolite side ignores
// the incoming offer and keeps its own.
export function isPolite(peerSessionId: string): boolean {
  const my = storeGet().mySessionId ?? ''
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
    receipt.epoch === deps.getNetworkEpoch()
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
    if (!receiptStillCurrent() || !deps.isPeerConnectionAttemptCurrent(attempt)) return

    const matchingCandidates = group.candidates.filter(candidate => (
      candidateCompatibleWithRemoteSdp(candidate, remoteSdp, {
        groupBindingProven: true,
        groupUfrag: group.ufrag,
      })
    ))
    group.candidates = group.candidates.filter(candidate => !matchingCandidates.includes(candidate))
    for (const candidate of matchingCandidates) {
      if (!receiptStillCurrent() || !deps.isPeerConnectionAttemptCurrent(attempt)) return
      try {
        await addIceCandidate(attempt.pc, candidate)
      } catch (err) {
        if (!receiptStillCurrent() || !deps.isPeerConnectionAttemptCurrent(attempt)) return
        console.warn('[net] addIceCandidate failed', err)
      }
    }
    if (
      group.endOfCandidates.length > 0
      && group.candidates.length === 0
      && receiptStillCurrent()
      && deps.isPeerConnectionAttemptCurrent(attempt)
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
        if (!receiptStillCurrent() || !deps.isPeerConnectionAttemptCurrent(attempt)) return
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

export async function handleRemoteSDP(receipt: SignalReceipt, fromNodeId: number, sdp: RTCSessionDescriptionInit) {
  const { peerSessionId: fromSessionId } = receipt
  const receivedEpoch = deps.getNetworkEpoch()
  // P1-3: defer SDP processing until we know our own sessionId. The polite/
  // impolite tie-break is computed against mySessionId — if an SDP arrives
  // before WELCOME finishes processing, mySessionId is null and isPolite()
  // resolves "" < peerSessionId === true, making BOTH sides polite. The
  // result is that both peers roll back their offers and neither establishes.
  // Wait up to 3s for WELCOME; any longer and something is structurally
  // broken (signaling never authed) — let the SDP fall through, which will
  // be a no-op because there's no PC and the offer-without-pc branch logs.
  if (storeGet().mySessionId === null) {
    const start = Date.now()
    while (storeGet().mySessionId === null && Date.now() - start < 3000) {
      await new Promise(r => setTimeout(r, 20))
      if (receivedEpoch !== deps.getNetworkEpoch()) return
    }
    if (storeGet().mySessionId === null) {
      console.warn('[net] handleRemoteSDP gave up waiting for WELCOME — dropping', fromSessionId, sdp.type)
      return
    }
  }
  if (receivedEpoch !== deps.getNetworkEpoch()) return

  // A valid inbound offer is also authoritative evidence that this session is
  // in our cluster. Publish the roster row before the TURN/key awaits so every
  // continuation can use the same peer-attempt predicate.
  if (sdp.type === 'offer') {
    storeSet(s => {
      if (receivedEpoch !== deps.getNetworkEpoch() || s.peers.some(p => p.sessionId === fromSessionId)) return s
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
  if (!storeGet().peers.some(peer => peer.sessionId === fromSessionId)) return

  let pc = deps.peerConnections.get(fromSessionId)
  if (sdp.type === 'offer') deps.remoteInitiatingPeers.delete(fromSessionId)

  if (pc && sdp.type === 'offer' && !hasAESKey(fromSessionId)) {
    const peerStatus = storeGet().peers
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
      deps.cleanupPeerConnection(fromSessionId, { failQueuedMessages: false })
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
    const gen = deps.bumpPeerGeneration(fromSessionId)
    const generationAttempt: PeerGenerationAttempt = {
      peerSessionId: fromSessionId,
      epoch: receivedEpoch,
      gen,
    }
    await ensureAutoTurnReady()
    if (!deps.isPeerGenerationAttemptCurrent(generationAttempt)) return
    if (deps.peerConnections.has(fromSessionId)) return
    pc = createPeerConnection()
    installIceErrorListener(pc)
    deps.peerConnections.set(fromSessionId, pc)
    const createdAttempt: PeerConnectionAttempt = { ...generationAttempt, pc }

    pc.ondatachannel = (e) => {
      if (!deps.isPeerConnectionAttemptCurrent(createdAttempt)) return
      const label = e.channel.label
      // Whitelist exactly `misaka` and `misaka-transfer-0..TRANSFER_LANE_COUNT-1`.
      // Accepting arbitrary labels let a peer overwrite the primary channel or
      // grow lanes without bound.
      if (label === 'misaka') {
        const prev = deps.dataChannels.get(fromSessionId)
        // Whitelist is correct; replacement policy is not: a duplicate exact
        // `misaka` must not close a live primary. Keep the open channel.
        if (prev && prev !== e.channel) {
          if (prev.readyState === 'open' || prev.readyState === 'connecting') {
            try { e.channel.close() } catch { /* ignore */ }
            return
          }
          try { prev.close() } catch { /* ignore */ }
        }
        deps.dataChannels.set(fromSessionId, e.channel)
        deps.notifyPrimaryChannel(fromSessionId)
        deps.setupDataChannel(e.channel, createdAttempt)
        return
      }
      const laneMatch = /^misaka-transfer-(\d+)$/.exec(label)
      if (laneMatch) {
        const laneIdx = Number(laneMatch[1])
        if (!Number.isInteger(laneIdx) || laneIdx < 0 || laneIdx >= TRANSFER_LANE_COUNT) {
          try { e.channel.close() } catch { /* ignore */ }
          return
        }
        // P2-9: de-duplicate. After an ICE restart the answerer's
        // ondatachannel fires again for the same labels; without this guard
        // each label accumulates additional channel entries and the same
        // chunk could be sent down two lanes.
        const lanes = deps.transferLanes.get(fromSessionId) ?? []
        const existing = lanes.find(l => l.label === label)
        if (existing) {
          const idx = lanes.indexOf(existing)
          try { existing.close() } catch { /* ignore */ }
          lanes[idx] = e.channel
        } else if (lanes.length < TRANSFER_LANE_COUNT) {
          lanes.push(e.channel)
        } else {
          try { e.channel.close() } catch { /* ignore */ }
          return
        }
        deps.transferLanes.set(fromSessionId, lanes)
        deps.setupDataChannel(e.channel, createdAttempt)
        return
      }
      try { e.channel.close() } catch { /* ignore */ }
    }

    deps.installIceCandidateHandler(createdAttempt)

    pc.oniceconnectionstatechange = () => deps.handleIceStateChange(createdAttempt)
    // The answerer can wedge before ICE emits `checking` too; cover the whole
    // initial negotiation window on both sides.
    deps.scheduleInitialIceRecovery(pc, fromSessionId)

    await generateECDHKeyPair(fromSessionId)
    if (!deps.isPeerConnectionAttemptCurrent(createdAttempt)) {
      deps.abandonPeerConnection(fromSessionId, pc)
      return
    }
  }

  const attempt = deps.capturePeerConnectionAttempt(fromSessionId, pc)
  if (!deps.isPeerConnectionAttemptCurrent(attempt)) return

  const neg = negState(fromSessionId)
  if (sdp.type === 'offer') {
    // Perfect negotiation (full state machine): glare while createOffer is
    // pending, while setRemoteDescription(answer) is pending, or while we
    // already have a local offer outstanding.
    const offerCollision =
      neg.makingOffer
      || neg.isSettingRemoteAnswerPending
      || pc.signalingState !== 'stable'
    if (!offerCollision) {
      // Clear sticky ignore from a prior collision so later legitimate
      // offers are not swallowed for the rest of the session.
      neg.ignoreOffer = false
    } else {
      const polite = isPolite(fromSessionId)
      neg.ignoreOffer = !polite
      if (!polite) {
        console.warn('[net] ignoring colliding offer (impolite side)', fromSessionId)
        return
      }
      // Polite: invalidate any in-flight createOffer so its later-resolving
      // SDP is never published, roll back an outstanding local offer, then
      // accept theirs.
      invalidatePendingLocalOffer(fromSessionId)
      try {
        if (pc.signalingState === 'have-local-offer') {
          await pc.setLocalDescription({ type: 'rollback' } as RTCSessionDescriptionInit)
        }
        if (!deps.isPeerConnectionAttemptCurrent(attempt)) return
        rebindPendingRemoteOfferIce(receipt, sdp)
      } catch (err) {
        if (!deps.isPeerConnectionAttemptCurrent(attempt)) return
        console.warn('[net] glare rollback failed', err)
        return
      }
    }
    if (neg.ignoreOffer) return
    const answer = await createAnswer(pc, sdp, () => deps.isPeerConnectionAttemptCurrent(attempt))
    if (!deps.isPeerConnectionAttemptCurrent(attempt)) return
    neg.ignoreOffer = false
    wsSend({ t: 'SIGNAL_SDP', targetSessionId: fromSessionId, sdp: answer })
  } else {
    if (!deps.isPeerConnectionAttemptCurrent(attempt)) return
    if (pc.signalingState !== 'have-local-offer' && !neg.makingOffer && !neg.isSettingRemoteAnswerPending) {
      console.warn('[net] ignoring stale SDP answer', fromSessionId, pc.signalingState)
      return
    }
    neg.isSettingRemoteAnswerPending = true
    try {
      await applyAnswer(pc, sdp, () => deps.isPeerConnectionAttemptCurrent(attempt))
    } finally {
      neg.isSettingRemoteAnswerPending = false
    }
    if (!deps.isPeerConnectionAttemptCurrent(attempt)) return
    neg.ignoreOffer = false
  }

  if (!deps.isPeerConnectionAttemptCurrent(attempt)) return
  await drainPendingRemoteIce(receipt, sdp, attempt)
}

export async function handleRemoteICE(receipt: SignalReceipt, candidate: RTCIceCandidateInit) {
  const { peerSessionId: fromSessionId } = receipt
  const pc = deps.peerConnections.get(fromSessionId)
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
    const attempt = deps.capturePeerConnectionAttempt(fromSessionId, pc)
    if (!deps.isPeerConnectionAttemptCurrent(attempt)) return
    // Wrap: addIceCandidate throws on closed pc / malformed candidate / unknown
    // sdpMid. Without try/catch the dispatch loop's forEach swallows the
    // rejection (unhandledrejection), and we'd never know one peer's bad IPv6
    // candidate was poisoning the whole session.
    try {
      await addIceCandidate(pc, candidate)
      if (!deps.isPeerConnectionAttemptCurrent(attempt)) return
    } catch (err) {
      if (!deps.isPeerConnectionAttemptCurrent(attempt)) return
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

export async function handleRemoteICEEnd(receipt: SignalReceipt) {
  const { peerSessionId: fromSessionId } = receipt
  const pc = deps.peerConnections.get(fromSessionId)
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

    const attempt = deps.capturePeerConnectionAttempt(fromSessionId, pc)
    if (!deps.isPeerConnectionAttemptCurrent(attempt)) return
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

  const attempt = deps.capturePeerConnectionAttempt(fromSessionId, pc)
  if (!deps.isPeerConnectionAttemptCurrent(attempt)) return
  // Empty-candidate marker per RFC 8445 §8.1.2 — signals the peer has
  // finished gathering. Browsers accept this to short-circuit waits.
  // Firefox rejects sdpMid:'' — endOfCandidatesFor reads a real mid from
  // the PC's first transceiver so both Chrome and FF accept the marker.
  try {
    await pc.addIceCandidate(endOfCandidatesFor(pc, receipt.remoteIceEndCandidate ?? undefined))
    if (!deps.isPeerConnectionAttemptCurrent(attempt)) return
  }
  catch { /* some browsers still reject the marker; harmless */ }
  retireUnusedPendingRemoteToken(receipt)
}


/** Cleanup owner: peer-runtime.cleanupPeerConnection */
export function clearPeerNegotiationState(sessionId: string): void {
  invalidatePeerSignalingIncarnation(sessionId)
  negotiationState.delete(sessionId)
  pendingRemoteIce.delete(sessionId)
  pendingRemoteNegotiationTokens.delete(sessionId)
  pendingRemoteTokenReservations.delete(sessionId)
  peerRemoteNegotiationCounters.delete(sessionId)
  pendingRemoteIceHints.delete(sessionId)
  installedRemoteNegotiationTokens.delete(sessionId)
  pendingRemoteIceOverflow.delete(sessionId)
}

/** Cleanup owner: session-scope.endNetworkEpoch */
export function clearAllNegotiationState(): void {
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
  negotiationState.clear()
}
