// BUG-026 — TURN/NAT diagnostics could fail silently or stay stuck on
// "测试中…" forever.
//
// `testTurnServer` built the RTCPeerConnection and awaited
// createOffer/setLocalDescription *outside* any try. The add-server form
// accepts free text, so a typo'd URL threw synchronously from the
// constructor; a WebRTC-hardened browser threw from createOffer. Either way
// the rejection propagated to `await testTurnServer(...)` in the settings
// modal, `setTestingId(null)` never ran, and the row sat on "测试中…" with no
// result and no reason.
//
// `testTurnServerDetailed` never rejects — every failure is a typed result
// carrying an actionable message.
//
// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from 'vitest'
import { testTurnServerDetailed, describeTurnTest } from '../../src/lib/turn'

const SERVER = {
  id: 'srv-1',
  url: 'turn:relay.example.com:3478?transport=udp',
  username: 'u',
  credential: 'c',
  enabled: true,
}

const realRtc = (globalThis as unknown as { RTCPeerConnection?: unknown }).RTCPeerConnection

function setRtc(impl: unknown) {
  ;(globalThis as unknown as { RTCPeerConnection?: unknown }).RTCPeerConnection = impl
}

afterEach(() => {
  setRtc(realRtc)
  vi.unstubAllEnvs()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** A minimal PC stub that fires one candidate of the requested flavour. */
function stubPc(candidate: string | null) {
  const pc: Record<string, unknown> = {
    createDataChannel: () => ({}),
    createOffer: async () => ({ type: 'offer', sdp: '' }),
    setLocalDescription: async () => {},
    close: vi.fn(),
  }
  queueMicrotask(() => {
    // Let the caller attach onicecandidate first.
    setTimeout(() => {
      const handler = pc.onicecandidate as ((e: unknown) => void) | undefined
      if (handler && candidate) handler({ candidate: { candidate } })
    }, 0)
  })
  return pc
}

describe('BUG-026 happy path', () => {
  it('reports RELAY_OK when a relay candidate is gathered', async () => {
    setRtc(function () { return stubPc('candidate:1 1 udp 1 1.2.3.4 3478 typ relay raddr 0.0.0.0') })

    const result = await testTurnServerDetailed(SERVER)

    expect(result.reachable).toBe(true)
    expect(result.code).toBe('RELAY_OK')
    expect(result.message).toBe(describeTurnTest('RELAY_OK'))
  })
})

describe('E2E host-only TURN diagnostics', () => {
  it('returns an explicit test-mode result without constructing a relay peer', async () => {
    vi.stubEnv('VITE_E2E_BUILD_NONCE', 'misaka-playwright-v1')
    vi.stubEnv('VITE_E2E_HOST_ICE_ONLY', '1')
    const ctor = vi.fn()
    setRtc(ctor)

    const result = await testTurnServerDetailed(SERVER)

    expect(result).toMatchObject({
      reachable: false,
      code: 'TEST_MODE_BLOCKED',
    })
    expect(result.message).toContain('端到端测试模式')
    expect(ctor).not.toHaveBeenCalled()
  })

  it('does not activate in a production environment even when E2E variables are present', async () => {
    vi.stubEnv('DEV', false)
    vi.stubEnv('VITE_E2E_BUILD_NONCE', 'misaka-playwright-v1')
    vi.stubEnv('VITE_E2E_HOST_ICE_ONLY', '1')
    const ctor = vi.fn(function () {
      return stubPc('candidate:1 1 udp 1 1.2.3.4 3478 typ relay raddr 0.0.0.0')
    })
    setRtc(ctor)

    expect((await testTurnServerDetailed(SERVER)).code).toBe('RELAY_OK')
    expect(ctor).toHaveBeenCalledWith(expect.objectContaining({
      iceTransportPolicy: 'relay',
    }))
  })
})

describe('BUG-026 REGRESSION: failures resolve instead of rejecting', () => {
  it('a constructor that throws yields INVALID_URL, not an unhandled rejection', async () => {
    setRtc(function () { throw new TypeError('Failed to construct RTCPeerConnection') })

    // The whole point: this await must not reject, so the caller's
    // setTestingId(null) always runs.
    const result = await testTurnServerDetailed(SERVER)

    expect(result.reachable).toBe(false)
    expect(result.code).toBe('INVALID_URL')
    expect(result.message).toContain('turn:example.com:3478')
    expect(result.detail).toContain('Failed to construct')
  })

  it('a createOffer that throws yields SETUP_FAILED and still closes the PC', async () => {
    const close = vi.fn()
    setRtc(function () {
      return {
        createDataChannel: () => ({}),
        createOffer: async () => { throw new Error('WebRTC disabled by policy') },
        setLocalDescription: async () => {},
        close,
      }
    })

    const result = await testTurnServerDetailed(SERVER)

    expect(result.reachable).toBe(false)
    expect(result.code).toBe('SETUP_FAILED')
    expect(close).toHaveBeenCalled()
  })

  it('a setLocalDescription that throws yields SETUP_FAILED', async () => {
    setRtc(function () {
      return {
        createDataChannel: () => ({}),
        createOffer: async () => ({ type: 'offer', sdp: '' }),
        setLocalDescription: async () => { throw new Error('InvalidStateError') },
        close: vi.fn(),
      }
    })

    expect((await testTurnServerDetailed(SERVER)).code).toBe('SETUP_FAILED')
  })

  it('EDGE — no WebRTC at all yields WEBRTC_UNAVAILABLE without constructing', async () => {
    setRtc(undefined)
    const result = await testTurnServerDetailed(SERVER)
    expect(result.code).toBe('WEBRTC_UNAVAILABLE')
    expect(result.reachable).toBe(false)
  })
})

describe('BUG-026: URL validation happens before any WebRTC work', () => {
  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['https URL', 'https://relay.example.com'],
    ['bare host', 'relay.example.com:3478'],
    ['stun URL', 'stun:stun.example.com:3478'],
    ['missing host', 'turn:?transport=udp'],
    ['authority syntax', 'turn://relay.example.com:3478'],
    ['credentials/at signs', 'turn:@@'],
    ['empty port', 'turn:relay.example.com:'],
    ['zero port', 'turn:relay.example.com:0'],
    ['oversized port', 'turn:relay.example.com:65536'],
    ['invalid transport', 'turn:relay.example.com:3478?transport=quic'],
    ['unknown query', 'turn:relay.example.com:3478?foo=bar'],
    ['duplicate transport', 'turn:relay.example.com:3478?transport=udp&transport=tcp'],
    ['empty DNS label', 'turn:relay..example.com:3478'],
    ['trailing DNS dot', 'turn:relay.example.com.:3478'],
    ['invalid DNS label character', 'turn:relay_example.com:3478'],
    ['leading label hyphen', 'turn:-relay.example.com:3478'],
    ['oversized DNS label', `turn:${'a'.repeat(64)}.example.com:3478`],
    ['encoded authority separator', 'turn:relay.example.com%40attacker.test:3478'],
    ['encoded slash', 'turn:relay.example.com%2fpath:3478'],
    ['raw backslash authority trick', 'turn:relay.example.com\\attacker.test:3478'],
    ['empty query segment', 'turn:relay.example.com:3478?transport=udp&&'],
    ['trailing query separator', 'turn:relay.example.com:3478?transport=udp&'],
    ['path segment', 'turn:relay.example.com/path'],
    ['malformed IPv6 compression', 'turn:[2001:::1]:3478'],
    ['invalid IPv4-mapped IPv6', 'turn:[::ffff:999.0.2.1]:3478'],
    ['missing IPv6 closing bracket', 'turn:[2001:db8::1:3478'],
  ])('rejects %s as INVALID_URL without touching RTCPeerConnection', async (_l, url) => {
    const ctor = vi.fn()
    setRtc(ctor)

    const result = await testTurnServerDetailed({ ...SERVER, url })

    expect(result.code).toBe('INVALID_URL')
    expect(ctor).not.toHaveBeenCalled()
  })

  it('accepts both turn: and turns:', async () => {
    setRtc(function () { return stubPc('candidate:1 1 udp 1 1.2.3.4 3478 typ relay raddr 0.0.0.0') })
    expect((await testTurnServerDetailed({ ...SERVER, url: 'turns:relay.example.com:5349' })).code)
      .toBe('RELAY_OK')
  })

  it.each([
    'turn:[2001:db8::1]:3478?transport=udp',
    'turns:[::1]:5349?transport=tcp',
    'turn:[2001:0db8::1]:3478',
    'turn:[0:0:0:0:0:0:0:1]:3478',
    'turn:[::ffff:192.0.2.1]:3478',
  ])('preserves valid bracketed IPv6: %s', async url => {
    setRtc(function () { return stubPc('candidate:1 1 udp 1 2001:db8::1 3478 typ relay raddr ::') })
    expect((await testTurnServerDetailed({ ...SERVER, url })).code).toBe('RELAY_OK')
  })
})

