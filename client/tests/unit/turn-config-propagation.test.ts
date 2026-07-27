// Live-PC propagation of TURN config changes (P0-4, P1-2) plus the
// turnSettings.enabled gating contract (CLAUDE.md "key contracts").
//
// Two regressions are guarded here:
//   1. refreshAutoTurn() used to update the module-local cache but never
//      reached existing RTCPeerConnections — long-lived PCs ran on dead creds.
//   2. The "force relay" toggle was honoured only on initial PC build —
//      flipping it in Settings mid-session was silently ignored.
//
// Both cases now route through onTurnConfigChange → applyIceConfigToAll.

import { describe, it, expect, beforeEach, vi } from 'vitest'

// Polyfill localStorage. jsdom defines a `localStorage` getter on window,
// but in Node 22+ the getter resolves through Node's experimental
// localStorage which is gated behind --localstorage-file and returns
// undefined. We install a minimal in-memory shim before importing any
// module that touches localStorage at runtime.
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

// TEST-008: the "TURN disabled" contract used to be asserted with only a
// MANUAL server seeded, which `getTurnIceServers()` filters out on its own —
// the test passed without ever exercising the auto-TURN path that production
// always injected. Mock the credential endpoint so we can put real
// server-issued creds in the cache and prove the master switch kills those
// too.
vi.mock('@/lib/api', () => ({
  AuthRequiredError: class AuthRequiredError extends Error {},
  authedFetch: vi.fn(async () => autoTurnResponse()),
}))

const AUTO_TURN_URL = 'turn:auto.example.com:3478'

function autoTurnResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      enabled: true,
      iceServers: [{ urls: AUTO_TURN_URL, username: 'auto-u', credential: 'auto-c' }],
      expiresAt: Date.now() + 600_000,
    }),
  } as unknown as Response
}

import {
  loadTurnSettings, saveTurnSettings,
  onTurnConfigChange, refreshAutoTurn, clearAutoTurn, getAutoTurnIceServers,
} from '../../src/lib/turn'
import { buildIceConfig, applyIceConfigToAll, isRelayAllowed, hasUsableTurnServer } from '../../src/lib/webrtc'
import { setDetectedNatType } from '../../src/lib/nat'

function turnUrlsIn(cfg: RTCConfiguration): string[] {
  return (cfg.iceServers ?? [])
    .flatMap(s => Array.isArray(s.urls) ? s.urls : [s.urls])
    .map(String)
    .filter(u => u.startsWith('turn:') || u.startsWith('turns:'))
}

beforeEach(() => {
  localStorage.clear()
  clearAutoTurn()
  setDetectedNatType('unknown')
})

describe('turnSettings.enabled = false (CLAUDE.md contract)', () => {
  it('omits both auto and manual TURN servers from the ICE config', async () => {
    // Seed a real, unexpired auto-TURN credential first — this is the case
    // the old test never covered (TEST-008).
    await refreshAutoTurn()
    expect(getAutoTurnIceServers().length).toBe(1)

    saveTurnSettings({
      enabled: false,
      forceRelay: false,
      servers: [{
        id: 'm1',
        url: 'turn:turn.example.com:3478',
        username: 'user',
        credential: 'cred',
        enabled: true,
      }],
    })
    const cfg = buildIceConfig()
    const urls = (cfg.iceServers ?? []).flatMap(s => Array.isArray(s.urls) ? s.urls : [s.urls])
    // STUN may still be present — only TURN must be excluded.
    expect(urls.some(u => String(u).startsWith('turn:'))).toBe(false)
    expect(urls.some(u => String(u).startsWith('turns:'))).toBe(false)
    expect(isRelayAllowed()).toBe(false)
  })

  it('keeps server-issued auto TURN when the user has never opened Settings', async () => {
    // No stored record at all: `enabled:false` is only the struct default, not
    // an opt-out. The server is the canonical gate for auto TURN (budget +
    // kill-switch), so it must still reach the ICE config out of the box.
    await refreshAutoTurn()
    expect(turnUrlsIn(buildIceConfig())).toEqual([AUTO_TURN_URL])
    expect(isRelayAllowed()).toBe(true)
  })

  it('re-enabling the master switch brings auto TURN back', async () => {
    await refreshAutoTurn()
    saveTurnSettings({ enabled: false, forceRelay: false, servers: [] })
    expect(turnUrlsIn(buildIceConfig())).toEqual([])

    saveTurnSettings({ enabled: true, forceRelay: false, servers: [] })
    expect(turnUrlsIn(buildIceConfig())).toEqual([AUTO_TURN_URL])
  })

  it('includes manual TURN when enabled = true', () => {
    saveTurnSettings({
      enabled: true,
      forceRelay: false,
      servers: [{
        id: 'm1', url: 'turn:turn.example.com:3478',
        username: 'user', credential: 'cred', enabled: true,
      }],
    })
    const cfg = buildIceConfig()
    const urls = (cfg.iceServers ?? []).flatMap(s => Array.isArray(s.urls) ? s.urls : [s.urls])
    expect(urls.some(u => u === 'turn:turn.example.com:3478')).toBe(true)
  })
})

