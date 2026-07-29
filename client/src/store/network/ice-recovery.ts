/**
 * ice-recovery.ts — ICE restart, watchdog, rebuild, disconnected timers.
 */
import type { NodeStatus } from '@/types'
import { whenSignalingStable, getSelectedIcePath, getSelectedChannelType } from '@/lib/webrtc'
import { hasAESKey } from '@/lib/crypto'
import {
  MAX_ICE_RESTART_ATTEMPTS, ICE_RESTART_BACKOFF_MS, ICE_DISCONNECTED_RESTART_DELAY_MS,
} from '@/constants'
import { storeGet, storeSet } from './store-access'
import { deps } from './deps'
import { failPendingMessages, appendSystemChat } from './chat-controller'

/** Structural attempt shapes — owned by peer-runtime; kept local to avoid cycles. */
interface PeerGenerationAttempt {
  peerSessionId: string
  epoch: number
  gen: number
}
interface PeerConnectionAttempt extends PeerGenerationAttempt {
  pc: RTCPeerConnection
}

/** Scheduled ICE restart retries (answer/ICE recovery deadline). */
/** Cleanup owner: ice-recovery via cleanupPeerConnection */
export const iceRestartRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()

// peerSessionId → the peer generation the in-flight restart belongs to. A Map
// (not a Set) so a stale restart can only release the lock it took itself —
// otherwise it cleared the lock of the connection that replaced it (BUG-007).
/** Cleanup owner: ice-recovery via cleanupPeerConnection */
export const iceRestarting = new Map<string, number>()

/** Cleanup owner: ice-recovery via cleanupPeerConnection */
export const iceRestartAttempts = new Map<string, number>()

// Schedule an ICE restart when state is 'disconnected' for too long. The
// browser fires 'failed' very lazily (~30s), so we stop waiting and try
// to recover proactively.
export const disconnectedTimers = new Map<string, ReturnType<typeof setTimeout>>()

// Chromium can occasionally remain in ICE "checking" forever even after
// both sides accepted host candidates. No failed/disconnected event means
// the normal recovery path never runs. Exactly one deterministic side owns
// a bounded initial ICE restart so both peers cannot create glare.
export const initialIceRecoveryTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** Cleanup owner: PEER_LEFT / blockPeer / encrypted-ready (OPEN: not in cleanupPeerConnection) */
export const initialEncryptedSessionRebuilds = new Set<string>()

const INITIAL_ICE_RECOVERY_MS = 8_000

const INITIAL_ICE_REOBSERVE_MS = 8_000

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
/** Elapsed-time budget for non-stable / signaling-down ICE restart waits. */
const ICE_RESTART_PRECONDITION_BUDGET_MS = 60_000

/**
 * Elapsed-time budget start per peer for non-stable / signaling-down waits.
 * Cleanup owner: clearPeerIceRecovery (via cleanupPeerConnection) — also
 * deleted when a real offer begins, observation succeeds, or exhaustion runs.
 */
export const iceRestartPreconditionStarted = new Map<string, number>()

/** Single cleanup owner for all ICE-recovery maps for one peer. */
export function clearPeerIceRecovery(sessionId: string): void {
  iceRestartPreconditionStarted.delete(sessionId)
  iceRestartAttempts.delete(sessionId)
  iceRestarting.delete(sessionId)
  const retry = iceRestartRetryTimers.get(sessionId)
  if (retry) {
    clearTimeout(retry)
    iceRestartRetryTimers.delete(sessionId)
  }
  clearDisconnectedTimer(sessionId)
  clearInitialIceRecovery(sessionId)
}

export function clearAllIceRecovery(): void {
  for (const sid of [...iceRestartPreconditionStarted.keys()]) clearPeerIceRecovery(sid)
  // clearPeerIceRecovery already cleared the rest for known keys; sweep leftovers.
  iceRestartPreconditionStarted.clear()
  iceRestartAttempts.clear()
  iceRestarting.clear()
  for (const t of iceRestartRetryTimers.values()) clearTimeout(t)
  iceRestartRetryTimers.clear()
  for (const sid of [...disconnectedTimers.keys()]) clearDisconnectedTimer(sid)
  for (const sid of [...initialIceRecoveryTimers.keys()]) clearInitialIceRecovery(sid)
}


