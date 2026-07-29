// Layout + a11y regressions for Network / TopNav / dialog / progress.
// Behavioural tests only — no source-regex scanners.
//
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import MisakaProgressBar from '../../src/components/ui/MisakaProgressBar'
import MisakaDialog from '../../src/components/ui/MisakaDialog'
import MisakaSwitch from '../../src/components/ui/MisakaSwitch'
import DownloadArtifactActions from '../../src/components/features/DownloadArtifactActions'
import type { Peer, Transfer } from '../../src/types'
import { scrollIntoViewSafely, scrollBehavior, prefersReducedMotion } from '../../src/hooks/useReducedMotion'
import { titleForPath } from '../../src/copy/zh-CN/pageMeta'

const { cancelTransferAction, cancelReceiveTransfer } = vi.hoisted(() => ({
  cancelTransferAction: vi.fn(),
  cancelReceiveTransfer: vi.fn(),
}))

const peerA: Peer = {
  sessionId: 'sess-a',
  nodeId: 10032,
  status: 'online',
  channelType: 'direct',
  joinedAt: Date.now() - 60_000,
}
const peerB: Peer = {
  sessionId: 'sess-b',
  nodeId: 10032,
  status: 'offline',
  channelType: 'ws',
  joinedAt: Date.now() - 120_000,
}

const transfer: Transfer = {
  id: 't-1',
  direction: 'recv',
  peerSessionId: 'sess-a',
  peerNodeId: 10032,
  fileName: 'photo.zip',
  fileSize: 1024,
  progress: 0.5,
  speedBps: 1000,
  status: 'transferring',
  startedAt: Date.now(),
}

const networkState = {
  peers: [peerA, peerB] as Peer[],
  transfers: [transfer] as Transfer[],
  selectedSessionId: null as string | null,
  unreadByPeer: {
    'sess-a': { message: 3, file: 1 },
    'sess-b': { message: 0, file: 2 },
  } as Record<string, { message: number; file: number }>,
  chatMessages: {} as Record<string, unknown[]>,
  pendingFiles: {} as Record<string, unknown[]>,
  sendingPeers: new Set<string>(),
  signalingStatus: 'online' as const,
  myNatType: null as string | null,
  autoTurnAvailable: true,
  init: vi.fn(),
  destroy: vi.fn(),
  selectPeer: vi.fn(),
  pauseTransfer: vi.fn(),
  resumeTransfer: vi.fn(),
  cancelTransferAction,
  pauseReceiveTransfer: vi.fn(),
  resumeReceiveTransfer: vi.fn(),
  cancelReceiveTransfer,
  addPendingFiles: vi.fn(),
  sendFilesToAll: vi.fn(),
  recoverConnections: vi.fn(),
  reconnectPeer: vi.fn(),
}

function useNetworkStoreMock(sel?: (s: typeof networkState) => unknown) {
  if (typeof sel === 'function') return sel(networkState)
  return networkState
}
useNetworkStoreMock.getState = () => ({
  ...networkState,
  cancelReceiveTransfer,
  pauseReceiveTransfer: vi.fn(),
  resumeReceiveTransfer: vi.fn(),
  reconnectPeer: vi.fn(),
  destroy: vi.fn(),
  init: vi.fn(),
})

vi.mock('@/store/network', async () => {
  const actual = await vi.importActual<typeof import('../../src/store/network')>('@/store/network')
  return {
    ...actual,
    useNetworkStore: useNetworkStoreMock,
    isLikelyUnreachable: () => false,
    getTransferDeliveryState: () => 'delivered',
    markDownloadArtifactStarted: vi.fn(),
    releaseDownloadArtifact: vi.fn(async () => {}),
  }
})

const authState = {
  session: { token: 'tok', sessionId: 'sess' },
  identity: { nodeId: 1, passCode: '123456' },
  isConnected: true,
}
function useAuthStoreMock(sel?: (s: typeof authState) => unknown) {
  if (typeof sel === 'function') return sel(authState)
  return authState
}
useAuthStoreMock.getState = () => authState
vi.mock('@/store/auth', () => ({ useAuthStore: useAuthStoreMock }))
vi.mock('@/lib/notify', () => ({ ensureNotificationPermission: async () => {} }))
vi.mock('@/lib/api', () => ({
  authedFetch: vi.fn(),
  AuthRequiredError: class AuthRequiredError extends Error {},
}))
vi.mock('@/components/features/QRModal', () => ({ default: () => null }))
vi.mock('@/components/features/SettingsModal', () => ({ default: () => null }))
vi.mock('@/components/ui/AppFooter', () => ({ default: () => null }))

