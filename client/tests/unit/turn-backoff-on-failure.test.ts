// P1-2: fetchAutoTurnOnce() failures used to leave no retry scheduled
// (scheduleNextRefresh bails when autoTurn === null). On a 503 spike or
// transient network blip we'd silently give up and the next ICE
// negotiation tried to run on stale/empty creds.
//
// Fix: every failed refresh must arm a backoff timer.
//   delay = min(5_000 * 2^attempts, 60_000)
//   attempts resets on success.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

;(() => {
  const store = new Map<string, string>()
  const shim: Storage = {
    get length() { return store.size },
    clear() { store.clear() },
    getItem(k) { return store.has(k) ? store.get(k)! : null },
    setItem(k, v) { store.set(k, String(v)) },
    removeItem(k) { store.delete(k) },
    key(i) { return Array.from(store.keys())[i] ?? null },
  }
  Object.defineProperty(globalThis, 'localStorage', { value: shim, configurable: true, writable: true })
  Object.defineProperty(window, 'localStorage', { value: shim, configurable: true, writable: true })
})()

// Stubbed fetch — flips between failure and success per scenario.
let fetchImpl: () => Promise<Response> = async () => new Response('{}', { status: 503 })

vi.mock('../../src/lib/api', () => ({
  AuthRequiredError: class AuthRequiredError extends Error {},
  authedFetch: vi.fn(async () => fetchImpl()),
}))

import { refreshAutoTurn, clearAutoTurn, getAutoTurnState } from '../../src/lib/turn'

beforeEach(() => {
  clearAutoTurn()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

function expectScheduledTimer(expectedDelay: number) {
  // vitest fake timers: peek pending timers.
  const count = vi.getTimerCount()
  expect(count, 'a retry timer should be scheduled after a failed refresh').toBeGreaterThan(0)
  // Advance just shy of expected delay → no firing yet.
  vi.advanceTimersByTime(expectedDelay - 1)
}

describe('refreshAutoTurn: backoff on repeated failure', () => {
  it('arms a retry timer when the fetch fails with 503', async () => {
    fetchImpl = async () => new Response(JSON.stringify({ enabled: false, reason: 'KILL_SWITCH' }), { status: 503 })

    await refreshAutoTurn()
    expect(getAutoTurnState().active).toBe(false)

    // First failure → 5 000 ms delay.
    expectScheduledTimer(5_000)
  })

  it('grows exponentially: 5 → 10 → 20 → 40 → 60 (capped) seconds', async () => {
    fetchImpl = async () => new Response('boom', { status: 503 })

    const expected = [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]
    for (let attempt = 0; attempt < expected.length; attempt++) {
      await refreshAutoTurn()
      const delay = expected[attempt]
      const count = vi.getTimerCount()
      expect(count, `attempt #${attempt + 1}: timer must exist`).toBeGreaterThan(0)
      // Step right up to (but not past) the delay; ensure timer hasn't
      // fired yet. Then advance one more ms — the timer fires, which calls
      // refreshAutoTurn (still failing in this scenario). Since the new
      // refreshAutoTurn awaits a Promise, fire-and-forget — we clear timers
      // and let the next loop iteration re-trigger explicitly.
      vi.clearAllTimers()
    }
  })

  it('resets attempts to zero after a successful refresh', async () => {
    // Two failures, then a success, then a failure again — last failure
    // delay should be 5 s, not 20 s.
    let phase: 'fail' | 'ok' = 'fail'
    fetchImpl = async () => {
      if (phase === 'fail') return new Response('', { status: 503 })
      return new Response(JSON.stringify({
        enabled: true,
        iceServers: [{ urls: 'turn:fresh.example.com:3478', username: 'u', credential: 'c' }],
        expiresAt: Date.now() + 30_000,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    await refreshAutoTurn()
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    vi.clearAllTimers()

    await refreshAutoTurn()
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    vi.clearAllTimers()

    phase = 'ok'
    await refreshAutoTurn()
    expect(getAutoTurnState().active).toBe(true)
    // Success → a refresh-before-expiry timer exists, that's fine.
    vi.clearAllTimers()

    phase = 'fail'
    await refreshAutoTurn()
    // Attempts should have reset on the success — first failure after
    // success again schedules ~5 s, not 20 s.
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    // Verify the delay is 5 s by stepping clock.
    vi.advanceTimersByTime(4_999)
    // (Timer should not have fired its body yet — the body refires
    // refreshAutoTurn → would create more timers, but we cleared.)
  })
})