export function handleIceStateChange(attempt: PeerConnectionAttempt) {
  const { pc, peerSessionId } = attempt
  // A closed/replaced PC may still dispatch a queued state callback. It must
  // not reset retry state or schedule work against the replacement.
  if (!deps.isPeerConnectionAttemptCurrent(attempt)) return
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
        if (!deps.isPeerConnectionAttemptCurrent(attempt)) return
        if (pc.iceConnectionState !== 'disconnected' && pc.iceConnectionState !== 'failed') return
        const prevStatus = storeGet().peers.find(p => p.sessionId === peerSessionId)?.status
        storeSet(s => {
          if (!deps.isPeerConnectionAttemptCurrent(attempt)) return s
          return {
            peers: s.peers.map(p =>
              p.sessionId === peerSessionId ? { ...p, status: 'reconnecting' as NodeStatus } : p,
            ),
          }
        })
        if (!deps.isPeerConnectionAttemptCurrent(attempt)) return
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



export function clearDisconnectedTimer(peerSessionId: string) {
  const t = disconnectedTimers.get(peerSessionId)
  if (t) {
    clearTimeout(t)
    disconnectedTimers.delete(peerSessionId)
  }
}



export function scheduleInitialIceRecovery(pc: RTCPeerConnection, peerSessionId: string) {
  if (initialIceRecoveryTimers.has(peerSessionId)) return
  const epoch = deps.getNetworkEpoch()
  const gen = deps.peerGeneration(peerSessionId)
  const timer = setTimeout(async () => {
    initialIceRecoveryTimers.delete(peerSessionId)
    if (!isInitialIceRecoveryCurrent(pc, peerSessionId, epoch, gen)) return
    // Both sides observe the same bounded window, but only the deterministic
    // polite side sends the restart offer. The other side merely re-observes,
    // so a stalled pair can never create symmetric glare.
    if (!deps.isPolite(peerSessionId)) {
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
      deps.cleanupPeerConnection(peerSessionId, { failQueuedMessages: false })
      storeSet(s => ({
        peers: s.peers.map(peer =>
          peer.sessionId === peerSessionId
            ? { ...peer, status: 'connecting' as NodeStatus }
            : peer,
        ),
      }))
      // Freeze this rebuild attempt's identity the instant it starts.
      // `initiateWebRTC` bumps the peer generation SYNCHRONOUSLY (before its
      // first await — see its own contract comment), so reading
      // `deps.peerGeneration()` right after the call, and never again, captures
      // exactly the generation this specific attempt owns. The `.catch()`
      // below must judge the rejection against THIS frozen snapshot, never
      // against `deps.getNetworkEpoch()` / `deps.peerGeneration()` read at rejection time —
      // a late rejection would otherwise always look "current" (it's being
      // compared against itself) and could misjudge a newer or manually
      // rebuilt connection that has since taken over this peer.
      const rebuildTask = deps.initiateWebRTC(peerSessionId)
      const rebuildAttempt: PeerGenerationAttempt = {
        peerSessionId,
        epoch: deps.getNetworkEpoch(),
        gen: deps.peerGeneration(peerSessionId),
      }
      rebuildTask.catch(err => {
        console.warn('[net] initial encrypted-session rebuild failed', peerSessionId, err)
        // Stale rejection: the epoch ended, a newer attempt/generation has
        // already superseded this one, the peer left the roster, or AES came
        // up (through this or any other path) in the meantime. None of that
        // is this rebuild attempt's business to react to.
        if (!isRebuildRecoveryCurrent(rebuildAttempt)) return
        const replacement = deps.peerConnections.get(peerSessionId)
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
    if (pc.signalingState !== 'stable' || !deps.isSignalingReady()) {
      markInitialIceRecoveryFailed(pc, peerSessionId, epoch, gen)
      return
    }
    let offerToken: number | undefined
    try {
      offerToken = deps.beginLocalOffer(peerSessionId)
      let offer: RTCSessionDescriptionInit
      try {
        offer = await pc.createOffer({ iceRestart: true })
        if (!isInitialIceRecoveryCurrent(pc, peerSessionId, epoch, gen)) return
        if (!deps.isLocalOfferCurrent(peerSessionId, offerToken)) return
        // makingOffer stays true until local description is installed.
        await pc.setLocalDescription(offer)
        if (!isInitialIceRecoveryCurrent(pc, peerSessionId, epoch, gen)) return
        if (!deps.isLocalOfferCurrent(peerSessionId, offerToken)) return
        deps.sendLocalOffer(peerSessionId, pc, pc.localDescription!.toJSON())
        scheduleInitialIceReobservation(pc, peerSessionId, epoch, gen)
      } finally {
        if (offerToken !== undefined && deps.isLocalOfferCurrent(peerSessionId, offerToken)) {
          deps.negState(peerSessionId).makingOffer = false
        }
      }
    } catch (err) {
      if (offerToken !== undefined && deps.isLocalOfferCurrent(peerSessionId, offerToken)) {
        deps.negState(peerSessionId).makingOffer = false
      }
      console.warn('[net] initial ICE recovery failed', peerSessionId, err)
      markInitialIceRecoveryFailed(pc, peerSessionId, epoch, gen)
    }
  }, INITIAL_ICE_RECOVERY_MS)
  initialIceRecoveryTimers.set(peerSessionId, timer)
}



export function isInitialIceRecoveryCurrent(
  pc: RTCPeerConnection,
  peerSessionId: string,
  epoch: number,
  gen: number,
): boolean {
  return epoch === deps.getNetworkEpoch()
    && deps.isCurrentGeneration(peerSessionId, gen)
    && storeGet().peers.some(peer => peer.sessionId === peerSessionId)
    && deps.peerConnections.get(peerSessionId) === pc
    && !hasAESKey(peerSessionId)
    && (
      pc.iceConnectionState === 'new'
      || pc.iceConnectionState === 'checking'
      || pc.iceConnectionState === 'connected'
      || pc.iceConnectionState === 'completed'
    )
}



export function scheduleInitialIceReobservation(
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



export function markInitialIceRecoveryFailed(
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
 * attempt (Finding 1) whose `deps.initiateWebRTC()` call rejected before it ever
 * created a replacement PC. Callers are responsible for verifying the
 * attempt is still current (there is no PC to compare against here).
 */
export function markPeerRecoveryTerminal(peerSessionId: string) {
  clearInitialIceRecovery(peerSessionId)
  storeSet(s => {
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
export function isRebuildRecoveryCurrent(attempt: PeerGenerationAttempt): boolean {
  return deps.isPeerGenerationAttemptCurrent(attempt) && !hasAESKey(attempt.peerSessionId)
}



export function clearInitialIceRecovery(peerSessionId: string) {
  const timer = initialIceRecoveryTimers.get(peerSessionId)
  if (timer) clearTimeout(timer)
  initialIceRecoveryTimers.delete(peerSessionId)
}



export async function onIceConnected(attempt: PeerConnectionAttempt) {
  const { pc, peerSessionId } = attempt
  const stillCurrent = () => deps.isPeerConnectionAttemptCurrent(attempt)
  if (!stillCurrent()) return

  const selectedPath = await getSelectedIcePath(pc)
  if (!stillCurrent()) return
  let ct = selectedPath?.channelType
  if (!ct) {
    ct = await getSelectedChannelType(pc)
    if (!stillCurrent()) return
  }
  const encryptionReady = hasAESKey(peerSessionId)
  storeSet(s => {
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



export async function attemptIceRestart(peerSessionId: string) {
  if (iceRestarting.has(peerSessionId)) return
  const gen = deps.peerGeneration(peerSessionId)
  const generationAttempt = deps.captureGenerationAttempt(peerSessionId, gen)
  const stillCurrent = () => deps.isPeerGenerationAttemptCurrent(generationAttempt)
  let pcAttempt: PeerConnectionAttempt | null = null

  const attempts = iceRestartAttempts.get(peerSessionId) ?? 0
  if (attempts >= MAX_ICE_RESTART_ATTEMPTS) {
    // Terminal offline ONLY through the final-attempt observation job — never
    // mark offline here. A concurrent restart trigger during the observation
    // window must not bypass the timer.
    if (!iceRestartRetryTimers.has(peerSessionId)) {
      scheduleIceRestartRetry(
        peerSessionId,
        gen,
        ICE_RESTART_BACKOFF_MS[ICE_RESTART_BACKOFF_MS.length - 1] ?? 16_000,
      )
    }
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

    storeSet(s => {
      if (!stillCurrent()) return s
      return {
        peers: s.peers.map(p =>
          p.sessionId === peerSessionId ? { ...p, status: 'reconnecting' as NodeStatus } : p,
        ),
      }
    })

    const pc = deps.peerConnections.get(peerSessionId)
    if (!pc || pc.connectionState === 'closed' || pc.connectionState === 'failed') {
      deps.cleanupPeerConnection(peerSessionId, { failQueuedMessages: false })
      // initiateWebRTC IS a real restart attempt — count it. (cleanup bumped
      // the generation, so from here on we're driving the new one.)
      iceRestartAttempts.set(peerSessionId, attempts + 1)
      iceRestartPreconditionStarted.delete(peerSessionId)
      await deps.initiateWebRTC(peerSessionId)
      return
    }
    pcAttempt = deps.capturePeerConnectionAttempt(peerSessionId, pc, gen)
    const pcStillCurrent = () => pcAttempt !== null && deps.isPeerConnectionAttemptCurrent(pcAttempt)

    // Bound how long we can sit in non-stable / signaling-down loops.
    const preconditionStarted =
      iceRestartPreconditionStarted.get(peerSessionId) ?? Date.now()
    iceRestartPreconditionStarted.set(peerSessionId, preconditionStarted)
    if (Date.now() - preconditionStarted > ICE_RESTART_PRECONDITION_BUDGET_MS) {
      iceRestartPreconditionStarted.delete(peerSessionId)
      markPeerOfflineFromIceExhaustion(peerSessionId, gen)
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
        // Must schedule — silent return left peers stuck in reconnecting.
        scheduleIceRestartRetry(peerSessionId, gen)
        return
      }
      // Same re-check after the second await, plus PC identity: a manual
      // reconnect may have replaced the connection we were waiting on.
      if (!pcStillCurrent()) return
    }
    // Signaling must be back up, otherwise the restart offer is dropped by
    // `wsSend` and we've burned an attempt for nothing (BUG-004).
    if (!deps.isSignalingReady()) {
      scheduleIceRestartRetry(peerSessionId, gen)
      return
    }

    iceRestartAttempts.set(peerSessionId, attempts + 1)
    iceRestartPreconditionStarted.delete(peerSessionId)
    const offerToken = deps.beginLocalOffer(peerSessionId)
    let offer: RTCSessionDescriptionInit
    try {
      offer = await pc.createOffer({ iceRestart: true })
      if (!pcStillCurrent()) {
        scheduleIceRestartRetry(peerSessionId, gen)
        return
      }
      if (!deps.isLocalOfferCurrent(peerSessionId, offerToken)) {
        scheduleIceRestartRetry(peerSessionId, gen)
        return
      }
      // makingOffer stays true until local description is installed.
      await pc.setLocalDescription(offer)
      if (!pcStillCurrent()) {
        scheduleIceRestartRetry(peerSessionId, gen)
        return
      }
      if (!deps.isLocalOfferCurrent(peerSessionId, offerToken)) {
        scheduleIceRestartRetry(peerSessionId, gen)
        return
      }
      // Trickle — candidates will stream via onicecandidate. (Same fix as
      // createOffer/createAnswer: the `{ once: true }` gathering wait could
      // miss the `complete` event and hang the restart forever.)
      deps.sendLocalOffer(peerSessionId, pc, pc.localDescription!.toJSON())
      // Always give the just-published restart an observation window — even
      // when this was the final numeric attempt. Terminal offline is decided
      // only after that window elapses without ICE recovery.
      scheduleIceRestartRetry(peerSessionId, gen, ICE_RESTART_BACKOFF_MS[
        Math.min(attempts + 1, ICE_RESTART_BACKOFF_MS.length - 1)
      ] ?? 16_000)
    } finally {
      if (deps.isLocalOfferCurrent(peerSessionId, offerToken)) {
        deps.negState(peerSessionId).makingOffer = false
      }
    }
  } catch {
    const attemptCurrent = pcAttempt
      ? deps.isPeerConnectionAttemptCurrent(pcAttempt)
      : stillCurrent()
    if (attemptCurrent) {
      // Do not terminal-offline on a single createOffer blip — schedule the
      // next attempt so remaining budget actually runs.
      scheduleIceRestartRetry(peerSessionId, gen)
    }
  } finally {
    if (iceRestarting.get(peerSessionId) === gen) iceRestarting.delete(peerSessionId)
  }
}



export function markPeerOfflineFromIceExhaustion(peerSessionId: string, gen: number) {
  if (deps.peerGeneration(peerSessionId) !== gen) return
  iceRestartPreconditionStarted.delete(peerSessionId)
  storeSet(s => ({
    peers: s.peers.map(p =>
      p.sessionId === peerSessionId ? { ...p, status: 'offline' as NodeStatus } : p,
    ),
  }))
  failPendingMessages(peerSessionId)
  appendSystemChat(peerSessionId, '连接已断开，未送达的消息可点击 ↺ 重试')
}



export function scheduleIceRestartRetry(peerSessionId: string, gen: number, delayMs = 1_000) {
  const existing = iceRestartRetryTimers.get(peerSessionId)
  if (existing) clearTimeout(existing)
  // Never mark offline synchronously here. Even when the attempt counter has
  // already hit MAX (final offer just published), wait `delayMs` so the last
  // restart has an observation window to succeed.
  const timer = setTimeout(() => {
    iceRestartRetryTimers.delete(peerSessionId)
    if (deps.peerGeneration(peerSessionId) !== gen) return
    if (deps.getNetworkEpoch() === 0) return
    const pc = deps.peerConnections.get(peerSessionId)
    const ice = pc?.iceConnectionState
    if (ice === 'connected' || ice === 'completed') {
      iceRestartPreconditionStarted.delete(peerSessionId)
      return
    }
    const attempts = iceRestartAttempts.get(peerSessionId) ?? 0
    if (attempts >= MAX_ICE_RESTART_ATTEMPTS) {
      // Observation window for the final restart elapsed without recovery.
      markPeerOfflineFromIceExhaustion(peerSessionId, gen)
      return
    }
    void attemptIceRestart(peerSessionId)
  }, delayMs)
  iceRestartRetryTimers.set(peerSessionId, timer)
}


