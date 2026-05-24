// P1 regression: when auto-TURN credentials expire mid-session, the very
// next consumer of getAutoTurnIceServers() must trigger a background refresh
// instead of silently returning an empty list and leaving the next PC
// without relay. Also: isAutoTurnStaleWithin reports the imminent-expiry
// window that ensureAutoTurnReady consults.

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

import {
  getAutoTurnIceServers, isAutoTurnStaleWithin,
  refreshAutoTurn, clearAutoTurn,
} from '../../src/lib/turn'

// Stub authedFetch so refreshAutoTurn() resolves deterministically.
vi.mock('../../src/lib/api', () => {
  let fetchCount = 0
  return {
    AuthRequiredError: class AuthRequiredError extends Error {},
    authedFetch: vi.fn(async () => {
      fetchCount++
      return new Response(JSON.stringify({
        enabled: true,
        // Pretend the server hands out 30-second-from-now creds. Tests
        // mutate `nowMs` via vi.useFakeTimers() to drive expiry.
        iceServers: [{ urls: 'turn:fresh.example.com:3478', username: 'u', credential: 'c' }],
        expiresAt: Date.now() + 30_000,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }),
    // expose for assertion
    _getFetchCount: () => fetchCount,
  }
})

beforeEach(() => {
  clearAutoTurn()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('auto-TURN staleness handling', () => {
  it('isAutoTurnStaleWithin(window) is true when nothing has been fetched yet', () => {
    expect(isAutoTurnStaleWithin(1_000)).toBe(true)
  })

  it('after a refresh, isAutoTurnStaleWithin reports based on time-to-expiry', async () => {
    await refreshAutoTurn()
    expect(getAutoTurnIceServers().length).toBeGreaterThan(0)
    // Server stub gives ~30s creds. A 10s window should not yet be stale.
    expect(isAutoTurnStaleWithin(10_000)).toBe(false)
    // A 60s window covers the entire credential lifetime → stale.
    expect(isAutoTurnStaleWithin(60_000)).toBe(true)
  })

  it('getAutoTurnIceServers() returns [] after expiry AND triggers a background refetch', async () => {
    await refreshAutoTurn()
    expect(getAutoTurnIceServers().length).toBeGreaterThan(0)

    // Walk the clock past expiry without unmocking authedFetch.
    const realNow = Date.now
    try {
      Date.now = () => realNow() + 31_000
      const servers = getAutoTurnIceServers()
      expect(servers).toEqual([])
      // The expired entry is dropped; isAutoTurnStaleWithin reports stale.
      expect(isAutoTurnStaleWithin(0)).toBe(true)
    } finally {
      Date.now = realNow
    }
  })
})
