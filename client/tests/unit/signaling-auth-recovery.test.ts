// WS auth-recovery chain — the CLAUDE.md key contract:
//   close code 4001/4002 → onAuthInvalid → clear cached session → re-register
//   → new socket AUTHs with the fresh token.
//
// TEST-007: this file used to stop at "connect(newToken) builds a new socket"
// and explicitly did NOT fire the close handler, so none of the actual
// recovery chain (close-code dispatch, handler lifecycle, sessionStorage
// clearing, single re-registration, fresh AUTH frame) was ever executed. The
// contract only looked green. It now drives the real auth store against a
// fake WebSocket and a mocked /api/register.
//
// Historic regression also still pinned here: after a 4002 the stale socket
// sat in CLOSING and doConnect()'s OPEN/CONNECTING guard used to bail, so the
// fresh token never reached the wire.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// JSDOM ships a usable EventTarget but no WebSocket. Stub one and capture
// every constructor call so we can verify a new socket is created on
// connect(newToken).
class StubWS {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  url: string
  readyState = 0
  onopen: (() => void) | null = null
  onclose: ((ev: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  close = vi.fn(() => { this.readyState = StubWS.CLOSED })
  send = vi.fn()
  constructor(url: string) {
    this.url = url
    constructed.push(this)
  }
  /** Drive the socket to OPEN and run the module's onopen wiring. */
  open() {
    this.readyState = StubWS.OPEN
    this.onopen?.()
  }
  /** Drive a server-side close with the given code. */
  fireClose(code: number) {
    this.readyState = StubWS.CLOSED
    this.onclose?.({ code })
  }
  sentFrames(): unknown[] {
    return this.send.mock.calls.map(c => JSON.parse(String(c[0])))
  }
}

let constructed: StubWS[] = []
let registerCalls = 0
let issuedToken = 0
let lastSignaling: typeof import('../../src/lib/signaling') | null = null

type Modules = {
  signaling: typeof import('../../src/lib/signaling')
  useAuthStore: typeof import('../../src/store/auth')['useAuthStore']
}

async function freshModules(): Promise<Modules> {
  vi.resetModules()
  constructed = []
  registerCalls = 0
  issuedToken = 0
  sessionStorage.clear()
  ;(globalThis as unknown as { WebSocket: typeof StubWS }).WebSocket = StubWS
  const signaling = await import('../../src/lib/signaling')
  const { useAuthStore } = await import('../../src/store/auth')
  lastSignaling = signaling
  return { signaling, useAuthStore }
}

/** Let the clearSession → connect() → fetch → setState chain settle. */
async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve()
  await new Promise(r => setTimeout(r, 0))
}

function seedSession(
  useAuthStore: Modules['useAuthStore'],
  token: string,
  proof: string | null = 'proof-seed',
) {
  const session = {
    token,
    sessionId: 'sid-old',
    expiresAt: Date.now() + 3_600_000,
    reRegisterProof: proof,
  }
  sessionStorage.setItem('misaka.session', JSON.stringify(session))
  useAuthStore.setState({ session, isConnected: true })
}

let lastRegisterBody: unknown = null
let lastReRegisterBody: unknown = null
let reRegisterCalls = 0

beforeEach(() => {
  lastRegisterBody = null
  lastReRegisterBody = null
  reRegisterCalls = 0
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/re-register')) {
      reRegisterCalls++
      lastReRegisterBody = init?.body ? JSON.parse(String(init.body)) : null
      issuedToken++
      return {
        ok: true,
        status: 200,
        json: async () => ({
          token: `fresh-token-${issuedToken}`,
          sessionId: `sid-${issuedToken}`,
          expiresAt: Date.now() + 3_600_000,
          reRegisterProof: `proof-${issuedToken}`,
          resumed: false,
        }),
      } as unknown as Response
    }
    if (url.includes('/api/register')) {
      registerCalls++
      lastRegisterBody = init?.body ? JSON.parse(String(init.body)) : null
      issuedToken++
      return {
        ok: true,
        status: 200,
        json: async () => ({
          token: `fresh-token-${issuedToken}`,
          sessionId: `sid-${issuedToken}`,
          expiresAt: Date.now() + 3_600_000,
          reRegisterProof: `proof-${issuedToken}`,
          resumed: false,
        }),
      } as unknown as Response
    }
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response
  }))
})

