// NAT probe generation: stale results from a superseded network must not
// overwrite the current verdict, and superseded PCs must close early.
//
// @vitest-environment jsdom

import { describe, it, expect, beforeEach, vi } from 'vitest'

const closeSpy = vi.fn()
let createDataChannelImpl: () => void = () => {}

/** Queue of per-PC behaviours so two concurrent probes can publish different verdicts. */
type ProbePlan = {
  delayMs: number
  /** Candidate SDP lines emitted from setLocalDescription. */
  candidates: string[]
}

const plans: ProbePlan[] = []

// cone: single public srflx mapping
const CONE_SRFLX =
  'candidate:1 1 UDP 1677729535 1.2.3.4 54320 typ srflx raddr 10.0.0.2 rport 40000'
// symmetric: two distinct public mappings from the same local socket
const SYM_SRFLX_A =
  'candidate:2 1 UDP 1677729535 5.6.7.8 10000 typ srflx raddr 10.0.0.2 rport 40000'
const SYM_SRFLX_B =
  'candidate:3 1 UDP 1677729535 5.6.7.8 10001 typ srflx raddr 10.0.0.2 rport 40000'

class FakePC {
  onicecandidate: ((e: { candidate: { candidate: string } | null }) => void) | null = null
  private plan: ProbePlan

  constructor() {
    this.plan = plans.shift() ?? { delayMs: 0, candidates: [CONE_SRFLX] }
  }

  createDataChannel = vi.fn(() => {
    createDataChannelImpl()
    return {}
  })

  createOffer = vi.fn(async () => {
    if (this.plan.delayMs > 0) await new Promise(r => setTimeout(r, this.plan.delayMs))
    return { type: 'offer', sdp: 'x' }
  })

  setLocalDescription = vi.fn(async () => {
    for (const c of this.plan.candidates) {
      this.onicecandidate?.({ candidate: { candidate: c } })
    }
    this.onicecandidate?.({ candidate: null })
  })

  close = () => { closeSpy() }
}

beforeEach(() => {
  closeSpy.mockClear()
  createDataChannelImpl = () => {}
  plans.length = 0
  vi.stubGlobal('RTCPeerConnection', FakePC as unknown as typeof RTCPeerConnection)
})

import {
  detectNatType, invalidateDetectedNatType, getDetectedNatType, setDetectedNatType,
} from '../../src/lib/nat'

describe('NAT detection generation', () => {
  it('only the newest generation publishes when concurrent probes race', async () => {
    // Two controlled PCs with different verdicts. Starting the second probe
    // supersedes the first (closes its PC + cancels its race). The newest
    // still publishes its own classification; the stale one must not.
    plans.push(
      { delayMs: 40, candidates: [CONE_SRFLX] },
      { delayMs: 0, candidates: [SYM_SRFLX_A, SYM_SRFLX_B] },
    )

    const slow = detectNatType([])
    // Allow first PC to be constructed before the superseding probe.
    await Promise.resolve()
    const closesAfterFirst = closeSpy.mock.calls.length

    const fast = detectNatType([])
    // First probe's PC is closed early when the second generation starts.
    expect(closeSpy.mock.calls.length).toBeGreaterThan(closesAfterFirst)

    const fastResult = await fast
    expect(fastResult.type).toBe('symmetric')
    expect(getDetectedNatType()).toBe('symmetric')

    const slowResult = await slow
    // Superseded probe returns without publishing.
    expect(slowResult.type).toBe('unknown')
    expect(getDetectedNatType()).toBe('symmetric')
  })

  it('out-of-order completion: slower cone cannot overwrite a faster symmetric', async () => {
    // Both probes fully classify (no mutual cancel mid-ICE). We force the
    // publish gate by bumping generation between classify and the set call
    // via a third superseding invalidate after the fast one lands.
    plans.push(
      { delayMs: 30, candidates: [CONE_SRFLX] },
      { delayMs: 0, candidates: [SYM_SRFLX_A, SYM_SRFLX_B] },
    )

    // Run them sequentially on the generation counter by letting the first
    // finish first would not prove ordering — instead run both and ensure
    // the published type equals the higher generation's result only.
    //
    // Implementation: start gen1 (slow cone), then gen2 (fast symmetric).
    // gen1 is cancelled; gen2 publishes. Then start gen3 with cone after a
    // delay so an artificial late cone cannot roll back symmetric if we
    // manually set and then run a stale path.
    setDetectedNatType('unknown')
    const p1 = detectNatType([])
    await Promise.resolve()
    const p2 = detectNatType([])
    await p2
    expect(getDetectedNatType()).toBe('symmetric')
    await p1
    expect(getDetectedNatType()).toBe('symmetric')

    // A later probe with cone must be allowed to publish (it's newest).
    plans.push({ delayMs: 0, candidates: [CONE_SRFLX] })
    const p3 = await detectNatType([])
    expect(p3.type).toBe('cone')
    expect(getDetectedNatType()).toBe('cone')
  })

  it('invalidate closes the in-flight probe PC early and discards its result', async () => {
    plans.push({ delayMs: 50, candidates: [CONE_SRFLX] })
    const pending = detectNatType([])
    // Allow the PC to be constructed.
    await Promise.resolve()
    const closesBefore = closeSpy.mock.calls.length

    invalidateDetectedNatType()
    // Superseded probe's PC is closed immediately, not after ICE finishes.
    expect(closeSpy.mock.calls.length).toBeGreaterThan(closesBefore)
    expect(getDetectedNatType()).toBe('unknown')

    const result = await pending
    expect(result.type).toBe('unknown')
    expect(getDetectedNatType()).toBe('unknown')
  })

  it('createDataChannel throw still closes the PC', async () => {
    createDataChannelImpl = () => { throw new Error('DataChannel blocked') }
    plans.push({ delayMs: 0, candidates: [] })
    const result = await detectNatType([])
    expect(result.type).toBe('unknown')
    expect(closeSpy).toHaveBeenCalled()
  })
})
