// P1-5: end-of-candidates signaling used to send `{ candidate: '' }` with
// `sdpMid: ''`. Firefox refuses that — `new RTCIceCandidate({ sdpMid: '' })`
// throws TypeError: "sdpMid and sdpMLineIndex cannot both be null". The
// helper now extracts a real mid from the PC's first transceiver (or, as a
// fallback, scrapes the local SDP) before signaling end-of-candidates.

import { describe, it, expect } from 'vitest'
import { endOfCandidatesFor } from '../../src/lib/webrtc'

function pcWithTransceivers(mids: (string | null)[]) {
  return {
    getTransceivers: () => mids.map(m => ({ mid: m })),
    localDescription: null,
  } as unknown as RTCPeerConnection
}

function pcWithLocalSdp(sdp: string) {
  return {
    getTransceivers: () => [],
    localDescription: { sdp },
  } as unknown as RTCPeerConnection
}

describe('endOfCandidatesFor', () => {
  it('uses the first non-null transceiver mid', () => {
    const pc = pcWithTransceivers([null, '0', '1'])
    const out = endOfCandidatesFor(pc)
    expect(out.candidate).toBe('')
    expect(out.sdpMid).toBe('0')
    expect(out.sdpMLineIndex).toBe(1)
  })

  it('falls back to scraping the SDP when no transceiver has a mid', () => {
    const sdp = [
      'v=0',
      'o=- 0 0 IN IP4 127.0.0.1',
      's=-',
      'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
      'c=IN IP4 0.0.0.0',
      'a=mid:data',
      'a=sctp-port:5000',
    ].join('\r\n')
    const pc = pcWithLocalSdp(sdp)
    const out = endOfCandidatesFor(pc)
    expect(out.sdpMid).toBe('data')
    expect(out.sdpMLineIndex).toBe(0)
  })

  it('falls back to safe defaults when nothing is available', () => {
    const pc = { getTransceivers: () => [], localDescription: null } as unknown as RTCPeerConnection
    const out = endOfCandidatesFor(pc)
    expect(out.sdpMid).toBe('0')
    expect(out.sdpMLineIndex).toBe(0)
  })

  it('produces a payload that Firefox’s RTCIceCandidate constructor accepts (mid + lineIndex are not both null)', () => {
    const pc = pcWithTransceivers(['audio'])
    const out = endOfCandidatesFor(pc)
    // The whole point: at least one of these is a real, non-null value.
    expect(out.sdpMid !== null || out.sdpMLineIndex !== null).toBe(true)
    expect(out.sdpMid).toBe('audio')
  })
})
