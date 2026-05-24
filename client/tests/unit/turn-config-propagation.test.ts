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

import {
  loadTurnSettings, saveTurnSettings,
  onTurnConfigChange,
} from '../../src/lib/turn'
import { buildIceConfig, applyIceConfigToAll } from '../../src/lib/webrtc'

beforeEach(() => {
  localStorage.clear()
})

describe('turnSettings.enabled = false (CLAUDE.md contract)', () => {
  it('omits both auto and manual TURN servers from the ICE config', () => {
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

describe('force-relay toggle propagates to live PCs', () => {
  it('saveTurnSettings → buildIceConfig reflects forceRelay immediately', () => {
    saveTurnSettings({ enabled: false, forceRelay: false, servers: [] })
    expect(buildIceConfig().iceTransportPolicy).toBe('all')

    saveTurnSettings({ enabled: false, forceRelay: true, servers: [] })
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

  it('applyIceConfigToAll calls setConfiguration on every non-closed PC with the current config', () => {
    saveTurnSettings({ enabled: false, forceRelay: false, servers: [] })

    const pcOpen: any = {
      connectionState: 'connected',
      setConfiguration: vi.fn(),
    }
    const pcClosed: any = {
      connectionState: 'closed',
      setConfiguration: vi.fn(),
    }

    saveTurnSettings({ enabled: false, forceRelay: true, servers: [] })
    applyIceConfigToAll([pcOpen, pcClosed])

    expect(pcOpen.setConfiguration).toHaveBeenCalledTimes(1)
    const passed = pcOpen.setConfiguration.mock.calls[0][0] as RTCConfiguration
    expect(passed.iceTransportPolicy).toBe('relay')
    expect(pcClosed.setConfiguration).not.toHaveBeenCalled()
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