import Network from '../../src/pages/Network'
import TopNav from '../../src/components/layout/TopNav'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  cancelTransferAction.mockClear()
  cancelReceiveTransfer.mockClear()
  networkState.transfers = [{ ...transfer }]
  networkState.peers = [peerA, peerB]
  networkState.selectedSessionId = null
  networkState.chatMessages = {}
  // jsdom does not implement scrollIntoView; ChannelChat calls it on mount.
  if (typeof Element.prototype.scrollIntoView !== 'function') {
    Element.prototype.scrollIntoView = vi.fn()
  }
  document.body.innerHTML = ''
  document.body.removeAttribute('data-dialog-open')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
  document.body.removeAttribute('data-dialog-open')
})

describe('08 P2: MisakaProgressBar accessible name', () => {
  it('exposes aria-label so multi-file panels can be distinguished', async () => {
    await act(async () => {
      root.render(<MisakaProgressBar value={0.42} label="接收 photo.zip 的进度" />)
    })
    const bar = container.querySelector('[role="progressbar"]')
    expect(bar?.getAttribute('aria-label')).toBe('接收 photo.zip 的进度')
    expect(bar?.getAttribute('aria-valuenow')).toBe('42')
  })

  it('uses scaleX transform for the fill (compositor-friendly)', async () => {
    await act(async () => {
      root.render(<MisakaProgressBar value={0.67} />)
    })
    const fill = container.querySelector('[role="progressbar"] > div')
    expect((fill as HTMLElement).style.transform).toContain('scaleX')
  })
})

describe('08 P2: MisakaDialog safe-area backdrop class', () => {
  it('applies misaka-dialog-backdrop by default', async () => {
    await act(async () => {
      root.render(
        <MisakaDialog title="测试" onRequestClose={() => {}}>
          <button type="button">ok</button>
        </MisakaDialog>,
      )
    })
    const host = document.querySelector('[data-misaka-dialog-host] > div')
    expect(host?.className).toMatch(/misaka-dialog-backdrop/)
  })

  it('sets body[data-dialog-open] while open (toast suppression contract)', async () => {
    await act(async () => {
      root.render(
        <MisakaDialog title="测试" onRequestClose={() => {}}>
          <button type="button">ok</button>
        </MisakaDialog>,
      )
    })
    expect(document.body.getAttribute('data-dialog-open')).toBe('true')
  })
})

describe('08 P3: MisakaSwitch animates transform not left', () => {
  it('knob uses translateX when checked', async () => {
    await act(async () => {
      root.render(
        <MisakaSwitch checked label="测试开关" onChange={() => {}} />,
      )
    })
    const knob = container.querySelector('[role="switch"] > span') as HTMLElement
    expect(knob.style.transform).toMatch(/translateX/)
    expect(knob.style.left || '').not.toMatch(/calc/)
  })
})

describe('08 P2: TopNav status a11y (rendered)', () => {
  it('exposes status via role=status and accessible name', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <TopNav />
        </MemoryRouter>,
      )
    })
    const status = document.querySelector('[role="status"]')
    expect(status).toBeTruthy()
    expect(status?.getAttribute('aria-live')).toBe('polite')
    const name = status?.getAttribute('aria-label') || status?.textContent || ''
    expect(name.length).toBeGreaterThan(0)
    // Must not be colour-only: a glyph or text is present for AT.
    expect(status?.textContent?.trim().length).toBeGreaterThan(0)
  })
})

