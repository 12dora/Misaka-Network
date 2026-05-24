import { getTurnIceServers, getAutoTurnIceServers, loadTurnSettings, refreshAutoTurn } from './turn'
import { DEFAULT_STUN, ICE_CANDIDATE_POOL_SIZE } from '@/constants'

// One-shot pre-warm so connections kicked off immediately after WS open
// can still get TURN ICE servers from the first RTCPeerConnection.
// refreshAutoTurn is idempotent / coalesces in-flight calls.
export async function ensureAutoTurnReady(timeoutMs = 1500): Promise<void> {
  if (getAutoTurnIceServers().length > 0) return
  try {
    await Promise.race([
      refreshAutoTurn(),
      new Promise(resolve => setTimeout(resolve, timeoutMs)),
    ])
  } catch { /* ignore — fall through with whatever we have */ }
}

// ICE candidate pair → channel type
export type ChannelType = 'direct' | 'stun' | 'relay'
export interface SelectedIcePath {
  channelType: ChannelType | null
  pathText: string
}

export function candidateType(candidate: RTCIceCandidate): ChannelType | null {
  if (!candidate.candidate) return null
  const s = candidate.candidate.toLowerCase()
  if (s.includes(' typ host ')) return 'direct'
  if (s.includes(' typ srflx ')) return 'stun'
  if (s.includes(' typ relay ')) return 'relay'
  return null
}

export async function getSelectedChannelType(pc: RTCPeerConnection): Promise<ChannelType | null> {
  try {
    const stats = await pc.getStats()
    for (const report of stats.values()) {
      if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) {
        const local = stats.get(report.localCandidateId)
        if (local?.candidateType === 'host') return 'direct'
        if (local?.candidateType === 'srflx') return 'stun'
        if (local?.candidateType === 'relay') return 'relay'
        return null
      }
    }
  } catch { /* stats may fail */ }
  return null
}

function normalizeCandidateType(t?: string): 'host' | 'srflx' | 'relay' | 'unknown' {
  if (t === 'host' || t === 'srflx' || t === 'relay') return t
  return 'unknown'
}

function toChannelType(t: 'host' | 'srflx' | 'relay' | 'unknown'): ChannelType | null {
  if (t === 'host') return 'direct'
  if (t === 'srflx') return 'stun'
  if (t === 'relay') return 'relay'
  return null
}

export async function getSelectedIcePath(pc: RTCPeerConnection): Promise<SelectedIcePath | null> {
  try {
    const stats = await pc.getStats()
    for (const report of stats.values()) {
      if (report.type !== 'candidate-pair' || report.state !== 'succeeded' || !report.nominated) continue
      const local = stats.get(report.localCandidateId)
      const remote = stats.get(report.remoteCandidateId)
      const localType = normalizeCandidateType(local?.candidateType)
      const remoteType = normalizeCandidateType(remote?.candidateType)
      const channelType = toChannelType(localType)
      const localProto = local?.protocol || '?'
      const remoteProto = remote?.protocol || '?'
      return {
        channelType,
        pathText: `${localType}/${localProto} → ${remoteType}/${remoteProto}`,
      }
    }
  } catch { /* stats may fail */ }
  return null
}

// Single source of truth for the RTCConfiguration derived from current TURN
// state — used both for new PCs and to re-apply via `pc.setConfiguration()`
// on existing PCs when creds rotate or the user flips force-relay.
export function buildIceConfig(): RTCConfiguration {
  const turnSettings = loadTurnSettings()
  // Order: STUN → server-issued auto TURN (always injected — server is the
  // canonical gate via budget/killswitch) → manual user TURN (only when
  // user opts in via the Settings toggle).
  const iceServers: RTCIceServer[] = [
    ...DEFAULT_STUN,
    ...getAutoTurnIceServers(),
    ...(turnSettings.enabled ? getTurnIceServers() : []),
  ]
  return {
    iceServers,
    iceTransportPolicy: turnSettings.forceRelay ? 'relay' : 'all',
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
    iceCandidatePoolSize: ICE_CANDIDATE_POOL_SIZE,
  }
}

export function createPeerConnection(): RTCPeerConnection {
  return new RTCPeerConnection(buildIceConfig())
}

// Re-apply the current TURN config to every live PC. Called when auto-TURN
// creds refresh, when the user toggles force-relay, when manual servers are
// added/removed, etc. Without this an existing connection keeps the original
// (now stale) creds until it's torn down and re-created.
export function applyIceConfigToAll(pcs: Iterable<RTCPeerConnection>) {
  const cfg = buildIceConfig()
  for (const pc of pcs) {
    if (pc.connectionState === 'closed') continue
    try {
      // setConfiguration accepts a partial; we always pass the full one so
      // toggling forceRelay OFF actually clears the prior 'relay' policy.
      pc.setConfiguration(cfg)
    } catch (err) {
      console.warn('[webrtc] setConfiguration failed', err)
    }
  }
}

export function createDataChannel(pc: RTCPeerConnection, label = 'misaka'): RTCDataChannel {
  return pc.createDataChannel(label, {
    ordered: true,
  })
}

// Trickle ICE: return the SDP as soon as the local description is set, then
// stream candidates over the signaling channel via `onicecandidate`.
// Previously we waited for `iceGatheringState === 'complete'` but the
// listener was registered with `{ once: true }` — the first transition is
// usually `new → gathering`, the handler fires, doesn't resolve, gets
// removed, and the `complete` event later has no handler. The whole
// handshake hung, the DC never opened, and the user saw "DataChannel 打开超时".
export async function createOffer(pc: RTCPeerConnection): Promise<RTCSessionDescriptionInit> {
  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)
  return pc.localDescription!.toJSON()
}

export async function createAnswer(
  pc: RTCPeerConnection,
  offer: RTCSessionDescriptionInit,
): Promise<RTCSessionDescriptionInit> {
  await pc.setRemoteDescription(new RTCSessionDescription(offer))
  const answer = await pc.createAnswer()
  await pc.setLocalDescription(answer)
  return pc.localDescription!.toJSON()
}

export async function applyAnswer(pc: RTCPeerConnection, answer: RTCSessionDescriptionInit) {
  await pc.setRemoteDescription(new RTCSessionDescription(answer))
}

export async function addIceCandidate(pc: RTCPeerConnection, candidate: RTCIceCandidateInit) {
  await pc.addIceCandidate(new RTCIceCandidate(candidate))
}
