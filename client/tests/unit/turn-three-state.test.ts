// TURN three-state preference + load validation + disabled-gate + epoch.
//
// @vitest-environment jsdom

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

let fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = async () =>
  new Response(JSON.stringify({
    enabled: true,
    iceServers: [{ urls: 'turn:auto.example:3478', username: 'u', credential: 'c' }],
    expiresAt: Date.now() + 600_000,
  }), { status: 200 })

const authedFetchMock = vi.fn(async (path: string, init?: RequestInit) => fetchImpl(path, init))

vi.mock('../../src/lib/api', () => ({
  AuthRequiredError: class AuthRequiredError extends Error {},
  authedFetch: (path: string, init?: RequestInit) => authedFetchMock(path, init),
}))

import {
  loadTurnSettings, saveTurnSettings, clearAutoTurn, refreshAutoTurn,
  getAutoTurnState, getAutoTurnIceServers, getTurnRelayPreference,
  isTurnExplicitlyDisabled, hasStoredTurnPreference, resetTurnSettingsMemory,
} from '../../src/lib/turn'
import { isRelayAllowed, buildIceConfig } from '../../src/lib/webrtc'
import { setDetectedNatType } from '../../src/lib/nat'

beforeEach(() => {
  localStorage.clear()
  resetTurnSettingsMemory()
  clearAutoTurn()
  setDetectedNatType('unknown')
  authedFetchMock.mockClear()
  vi.useFakeTimers()
  fetchImpl = async () => new Response(JSON.stringify({
    enabled: true,
    iceServers: [{ urls: 'turn:auto.example:3478', username: 'u', credential: 'c' }],
    expiresAt: Date.now() + 600_000,
  }), { status: 200 })
})

afterEach(() => {
  vi.useRealTimers()
  clearAutoTurn()
})