describe('08 P2: node card aria-label (rendered)', () => {
  it('two devices with the same nodeId have distinct accessible names with status + unread', async () => {
    await act(async () => { root.render(<Network />) })
    const cards = Array.from(document.querySelectorAll('[role="button"][aria-label]'))
      .filter(el => (el.getAttribute('aria-label') || '').includes('10032'))
    expect(cards.length).toBeGreaterThanOrEqual(2)
    const labels = cards.map(c => c.getAttribute('aria-label') || '')
    expect(labels[0]).not.toBe(labels[1])
    for (const label of labels) {
      // status vocabulary and unread counts must be present
      expect(label).toMatch(/连接|已断开|正在/)
      expect(label).toMatch(/未读/)
    }
  })
})

describe('08 P2: toast vs dialog stacking', () => {
  it('REAL Network toast uses misaka-notify; cancel dialog sets data-dialog-open', async () => {
    const api = await import('../../src/lib/api')
    vi.mocked(api.authedFetch).mockRejectedValueOnce(
      new Error('HTTP 500 crypto worker crashed at line 42'),
    )
    // Empty peer list surfaces the copy-link control; keep a live transfer so
    // the tasks panel can open a real cancel dialog while the toast is up.
    networkState.peers = []
    networkState.transfers = [{ ...transfer }]

    await act(async () => { root.render(<Network />) })

    const copyBtn = Array.from(document.querySelectorAll('button'))
      .find(b => b.textContent?.includes('复制链接'))
    expect(copyBtn).toBeTruthy()
    await act(async () => { copyBtn!.click() })

    const toast = document.querySelector('[data-testid="network-toast"]') as HTMLElement | null
    expect(toast).toBeTruthy()
    expect(toast!.classList.contains('misaka-notify')).toBe(true)
    // 07-02: raw HTTP / worker strings must never paint into the toast.
    expect(toast!.textContent || '').not.toMatch(/HTTP 500|crypto worker/i)

    // Open production cancel confirmation dialog on the same Network mount.
    const tasksTab = Array.from(document.querySelectorAll('button'))
      .find(b => b.getAttribute('aria-label') === '任务' || b.textContent?.includes('任务'))
    expect(tasksTab).toBeTruthy()
    await act(async () => { tasksTab!.click() })

    const cancelBtn = document.querySelector('[data-testid="cancel-transfer-t-1"]') as HTMLButtonElement | null
    expect(cancelBtn).toBeTruthy()
    await act(async () => { cancelBtn!.click() })

    expect(document.body.getAttribute('data-dialog-open')).toBe('true')
    // Toast remains mounted under the dialog (CSS hides it via the attribute).
    expect(document.querySelector('[data-testid="network-toast"]')).toBeTruthy()
  })
})

describe('08 P2: DownloadArtifactActions release target', () => {
  it('uses shared button + tap-target classes for the destructive release action', async () => {
    await act(async () => {
      root.render(
        <DownloadArtifactActions id="dl-1" url="blob:test" fileName="a.bin" />,
      )
    })
    const downloadBtn = Array.from(container.querySelectorAll('button'))
      .find(b => b.textContent?.includes('下载'))
    expect(downloadBtn).toBeTruthy()
    await act(async () => { downloadBtn!.click() })
    const releaseBtn = container.querySelector('[data-testid="release-download-dl-1"]') as HTMLElement | null
    expect(releaseBtn).toBeTruthy()
    expect(releaseBtn!.className).toMatch(/min-h-11/)
    expect(releaseBtn!.className).toMatch(/tap-target/)
    // Computed 44×44 geometry is not reliable in jsdom — deferred to E2E.
  })
})

describe('08 P2: reduced-motion scroll behaviour', () => {
  it('Network ChannelChat call-site scrolls with auto under reduced motion', async () => {
    const original = window.matchMedia
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      onchange: null,
    })) as unknown as typeof window.matchMedia

    expect(prefersReducedMotion()).toBe(true)
    expect(scrollBehavior()).toBe('auto')

    const scrollSpy = vi.fn()
    Element.prototype.scrollIntoView = scrollSpy

    networkState.peers = [peerA]
    networkState.selectedSessionId = peerA.sessionId
    networkState.chatMessages = {
      [peerA.sessionId]: [
        {
          id: 'm1',
          peerSessionId: peerA.sessionId,
          from: 'peer',
          text: '你好',
          timestamp: Date.now(),
          status: 'delivered',
        },
      ],
    }
    networkState.transfers = []

    await act(async () => { root.render(<Network />) })

    const channelTab = Array.from(document.querySelectorAll('button'))
      .find(b => b.getAttribute('aria-label') === '会话' || b.textContent?.includes('会话'))
    expect(channelTab).toBeTruthy()
    await act(async () => { channelTab!.click() })

    expect(scrollSpy).toHaveBeenCalled()
    const last = scrollSpy.mock.calls.at(-1)?.[0]
    expect(last).toEqual(expect.objectContaining({ behavior: 'auto' }))

    Element.prototype.scrollIntoView = vi.fn()
    window.matchMedia = original
  })
})

