import { getTurnIceServers, getAutoTurnIceServers, loadTurnSettings } from './turn'
import { DEFAULT_STUN, ICE_CANDIDATE_POOL_SIZE } from '@/constants'

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

export function createPeerConnection(): RTCPeerConnection {
  const turnSettings = loadTurnSettings()
  // Order: STUN → server-issued auto TURN (Cloudflare short-lived) → manual user TURN.
  // Manual user TURN is preserved even when auto TURN is unavailable.
  const iceServers: RTCIceServer[] = [
    ...DEFAULT_STUN,
    ...getAutoTurnIceServers(),
    ...getTurnIceServers(),
  ]

  return new RTCPeerConnection({
    iceServers,
    iceTransportPolicy: turnSettings.forceRelay ? 'relay' : 'all',
    // max-bundle: multiplex all media on a single transport — fewer ports
    // requested, friendlier to strict firewalls. Required when using DCs.
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
    // Pre-gather candidates so the offer/answer ships with srflx ready,
    // and connectivity checks can start the moment SDP arrives.
    iceCandidatePoolSize: ICE_CANDIDATE_POOL_SIZE,
  })
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
