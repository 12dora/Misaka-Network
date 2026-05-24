// P1-1: NAT-unreachable selector + store wiring.
//
// `isLikelyUnreachable` is the entire UX gate for the warning banner that
// stops users from waiting ~30 s on a doomed ICE-restart cycle. The
// selector must be:
//   - false when NAT is anything other than the firm 'symmetric' verdict,
//     so 'unknown' (firewalled probe timeout) does NOT over-warn.
//   - false when ANY usable TURN exists (auto-issued by the server, or a
//     user-enabled manual entry).
//   - true ONLY when both conditions stack: symmetric NAT AND no TURN.

import { describe, it, expect, beforeEach } from 'vitest'

// jsdom under Node 22 doesn't expose a usable localStorage (see
// turn-config-propagation.test.ts comment). Install an in-memory shim
// before importing turn.ts, which loadTurnSettings reads from at runtime.
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

import { saveTurnSettings } from '../../src/lib/turn'
import { isLikelyUnreachable } from '../../src/store/network'

beforeEach(() => {
  localStorage.clear()
})

describe('isLikelyUnreachable', () => {
  it('false when NAT is open / cone / blocked / unknown — any non-symmetric verdict', () => {
    for (const nat of ['open', 'cone', 'blocked', 'unknown', null] as const) {
      expect(isLikelyUnreachable({ myNatType: nat, autoTurnAvailable: false })).toBe(false)
    }
  })

  it('false when symmetric BUT auto-TURN is available', () => {
    expect(isLikelyUnreachable({ myNatType: 'symmetric', autoTurnAvailable: true })).toBe(false)
  })

  it('false when symmetric + no auto-TURN BUT a manual TURN is enabled', () => {
    saveTurnSettings({
      enabled: true,
      forceRelay: false,
      servers: [{
        id: 'm', url: 'turn:t.example.com', username: 'u', credential: 'c', enabled: true,
      }],
    })
    expect(isLikelyUnreachable({ myNatType: 'symmetric', autoTurnAvailable: false })).toBe(false)
  })

  it('false when symmetric + manual TURN exists but is disabled (settings.enabled=false)', () => {
    saveTurnSettings({
      enabled: false,
      forceRelay: false,
      servers: [{
        id: 'm', url: 'turn:t.example.com', username: 'u', credential: 'c', enabled: true,
      }],
    })
    // settings.enabled=false → manual list is NOT injected. With no auto
    // TURN either, the peer is unreachable.
    expect(isLikelyUnreachable({ myNatType: 'symmetric', autoTurnAvailable: false })).toBe(true)
  })

  it('false when symmetric + manual TURN entry exists but its row is disabled', () => {
    saveTurnSettings({
      enabled: true,
      forceRelay: false,
      servers: [{
        id: 'm', url: 'turn:t.example.com', username: 'u', credential: 'c', enabled: false,
      }],
    })
    // Per-row toggle off → not used. With no auto, unreachable.
    expect(isLikelyUnreachable({ myNatType: 'symmetric', autoTurnAvailable: false })).toBe(true)
  })

  it('true ONLY when symmetric AND no usable TURN of either kind', () => {
    saveTurnSettings({ enabled: false, forceRelay: false, servers: [] })
    expect(isLikelyUnreachable({ myNatType: 'symmetric', autoTurnAvailable: false })).toBe(true)
  })
})
