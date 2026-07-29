// Join page boundary: QR redeem errors must surface decoder copy, not a
// generic "接入失败" for RATE_LIMITED / NODE_LOCKED / BAD_ORIGIN / INVALID_INPUT.
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

const navigate = vi.fn()
let searchParams = new URLSearchParams()

vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
  useSearchParams: () => [searchParams],
}))

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>
let fetchHandler: FetchHandler = async () => new Response('{}', { status: 500 })

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  navigate.mockClear()
  searchParams = new URLSearchParams({
    type: 'node',
    id: '42',
    t: 'qr-token-abcdef',
  })
  ;(globalThis as unknown as { fetch: unknown }).fetch = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => fetchHandler(String(input), init),
  )
  sessionStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

function setControlledInput(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

async function renderJoin(): Promise<void> {
  const { default: Join } = await import('../../src/pages/Join')
  await act(async () => {
    root.render(<Join /> as ReactElement)
  })
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
}

async function submitPassCode(pass = '123456') {
  const input = document.querySelector('#join-passcode') as HTMLInputElement | null
  expect(input).toBeTruthy()
  await act(async () => {
    setControlledInput(input!, pass)
  })
  const submit = Array.from(document.querySelectorAll('button')).find(b =>
    (b.textContent ?? '').includes('接入'),
  )
  expect(submit).toBeTruthy()
  await act(async () => { submit!.click() })
  await act(async () => {
    for (let i = 0; i < 40; i++) await Promise.resolve()
  })
}

describe('Join QR error classification at page boundary', () => {
  it.each([
    {
      name: 'RATE_LIMITED',
      status: 429,
      body: { error: 'RATE_LIMITED', message: '请求过于频繁，请稍后再试' },
      re: /频繁|稍后再试/,
    },
    {
      name: 'NODE_LOCKED',
      status: 423,
      body: {
        error: 'NODE_LOCKED',
        reason: 'WRONG_PASSCODE',
        // ~2 minutes — decoder must render the unlock window, not just "锁定".
        unlockAt: Date.now() + 120_000,
      },
      re: /锁定/,
      timeRe: /2\s*分钟/,
    },
    {
      name: 'BAD_ORIGIN',
      status: 403,
      body: { error: 'BAD_ORIGIN' },
      re: /来源|官方|域名/,
    },
    {
      name: 'INVALID_INPUT',
      status: 400,
      body: { error: 'INVALID_INPUT', message: '请求参数无效' },
      re: /参数/,
    },
  ] as const)('surfaces $name copy from the shared decoder', async ({ status, body, re, ...rest }) => {
    fetchHandler = async (url) => {
      if (url.includes('/api/qr-redeem')) {
        return new Response(JSON.stringify(body), { status })
      }
      return new Response('{}', { status: 404 })
    }

    await renderJoin()
    await submitPassCode('654321')

    const text = document.body.textContent ?? ''
    expect(text).toMatch(re)
    // Must not be the undifferentiated generic-only path with empty detail.
    expect(text).toContain('接入失败')
    if ('timeRe' in rest && rest.timeRe) {
      expect(text).toMatch(rest.timeRe)
    }
  })
})

describe('Join does not navigate on refused connect while previously connected', () => {
  it('branches on commit result, not a stale global isConnected', async () => {
    // Reset modules so Join sees a clean auth store; then seed a prior session.
    vi.resetModules()
    const { useAuthStore } = await import('../../src/store/auth')
    useAuthStore.setState({
      session: {
        token: 'prior-tok',
        sessionId: 'prior-sid',
        expiresAt: Date.now() + 60_000,
        reRegisterProof: 'prior-proof',
      },
      isConnected: true,
      identity: { nodeId: 1, passCode: '', createdAt: Date.now() },
    })

    fetchHandler = async (url) => {
      if (url.includes('/api/qr-redeem')) {
        return new Response(JSON.stringify({
          targetNodeId: 42,
          channelId: 'ch-1',
          admissionGrant: 'a'.repeat(64),
        }), { status: 200 })
      }
      if (url.includes('/api/register')) {
        // Admission register fails — must not navigate via stale isConnected.
        return new Response(JSON.stringify({
          error: 'CONFLICT',
          remaining: 1,
          message: '该节点编号已被他人使用，请换一个',
        }), { status: 409 })
      }
      if (url.includes('/api/release')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    }

    // Re-import Join after auth store is seeded (Join uses the same module).
    const { default: Join } = await import('../../src/pages/Join')
    await act(async () => {
      root.render(<Join /> as ReactElement)
    })
    await act(async () => {
      for (let i = 0; i < 8; i++) await Promise.resolve()
    })
    await submitPassCode('123456')

    expect(navigate).not.toHaveBeenCalled()
    const text = document.body.textContent ?? ''
    expect(text).toMatch(/接入失败|节点|通行码/)
    expect(useAuthStore.getState().isConnected).toBe(false)
  })
})