describe('08 P1: mobile bottom bar is viewport-fixed', () => {
  it('renders the bar with position:fixed so document scroll cannot carry it away', async () => {
    await act(async () => { root.render(<Network />) })
    const bar = document.querySelector('[data-testid="mobile-bottom-bar"]') as HTMLElement | null
    // On desktop layout jsdom still mounts both trees; the bar is in the mobile branch.
    expect(bar).toBeTruthy()
    expect(bar!.style.position).toBe('fixed')
    expect(bar!.style.bottom).toBe('0px')
  })
})

describe('08 P2: unread badge contrast-safe tokens (call site)', () => {
  it('unread badge does not use raw --state-danger fill with white text', async () => {
    await act(async () => { root.render(<Network />) })
    const badge = document.querySelector('[data-testid="unread-badge"]') as HTMLElement | null
    expect(badge).toBeTruthy()
    // Must use the AA-safe fill, not the raw fill token.
    expect(badge!.style.background).toMatch(/state-danger-on-light/)
    expect(badge!.style.background).not.toBe('var(--state-danger)')
  })
})

describe('07 P2: failed transfer rows never paint raw errors', () => {
  it('renders mapped user message for a raw crypto/HTTP failure string', async () => {
    networkState.transfers = [{
      ...transfer,
      status: 'failed',
      error: 'Error: HTTP 500 crypto worker crashed\n    at Worker.onmessage',
    }]
    await act(async () => { root.render(<Network />) })
    const tasksTab = Array.from(document.querySelectorAll('button'))
      .find(b => b.getAttribute('aria-label') === '任务' || b.textContent?.includes('任务'))
    await act(async () => { tasksTab?.click() })
    const card = document.querySelector('[data-testid="transfer-card-t-1"]')
    expect(card).toBeTruthy()
    const text = card!.textContent || ''
    expect(text).toMatch(/失败|安全连接|网络|重试/)
    expect(text).not.toMatch(/HTTP 500|crypto worker|onmessage/)
  })
})

describe('08-20: transfer cards animate enter/exit', () => {
  it('renders live cards with activity-enter and plans exiting rows on removal', async () => {
    const { planTransferDisplay } = await import('../../src/pages/Network')
    networkState.transfers = [{ ...transfer }]
    await act(async () => { root.render(<Network />) })
    const tasksTab = Array.from(document.querySelectorAll('button'))
      .find(b => b.getAttribute('aria-label') === '任务' || b.textContent?.includes('任务'))
    await act(async () => { tasksTab?.click() })
    const card = document.querySelector('[data-testid="transfer-card-t-1"]') as HTMLElement | null
    expect(card).toBeTruthy()
    expect(card!.className).toMatch(/activity-enter/)

    const planned = planTransferDisplay([{ ...transfer }], [], false)
    expect(planned.removedIds).toEqual(['t-1'])
    expect(planned.next.some(t => t.id === 't-1' && t.exiting)).toBe(true)
    expect(planned.next.find(t => t.id === 't-1')!.exiting).toBe(true)
  })
})

/**
 * DEFERRED TO E2E (jsdom cannot assert true layout geometry):
 * - 08 P1 nav offset with nonzero safe-area-inset-top (pixel geometry)
 * - 08 P1 chat input overflow at 320×568 / 768×1024 (scrollWidth vs clientWidth)
 * - 08 P2 dialog safe-area inset geometry under a notched viewport
 * - 08 P2 completed-row wrap at tablet width (computed flex wrap)
 * - 08 P2 download release 44×44 CSS-px measured box
 */