afterEach(() => {
  // Kill the heartbeat interval / reconnect timer of whichever module
  // generation the test used, otherwise it outlives the test run.
  lastSignaling?.disconnect()
  lastSignaling = null
  vi.unstubAllGlobals()
})

describe('signaling.connect: auth recovery with a fresh token', () => {
  it('discards the stale socket and opens a new one when the token changes', async () => {
    const { signaling } = await freshModules()
    signaling.connect('stale-token')
    expect(constructed.length).toBe(1)
    const first = constructed[0]
    // Pretend the server-restart 4002 close happened without firing the
    // handler: the socket is merely left in CLOSING.
    first.readyState = StubWS.CLOSING

    // Auth store re-registers and calls connect(newToken).
    signaling.connect('fresh-token')

    // A brand-new WebSocket must be constructed even though the previous
    // ref was still in CLOSING. Pre-fix this used to bail because of the
    // OPEN/CONNECTING guard mistakenly matching CLOSING.
    expect(constructed.length).toBe(2)
    expect(constructed[1]).not.toBe(first)
    // The stale socket's onclose must be detached so its eventual close
    // event no longer flips serverShutdown / authInvalid.
    expect(first.onclose).toBeNull()
    expect(first.close).toHaveBeenCalled()
  })
})

describe('WS 4001/4002 → clear session → re-register → fresh AUTH (TEST-007)', () => {
  for (const code of [4001, 4002]) {
    it(`close ${code} clears the cached session and re-registers exactly once`, async () => {
      const { signaling, useAuthStore } = await freshModules()
      seedSession(useAuthStore, 'stale-token')

      signaling.connect('stale-token')
      const sock = constructed[0]
      sock.open()
      expect(sock.sentFrames()).toContainEqual({ t: 'AUTH', token: 'stale-token' })

      sock.fireClose(code)

      // Synchronous half of the contract: the dead token is gone from both
      // the store and sessionStorage before any network call happens.
      expect(useAuthStore.getState().session).toBeNull()
      expect(useAuthStore.getState().isConnected).toBe(false)
      expect(sessionStorage.getItem('misaka.session')).toBeNull()

      await settle()

      // Exactly one re-registration via /api/re-register with the stored proof
      // (Contract 1) — never /api/register with an empty passcode.
      expect(reRegisterCalls).toBe(1)
      expect(registerCalls).toBe(0)
      expect(lastReRegisterBody).toEqual({ proof: 'proof-seed' })
      expect(useAuthStore.getState().session?.token).toBe('fresh-token-1')
      expect(JSON.parse(sessionStorage.getItem('misaka.session')!).token).toBe('fresh-token-1')

      // No auto-reconnect happened on the dead token — the only way back is
      // an explicit connect() with the fresh one (network store's init()).
      expect(constructed.length).toBe(1)

      signaling.connect(useAuthStore.getState().session!.token)
      expect(constructed.length).toBe(2)
      const revived = constructed[1]
      revived.open()
      expect(revived.sentFrames()).toContainEqual({ t: 'AUTH', token: 'fresh-token-1' })
    })
  }

  it('coalesces two 4002 closes into a single registration', async () => {
    const { signaling, useAuthStore } = await freshModules()
    seedSession(useAuthStore, 'stale-token')

    signaling.connect('stale-token')
    constructed[0].open()
    // Two sockets both dying on the dead token (e.g. a reconnect that raced
    // the first close). Both notify authInvalid.
    constructed[0].fireClose(4002)
    signaling.connect('stale-token-2')
    constructed[1].open()
    constructed[1].fireClose(4002)

    await settle()
    expect(reRegisterCalls).toBe(1)
    expect(registerCalls).toBe(0)
  })

  it('a transient close (1006) keeps the session and schedules a reconnect', async () => {
    vi.useFakeTimers()
    try {
      const { signaling, useAuthStore } = await freshModules()
      seedSession(useAuthStore, 'live-token')

      signaling.connect('live-token')
      constructed[0].open()
      constructed[0].fireClose(1006)

      // Not an auth failure: the cached session survives untouched.
      expect(useAuthStore.getState().session?.token).toBe('live-token')
      expect(sessionStorage.getItem('misaka.session')).not.toBeNull()
      expect(registerCalls).toBe(0)

      await vi.advanceTimersByTimeAsync(1100)
      expect(constructed.length).toBe(2)
      constructed[1].open()
      expect(constructed[1].sentFrames()).toContainEqual({ t: 'AUTH', token: 'live-token' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('onAuthInvalid subscribers survive an explicit disconnect()', async () => {
    // disconnect() must not rip the auth store's module-scope onAuthInvalid
    // registration out of the signaling module — otherwise the very first
    // logout permanently disables auth recovery for the rest of the tab's
    // lifetime.
    const { signaling, useAuthStore } = await freshModules()
    const seen: number[] = []
    const off = signaling.onAuthInvalid(() => { seen.push(1) })

    signaling.disconnect()
    seedSession(useAuthStore, 'stale-token')
    signaling.connect('stale-token')
    constructed[constructed.length - 1].open()
    constructed[constructed.length - 1].fireClose(4001)

    expect(seen.length).toBe(1)
    expect(useAuthStore.getState().session).toBeNull()
    off()
  })

  for (const code of [4001, 4002]) {
    it(`close ${code} with null reRegisterProof → credentials-required, no empty /api/register`, async () => {
      const { signaling, useAuthStore } = await freshModules()
      seedSession(useAuthStore, 'stale-token', null)
      // Empty passcode is the dangerous default after restore.
      useAuthStore.setState({
        identity: { nodeId: 7, passCode: '', createdAt: Date.now() },
      })

      signaling.connect('stale-token')
      constructed[0].open()
      constructed[0].fireClose(code)

      await settle()

      expect(useAuthStore.getState().credentialsRequired).toBe(true)
      expect(useAuthStore.getState().isConnected).toBe(false)
      expect(useAuthStore.getState().session).toBeNull()
      expect(registerCalls).toBe(0)
      expect(reRegisterCalls).toBe(0)
      // Must never have fired /api/register with an empty passcode.
      expect(lastRegisterBody).toBeNull()
      expect(useAuthStore.getState().error).toMatch(/通行码|会话/)
    })
  }

  it('stale pending proof cannot defeat a later proofless session null (two-cycle)', async () => {
    // Cycle 1: live proof recovery fails → leaves credentials-required.
    // Cycle 2: user logs in manually with no recovery proof (null).
    // A subsequent 4001/4002 must honour the live null and go straight to
    // credentials-required — never re-attempt /api/re-register with the
    // stale pending proof from cycle 1.
    const { signaling, useAuthStore } = await freshModules()

    // Override fetch: first re-register fails; later register is proofless.
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/api/re-register')) {
        reRegisterCalls++
        lastReRegisterBody = init?.body ? JSON.parse(String(init.body)) : null
        return {
          ok: false,
          status: 401,
          json: async () => ({ error: 'INVALID_PROOF', message: '会话已失效，请重新输入通行码接入' }),
        } as unknown as Response
      }
      if (url.includes('/api/register')) {
        registerCalls++
        lastRegisterBody = init?.body ? JSON.parse(String(init.body)) : null
        issuedToken++
        return {
          ok: true,
          status: 200,
          json: async () => ({
            token: `fresh-token-${issuedToken}`,
            sessionId: `sid-${issuedToken}`,
            expiresAt: Date.now() + 3_600_000,
            // Explicit null — degraded recovery (the whole point of nullable).
            reRegisterProof: null,
            resumed: false,
          }),
        } as unknown as Response
      }
      if (url.includes('/api/release')) {
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response
      }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response
    }))

    // ── Cycle 1: proof recovery fails ────────────────────────────────
    seedSession(useAuthStore, 'stale-token', 'proof-stale-pending')
    useAuthStore.setState({
      identity: { nodeId: 7, passCode: '', createdAt: Date.now() },
    })
    signaling.connect('stale-token')
    constructed[0].open()
    constructed[0].fireClose(4001)
    await settle()

    expect(reRegisterCalls).toBe(1)
    expect(lastReRegisterBody).toEqual({ proof: 'proof-stale-pending' })
    expect(useAuthStore.getState().credentialsRequired).toBe(true)
    expect(useAuthStore.getState().isConnected).toBe(false)

    // ── Cycle 2: manual proofless login ──────────────────────────────
    reRegisterCalls = 0
    registerCalls = 0
    lastReRegisterBody = null
    lastRegisterBody = null
    useAuthStore.getState().setPassCode('123456')
    const committed = await useAuthStore.getState().connect()
    await settle()
    expect(committed).toBe(true)
    expect(useAuthStore.getState().isConnected).toBe(true)
    expect(useAuthStore.getState().session?.reRegisterProof).toBeNull()
    expect(registerCalls).toBe(1)
    expect(reRegisterCalls).toBe(0)

    // ── Cycle 2 close: live null must win over any leftover pending ──
    reRegisterCalls = 0
    registerCalls = 0
    lastReRegisterBody = null
    lastRegisterBody = null
    // Empty passcode again (typed only for the connect; recovery path sees empty).
    useAuthStore.setState({
      identity: { ...useAuthStore.getState().identity, passCode: '' },
    })
    const liveToken = useAuthStore.getState().session!.token
    signaling.connect(liveToken)
    constructed[constructed.length - 1].open()
    constructed[constructed.length - 1].fireClose(4002)
    await settle()

    expect(useAuthStore.getState().credentialsRequired).toBe(true)
    expect(useAuthStore.getState().isConnected).toBe(false)
    expect(useAuthStore.getState().session).toBeNull()
    // The live session's null must win: no re-register, no empty-passcode register.
    expect(reRegisterCalls).toBe(0)
    expect(registerCalls).toBe(0)
    expect(lastReRegisterBody).toBeNull()
    expect(lastRegisterBody).toBeNull()
  })
})

describe('handler dispatch is failure-isolated (BUG-006)', () => {
  it('a throwing message handler does not stop the other handlers', async () => {
    const { signaling } = await freshModules()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const seen: string[] = []
    const offA = signaling.onMessage(() => { throw new Error('sync boom') })
    const offB = signaling.onMessage(msg => { seen.push((msg as { t: string }).t) })

    signaling.connect('tok')
    constructed[0].open()
    constructed[0].onmessage?.({ data: JSON.stringify({ t: 'PONG' }) })

    expect(seen).toEqual(['PONG'])
    offA(); offB(); warn.mockRestore()
  })

  it('an async handler rejection is caught, not left unhandled', async () => {
    const { signaling } = await freshModules()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const unhandled: unknown[] = []
    const onUnhandled = (e: PromiseRejectionEvent) => { unhandled.push(e.reason); e.preventDefault?.() }
    window.addEventListener('unhandledrejection', onUnhandled)

    const seen: string[] = []
    const offA = signaling.onMessage(async () => { throw new Error('async boom') })
    const offB = signaling.onMessage(msg => { seen.push((msg as { t: string }).t) })

    signaling.connect('tok')
    constructed[0].open()
    constructed[0].onmessage?.({ data: JSON.stringify({ t: 'PONG' }) })

    await settle()
    expect(seen).toEqual(['PONG'])
    expect(unhandled).toEqual([])
    expect(warn).toHaveBeenCalled()

    window.removeEventListener('unhandledrejection', onUnhandled)
    offA(); offB(); warn.mockRestore()
  })

  it('a throwing connect handler does not prevent the AUTH frame or later handlers', async () => {
    const { signaling } = await freshModules()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let second = 0
    const offA = signaling.onConnect(() => { throw new Error('boom') })
    const offB = signaling.onConnect(() => { second++ })

    signaling.connect('tok')
    constructed[0].open()

    expect(constructed[0].sentFrames()).toContainEqual({ t: 'AUTH', token: 'tok' })
    expect(second).toBe(1)
    offA(); offB(); warn.mockRestore()
  })
})

describe('Contract 3: close code 4003 is transient — same-token reconnect', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('4003 does NOT dispatch onAuthInvalid and reconnects with the same token', async () => {
    const { signaling } = await freshModules()
    const authInvalid: number[] = []
    const off = signaling.onAuthInvalid(() => { authInvalid.push(1) })

    signaling.connect('live-token')
    const sock = constructed[0]
    sock.open()
    sock.fireClose(4003)

    expect(authInvalid).toEqual([])
    // Backoff fires the first reconnect attempt.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(constructed.length).toBe(2)
    const next = constructed[1]
    next.open()
    expect(next.sentFrames()).toContainEqual({ t: 'AUTH', token: 'live-token' })

    off()
  })

  it('4001 still dispatches onAuthInvalid (hard contract unchanged)', async () => {
    const { signaling, useAuthStore } = await freshModules()
    seedSession(useAuthStore, 'stale-token')
    const authInvalid: number[] = []
    const off = signaling.onAuthInvalid(() => { authInvalid.push(1) })

    signaling.connect('stale-token')
    constructed[0].open()
    constructed[0].fireClose(4001)

    expect(authInvalid).toEqual([1])
    off()
  })
})

