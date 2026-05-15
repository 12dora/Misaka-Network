// ── NAT type detection (browser entry point) ─────────────────────────
// Probes several STUN servers from one ICE agent and inspects the
// resulting server-reflexive (srflx) candidates to classify NAT type.
// All pure logic lives in `nat-classify.ts`; this file is a thin shell
// that drives an RTCPeerConnection.

import { DEFAULT_STUN, NAT_DETECTION_TIMEOUT_MS } from '@/constants'
import { classifyNat, parseCandidate, type NatDetectionResult, type ParsedCandidate } from './nat-classify'

export type { NatType, NatDetectionResult, ParsedCandidate } from './nat-classify'
export { classifyNat, parseCandidate, isPrivateAddress } from './nat-classify'

export async function detectNatType(
  stunServers: RTCIceServer[] = DEFAULT_STUN,
): Promise<NatDetectionResult> {
  if (typeof RTCPeerConnection === 'undefined') {
    return {
      type: 'unknown',
      publicEndpoints: [],
      hasHostCandidate: false,
      reason: '当前环境无 RTCPeerConnection。',
    }
  }

  const pc = new RTCPeerConnection({ iceServers: stunServers })
  // Need at least one m-line so the browser actually gathers.
  pc.createDataChannel('nat-probe')

  const candidates: ParsedCandidate[] = []
  const done = new Promise<void>(resolve => {
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      timer = null
      resolve()
    }, NAT_DETECTION_TIMEOUT_MS)

    pc.onicecandidate = (e) => {
      if (e.candidate?.candidate) {
        const parsed = parseCandidate(e.candidate.candidate)
        if (parsed) candidates.push(parsed)
      } else {
        if (timer) { clearTimeout(timer); timer = null }
        resolve()
      }
    }
  })

  try {
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    await done
    return classifyNat(candidates)
  } finally {
    pc.close()
  }
}
