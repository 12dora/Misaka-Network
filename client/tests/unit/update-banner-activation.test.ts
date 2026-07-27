// BUG-029 component contract: a waiting worker must control the page before
// reload. The previous three-second timer reloaded unconditionally.
//
// @vitest-environment jsdom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import UpdateBanner, { waitForWorkerActivation } from '../../src/components/features/UpdateBanner'
import { __resetActiveWork, registerActiveWorkProbe } from '../../src/hooks/activeWork'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let serviceWorker: EventTarget & {
  getRegistration: ReturnType<typeof vi.fn>
}
let waitingPost: ReturnType<typeof vi.fn>

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  waitingPost = vi.fn()
  serviceWorker = Object.assign(new EventTarget(), {
    getRegistration: vi.fn(async () => ({ waiting: { postMessage: waitingPost } })),
  })
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: serviceWorker,
  })
  __resetActiveWork()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  __resetActiveWork()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('UpdateBanner worker activation gate', () => {
  it('happy path resolves true only after controllerchange', async () => {
    const target = new EventTarget()
    const pending = waitForWorkerActivation(target as ServiceWorkerContainer, 3_000)
    target.dispatchEvent(new Event('controllerchange'))
    await expect(pending).resolves.toBe(true)
  })

  it('edge path times out false instead of authorizing an unconditional reload', async () => {
    vi.useFakeTimers()
    const target = new EventTarget()
    const pending = waitForWorkerActivation(target as ServiceWorkerContainer, 3_000)
    await vi.advanceTimersByTimeAsync(3_001)
    await expect(pending).resolves.toBe(false)
  })
})

describe('UpdateBanner component integration', () => {
  async function showBanner(onReload: () => void) {
    await act(async () => {
      root.render(React.createElement(
        UpdateBanner as React.ComponentType<{ onReload: () => void }>,
        { onReload },
      ))
    })
    await act(async () => {
      serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'sw-updated' } }))
    })
    return Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent?.includes('安全时刷新')) as HTMLButtonElement
  }

  it('blocks activation and reload while active work exists', async () => {
    const off = registerActiveWorkProbe(() => true)
    const onReload = vi.fn()
    const button = await showBanner(onReload)

    expect(button.disabled).toBe(true)
    await act(async () => { button.click(); await Promise.resolve() })
    expect(waitingPost).not.toHaveBeenCalled()
    expect(onReload).not.toHaveBeenCalled()
    off()
  })

  it('activates the waiting worker and reloads only after controllerchange', async () => {
    const onReload = vi.fn()
    const button = await showBanner(onReload)

    await act(async () => { button.click(); await Promise.resolve() })
    expect(waitingPost).toHaveBeenCalledWith({ type: 'skip-waiting' })
    expect(onReload).not.toHaveBeenCalled()

    await act(async () => {
      serviceWorker.dispatchEvent(new Event('controllerchange'))
      await Promise.resolve()
    })
    expect(onReload).toHaveBeenCalledTimes(1)
  })
})