describe('socket ownership: generation-guarded callbacks (02 P2 / 09 P2)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reconnectNow replaces an OPEN socket when PING throws', async () => {
    const { signaling } = await freshModules()
    signaling.connect('tok')
    const sock = constructed[0]
    sock.open()
    sock.send = vi.fn(() => { throw new Error('half-dead') })

    signaling.reconnectNow()

    expect(constructed.length).toBe(2)
    expect(sock.close).toHaveBeenCalled()
    // Old handlers detached so a late close cannot poison the new socket.
    expect(sock.onclose).toBeNull()
  })

  it('a CLOSING socket set aside cannot stop the NEW socket heartbeat or fire authInvalid', async () => {
    const { signaling, useAuthStore } = await freshModules()
    seedSession(useAuthStore, 'tok')
    const authInvalid: number[] = []
    const disconnects: number[] = []
    signaling.onAuthInvalid(() => { authInvalid.push(1) })
    signaling.onDisconnect(() => { disconnects.push(1) })

    signaling.connect('tok')
    const old = constructed[0]
    old.open()

    // Simulate reconnectNow's CLOSING path: detach the old, open a new one.
    old.readyState = StubWS.CLOSING
    signaling.reconnectNow()
    expect(constructed.length).toBe(2)
    const next = constructed[1]
    next.open()

    // Stale close from the detached old socket (as if the browser delivered it late).
    old.readyState = StubWS.CLOSED
    old.onclose?.({ code: 4001 })

    // Must not have counted as auth-invalid or an extra disconnect for the live socket.
    expect(authInvalid).toEqual([])
    // reconnectNow detachAndClose nulls onclose, so fireClose path shouldn't run —
    // but if a caller still holds a reference and invokes, generation check blocks it.
    // Since onclose is null after detach, we also verify via direct call above no-ops.
    expect(signaling.isConnected()).toBe(true)
  })

  it('connect watchdog closes a forever-CONNECTING socket and enters backoff', async () => {
    const { signaling } = await freshModules()
    const { WS_CONNECT_TIMEOUT_MS } = await import('../../src/constants')

    signaling.connect('tok')
    expect(constructed.length).toBe(1)
    expect(constructed[0].readyState).toBe(StubWS.CONNECTING)

    // Still CONNECTING past the watchdog budget.
    await vi.advanceTimersByTimeAsync(WS_CONNECT_TIMEOUT_MS)
    expect(constructed[0].close).toHaveBeenCalled()

    // Backoff schedules a new socket.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(constructed.length).toBe(2)
  })
})
