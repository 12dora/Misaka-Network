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
let natGeneration = 0
/** Live probe PC — closed early when a newer generation supersedes it. */
let activeProbePc: RTCPeerConnection | null = null
let activeProbeGeneration = 0
/** Rejects the in-flight detectNatType race when the probe is superseded. */
let activeProbeCancel: ((err: Error) => void) | null = null
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

function closeActiveProbe() {
  if (activeProbeCancel) {
    try { activeProbeCancel(new Error('NAT_PROBE_SUPERSEDED')) } catch { /* ignore */ }
    activeProbeCancel = null
  }
  if (!activeProbePc) return
  try {
    activeProbePc.onicecandidate = null
    activeProbePc.close()
  } catch { /* ignore */ }
  activeProbePc = null
  activeProbeGeneration = 0
}

// P1-6: discard the cached verdict (e.g. on network change / unhide) so
// the next detectNatType() re-probes from scratch. Goes through
// setDetectedNatType so all subscribers see the reset. Bumps generation
// so any in-flight probe from the old network cannot publish, and closes
// its RTCPeerConnection immediately rather than waiting for ICE to finish.
export function invalidateDetectedNatType() {
  natGeneration++
  closeActiveProbe()
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

  // Bump so concurrent/stale probes from a previous network cannot overwrite.
  // Close any prior probe PC early — ICE agents are not free.
  const generation = ++natGeneration
  closeActiveProbe()

  // Same-host Playwright peers need no external discovery. Keeping the NAT
  // probe host-only prevents a supposedly deterministic test run from
  // quietly issuing public STUN DNS requests before the real peer is built.
  let pc: RTCPeerConnection
  try {
    pc = new RTCPeerConnection({
      iceServers: isE2eHostIceOnly() ? [] : stunServers,
    })
  } catch (err) {
    return {
      type: 'unknown',
      publicEndpoints: [],
      hasHostCandidate: false,
      reason: `无法创建 RTCPeerConnection：${String(err)}`,
    }
  }
  activeProbePc = pc
  activeProbeGeneration = generation

  const candidates: ParsedCandidate[] = []
  try {
    // createDataChannel (and everything else) lives inside try/finally so a
    // policy/hardening throw cannot leak the ICE agent.
    pc.createDataChannel('nat-probe')

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

    let timeout: ReturnType<typeof setTimeout> | null = null
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error('NAT_DETECTION_TIMEOUT')), NAT_DETECTION_TIMEOUT_MS)
    })
    const cancelled = new Promise<never>((_, reject) => {
      activeProbeCancel = reject
    })
    try {
      await Promise.race([
        (async () => {
          const offer = await pc.createOffer()
          if (generation !== natGeneration) throw new Error('NAT_PROBE_SUPERSEDED')
          await pc.setLocalDescription(offer)
          if (generation !== natGeneration) throw new Error('NAT_PROBE_SUPERSEDED')
          await done
        })(),
        deadline,
        cancelled,
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
      if (activeProbeCancel) activeProbeCancel = null
    }

    if (generation !== natGeneration) {
      return {
        type: 'unknown',
        publicEndpoints: [],
        hasHostCandidate: false,
        reason: '检测已被更新的网络状态取代。',
      }
    }

    const result = classifyNat(candidates)
    // Only publish if this probe is still the latest generation.
    if (generation === natGeneration) {
      setDetectedNatType(result.type)
    }
    return result
  } catch (err) {
    // Outer deadline still rejects so callers (and existing tests) can
    // distinguish timeout from a soft "unknown" classification.
    if (err instanceof Error && err.message === 'NAT_DETECTION_TIMEOUT') {
      throw err
    }
    if (err instanceof Error && err.message === 'NAT_PROBE_SUPERSEDED') {
      return {
        type: 'unknown',
        publicEndpoints: [],
        hasHostCandidate: false,
        reason: '检测已被更新的网络状态取代。',
      }
    }
    return {
      type: 'unknown',
      publicEndpoints: [],
      hasHostCandidate: false,
      reason: `网络类型检测失败：${String(err)}`,
    }
  } finally {
    if (activeProbePc === pc && activeProbeGeneration === generation) {
      activeProbePc = null
      activeProbeGeneration = 0
      activeProbeCancel = null
    }
    try {
      pc.onicecandidate = null
      pc.close()
    } catch { /* ignore */ }
  }
}
