// Regression [P2]: waitForBuffer only resolved via `onbufferedamountlow`. A
// DataChannel that closes (peer drop / NAT reset) while parked ABOVE the
// high-water mark never fires bufferedamountlow, so the promise hung forever —
// Promise.allSettled(laneLoop...) then never resolved, sendFileParallel hung,
// and the transfer card stuck at its last percent with no failure surfaced.
// The fix: also settle on channel close/error (and short-circuit when the
// channel is already not 'open').

import { describe, it, expect } from 'vitest'
import { waitForBuffer } from '../../src/lib/transfer'

function makeParkedDc() {
  const listeners: Record<string, Set<() => void>> = {}
  return {
    readyState: 'open' as RTCDataChannelState,
    // Force the parked path: bufferedAmount is well above any HIGH_WATER_MARK.
    bufferedAmount: Number.MAX_SAFE_INTEGER,
    bufferedAmountLowThreshold: 0,
    onbufferedamountlow: null as null | (() => void),
    addEventListener(t: string, fn: () => void) { (listeners[t] ??= new Set()).add(fn) },
    removeEventListener(t: string, fn: () => void) { listeners[t]?.delete(fn) },
    _fire(t: string) { for (const fn of listeners[t] ?? []) fn() },
  }
}

describe('waitForBuffer settles on channel death', () => {
  it('resolves when a parked channel fires close', async () => {
    const dc = makeParkedDc()
    let done = false
    const p = waitForBuffer(dc as unknown as RTCDataChannel).then(() => { done = true })
    // Give the sync body a couple of microtasks — it must NOT have resolved
    // yet (we are parked above the high-water mark).
    await Promise.resolve()
    await Promise.resolve()
    expect(done).toBe(false)
    // Channel dies → the close listener must resolve the promise.
    dc._fire('close')
    await p
    expect(done).toBe(true)
  })

  it('resolves when a parked channel fires error', async () => {
    const dc = makeParkedDc()
    const p = waitForBuffer(dc as unknown as RTCDataChannel)
    dc._fire('error')
    await expect(p).resolves.toBeUndefined()
  })

  it('resolves immediately when the channel is not open', async () => {
    const dc = makeParkedDc()
    dc.readyState = 'closing'
    // Must resolve without any event being fired.
    await expect(waitForBuffer(dc as unknown as RTCDataChannel)).resolves.toBeUndefined()
  })

  it('still resolves via bufferedamountlow in the normal case', async () => {
    const dc = makeParkedDc()
    const p = waitForBuffer(dc as unknown as RTCDataChannel)
    // The browser fires bufferedamountlow once the queue drains.
    dc.onbufferedamountlow?.()
    await expect(p).resolves.toBeUndefined()
  })
})
