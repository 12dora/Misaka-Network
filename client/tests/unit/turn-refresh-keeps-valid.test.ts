// Regression [P1]: a scheduled auto-TURN refresh fires REFRESH_LEAD_MS BEFORE
// the current credentials expire, so they are usually still valid. A transient
// failure at that moment (one-off 503 / network blip / AuthRequiredError) must
// NOT clobber the still-valid creds to null — doing so returned [] from
// getAutoTurnIceServers() and, worse, emitted a config change that strips relay
// servers off every live RTCPeerConnection, breaking new / ICE-restarted
// symmetric-NAT peers until a backoff retry landed. Keep the creds until they
// have actually expired.

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

// Stubbed fetch — flips between success and failure per scenario.
let fetchImpl: () => Promise<Response> = async () =>
  new Response(JSON.stringify({
    enabled: true,
    iceServers: [{ urls: 'turn:fresh.example.com:3478', username: 'u', credential: 'c' }],
    expiresAt: Date.now() + 30_000,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })

vi.mock('../../src/lib/api', () => ({
  AuthRequiredError: class AuthRequiredError extends Error {},
  authedFetch: vi.fn(async () => fetchImpl()),
}))

import {
  refreshAutoTurn, clearAutoTurn, getAutoTurnIceServers, getAutoTurnState, onTurnConfigChange,
} from '../../src/lib/turn'

beforeEach(() => {
  clearAutoTurn()
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('refreshAutoTurn: transient failure keeps still-valid creds', () => {
  it('retains the credentials and emits NO config change on a transient 503', async () => {
    // 1) First a successful fetch installs ~30s creds.
    await refreshAutoTurn()
    expect(getAutoTurnIceServers().length).toBeGreaterThan(0)
    expect(getAutoTurnState().active).toBe(true)

    // 2) Now the scheduled refresh fails while the creds are still valid.
    const changeSpy = vi.fn()
    const unsub = onTurnConfigChange(changeSpy)
    fetchImpl = async () => new Response(JSON.stringify({ enabled: false, reason: 'KILL' }), { status: 503 })
    await refreshAutoTurn()

    // Creds must be RETAINED, not wiped to null.
    expect(getAutoTurnIceServers().length).toBeGreaterThan(0)
    expect(getAutoTurnState().active).toBe(true)
    // No config change → live PeerConnections keep their relay servers.
    expect(changeSpy).not.toHaveBeenCalled()
    unsub()
  })

  it('a successful refresh still resets and reports active', async () => {
    fetchImpl = async () => new Response(JSON.stringify({
      enabled: true,
      iceServers: [{ urls: 'turn:a.example.com:3478', username: 'u', credential: 'c' }],
      expiresAt: Date.now() + 30_000,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    await refreshAutoTurn()
    expect(getAutoTurnState().active).toBe(true)
    expect(getAutoTurnIceServers().length).toBe(1)
  })
})