describe('BUG-026: a timed-out gather reports NO_RELAY with a recovery hint', () => {
  it('resolves false rather than hanging the row on "测试中…"', async () => {
    vi.useFakeTimers()
    setRtc(function () {
      return {
        createDataChannel: () => ({}),
        createOffer: async () => ({ type: 'offer', sdp: '' }),
        setLocalDescription: async () => {},
        close: vi.fn(),
      }
    })

    const promise = testTurnServerDetailed(SERVER)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(5_001)
    const result = await promise

    expect(result.reachable).toBe(false)
    expect(result.code).toBe('NO_RELAY')
    // UX-COPY-004: the message must be actionable, not a raw protocol dump.
    expect(result.message).toContain('请检查地址、端口、用户名和密码')
  })

  it('bounds a createOffer promise that never resolves', async () => {
    vi.useFakeTimers()
    const close = vi.fn()
    setRtc(function () {
      return {
        createDataChannel: () => ({}),
        createOffer: () => new Promise(() => {}),
        setLocalDescription: async () => {},
        close,
      }
    })

    const promise = testTurnServerDetailed(SERVER)
    await vi.advanceTimersByTimeAsync(5_001)
    const result = await promise
    expect(result.code).toBe('SETUP_FAILED')
    expect(close).toHaveBeenCalled()
  })

  it('uses one total budget across slow setup and candidate gathering', async () => {
    vi.useFakeTimers()
    const close = vi.fn()
    setRtc(function () {
      return {
        createDataChannel: () => ({}),
        createOffer: () => new Promise(resolve => {
          setTimeout(() => resolve({ type: 'offer', sdp: '' }), 4_000)
        }),
        setLocalDescription: async () => {},
        close,
      }
    })

    let settled = false
    const promise = testTurnServerDetailed(SERVER).finally(() => { settled = true })
    await vi.advanceTimersByTimeAsync(4_999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    expect(settled).toBe(true)
    expect((await promise).code).toBe('NO_RELAY')
    expect(close).toHaveBeenCalled()
  })
})