describe('three-state TURN preference', () => {
  it('unset: no storage → preference unset, relay allowed', () => {
    expect(hasStoredTurnPreference()).toBe(false)
    expect(getTurnRelayPreference()).toBe('unset')
    expect(isTurnExplicitlyDisabled()).toBe(false)
    expect(loadTurnSettings().enabled).toBe(false)
    expect(isRelayAllowed()).toBe(true)
  })

  it('explicit disabled: no auto credential fetch', async () => {
    saveTurnSettings({ enabled: false, forceRelay: false, servers: [] })
    expect(getTurnRelayPreference()).toBe('disabled')
    expect(isTurnExplicitlyDisabled()).toBe(true)

    const servers = await refreshAutoTurn()
    expect(servers).toEqual([])
    expect(authedFetchMock).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('explicit enabled: fetches credentials', async () => {
    saveTurnSettings({ enabled: true, forceRelay: false, servers: [] })
    const servers = await refreshAutoTurn()
    expect(servers.length).toBe(1)
    expect(authedFetchMock).toHaveBeenCalled()
  })

  it('tri-state under buildIceConfig: unset allows auto TURN; explicit disabled blocks all turn: URLs', async () => {
    // Distinct from the failed-disable (item 3) path: pins both sides of the
    // preference directly against buildIceConfig(), including a manual server
    // that must also be suppressed when the gate is explicit-off.
    function turnUrls(): string[] {
      return (buildIceConfig().iceServers ?? [])
        .flatMap(s => Array.isArray(s.urls) ? s.urls : [s.urls])
        .map(String)
        .filter(u => u.startsWith('turn:') || u.startsWith('turns:'))
    }

    // unset → auto TURN permitted
    expect(getTurnRelayPreference()).toBe('unset')
    expect(isRelayAllowed()).toBe(true)
    await refreshAutoTurn()
    expect(turnUrls()).toEqual(['turn:auto.example:3478'])

    // explicit disabled → no turn: from auto OR manual
    saveTurnSettings({
      enabled: false,
      forceRelay: false,
      servers: [{
        id: 'manual-1',
        url: 'turn:manual.example:3478',
        username: 'u',
        credential: 'c',
        enabled: true,
      }],
    })
    expect(getTurnRelayPreference()).toBe('disabled')
    expect(isRelayAllowed()).toBe(false)
    expect(turnUrls()).toEqual([])
  })
})

describe('loadTurnSettings schema validation', () => {
  it('missing servers array falls back safely', () => {
    localStorage.setItem('misaka.turnServers', JSON.stringify({ enabled: true }))
    const s = loadTurnSettings()
    expect(s.enabled).toBe(false)
    expect(s.servers).toEqual([])
  })

  it('null JSON falls back safely', () => {
    localStorage.setItem('misaka.turnServers', 'null')
    const s = loadTurnSettings()
    expect(s).toEqual({ servers: [], enabled: false, forceRelay: false })
  })

  it('malformed server entries are filtered, not thrown', () => {
    localStorage.setItem('misaka.turnServers', JSON.stringify({
      enabled: true,
      forceRelay: false,
      servers: [
        { id: 'ok', url: 'turn:x:3478', username: 'u', credential: 'c', enabled: true },
        { id: 1, url: 'bad' },
        null,
        'nope',
      ],
    }))
    const s = loadTurnSettings()
    expect(s.enabled).toBe(true)
    expect(s.servers).toHaveLength(1)
    expect(s.servers[0].id).toBe('ok')
  })

  it('saveTurnSettings survives localStorage throw', () => {
    const realSet = localStorage.setItem.bind(localStorage)
    localStorage.setItem = () => { throw new Error('QuotaExceededError') }
    const result = saveTurnSettings({ enabled: true, forceRelay: false, servers: [] })
    expect(result.persisted).toBe(false)
    expect(loadTurnSettings().enabled).toBe(true)
    localStorage.setItem = realSet
  })

  it('failed disable write keeps live off; buildIceConfig has no turn: URL', async () => {
    // Old enabled record on disk + cached auto credentials.
    saveTurnSettings({ enabled: true, forceRelay: false, servers: [] })
    await refreshAutoTurn()
    expect(getAutoTurnIceServers().length).toBe(1)

    const realSet = localStorage.setItem.bind(localStorage)
    localStorage.setItem = () => { throw new Error('QuotaExceededError') }
    const result = saveTurnSettings({ enabled: false, forceRelay: false, servers: [] })
    expect(result.persisted).toBe(false)

    // Live memory is the single source WebRTC consumes.
    expect(loadTurnSettings().enabled).toBe(false)
    expect(getTurnRelayPreference()).toBe('disabled')
    expect(isRelayAllowed()).toBe(false)

    const urls = (buildIceConfig().iceServers ?? [])
      .flatMap(s => Array.isArray(s.urls) ? s.urls : [s.urls])
      .map(String)
    expect(urls.some(u => u.startsWith('turn:') || u.startsWith('turns:'))).toBe(false)

    // Stale enabled record still on disk must not reappear via load.
    localStorage.setItem = realSet
    // storage still has the pre-throw enabled record (setItem threw on disable)
    expect(loadTurnSettings().enabled).toBe(false)
  })
})

describe('clearAutoTurn epoch cancels in-flight commit', () => {
  it('late success after clear does not resurrect credentials or timer', async () => {
    let resolveFetch!: (r: Response) => void
    fetchImpl = () => new Promise<Response>(resolve => { resolveFetch = resolve })

    const pending = refreshAutoTurn()
    // Give the in-flight assignment a tick.
    await Promise.resolve()
    clearAutoTurn()

    resolveFetch(new Response(JSON.stringify({
      enabled: true,
      iceServers: [{ urls: 'turn:late.example:3478', username: 'u', credential: 'c' }],
      expiresAt: Date.now() + 600_000,
    }), { status: 200 }))

    await pending
    expect(getAutoTurnState().active).toBe(false)
    expect(getAutoTurnIceServers()).toEqual([])
    // No refresh timer resurrected.
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('hung credential fetch releases inFlight via deadline', () => {
  it('timeout allows a later refresh to succeed', async () => {
    fetchImpl = () => new Promise(() => { /* never settles — raceAbort kills it */ })

    const first = refreshAutoTurn()
    await vi.advanceTimersByTimeAsync(12_001)
    await first
    clearAutoTurn()
    expect(getAutoTurnState().active).toBe(false)

    fetchImpl = async () => new Response(JSON.stringify({
      enabled: true,
      iceServers: [{ urls: 'turn:recovered.example:3478', username: 'u', credential: 'c' }],
      expiresAt: Date.now() + 600_000,
    }), { status: 200 })

    const servers = await refreshAutoTurn()
    expect(servers.length).toBe(1)
    expect(getAutoTurnState().active).toBe(true)
  }, 20_000)
})

describe('permanent rejections do not arm backoff', () => {
  it.each(['DISABLED', 'NOT_CONFIGURED', 'GLOBAL_QUOTA_EXCEEDED', 'IP_BANNED', 'SESSION_BANNED'])(
    'reason %s stops retry timer',
    async (reason) => {
      clearAutoTurn()
      fetchImpl = async () => new Response(JSON.stringify({ enabled: false, reason }), { status: 503 })
      await refreshAutoTurn()
      expect(getAutoTurnState().lastFailReason).toBe(reason)
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it('transient 503 still arms backoff', async () => {
    clearAutoTurn()
    fetchImpl = async () => new Response(JSON.stringify({ enabled: false, reason: 'CF_ERROR' }), { status: 503 })
    await refreshAutoTurn()
    expect(vi.getTimerCount()).toBeGreaterThan(0)
  })
})
