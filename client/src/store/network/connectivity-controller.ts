/**
 * connectivity-controller.ts — TURN/NAT probe, live config apply, ICE migration,
 * foreground recovery.
 */
import {
  applyIceConfigToAll, whenSignalingStable,
} from '@/lib/webrtc'
import { refreshAutoTurn, onTurnConfigChange, fetchTurnStatus, getAutoTurnState } from '@/lib/turn'
import { detectNatType, onNatTypeChange, invalidateDetectedNatType } from '@/lib/nat'
import { reconnectNow } from '@/lib/signaling'
import { storeGet, storeSet } from './store-access'
import { deps } from './deps'

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

export const pendingIceMigration = new Set<string>()


export function sessionIdForPc(pc: RTCPeerConnection): string | null {
  for (const [sid, candidate] of deps.peerConnections) {
    if (candidate === pc) return sid
  }
  return null
}



export function propagateIceConfig() {
  const changed = applyIceConfigToAll(deps.peerConnections.values()) ?? []
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



export async function migrateIcePath(peerSessionId: string) {
  const pc = deps.peerConnections.get(peerSessionId)
  if (!pc) return
  const attempt = deps.capturePeerConnectionAttempt(peerSessionId, pc)
  // Nothing to migrate on a connection that hasn't picked a path yet — its
  // first gathering round already uses the new config.
  if (pc.iceConnectionState !== 'connected' && pc.iceConnectionState !== 'completed') return
  let offerToken: number | undefined
  try {
    if (pc.signalingState !== 'stable') {
      await whenSignalingStable(pc, { timeoutMs: 10_000 })
    }
    // Re-verify everything the awaits could have invalidated.
    if (!deps.isPeerConnectionAttemptCurrent(attempt)) return
    if (!deps.isSignalingReady()) return
    offerToken = deps.beginLocalOffer(peerSessionId)
    let offer: RTCSessionDescriptionInit
    try {
      offer = await pc.createOffer({ iceRestart: true })
      if (!deps.isPeerConnectionAttemptCurrent(attempt)) return
      if (!deps.isLocalOfferCurrent(peerSessionId, offerToken)) return
      // Keep makingOffer true through setLocalDescription so a remote offer
      // arriving mid-install still observes the collision window.
      await pc.setLocalDescription(offer)
      if (!deps.isPeerConnectionAttemptCurrent(attempt)) return
      if (!deps.isLocalOfferCurrent(peerSessionId, offerToken)) return
      deps.sendLocalOffer(peerSessionId, pc, pc.localDescription!.toJSON())
    } finally {
      // Only the current offer token may clear makingOffer — after local
      // description is installed or this token is no longer current.
      if (offerToken !== undefined && deps.isLocalOfferCurrent(peerSessionId, offerToken)) {
        deps.negState(peerSessionId).makingOffer = false
      }
    }
  } catch (err) {
    if (offerToken !== undefined && deps.isLocalOfferCurrent(peerSessionId, offerToken)) {
      deps.negState(peerSessionId).makingOffer = false
    }
    console.warn('[net] ICE path migration failed', peerSessionId, err)
  }
}



export function installTurnConfigPropagation() {
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
      storeSet({ myNatType: t })
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
export function startNatAndTurnProbes() {
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
      storeSet({ myNatType: result.type })
    } catch (err) {
      console.warn('[nat] probe failed', err)
      storeSet({ myNatType: 'unknown' })
    }
  })()

  // Auto-TURN status: server may report disabled / quota-exceeded / not
  // configured. We treat any "not enabled" reply as `autoTurnAvailable=false`.
  void (async () => {
    try {
      const status = await fetchTurnStatus()
      if (!status) {
        storeSet({ autoTurnAvailable: false })
        return
      }
      storeSet({ autoTurnAvailable: status.available })
    } catch {
      storeSet({ autoTurnAvailable: false })
    }
  })()
}



// Re-export the auto-TURN state inspector so the page can decide whether
// to call out "TURN unavailable" explicitly. Cheap wrapper, no state copy.
export function getAutoTurnSnapshot() {
  return getAutoTurnState()
}



export function installForegroundRecovery() {
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
    deps.transferSpeedSamples.clear()
  })
}

/** Called from destroy() / endNetworkEpoch — clears unsubs and migration timer. */
export function clearConnectivityOnDestroy() {
  if (turnConfigUnsubscribe) { turnConfigUnsubscribe(); turnConfigUnsubscribe = null }
  if (natConfigUnsubscribe) { natConfigUnsubscribe(); natConfigUnsubscribe = null }
  natStoreUnsubscribe = null
  natProbeStarted = false
  if (iceMigrationTimer) { clearTimeout(iceMigrationTimer); iceMigrationTimer = null }
  pendingIceMigration.clear()
}

export function clearIceMigrationTimer() {
  if (iceMigrationTimer) { clearTimeout(iceMigrationTimer); iceMigrationTimer = null }
}



/**
 * BUG-004: after signaling comes back (fresh WELCOME + JOIN), re-negotiate
 * every peer we still know about whose connection did not survive. Attempts
 * made while signaling was down were refused by the readiness barrier, so
 * something has to pick them up again — and the generation check makes this
 * safe to run alongside the server's own PEER_JOINED-driven initiations.
 */
export function renegotiateOrphanPeers() {
  for (const peer of storeGet().peers) {
    if (deps.remoteInitiatingPeers.has(peer.sessionId)) continue
    const pc = deps.peerConnections.get(peer.sessionId)
    const dc = deps.dataChannels.get(peer.sessionId)
    const alive = pc && pc.connectionState !== 'closed' && pc.connectionState !== 'failed'
      && dc && dc.readyState !== 'closed'
    if (alive) continue
    deps.cleanupPeerConnection(peer.sessionId, { failQueuedMessages: false })
    deps.initiateWebRTC(peer.sessionId).catch(err => console.warn('[net] orphan renegotiate failed', err))
  }
}



export function recoverConnections() {
  const now = Date.now()
  if (now - lastRecoverAt < 1_500) return
  lastRecoverAt = now
  // Network environment may have changed (Wi-Fi ↔ cellular, VPN flip) — cached
  // NAT classification is stale; force a re-probe on the next request so
  // buildIceConfig picks the right relay policy.
  invalidateDetectedNatType()
  natProbeStarted = false
  if ((deps as { currentToken?: string }).currentToken) {
    reconnectNow()
    void refreshAutoTurn()
    startNatAndTurnProbes()
  }
  for (const peer of storeGet().peers) {
    const pc = deps.peerConnections.get(peer.sessionId)
    const dc = deps.dataChannels.get(peer.sessionId)
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
      deps.cleanupPeerConnection(peer.sessionId)
      deps.initiateWebRTC(peer.sessionId).catch(() => {})
    } else if (pc.iceConnectionState === 'disconnected') {
      void Promise.resolve(deps.attemptIceRestart(peer.sessionId)).catch(() => {})
    }
  }
}


