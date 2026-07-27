// ── NAT type detection (browser entry point) ─────────────────────────
// Probes several STUN servers from one ICE agent and inspects the
// resulting server-reflexive (srflx) candidates to classify NAT type.
// All pure logic lives in `nat-classify.ts`; this file is a thin shell
// that drives an RTCPeerConnection.

import { DEFAULT_STUN, NAT_DETECTION_TIMEOUT_MS } from '@/constants'
import { SUPPLEMENTAL_STUN } from './turn'
import { isE2eHostIceOnly } from './e2e-ice'
import { classifyNat, parseCandidate, type NatDetectionResult, type NatType, type ParsedCandidate } from './nat-classify'

export type { NatType, NatDetectionResult, ParsedCandidate } from './nat-classify'
export { classifyNat, parseCandidate, isPrivateAddress } from './nat-classify'

// ── Shared NAT state ──────────────────────────────────────────────────
// `detectNatType()` is called from the Settings modal. We stash the latest
// result so other layers (webrtc.ts → buildIceConfig) can adjust ICE policy
// without needing every call site to re-probe. Listeners let the live PC
// graph re-apply config when the local NAT type changes.

let lastNatType: NatType = 'unknown'
type NatTypeListener = (t: NatType) => void
const natListeners = new Set<NatTypeListener>()

export function getDetectedNatType(): NatType {
  return lastNatType
}

export function setDetectedNatType(t: NatType) {
  if (lastNatType === t) return
  lastNatType = t
  for (const fn of natListeners) {
    try { fn(t) } catch (err) { nlog('listener failed', err) }
  }
}

// P2-9: scoped + timestamped warn (mirrors webrtc.ts wlog without forcing
// a cross-module import cycle).
function nlog(...args: unknown[]) {
  const ts = new Date().toISOString().slice(11, 23)
  console.warn(`[nat ${ts}]`, ...args)
}

export function onNatTypeChange(fn: NatTypeListener): () => void {
  natListeners.add(fn)
  return () => natListeners.delete(fn)
}

// P1-6: discard the cached verdict (e.g. on network change / unhide) so
// the next detectNatType() re-probes from scratch. Goes through
// setDetectedNatType so all subscribers see the reset.
export function invalidateDetectedNatType() {
  setDetectedNatType('unknown')
}

export async function detectNatType(
  stunServers: RTCIceServer[] = [...DEFAULT_STUN, ...SUPPLEMENTAL_STUN],
): Promise<NatDetectionResult> {
  if (typeof RTCPeerConnection === 'undefined') {
    return {
      type: 'unknown',
      publicEndpoints: [],
      hasHostCandidate: false,
      reason: '当前环境无 RTCPeerConnection。',
    }
  }

  // Same-host Playwright peers need no external discovery. Keeping the NAT
  // probe host-only prevents a supposedly deterministic test run from
  // quietly issuing public STUN DNS requests before the real peer is built.
  const pc = new RTCPeerConnection({
    iceServers: isE2eHostIceOnly() ? [] : stunServers,
  })
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
    let timeout: ReturnType<typeof setTimeout> | null = null
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error('NAT_DETECTION_TIMEOUT')), NAT_DETECTION_TIMEOUT_MS)
    })
    try {
      await Promise.race([
        (async () => {
          const offer = await pc.createOffer()
          await pc.setLocalDescription(offer)
          await done
        })(),
        deadline,
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
    }
    const result = classifyNat(candidates)
    // P1: stash the latest type so buildIceConfig can switch to relay
    // automatically when we're behind a symmetric NAT — without this the
    // user had to manually toggle "强制使用 TURN" in Settings.
    setDetectedNatType(result.type)
    return result
  } finally {
    pc.close()
  }
}
