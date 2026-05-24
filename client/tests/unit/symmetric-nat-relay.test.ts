// P1 regression: when the local NAT type is symmetric, buildIceConfig() must
// auto-promote `iceTransportPolicy` to 'relay' as long as at least one TURN
// server is in the configured list. Without this the user had to manually
// toggle "强制使用 TURN" in Settings — symmetric-vs-symmetric P2P pairs would
// just sit on `iceTransportPolicy: 'all'` and silently fail ICE.

import { describe, it, expect, beforeEach } from 'vitest'

// Same in-memory localStorage shim as turn-config-propagation.test.ts —
// vitest's jsdom environment doesn't expose a writable Storage in Node 22+.
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
import { setDetectedNatType, onNatTypeChange } from '../../src/lib/nat'
import { buildIceConfig } from '../../src/lib/webrtc'

beforeEach(() => {
  localStorage.clear()
  setDetectedNatType('unknown')
})

describe('symmetric NAT → auto force-relay', () => {
  it('uses iceTransportPolicy=relay when nat=symmetric AND a TURN server is present', () => {
    saveTurnSettings({
      enabled: true,
      forceRelay: false,
      servers: [{
        id: 's1', url: 'turn:turn.example.com:3478',
        username: 'u', credential: 'c', enabled: true,
      }],
    })
    setDetectedNatType('symmetric')

    const cfg = buildIceConfig()
    expect(cfg.iceTransportPolicy).toBe('relay')
  })

  it('does NOT force relay if there is no TURN entry (would be unsatisfiable)', () => {
    saveTurnSettings({ enabled: false, forceRelay: false, servers: [] })
    setDetectedNatType('symmetric')

    const cfg = buildIceConfig()
    // STUN-only + symmetric is hopeless anyway, but at least we don't lock
    // the policy to 'relay' with no relay candidate available — that would
    // hang every connection on ICE-gathering forever.
    expect(cfg.iceTransportPolicy).toBe('all')
  })

  it('cone NAT stays on iceTransportPolicy=all (no over-eager relay)', () => {
    saveTurnSettings({
      enabled: true,
      forceRelay: false,
      servers: [{
        id: 's1', url: 'turn:turn.example.com:3478',
        username: 'u', credential: 'c', enabled: true,
      }],
    })
    setDetectedNatType('cone')

    const cfg = buildIceConfig()
    expect(cfg.iceTransportPolicy).toBe('all')
  })

  it('manual forceRelay still wins even when NAT is unknown', () => {
    saveTurnSettings({ enabled: false, forceRelay: true, servers: [] })
    setDetectedNatType('unknown')

    expect(buildIceConfig().iceTransportPolicy).toBe('relay')
  })

  it('notifies onNatTypeChange listeners on transition', () => {
    let calls = 0
    let lastType: string | null = null
    const off = onNatTypeChange(t => { calls++; lastType = t })

    setDetectedNatType('symmetric')
    expect(calls).toBe(1)
    expect(lastType).toBe('symmetric')

    // No-op transition: same value, no extra fire.
    setDetectedNatType('symmetric')
    expect(calls).toBe(1)

    setDetectedNatType('cone')
    expect(calls).toBe(2)
    expect(lastType).toBe('cone')

    off()
    setDetectedNatType('symmetric')
    expect(calls).toBe(2)
  })
})
