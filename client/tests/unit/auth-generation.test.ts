// Auth generation, connect dedupe key, lock lease, error decoder, renewal.
//
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../src/lib/signaling', () => ({
  onAuthInvalid: vi.fn(),
  endSession: vi.fn(),
}))

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>
let fetchHandler: FetchHandler = async () => new Response('{}', { status: 500 })
const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
  fetchHandler(String(input), init),
)

beforeEach(() => {
  fetchSpy.mockClear()
  ;(globalThis as unknown as { fetch: unknown }).fetch = fetchSpy
  sessionStorage.clear()
  vi.useRealTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.resetModules()
})

async function loadAuth() {
  vi.resetModules()
  // Re-apply signaling mock after resetModules.
  vi.doMock('../../src/lib/signaling', () => ({
    onAuthInvalid: vi.fn(),
    endSession: vi.fn(),
  }))
  const mod = await import('../../src/store/auth')
  return mod
}

function okRegister(overrides: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({
    token: 'tok-1',
    sessionId: 'sid-1',
    expiresAt: Date.now() + 3_600_000,
    reRegisterProof: 'proof-1',
    resumed: false,
    ...overrides,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('connect() generation and dedupe key', () => {
  it('does not merge plain re-auth with QR admission grant', async () => {
    const bodies: unknown[] = []
    const gates: Array<(r: Response) => void> = []
    fetchHandler = async (_url, init) => {
      if (!_url.includes('/api/register')) return new Response('{}', { status: 404 })
      bodies.push(init?.body ? JSON.parse(String(init.body)) : null)
      return new Promise<Response>(resolve => { gates.push(resolve) })
    }

    const { useAuthStore } = await loadAuth()
    useAuthStore.getState().setPassCode('123456')
    const plain = useAuthStore.getState().connect()
    await flush()
    expect(gates.length).toBe(1)

    const withGrant = useAuthStore.getState().connect({ admissionGrant: 'g'.repeat(64) })
    await flush()
    // Superseded plain + new grant request.
    expect(gates.length).toBeGreaterThanOrEqual(1)

    // Resolve every gate so both settle.
    for (const g of gates) {
      g(okRegister({
        token: `tok-${bodies.length}`,
        sessionId: `sid-${bodies.length}`,
      }))
    }
    await Promise.all([plain, withGrant])

    expect(bodies.some(b => b && typeof b === 'object' && 'admissionGrant' in (b as object))).toBe(true)
    // Not coalesced onto a single call with dropped grant.
    expect(bodies.length).toBeGreaterThanOrEqual(2)
  })

  it('late register after disconnect does not re-login', async () => {
    let resolveReg!: (r: Response) => void
    fetchHandler = async (url) => {
      if (url.includes('/api/register')) {
        return new Promise<Response>(resolve => { resolveReg = resolve })
      }
      if (url.includes('/api/release')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    }

    const { useAuthStore } = await loadAuth()
    useAuthStore.getState().setPassCode('654321')
    const pending = useAuthStore.getState().connect()
    await flush()
    expect(typeof resolveReg).toBe('function')
    await useAuthStore.getState().disconnect()

    resolveReg(okRegister({ token: 'late-tok', sessionId: 'late-sid' }))
    await pending
    await flush()

    expect(useAuthStore.getState().isConnected).toBe(false)
    expect(useAuthStore.getState().session).toBeNull()
    expect(fetchSpy.mock.calls.some(([u]) => String(u).includes('/api/release'))).toBe(true)
  })
})

describe('decodeAuthError', () => {
  it('maps NETWORK_FULL and SERVER_BUSY distinctly', async () => {
    const { decodeAuthError } = await loadAuth()
    const full = decodeAuthError(503, { error: 'NETWORK_FULL', message: '御坂网络已达容量上限' })
    expect(full.retryable).toBe(false)
    expect(full.message).toContain('容量')

    const busy = decodeAuthError(503, { error: 'SERVER_BUSY' })
    expect(busy.retryable).toBe(true)
    expect(busy.message).toMatch(/繁忙|稍后/)
  })

  it('maps RATE_LIMITED and NODE_LOCKED for QR path reuse', async () => {
    const { decodeAuthError } = await loadAuth()
    const rate = decodeAuthError(429, { error: 'RATE_LIMITED', message: '太快了' })
    expect(rate.retryable).toBe(true)
    expect(rate.message).toBe('太快了')

    const unlockAt = Date.now() + 120_000
    const locked = decodeAuthError(423, { error: 'NODE_LOCKED', reason: 'WRONG_PASSCODE', unlockAt })
    expect(locked.retryable).toBe(false)
    expect(locked.message).toMatch(/锁定/)
    // Unlock time must be rendered (≈2 minutes) — matching only /锁定/ would
    // pass code that ignored unlockAt entirely.
    expect(locked.message).toMatch(/2\s*分钟/)
    expect(locked.unlockAt).toBe(unlockAt)
  })
})

describe('releaseAllFromIp prefers identity proof over Bearer', () => {
  it('sends B proof when session is A and identity is B', async () => {
    let releaseBody: unknown = null
    let releaseAuthHeader: string | null | undefined = 'unset'
    fetchHandler = async (url, init) => {
      if (url.includes('/api/release-by-ip')) {
        releaseBody = init?.body ? JSON.parse(String(init.body)) : null
        const headers = init?.headers
        if (headers instanceof Headers) {
          releaseAuthHeader = headers.get('Authorization')
        } else if (headers && typeof headers === 'object') {
          const rec = headers as Record<string, string>
          releaseAuthHeader = rec.Authorization ?? rec.authorization ?? null
        } else {
          releaseAuthHeader = null
        }
        return new Response(JSON.stringify({ released: 1, releasedNodeId: 42 }), { status: 200 })
      }
      return okRegister()
    }

    const { useAuthStore } = await loadAuth()
    useAuthStore.setState({
      session: { token: 'token-A', sessionId: 'sid-A', expiresAt: Date.now() + 60_000, reRegisterProof: 'p' },
      isConnected: true,
      identity: { nodeId: 42, passCode: '112233', createdAt: Date.now() },
    })

    const released = await useAuthStore.getState().releaseAllFromIp()
    expect(released).toBe(1)
    expect(releaseBody).toEqual({ nodeId: 42, passCode: '112233' })
    expect(releaseAuthHeader).toBeNull()
  })
})

describe('session renewal keeps sessionId (Contract 2)', () => {
  it('renewal replaces token in place without changing sessionId', async () => {
    vi.useFakeTimers()
    fetchHandler = async (url) => {
      if (url.includes('/api/session-renew')) {
        return new Response(JSON.stringify({
          sessionId: 'sid-stable',
          token: 'tok-renewed',
          expiresAt: Date.now() + 3_600_000,
          reRegisterProof: 'proof-renewed',
        }), { status: 200 })
      }
      return okRegister({ sessionId: 'sid-stable', token: 'tok-1', expiresAt: Date.now() + 10_000 })
    }

    const { useAuthStore } = await loadAuth()
    useAuthStore.getState().setPassCode('999999')
    await useAuthStore.getState().connect()
    const before = useAuthStore.getState().session!
    expect(before.sessionId).toBe('sid-stable')

    await vi.advanceTimersByTimeAsync(5_100)
    await flush()

    const after = useAuthStore.getState().session!
    expect(after.sessionId).toBe('sid-stable')
    expect(after.token).toBe('tok-renewed')
    expect(after.reRegisterProof).toBe('proof-renewed')
  })
})

describe('register deadline', () => {
  it('black-holed network surfaces a retryable timeout error', async () => {
    vi.useFakeTimers()
    fetchHandler = () => new Promise(() => { /* never */ })
    const { useAuthStore } = await loadAuth()
    useAuthStore.getState().setPassCode('111111')
    const p = useAuthStore.getState().connect()
    // Let doConnect arm the deadline timer before advancing the clock.
    await flush()
    await vi.advanceTimersByTimeAsync(15_100)
    await flush()
    await p
    expect(useAuthStore.getState().isLoading).toBe(false)
    expect(useAuthStore.getState().error).toMatch(/超时|网络/)
    // A subsequent connect can retry.
    fetchHandler = async () => okRegister()
    await useAuthStore.getState().connect()
    expect(useAuthStore.getState().isConnected).toBe(true)
  }, 20_000)
})

describe('identity mutation supersedes in-flight register', () => {
  it('discards a late 200 for identity A after the user edits to B and releases the token', async () => {
    let resolveReg!: (r: Response) => void
    const releasedTokens: string[] = []
    fetchHandler = async (url, init) => {
      if (url.includes('/api/register')) {
        return new Promise<Response>(resolve => { resolveReg = resolve })
      }
      if (url.includes('/api/release')) {
        const body = init?.body ? JSON.parse(String(init.body)) as { token?: string } : {}
        if (body.token) releasedTokens.push(body.token)
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    }

    const { useAuthStore } = await loadAuth()
    useAuthStore.setState({
      identity: { nodeId: 100, passCode: '111111', createdAt: Date.now() },
    })
    const pending = useAuthStore.getState().connect()
    await flush()
    expect(typeof resolveReg).toBe('function')

    // User edits identity to B while A's register is still in flight.
    useAuthStore.getState().setNodeId(200)
    useAuthStore.getState().setPassCode('222222')
    expect(useAuthStore.getState().identity.nodeId).toBe(200)
    expect(useAuthStore.getState().isLoading).toBe(false)

    resolveReg(okRegister({ token: 'tok-A', sessionId: 'sid-A' }))
    await pending
    await flush()

    // Late 200 for A must not install a session under B's UI.
    expect(useAuthStore.getState().isConnected).toBe(false)
    expect(useAuthStore.getState().session).toBeNull()
    expect(useAuthStore.getState().identity.nodeId).toBe(200)
    expect(useAuthStore.getState().identity.passCode).toBe('222222')
    expect(releasedTokens).toContain('tok-A')
  })
})

describe('generation re-check after res.json()', () => {
  it('superseded while success body is pending does not install the stale session', async () => {
    // Precise window: Response is already available, only res.json() is held.
    // Supersede mid-parse, then resolve the body — must not commit.
    let call = 0
    let resolveFirstJson!: (body: unknown) => void
    const firstJson = new Promise<unknown>(r => { resolveFirstJson = r })
    let resolveSecond!: (r: Response) => void

    fetchHandler = async (url) => {
      if (!url.includes('/api/register')) return new Response('{}', { status: 404 })
      call++
      if (call === 1) {
        // Headers/status available immediately; body parse is deferred.
        return {
          ok: true,
          status: 200,
          json: () => firstJson,
        } as unknown as Response
      }
      return new Promise<Response>(resolve => { resolveSecond = resolve })
    }

    const { useAuthStore } = await loadAuth()
    useAuthStore.getState().setPassCode('111111')
    const first = useAuthStore.getState().connect()
    await flush()
    expect(call).toBe(1)

    // Supersede while first's body promise is still pending.
    useAuthStore.getState().setPassCode('222222')
    const second = useAuthStore.getState().connect()
    await flush()
    expect(call).toBe(2)
    expect(useAuthStore.getState().isLoading).toBe(true)

    // Resolve the deferred body AFTER supersede — this is the CAS window.
    resolveFirstJson({
      token: 'tok-stale',
      sessionId: 'sid-stale',
      expiresAt: Date.now() + 3_600_000,
      reRegisterProof: 'proof-stale',
      resumed: false,
    })
    await flush()

    // Stale success must not install under the new identity.
    expect(useAuthStore.getState().session?.token).not.toBe('tok-stale')
    expect(useAuthStore.getState().isConnected).not.toBe(true)
    expect(useAuthStore.getState().isLoading).toBe(true)

    resolveSecond(okRegister({ token: 'tok-2', sessionId: 'sid-2' }))
    await Promise.all([first, second])
    await flush()

    expect(useAuthStore.getState().isConnected).toBe(true)
    expect(useAuthStore.getState().session?.token).toBe('tok-2')
    expect(useAuthStore.getState().error).toBeNull()
  })

  it('superseded while error body is pending does not clobber newer loading state', async () => {
    let call = 0
    let resolveFirstJson!: (body: unknown) => void
    const firstJson = new Promise<unknown>(r => { resolveFirstJson = r })
    let resolveSecond!: (r: Response) => void

    fetchHandler = async (url) => {
      if (!url.includes('/api/register')) return new Response('{}', { status: 404 })
      call++
      if (call === 1) {
        return {
          ok: false,
          status: 503,
          json: () => firstJson,
        } as unknown as Response
      }
      return new Promise<Response>(resolve => { resolveSecond = resolve })
    }

    const { useAuthStore } = await loadAuth()
    useAuthStore.getState().setPassCode('111111')
    const first = useAuthStore.getState().connect()
    await flush()

    useAuthStore.getState().setPassCode('222222')
    const second = useAuthStore.getState().connect()
    await flush()
    expect(useAuthStore.getState().isLoading).toBe(true)

    resolveFirstJson({ error: 'SERVER_BUSY', message: 'stale-busy-from-first' })
    await flush()

    expect(useAuthStore.getState().isLoading).toBe(true)
    expect(useAuthStore.getState().error).not.toBe('stale-busy-from-first')

    resolveSecond(okRegister({ token: 'tok-2', sessionId: 'sid-2' }))
    await Promise.all([first, second])
    await flush()

    expect(useAuthStore.getState().isConnected).toBe(true)
    expect(useAuthStore.getState().session?.token).toBe('tok-2')
    expect(useAuthStore.getState().error).toBeNull()
  })
})

describe('Contract 1 reRegisterProof — absence degrades recovery, never blocks', () => {
  it('commits a proofless 200 with recovery marked unavailable (no release)', async () => {
    const released: string[] = []
    fetchHandler = async (url, init) => {
      if (url.includes('/api/register')) {
        return new Response(JSON.stringify({
          token: 'tok-no-proof',
          sessionId: 'sid-no-proof',
          expiresAt: Date.now() + 3_600_000,
          // deliberately omit reRegisterProof — current/older server
        }), { status: 200 })
      }
      if (url.includes('/api/release')) {
        const body = init?.body ? JSON.parse(String(init.body)) as { token?: string } : {}
        if (body.token) released.push(body.token)
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    }

    const { useAuthStore } = await loadAuth()
    useAuthStore.getState().setPassCode('123456')
    const committed = await useAuthStore.getState().connect()
    await flush()

    expect(committed).toBe(true)
    expect(useAuthStore.getState().isConnected).toBe(true)
    expect(useAuthStore.getState().session).toEqual({
      token: 'tok-no-proof',
      sessionId: 'sid-no-proof',
      expiresAt: expect.any(Number),
      reRegisterProof: null,
    })
    expect(useAuthStore.getState().recoveryUnavailableNotice).toBe(true)
    expect(released).not.toContain('tok-no-proof')
    // Session is usable for chat/transfer; only silent recovery is unavailable.
    expect(useAuthStore.getState().error).toBeNull()
    expect(useAuthStore.getState().credentialsRequired).toBe(false)
  })

  it('restores a still-valid legacy cached row with null proof and surfaces a notice', async () => {
    const legacy = {
      token: 'legacy-tok',
      sessionId: 'legacy-sid',
      expiresAt: Date.now() + 3_600_000,
      // no reRegisterProof field
    }
    sessionStorage.setItem('misaka.session', JSON.stringify(legacy))
    sessionStorage.setItem('misaka.identity', JSON.stringify({ nodeId: 42, createdAt: Date.now() }))

    const { useAuthStore } = await loadAuth()
    const state = useAuthStore.getState()
    expect(state.isConnected).toBe(true)
    expect(state.session?.token).toBe('legacy-tok')
    expect(state.session?.reRegisterProof).toBeNull()
    expect(state.recoveryUnavailableNotice).toBe(true)
    // Row is NOT deleted — still present (rewritten with explicit null is ok).
    const stored = JSON.parse(sessionStorage.getItem('misaka.session')!)
    expect(stored.token).toBe('legacy-tok')
    expect(stored.reRegisterProof).toBeNull()
  })

  it('connect() returns false on refusal and clears prior isConnected atomically', async () => {
    fetchHandler = async (url) => {
      if (url.includes('/api/register')) {
        return new Response(JSON.stringify({
          error: 'CONFLICT',
          remaining: 2,
          message: '通行码错误',
        }), { status: 409 })
      }
      if (url.includes('/api/release')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    }

    const { useAuthStore } = await loadAuth()
    // Simulate a prior live session (Join admission against a connected tab).
    useAuthStore.setState({
      session: {
        token: 'prior-tok',
        sessionId: 'prior-sid',
        expiresAt: Date.now() + 60_000,
        reRegisterProof: 'prior-proof',
      },
      isConnected: true,
    })
    useAuthStore.getState().setPassCode('123456')
    const committed = await useAuthStore.getState().connect()
    await flush()

    expect(committed).toBe(false)
    expect(useAuthStore.getState().isConnected).toBe(false)
    expect(useAuthStore.getState().session).toBeNull()
    expect(useAuthStore.getState().error).toMatch(/通行码|节点/)
  })

  it('failed connect that replaces a committed session releases the prior token', async () => {
    const releasedTokens: string[] = []
    fetchHandler = async (url, init) => {
      if (url.includes('/api/register')) {
        return new Response(JSON.stringify({
          error: 'CONFLICT',
          remaining: 1,
          message: '通行码错误',
        }), { status: 409 })
      }
      if (url.includes('/api/release')) {
        const body = init?.body ? JSON.parse(String(init.body)) as { token?: string } : {}
        if (body.token) releasedTokens.push(body.token)
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    }

    const { useAuthStore } = await loadAuth()
    const { endSession } = await import('../../src/lib/signaling')
    useAuthStore.setState({
      session: {
        token: 'prior-live-tok',
        sessionId: 'prior-live-sid',
        expiresAt: Date.now() + 60_000,
        reRegisterProof: 'prior-live-proof',
      },
      isConnected: true,
    })
    useAuthStore.getState().setPassCode('123456')
    const committed = await useAuthStore.getState().connect()
    await flush()

    expect(committed).toBe(false)
    expect(useAuthStore.getState().isConnected).toBe(false)
    expect(useAuthStore.getState().session).toBeNull()
    // Old server session must not survive behind a disconnected store.
    expect(releasedTokens).toContain('prior-live-tok')
    expect(endSession).toHaveBeenCalled()
  })
})

describe('bestEffortRelease retries on failure', () => {
  it('retries once when the first /api/release fails with 500', async () => {
    let releaseAttempts = 0
    fetchHandler = async (url) => {
      if (url.includes('/api/register')) return okRegister({ token: 'tok-rel' })
      if (url.includes('/api/release')) {
        releaseAttempts++
        if (releaseAttempts === 1) {
          return new Response(JSON.stringify({ error: 'BUSY' }), { status: 500 })
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    }

    const { useAuthStore } = await loadAuth()
    useAuthStore.getState().setPassCode('123456')
    await useAuthStore.getState().connect()
    expect(useAuthStore.getState().isConnected).toBe(true)

    await useAuthStore.getState().disconnect()
    await flush()
    expect(releaseAttempts).toBe(2)
  })

  it('retries once on transport failure then succeeds', async () => {
    let releaseAttempts = 0
    fetchHandler = async (url) => {
      if (url.includes('/api/register')) return okRegister({ token: 'tok-rel-net' })
      if (url.includes('/api/release')) {
        releaseAttempts++
        if (releaseAttempts === 1) throw new Error('network down')
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    }

    const { useAuthStore } = await loadAuth()
    useAuthStore.getState().setPassCode('123456')
    await useAuthStore.getState().connect()
    await useAuthStore.getState().disconnect()
    await flush()
    expect(releaseAttempts).toBe(2)
  })
})

describe('retry policy NETWORK_FULL / SERVER_BUSY', () => {
  it('NETWORK_FULL blocks immediate reconnect until identity changes', async () => {
    fetchHandler = async (url) => {
      if (url.includes('/api/register')) {
        return new Response(JSON.stringify({
          error: 'NETWORK_FULL',
          message: '御坂网络已达容量上限',
        }), { status: 503 })
      }
      return new Response('{}', { status: 404 })
    }

    const { useAuthStore } = await loadAuth()
    useAuthStore.getState().setPassCode('123456')
    await useAuthStore.getState().connect()
    expect(useAuthStore.getState().lastAuthErrorCode).toBe('NETWORK_FULL')
    expect(useAuthStore.getState().isConnectBlocked()).toBe(true)

    // Immediate retry is a no-op at the store boundary.
    fetchHandler = async () => okRegister()
    await useAuthStore.getState().connect()
    expect(useAuthStore.getState().isConnected).toBe(false)

    // Identity mutation clears the block.
    useAuthStore.getState().setPassCode('654321')
    expect(useAuthStore.getState().isConnectBlocked()).toBe(false)
    await useAuthStore.getState().connect()
    expect(useAuthStore.getState().isConnected).toBe(true)
  })

  it('SERVER_BUSY sets a finite cooldown that expires', async () => {
    vi.useFakeTimers()
    fetchHandler = async (url) => {
      if (url.includes('/api/register')) {
        return new Response(JSON.stringify({ error: 'SERVER_BUSY' }), { status: 503 })
      }
      return new Response('{}', { status: 404 })
    }

    const { useAuthStore, serverBusyBackoffMs } = await loadAuth()
    // Pin backoff for the test by exercising the helper range.
    const sample = serverBusyBackoffMs(() => 0.5)
    expect(sample).toBeGreaterThanOrEqual(1_500)
    expect(sample).toBeLessThanOrEqual(4_500)

    useAuthStore.getState().setPassCode('123456')
    await useAuthStore.getState().connect()
    expect(useAuthStore.getState().lastAuthErrorCode).toBe('SERVER_BUSY')
    expect(useAuthStore.getState().isConnectBlocked()).toBe(true)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(useAuthStore.getState().isConnectBlocked()).toBe(false)
  })
})

describe('Web Lock lease release', () => {
  type LockCb = (lock: { name: string } | null) => Promise<unknown> | unknown
  let held = new Map<string, true>()
  let requestImpl: (name: string, opts: { ifAvailable?: boolean }, cb: LockCb) => Promise<unknown>

  function installLocks() {
    held = new Map()
    requestImpl = async (name, opts, cb) => {
      if (opts?.ifAvailable && held.has(name)) {
        return cb(null)
      }
      held.set(name, true)
      const lock = { name }
      // Hold until the callback's returned promise settles (or immediately if sync).
      const result = cb(lock)
      await Promise.resolve(result)
      held.delete(name)
      return undefined
    }
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: (name: string, opts: { ifAvailable?: boolean }, cb: LockCb) =>
          requestImpl(name, opts, cb),
      },
    })
  }

  function lockHeld(nodeId: number) {
    return held.has(`misaka-node-${nodeId}`)
  }

  async function canSecondTabAcquire(nodeId: number): Promise<boolean> {
    let got: boolean | null = null
    await navigator.locks.request(`misaka-node-${nodeId}`, { ifAvailable: true }, (lock) => {
      got = lock !== null
      return undefined
    })
    return got === true
  }

  it('releases the lock after 409 so a second tab can acquire', async () => {
    installLocks()
    fetchHandler = async (url) => {
      if (url.includes('/api/register')) {
        return new Response(JSON.stringify({ error: 'CONFLICT', remaining: 2 }), { status: 409 })
      }
      return new Response('{}', { status: 404 })
    }
    const { useAuthStore } = await loadAuth()
    useAuthStore.setState({
      identity: { nodeId: 777, passCode: '111111', createdAt: Date.now() },
    })
    await useAuthStore.getState().connect()
    expect(useAuthStore.getState().isConnected).toBe(false)
    expect(await canSecondTabAcquire(777)).toBe(true)
  })

  it('releases the lock after 500 so a second tab can acquire', async () => {
    installLocks()
    fetchHandler = async (url) => {
      if (url.includes('/api/register')) {
        return new Response(JSON.stringify({ error: 'INTERNAL' }), { status: 500 })
      }
      return new Response('{}', { status: 404 })
    }
    const { useAuthStore } = await loadAuth()
    useAuthStore.setState({
      identity: { nodeId: 778, passCode: '111111', createdAt: Date.now() },
    })
    await useAuthStore.getState().connect()
    expect(await canSecondTabAcquire(778)).toBe(true)
  })

  it('releases the lock after fetch rejection', async () => {
    installLocks()
    fetchHandler = async (url) => {
      if (url.includes('/api/register')) throw new Error('network down')
      return new Response('{}', { status: 404 })
    }
    const { useAuthStore } = await loadAuth()
    useAuthStore.setState({
      identity: { nodeId: 779, passCode: '111111', createdAt: Date.now() },
    })
    await useAuthStore.getState().connect()
    expect(await canSecondTabAcquire(779)).toBe(true)
  })

  it('releases the lock when superseded during acquire', async () => {
    installLocks()
    // Delay the lock callback so we can supersede while acquire is pending.
    let releaseAcquire!: () => void
    const acquireGate = new Promise<void>(r => { releaseAcquire = r })
    const originalRequest = requestImpl
    requestImpl = async (name, opts, cb) => {
      await acquireGate
      return originalRequest(name, opts, cb)
    }

    fetchHandler = async (url) => {
      if (url.includes('/api/register')) return okRegister()
      if (url.includes('/api/release')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    }

    const { useAuthStore } = await loadAuth()
    useAuthStore.setState({
      identity: { nodeId: 780, passCode: '111111', createdAt: Date.now() },
    })
    const pending = useAuthStore.getState().connect()
    await flush()

    // Supersede while still waiting on locks.request.
    useAuthStore.getState().setNodeId(781)
    releaseAcquire()
    await pending
    await flush()

    expect(useAuthStore.getState().isConnected).toBe(false)
    // Original node lock must not remain held.
    expect(await canSecondTabAcquire(780)).toBe(true)
    expect(lockHeld(780)).toBe(false)
  })
})

describe('decodeAuthError INVALID_INPUT', () => {
  it('maps INVALID_INPUT / 400 to specific non-retryable copy', async () => {
    const { decodeAuthError } = await loadAuth()
    const view = decodeAuthError(400, { error: 'INVALID_INPUT', message: '参数不合法' })
    expect(view.code).toBe('INVALID_INPUT')
    expect(view.retryable).toBe(false)
    expect(view.message).toContain('参数')
  })
})
