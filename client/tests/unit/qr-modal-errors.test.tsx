// 07 P2 — QRModal must never paint raw HTTP status / exception text.
//
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { network as netCopy } from '../../src/copy/zh-CN/network'

const authedFetch = vi.fn()

vi.mock('@/lib/api', () => ({
  authedFetch: (...args: unknown[]) => authedFetch(...args),
  AuthRequiredError: class AuthRequiredError extends Error {
    constructor() { super('auth required') }
  },
}))

vi.mock('@/store/auth', () => ({
  useAuthStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ session: { token: 'tok', sessionId: 's1' } }),
}))

vi.mock('@/lib/sound', () => ({ playSound: vi.fn() }))
vi.mock('@/hooks/useModalExit', () => ({
  useModalExit: (onClose: () => void) => ({
    open: true,
    requestClose: onClose,
    onPanelAnimationEnd: () => {},
  }),
}))

import QRModal from '../../src/components/features/QRModal'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  authedFetch.mockReset()
  document.body.innerHTML = ''
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('07 P2: QRModal raw-error suppression', () => {
  it('shows stable tokenFailed copy on non-ok HTTP, never the status code', async () => {
    authedFetch.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: 'Service Unavailable' }),
    })
    await act(async () => {
      root.render(<QRModal nodeId={1} passCode="123456" onClose={() => {}} />)
    })
    // Allow fetch effect to settle.
    await act(async () => { await Promise.resolve() })
    await act(async () => { await Promise.resolve() })

    const text = document.body.textContent || ''
    expect(text).toContain(netCopy.qr.tokenFailed)
    expect(text).not.toMatch(/503|Service Unavailable|HTTP/i)
  })

  it('shows stable copy on thrown network error, never the raw message', async () => {
    authedFetch.mockRejectedValue(new Error('TypeError: Failed to fetch at internal'))
    await act(async () => {
      root.render(<QRModal nodeId={1} passCode="123456" onClose={() => {}} />)
    })
    await act(async () => { await Promise.resolve() })
    await act(async () => { await Promise.resolve() })

    const text = document.body.textContent || ''
    expect(text).toContain(netCopy.qr.tokenFailed)
    expect(text).not.toMatch(/TypeError|Failed to fetch|internal/i)
  })
})
