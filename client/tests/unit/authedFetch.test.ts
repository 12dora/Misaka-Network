// Behavioural tests for authedFetch — the 401 self-heal helper.
//
// Why these tests exist: commit 2fa6869 fixed a recurring class of bugs where a
// server restart silently invalidates a sessionStorage token, the next QR /
// copy-link call returns 401, and the UI is stuck with a useless "HTTP 401"
// surface. The helper must:
//
//   1. Send an `Authorization: Bearer <token>` header for every request.
//   2. On a 401, call reAuth() (the auth store's connect()) and retry once
//      with the fresh token.
//   3. If the retry also returns 401, clear sessionStorage AND throw
//      AuthRequiredError — not silently resolve a 401 response, otherwise
//      callers can't distinguish "real 401" from "everything is fine".
//   4. Not retry on non-401 statuses.
//
// Mocking note: we stub global fetch and the auth store. We do NOT stub
// AuthRequiredError itself — the class identity is part of the public contract
// (callers `instanceof` it), so the real export must come through.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// authedFetch reads VITE_DEV/window from a transitive import. jsdom env has
// these but apiUrl prefixes "" in dev — so calls keep their relative paths,
// which is fine for our string assertions.

// ── Test doubles ────────────────────────────────────────────────────
//
// We hoist a mutable session object so each test can rewrite what
// currentToken() / reAuth() see without re-importing the module.

const mockState = vi.hoisted(() => ({
  session: null as { token: string; sessionId: string; expiresAt: number } | null,
  connectCalls: 0,
  invalidateCalls: 0,
  connectImpl: (() => { /* default no-op */ }) as () => void | Promise<void>,
}))

vi.mock('@/store/auth', () => ({
  useAuthStore: {
    getState: () => ({
      session: mockState.session,
      connect: async () => {
        mockState.connectCalls++
        await mockState.connectImpl()
      },
      invalidateSession: () => {
        mockState.invalidateCalls++
        mockState.session = null
        try { sessionStorage.removeItem('misaka.session') } catch { /* ignore */ }
      },
    }),
    setState: (patch: Record<string, unknown>) => {
      if ('session' in patch) mockState.session = patch.session as typeof mockState.session
    },
  },
}))

// authedFetch imports apiUrl; we leave the real implementation, which returns
// the path unchanged when API_BASE is empty (the test default).
vi.mock('@/config', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/config')>()
  return { ...orig, apiUrl: (p: string) => p }
})

import { authedFetch, AuthRequiredError } from '../../src/lib/api'

describe('authedFetch', () => {
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockState.session = { token: 'tok-original', sessionId: 'sess-1', expiresAt: Date.now() + 60_000 }
    mockState.connectCalls = 0
    mockState.invalidateCalls = 0
    mockState.connectImpl = () => {
      mockState.session = { token: 'tok-refreshed', sessionId: 'sess-2', expiresAt: Date.now() + 60_000 }
    }
    fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    sessionStorage.clear()
    sessionStorage.setItem('misaka.session', JSON.stringify(mockState.session))
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function jsonResponse(status: number, body: unknown = {}) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  it('sends Bearer header with the current token', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { ok: true }))

    await authedFetch('/api/foo')

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const init = fetchSpy.mock.calls[0][1] as RequestInit
    const headers = new Headers(init.headers)
    expect(headers.get('Authorization')).toBe('Bearer tok-original')
  })

  it('passes through 2xx without re-auth', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { ok: true }))

    const res = await authedFetch('/api/foo')

    expect(res.status).toBe(200)
    expect(mockState.connectCalls).toBe(0)
  })

  it('does not retry on non-401 errors (e.g. 500)', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(500, { error: 'BOOM' }))

    const res = await authedFetch('/api/foo')

    expect(res.status).toBe(500)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(mockState.connectCalls).toBe(0)
  })

  it('on 401: re-authenticates and retries with the fresh token', async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse(401))     // first call rejected
      .mockResolvedValueOnce(jsonResponse(200, { ok: true })) // retry succeeds

    const res = await authedFetch('/api/foo')

    expect(res.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(mockState.connectCalls).toBe(1)

    const retryInit = fetchSpy.mock.calls[1][1] as RequestInit
    const retryHeaders = new Headers(retryInit.headers)
    expect(retryHeaders.get('Authorization')).toBe('Bearer tok-refreshed')
  })

  it('on 401 → re-auth fails: clears session via invalidateSession and throws AuthRequiredError', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(401))
    mockState.connectImpl = () => { mockState.session = null }

    await expect(authedFetch('/api/foo')).rejects.toBeInstanceOf(AuthRequiredError)

    expect(fetchSpy).toHaveBeenCalledTimes(1) // no retry without a token
    expect(sessionStorage.getItem('misaka.session')).toBeNull()
    expect(mockState.invalidateCalls).toBe(1)
  })

  it('on 401 → retry also 401: clears session via invalidateSession and throws AuthRequiredError', async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse(401))
      .mockResolvedValueOnce(jsonResponse(401))

    await expect(authedFetch('/api/foo')).rejects.toBeInstanceOf(AuthRequiredError)

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(sessionStorage.getItem('misaka.session')).toBeNull()
    expect(mockState.invalidateCalls).toBe(1)
  })

  it('with no cached token: re-auths first, then sends the request', async () => {
    mockState.session = null
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { ok: true }))

    const res = await authedFetch('/api/foo')

    expect(res.status).toBe(200)
    expect(mockState.connectCalls).toBe(1)
    const init = fetchSpy.mock.calls[0][1] as RequestInit
    const headers = new Headers(init.headers)
    expect(headers.get('Authorization')).toBe('Bearer tok-refreshed')
  })

  it('with no cached token and re-auth fails: throws without calling fetch', async () => {
    mockState.session = null
    mockState.connectImpl = () => { mockState.session = null }

    await expect(authedFetch('/api/foo')).rejects.toBeInstanceOf(AuthRequiredError)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('preserves caller headers and method on retry', async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse(401))
      .mockResolvedValueOnce(jsonResponse(200))

    await authedFetch('/api/foo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Custom': 'k' },
      body: JSON.stringify({ a: 1 }),
    })

    const retryInit = fetchSpy.mock.calls[1][1] as RequestInit
    expect(retryInit.method).toBe('POST')
    expect(retryInit.body).toBe(JSON.stringify({ a: 1 }))
    const retryHeaders = new Headers(retryInit.headers)
    expect(retryHeaders.get('Content-Type')).toBe('application/json')
    expect(retryHeaders.get('X-Custom')).toBe('k')
    expect(retryHeaders.get('Authorization')).toBe('Bearer tok-refreshed')
  })
})
