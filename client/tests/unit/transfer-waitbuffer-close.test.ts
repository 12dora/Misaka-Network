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
    _fire(t: string) { for (const fn of [...(listeners[t] ?? [])]) fn() },
    _listenerCount(t: string) { return listeners[t]?.size ?? 0 },
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
    // The browser fires bufferedamountlow once the queue drains. BUG-015
    // moved the waiter off the single-slot `dc.onbufferedamountlow` property
    // onto a real listener, so that is what the test dispatches.
    expect(dc.onbufferedamountlow).toBeNull()
    dc._fire('bufferedamountlow')
    await expect(p).resolves.toBeUndefined()
  })

  // ── BUG-015 ────────────────────────────────────────────────────────
  // Two concurrent transfers (or two lanes of one transfer) can both be
  // parked above the high-water mark on the SAME channel. The old
  // implementation stored the waiter in `dc.onbufferedamountlow`, a single
  // slot: the second waiter overwrote the first, and whichever waiter ran
  // `cleanup()` first nulled the other one out. The loser's promise never
  // settled, `Promise.allSettled(lanes)` never resolved, and the send hung.
  describe('BUG-015: concurrent waiters on one channel', () => {
    it('wakes EVERY parked waiter on a single bufferedamountlow event', async () => {
      const dc = makeParkedDc()
      const settled = [false, false, false]
      const promises = settled.map((_, i) =>
        waitForBuffer(dc as unknown as RTCDataChannel).then(() => { settled[i] = true }),
      )
      await Promise.resolve()
      expect(settled).toEqual([false, false, false])

      dc._fire('bufferedamountlow')
      await Promise.all(promises)
      expect(settled).toEqual([true, true, true])
    })

    it('one waiter settling does not strip the others listeners', async () => {
      const dc = makeParkedDc()
      let firstDone = false
      let secondDone = false
      const first = waitForBuffer(dc as unknown as RTCDataChannel).then(() => { firstDone = true })
      const second = waitForBuffer(dc as unknown as RTCDataChannel).then(() => { secondDone = true })

      // Deliver the event to the FIRST waiter only by firing once — both
      // listeners are independent registrations, so both must settle.
      dc._fire('bufferedamountlow')
      await Promise.all([first, second])
      expect(firstDone).toBe(true)
      expect(secondDone).toBe(true)

      // Every listener removed itself: a later event has nothing to call.
      const remaining = dc._listenerCount('bufferedamountlow')
      expect(remaining).toBe(0)
    })

    it('a dying channel settles all parked waiters, not just one', async () => {
      const dc = makeParkedDc()
      const results: string[] = []
      const a = waitForBuffer(dc as unknown as RTCDataChannel).then(() => results.push('a'))
      const b = waitForBuffer(dc as unknown as RTCDataChannel).then(() => results.push('b'))
      dc._fire('close')
      await Promise.all([a, b])
      expect(results.sort()).toEqual(['a', 'b'])
    })
  })
})