describe('force-relay is refused when there is no reachable TURN (BUG-008)', () => {
  it('relay-only + zero TURN servers is downgraded to iceTransportPolicy=all', () => {
    // A 'relay' policy with a STUN-only server list can never produce a
    // candidate — every connection would be guaranteed to fail. Refuse it.
    saveTurnSettings({ enabled: true, forceRelay: true, servers: [] })
    expect(hasUsableTurnServer()).toBe(false)
    expect(buildIceConfig().iceTransportPolicy).toBe('all')
  })

  it('force-relay is also refused when the master switch hid the only TURN', async () => {
    await refreshAutoTurn()
    saveTurnSettings({ enabled: false, forceRelay: true, servers: [] })
    expect(hasUsableTurnServer()).toBe(false)
    expect(buildIceConfig().iceTransportPolicy).toBe('all')
  })

  it('force-relay is honoured once a usable TURN exists', () => {
    saveTurnSettings({
      enabled: true, forceRelay: true,
      servers: [{ id: 'm1', url: 'turn:t.example.com:3478', username: 'u', credential: 'c', enabled: true }],
    })
    expect(hasUsableTurnServer()).toBe(true)
    expect(buildIceConfig().iceTransportPolicy).toBe('relay')
  })
})

describe('force-relay toggle propagates to live PCs', () => {
  it('saveTurnSettings → buildIceConfig reflects forceRelay immediately', async () => {
    await refreshAutoTurn()
    saveTurnSettings({ enabled: true, forceRelay: false, servers: [] })
    expect(buildIceConfig().iceTransportPolicy).toBe('all')

    saveTurnSettings({ enabled: true, forceRelay: true, servers: [] })
    expect(buildIceConfig().iceTransportPolicy).toBe('relay')
  })

  it('fires onTurnConfigChange listeners when settings flip', () => {
    saveTurnSettings({ enabled: false, forceRelay: false, servers: [] })

    const listener = vi.fn()
    const off = onTurnConfigChange(listener)

    saveTurnSettings({ enabled: false, forceRelay: true, servers: [] })
    expect(listener).toHaveBeenCalledTimes(1)

    saveTurnSettings({ enabled: true, forceRelay: true, servers: [] })
    expect(listener).toHaveBeenCalledTimes(2)

    off()
  })

  it('applyIceConfigToAll calls setConfiguration on every non-closed PC with the current config', async () => {
    await refreshAutoTurn()
    saveTurnSettings({ enabled: true, forceRelay: false, servers: [] })

    const pcOpen: any = {
      connectionState: 'connected',
      setConfiguration: vi.fn(),
    }
    const pcClosed: any = {
      connectionState: 'closed',
      setConfiguration: vi.fn(),
    }

    saveTurnSettings({ enabled: true, forceRelay: true, servers: [] })
    applyIceConfigToAll([pcOpen, pcClosed])

    expect(pcOpen.setConfiguration).toHaveBeenCalledTimes(1)
    const passed = pcOpen.setConfiguration.mock.calls[0][0] as RTCConfiguration
    expect(passed.iceTransportPolicy).toBe('relay')
    expect(pcClosed.setConfiguration).not.toHaveBeenCalled()
  })

  // BUG-009: `setConfiguration()` alone never migrates the *already selected*
  // candidate pair — the peers keep using the old path until something else
  // restarts ICE. applyIceConfigToAll therefore reports which live PCs saw a
  // materially different config so the caller can schedule an ICE restart.
  it('reports the PCs whose effective ICE config actually changed', async () => {
    await refreshAutoTurn()
    saveTurnSettings({ enabled: true, forceRelay: false, servers: [] })

    const pc: any = { connectionState: 'connected', setConfiguration: vi.fn() }

    // First application only records a baseline — nothing to migrate yet.
    expect(applyIceConfigToAll([pc])).toEqual([])

    saveTurnSettings({ enabled: true, forceRelay: true, servers: [] })
    expect(applyIceConfigToAll([pc])).toEqual([pc])

    // Re-applying the same config is a no-op for migration purposes.
    expect(applyIceConfigToAll([pc])).toEqual([])
  })

  it('reports a change when the TURN server set rotates but the policy does not', async () => {
    saveTurnSettings({ enabled: true, forceRelay: false, servers: [] })
    const pc: any = { connectionState: 'connected', setConfiguration: vi.fn() }
    applyIceConfigToAll([pc])

    saveTurnSettings({
      enabled: true, forceRelay: false,
      servers: [{ id: 'm1', url: 'turn:new.example.com:3478', username: 'u', credential: 'c', enabled: true }],
    })
    expect(applyIceConfigToAll([pc])).toEqual([pc])
  })

  it('swallows setConfiguration errors so one bad PC does not stop the others', () => {
    saveTurnSettings({ enabled: false, forceRelay: false, servers: [] })
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const bad: any = { connectionState: 'connected', setConfiguration: () => { throw new Error('fail') } }
    const good: any = { connectionState: 'connected', setConfiguration: vi.fn() }

    applyIceConfigToAll([bad, good])
    expect(good.setConfiguration).toHaveBeenCalledTimes(1)

    consoleSpy.mockRestore()
  })
})

describe('onTurnConfigChange subscriber lifecycle', () => {
  it('returns an unsubscribe function that removes the listener', () => {
    saveTurnSettings({ enabled: false, forceRelay: false, servers: [] })
    const listener = vi.fn()
    const off = onTurnConfigChange(listener)
    saveTurnSettings({ enabled: false, forceRelay: true, servers: [] })
    expect(listener).toHaveBeenCalledTimes(1)
    off()
    saveTurnSettings({ enabled: true, forceRelay: true, servers: [] })
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('loadTurnSettings defaults', () => {
  it('returns enabled=false / forceRelay=false / no servers when nothing is saved', () => {
    localStorage.removeItem('misaka.turnServers')
    const s = loadTurnSettings()
    expect(s.enabled).toBe(false)
    expect(s.forceRelay).toBe(false)
    expect(s.servers).toEqual([])
  })
})
