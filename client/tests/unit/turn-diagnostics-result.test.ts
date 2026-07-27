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
})
