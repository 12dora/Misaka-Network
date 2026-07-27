// Regression [P2]: after a server restart, several in-flight authedFetch calls
// each 401 and each fires reAuth()->connect(); onAuthInvalid (WS 4001/4002)
// also calls connect(). Without dedup they raced the same Web Lock (only one
// won → the losers flashed a bogus "该节点编号已在本浏览器的另一个标签页接入"
// error) and double-registered. A shared in-flight promise must coalesce
// concurrent connect() calls onto a single registration.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Avoid pulling in the real signaling module (WebSocket side effects on import).
vi.mock('../../src/lib/signaling', () => ({ onAuthInvalid: vi.fn() }))

const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(
  JSON.stringify({ token: 't-1', sessionId: 's-1', expiresAt: Date.now() + 60_000, resumed: false }),
  { status: 200, headers: { 'Content-Type': 'application/json' } },
))

beforeEach(() => {
  fetchSpy.mockClear()
  ;(globalThis as unknown as { fetch: unknown }).fetch = fetchSpy
  try { sessionStorage.clear() } catch { /* jsdom provides sessionStorage */ }
})

import { useAuthStore } from '../../src/store/auth'

describe('connect() dedupes concurrent callers', () => {
  it('three concurrent connect() calls trigger exactly one /api/register', async () => {
    const store = useAuthStore.getState()
    await Promise.all([store.connect(), store.connect(), store.connect()])

    const registerCalls = fetchSpy.mock.calls.filter(([url]) => String(url).includes('/api/register'))
    expect(registerCalls.length).toBe(1)
    expect(useAuthStore.getState().isConnected).toBe(true)
    // No spurious same-tab conflict error.
    expect(useAuthStore.getState().error).toBeNull()
  })

  it('a subsequent connect() after the first settles issues a fresh register', async () => {
    const store = useAuthStore.getState()
    await store.connect()
    fetchSpy.mockClear()
    await store.connect()
    const registerCalls = fetchSpy.mock.calls.filter(([url]) => String(url).includes('/api/register'))
    expect(registerCalls.length).toBe(1)
  })

  it('forwards a QR admission grant only on the registration that commits it', async () => {
    const store = useAuthStore.getState()
    await store.connect({ admissionGrant: 'g'.repeat(64) })

    const [, init] = fetchSpy.mock.calls.find(([url]) => String(url).includes('/api/register'))!
    expect(JSON.parse(String(init?.body))).toMatchObject({
      admissionGrant: 'g'.repeat(64),
    })
  })
})
