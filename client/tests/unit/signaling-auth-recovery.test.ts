// Regression for the WS auth recovery dead-lock.
//
// Before the fix: after the server restarted and the cached token went stale,
// the WS closed with 4002, `serverShutdown` latched true, and a subsequent
// `connect(newToken)` would either:
//   (a) bail out of doConnect() because the old socket was still in the
//       CLOSING/CLOSED state but referenced by the module-level `ws`, OR
//   (b) leave `serverShutdown` true with no auto-reconnect scheduled.
// Either way the user stayed disconnected until full page reload.
//
// The fix in connect() detaches/closes the stale socket and resets
// reconnectTimer + serverShutdown so the new token actually opens a fresh WS.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { connect } from '../../src/lib/signaling'

// JSDOM ships a usable EventTarget but no WebSocket. Stub one and capture
// every constructor call so we can verify a new socket is created on
// connect(newToken).
type FakeWS = {
  url: string
  readyState: number
  onopen: ((this: WebSocket, ev: Event) => unknown) | null
  onclose: ((this: WebSocket, ev: CloseEvent) => unknown) | null
  onerror: ((this: WebSocket, ev: Event) => unknown) | null
  onmessage: ((this: WebSocket, ev: MessageEvent) => unknown) | null
  close: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
}

let constructed: FakeWS[] = []

class StubWS {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  url: string
  readyState = 0
  onopen: ((this: WebSocket, ev: Event) => unknown) | null = null
  onclose: ((this: WebSocket, ev: CloseEvent) => unknown) | null = null
  onerror: ((this: WebSocket, ev: Event) => unknown) | null = null
  onmessage: ((this: WebSocket, ev: MessageEvent) => unknown) | null = null
  close = vi.fn(() => { this.readyState = StubWS.CLOSED })
  send = vi.fn()
  constructor(url: string) {
    this.url = url
    constructed.push(this as unknown as FakeWS)
  }
}

beforeEach(() => {
  constructed = []
  ;(globalThis as unknown as { WebSocket: typeof StubWS }).WebSocket = StubWS
})

describe('signaling.connect: auth recovery with a fresh token', () => {
  it('discards the stale socket and opens a new one when the token changes', () => {
    connect('stale-token')
    expect(constructed.length).toBe(1)
    const first = constructed[0]
    // Pretend the server-restart 4002 close happened. (We DON'T fire the
    // close handler — that would normally trigger serverShutdown=true and
    // the authInvalid notify path; we just leave the socket in CLOSING.)
    first.readyState = StubWS.CLOSING

    // Auth store re-registers and calls connect(newToken).
    connect('fresh-token')

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
