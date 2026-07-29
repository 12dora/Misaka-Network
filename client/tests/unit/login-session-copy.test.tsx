// 07 P1 — session TTL copy must match seamless-renewal semantics.
// Contract 2: renewal only runs while the tab is alive and connected, so
// "会话在持续使用时自动续期，闲置约 30 分钟后释放" is accurate.
//
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

const authState = {
  identity: { nodeId: 10032, passCode: '123456' },
  isConnected: false,
  isLoading: false,
  error: null as string | null,
  session: null as null,
  ipFullPrompt: null as null,
  connect: vi.fn(),
  disconnect: vi.fn(),
  setNodeId: vi.fn(),
  setPassCode: vi.fn(),
  regenerateNodeId: vi.fn(),
  regeneratePassCode: vi.fn(),
  releaseAllFromIp: vi.fn(async () => 0),
  dismissIpFullPrompt: vi.fn(),
  clearError: vi.fn(),
}

function useAuthStoreMock(sel?: (s: typeof authState) => unknown) {
  if (typeof sel === 'function') return sel(authState)
  return authState
}
useAuthStoreMock.getState = () => authState

vi.mock('@/store/auth', () => ({
  useAuthStore: useAuthStoreMock,
}))

vi.mock('@/components/features/QRModal', () => ({ default: () => null }))
vi.mock('@/components/features/ScanModal', () => ({ default: () => null }))
vi.mock('@/components/features/IpFullPrompt', () => ({ default: () => null }))

import LoginCard from '../../src/components/features/LoginCard'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  document.body.innerHTML = ''
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('07 P1: LoginCard session TTL copy', () => {
  it('states seamless renewal while active and ~30 min idle release', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <LoginCard />
        </MemoryRouter>,
      )
    })
    const hint = container.querySelector('[data-testid="session-ttl-hint"]')
    expect(hint?.textContent).toContain('会话在持续使用时自动续期，闲置约 30 分钟后释放')
    // Old misleading "无活动" wording must be gone.
    expect(container.textContent).not.toMatch(/30 分钟无活动会话自动释放/)
  })
})
