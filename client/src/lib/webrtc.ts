export interface TurnServer {
  urls: string | string[]
  username?: string
  credential?: string
}

const DEFAULT_STUN: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
]

// ICE candidate pair → channel type
export type ChannelType = 'direct' | 'stun' | 'relay'

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

export function createPeerConnection(turnServers: TurnServer[] = []): RTCPeerConnection {
  const iceServers: RTCIceServer[] = [
    ...DEFAULT_STUN,
    ...turnServers.map(t => ({
      urls: typeof t.urls === 'string' ? [t.urls] : t.urls,
      username: t.username,
      credential: t.credential,
    })),
  ]

  return new RTCPeerConnection({
    iceServers,
    iceTransportPolicy: 'all',
  })
}

export function createDataChannel(pc: RTCPeerConnection, label = 'misaka'): RTCDataChannel {
  return pc.createDataChannel(label, {
    ordered: true,
  })
}

export async function createOffer(pc: RTCPeerConnection): Promise<RTCSessionDescriptionInit> {
  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)
  // Wait for ICE gathering to complete
  await new Promise<void>(resolve => {
    if (pc.iceGatheringState === 'complete') resolve()
    else pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') resolve()
    }, { once: true })
  })
  return pc.localDescription!.toJSON()
}

export async function createAnswer(
  pc: RTCPeerConnection,
  offer: RTCSessionDescriptionInit,
): Promise<RTCSessionDescriptionInit> {
  await pc.setRemoteDescription(new RTCSessionDescription(offer))
  const answer = await pc.createAnswer()
  await pc.setLocalDescription(answer)
  // Wait for ICE gathering
  await new Promise<void>(resolve => {
    if (pc.iceGatheringState === 'complete') resolve()
    else pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') resolve()
    }, { once: true })
  })
  return pc.localDescription!.toJSON()
}

export async function applyAnswer(pc: RTCPeerConnection, answer: RTCSessionDescriptionInit) {
  await pc.setRemoteDescription(new RTCSessionDescription(answer))
}

export async function addIceCandidate(pc: RTCPeerConnection, candidate: RTCIceCandidateInit) {
  await pc.addIceCandidate(new RTCIceCandidate(candidate))
}
