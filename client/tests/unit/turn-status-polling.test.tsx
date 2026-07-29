// TURN status polling: serial schedule, at most one in-flight, abort on unmount.
// Does NOT mock fetchTurnStatus — drives the real helper + SettingsModal effect.
//
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import type { ReactElement } from 'react'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let loaded = { servers: [] as never[], enabled: false, forceRelay: false }
const saved: unknown[] = []

vi.mock('../../src/lib/turn', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/lib/turn')>()
  return {
    ...actual,
    // Keep real fetchTurnStatus; only stub settings persistence + auto helpers.
    loadTurnSettings: () => loaded,
    saveTurnSettings: (s: unknown) => { saved.push(JSON.parse(JSON.stringify(s))) },
    testTurnServerDetailed: vi.fn(async () => ({ reachable: false, code: 'NO_RELAY', message: 'x' })),
    getAutoTurnState: () => ({ active: false, expiresAt: null, lastFailReason: null }),
    refreshAutoTurn: vi.fn(async () => []),
  }
})
vi.mock('../../src/lib/nat', () => ({
  detectNatType: vi.fn(async () => ({ type: 'unknown', reason: '', publicEndpoints: [] })),
}))
vi.mock('../../src/lib/sound', () => ({
  isSoundEnabled: () => false,
  setSoundEnabled: vi.fn(),
  subscribeSoundPreference: () => () => {},
  playSound: vi.fn(),
}))
vi.mock('../../src/lib/notify', () => ({ ensureNotificationPermission: vi.fn(async () => 'default') }))
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }))

import SettingsModal from '../../src/components/features/SettingsModal'

let container: HTMLDivElement
let root: Root
let inFlight = 0
let maxInFlight = 0
let fetchCalls = 0
const abortSignals: AbortSignal[] = []
let blackHole = true

beforeEach(() => {
  loaded = { servers: [], enabled: false, forceRelay: false }
  saved.length = 0
  inFlight = 0
  maxInFlight = 0
  fetchCalls = 0
  abortSignals.length = 0
  blackHole = true
  vi.useFakeTimers()

  ;(globalThis as unknown as { fetch: unknown }).fetch = vi.fn(
    (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (!url.includes('/api/turn-status')) {
        return Promise.resolve(new Response('{}', { status: 404 }))
      }
      fetchCalls++
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      const signal = init?.signal
      if (signal) abortSignals.push(signal)

      return new Promise<Response>((resolve, reject) => {
        const onAbort = () => {
          inFlight = Math.max(0, inFlight - 1)
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        }
        if (signal?.aborted) {
          onAbort()
          return
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        if (!blackHole) {
          queueMicrotask(() => {
            signal?.removeEventListener('abort', onAbort)
            inFlight = Math.max(0, inFlight - 1)
            resolve(new Response(JSON.stringify({
              enabled: true,
              configured: true,
              provider: 'cf',
              credentialTtlSec: 600,
              available: true,
              detailed: false,
            }), { status: 200 }))
          })
        }
        // blackHole: never settles until abort or test ends
      })
    },
  )

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  document.body.removeAttribute('data-dialog-open')
  vi.useRealTimers()
})

describe('TURN status polling behaviour', () => {
  it('never overlaps requests across the 10s boundary and aborts the live signal on unmount', async () => {
    await act(async () => {
      root.render(<SettingsModal onClose={() => {}} /> as ReactElement)
    })
    // First tick starts immediately.
    await act(async () => { await Promise.resolve() })
    expect(fetchCalls).toBe(1)
    expect(maxInFlight).toBe(1)

    // Advance past the 10s poll interval. The 8s status deadline fires during
    // this window and settles the first request; the serial loop then arms a
    // 10s wait — a second request must not have started yet.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(fetchCalls).toBe(1)
    expect(maxInFlight).toBe(1)

    // Fire the post-settle 10s timer so a fresh poll is in flight.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    await act(async () => { await Promise.resolve() })
    expect(fetchCalls).toBe(2)
    expect(maxInFlight).toBe(1)

    // Assert the *currently in-flight* signal transitions false → true on
    // unmount. (A vacuous `some(s.aborted)` would pass because the first
    // signal was already aborted by the 8s deadline.)
    const inflight = abortSignals[abortSignals.length - 1]
    expect(inflight).toBeDefined()
    expect(inflight!.aborted).toBe(false)
    await act(async () => { root.unmount() })
    expect(inflight!.aborted).toBe(true)
  })
})
