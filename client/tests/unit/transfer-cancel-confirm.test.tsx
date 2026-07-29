// 08 P0 — active transfer cancel must require confirmation.
//
// Before: "✕ 取消" sat next to "⏸ 暂停" at the same weight and called
// onCancel immediately. A mis-tap on a 90%-received multi-GB file threw
// the partial away with no undo.
//
// After: cancel opens a MisakaDialog with file name, direction, percent
// and "已接收部分将被删除"; default focus is "继续传输"; confirm still
// calls the existing onCancel (dispatchCancel) without changing protocol.
//
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import type { Transfer } from '../../src/types'

const { cancelTransferAction, cancelReceiveTransfer } = vi.hoisted(() => ({
  cancelTransferAction: vi.fn(),
  cancelReceiveTransfer: vi.fn(),
}))

const transfer: Transfer = {
  id: 't-big',
  direction: 'recv',
  peerSessionId: 'peer-sess-1',
  peerNodeId: 10032,
  fileName: 'huge-archive.zip',
  fileSize: 20 * 1024 ** 3,
  progress: 0.9,
  speedBps: 1_000_000,
  status: 'transferring',
  startedAt: Date.now() - 60_000,
}

const networkState = {
  peers: [] as unknown[],
  transfers: [transfer],
  selectedSessionId: null as string | null,
  unreadByPeer: {} as Record<string, { message: number; file: number }>,
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

vi.mock('@/store/auth', () => ({
  useAuthStore: useAuthStoreMock,
}))

vi.mock('@/lib/notify', () => ({ ensureNotificationPermission: async () => {} }))
vi.mock('@/lib/api', () => ({
  authedFetch: vi.fn(),
  AuthRequiredError: class AuthRequiredError extends Error {},
}))
vi.mock('@/components/features/QRModal', () => ({ default: () => null }))
vi.mock('@/components/features/SettingsModal', () => ({ default: () => null }))
vi.mock('@/components/ui/AppFooter', () => ({ default: () => null }))

import Network from '../../src/pages/Network'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  cancelTransferAction.mockClear()
  cancelReceiveTransfer.mockClear()
  // Reset shared fixture — later cases mutate status/startedAt.
  networkState.transfers = [{ ...transfer }]
  document.body.innerHTML = ''
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
})

describe('08 P0: transfer cancel confirmation', () => {
  it('does not call cancel immediately — opens a confirmation dialog first', async () => {
    await act(async () => { root.render(<Network />) })

    const cancelBtn = document.querySelector<HTMLButtonElement>('[data-testid="cancel-transfer-t-big"]')
    expect(cancelBtn).toBeTruthy()
    await act(async () => { cancelBtn!.click() })

    expect(cancelReceiveTransfer).not.toHaveBeenCalled()
    expect(cancelTransferAction).not.toHaveBeenCalled()

    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog).toBeTruthy()
    expect(dialog!.textContent).toMatch(/huge-archive\.zip/)
    expect(dialog!.textContent).toMatch(/90%/)
    expect(dialog!.textContent).toMatch(/已接收部分将被删除/)
    expect(document.querySelector('[data-testid="cancel-partial-warning"]')).toBeTruthy()
  })

  it('happy path — continue dismisses without cancelling', async () => {
    await act(async () => { root.render(<Network />) })
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="cancel-transfer-t-big"]')!.click()
    })
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="cancel-dialog-continue"]')!.click()
    })
    expect(cancelReceiveTransfer).not.toHaveBeenCalled()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('confirm calls the existing cancel path (recv → cancelReceiveTransfer)', async () => {
    await act(async () => { root.render(<Network />) })
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="cancel-transfer-t-big"]')!.click()
    })
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="cancel-dialog-confirm"]')!.click()
    })
    expect(cancelReceiveTransfer).toHaveBeenCalledTimes(1)
    expect(cancelReceiveTransfer).toHaveBeenCalledWith('t-big')
  })

  it('REGRESSION — stale confirm after completion does not cancel / destroy artifact', async () => {
    // P0 race: open cancel at 99%, let the transfer finish, then confirm.
    // Must not call cancelReceiveTransfer (which would clean OPFS-backed data).
    await act(async () => { root.render(<Network />) })
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="cancel-transfer-t-big"]')!.click()
    })
    expect(document.querySelector('[role="dialog"]')).toBeTruthy()

    // Drive the transfer to a terminal completed state while the dialog is open.
    networkState.transfers = [{
      ...transfer,
      status: 'completed',
      progress: 1,
      storageMode: 'opfs',
    }]
    await act(async () => { root.render(<Network />) })

    // Dialog should auto-dismiss; even if a confirm node lingered, cancel must not fire.
    const confirm = document.querySelector<HTMLButtonElement>('[data-testid="cancel-dialog-confirm"]')
    if (confirm) {
      await act(async () => { confirm.click() })
    }

    expect(cancelReceiveTransfer).not.toHaveBeenCalled()
    expect(cancelTransferAction).not.toHaveBeenCalled()
    // Completed transfer still present in the store (artifact survives).
    expect(networkState.transfers[0]?.status).toBe('completed')
    expect(networkState.transfers[0]?.id).toBe('t-big')
  })

  it('REGRESSION — confirm revalidates startedAt generation', async () => {
    await act(async () => { root.render(<Network />) })
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="cancel-transfer-t-big"]')!.click()
    })

    // Same id, new attempt (different startedAt) — stale dialog must not cancel.
    networkState.transfers = [{
      ...transfer,
      startedAt: transfer.startedAt + 999_000,
      status: 'transferring',
      progress: 0.1,
    }]
    await act(async () => { root.render(<Network />) })

    const confirm = document.querySelector<HTMLButtonElement>('[data-testid="cancel-dialog-confirm"]')
    if (confirm) {
      await act(async () => { confirm.click() })
    }

    expect(cancelReceiveTransfer).not.toHaveBeenCalled()
    expect(cancelTransferAction).not.toHaveBeenCalled()
  })
})
