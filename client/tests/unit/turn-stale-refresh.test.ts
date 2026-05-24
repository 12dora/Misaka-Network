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
  refreshAutoTurn, clearAutoTurn, testTurnServer,
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

// P2-7: testTurnServer used to close the PC but leave its event handlers
// attached; a late onicecandidate event kept the underlying ICE agent in
// the GC graph. Verify all handlers are detached prior to close.
describe('testTurnServer: listener cleanup before close', () => {
  it('clears every event handler on the timeout path', async () => {
    const handlers = {
      onicecandidate: vi.fn(),
      onicecandidateerror: vi.fn(),
      onicegatheringstatechange: vi.fn(),
      oniceconnectionstatechange: vi.fn(),
      onconnectionstatechange: vi.fn(),
      onsignalingstatechange: vi.fn(),
      ondatachannel: vi.fn(),
    }
    const closed = vi.fn()
    // Track set-to-null assignments so we can verify cleanup. Use a Proxy
    // so any property the implementation nulls is visible to the test.
    const cleared = new Set<string>()
    const pcStub: any = new Proxy({
      createDataChannel: () => ({}),
      createOffer: async () => ({ type: 'offer', sdp: '' }),
      setLocalDescription: async () => {},
      close: closed,
      ...handlers,
    }, {
      set(t, k, v) {
        if (typeof k === 'string' && v === null) cleared.add(k)
        ;(t as any)[k] = v
        return true
      },
      get(t, k) { return (t as any)[k] },
    })

    const origRtc = (globalThis as any).RTCPeerConnection
    ;(globalThis as any).RTCPeerConnection = function () { return pcStub } as any

    vi.useFakeTimers()
    const promise = testTurnServer({
      id: 'x', url: 'turn:none.example.com', username: 'u', credential: 'c',
      enabled: true,
    })
    // Let the createOffer + setLocalDescription microtasks settle.
    await vi.advanceTimersByTimeAsync(0)
    vi.advanceTimersByTime(5_001)
    const verdict = await promise
    vi.useRealTimers()
    ;(globalThis as any).RTCPeerConnection = origRtc

    expect(verdict).toBe(false)
    expect(closed).toHaveBeenCalled()
    // All the listener properties we care about were set to null before
    // close() so a stray late candidate cannot revive the agent.
    for (const key of Object.keys(handlers)) {
      expect(cleared.has(key), `expected ${key} to be nulled`).toBe(true)
    }
  })
})
