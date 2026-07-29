// 08 P1 — "暂停动态" must keep the ACTIVITY subscription alive and must not
// promise more history than the real home store retains.
//
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { StrictMode } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import type { ActivityEvent } from '../../src/types'
import { ACTIVITY_HISTORY_CAP, useHomeStore } from '../../src/store/home'
import { flushDisclosure } from '../../src/components/features/ActivityStream'

const handlers: Array<(msg: { t: string; event: ActivityEvent }) => void> = []

vi.mock('@/lib/signaling', () => ({
  onMessage: (fn: (msg: { t: string; event: ActivityEvent }) => void) => {
    handlers.push(fn)
    return () => {
      const i = handlers.indexOf(fn)
      if (i >= 0) handlers.splice(i, 1)
    }
  },
}))

vi.mock('@/store/auth', () => ({
  useAuthStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ session: { token: 't' } }),
}))

vi.mock('@/hooks/useReducedMotion', () => ({
  useReducedMotion: () => false,
  useCoarsePointer: () => false,
  scrollBehavior: () => 'auto' as const,
}))

import ActivityStream from '../../src/components/features/ActivityStream'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  handlers.length = 0
  useHomeStore.setState({
    activities: [
      { id: 'seed', type: 'join', timestamp: Date.now(), message: '御坂 1 号已接入网络' },
    ],
  })
  document.body.innerHTML = ''
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function emit(n: number, prefix = 'live') {
  for (let i = 0; i < n; i++) {
    const event: ActivityEvent = {
      id: `${prefix}-${i}`,
      type: 'transfer',
      timestamp: Date.now() + i,
      message: `事件 ${i}`,
    }
    for (const h of [...handlers]) h({ t: 'ACTIVITY', event })
  }
}

function pauseButton() {
  return Array.from(container.querySelectorAll('button'))
    .find(b => b.textContent?.includes('暂停动态'))
}

function flushButton() {
  return container.querySelector('[data-testid="activity-flush-buffer"]') as HTMLButtonElement | null
}

describe('08 P1: ActivityStream pause keeps subscription', () => {
  it('REGRESSION — events that arrive while paused are buffered, not dropped', async () => {
    await act(async () => { root.render(<ActivityStream />) })
    expect(handlers.length).toBe(1)

    await act(async () => { pauseButton()!.click() })
    expect(handlers.length).toBe(1)

    const event: ActivityEvent = {
      id: 'live-1',
      type: 'transfer',
      timestamp: Date.now(),
      message: '文件传输开始',
    }
    await act(async () => {
      for (const h of [...handlers]) h({ t: 'ACTIVITY', event })
    })

    // Real store must NOT have been written while paused.
    expect(useHomeStore.getState().activities.some(a => a.id === 'live-1')).toBe(false)
    expect(container.textContent).toMatch(/有 \d+ 条新动态/)

    await act(async () => { flushButton()!.click() })
    expect(useHomeStore.getState().activities.some(a => a.id === 'live-1')).toBe(true)
  })

  it('REGRESSION — flush of 41 events discloses store retention; real store keeps 20', async () => {
    await act(async () => { root.render(<ActivityStream />) })
    await act(async () => { pauseButton()!.click() })

    await act(async () => { emit(41) })

    const btn = flushButton()
    expect(btn).toBeTruthy()
    // Promise must match store cap, not the raw buffer length.
    expect(btn!.getAttribute('data-retained')).toBe(String(ACTIVITY_HISTORY_CAP))
    expect(btn!.getAttribute('data-omitted')).toBe(String(41 - ACTIVITY_HISTORY_CAP))
    expect(btn!.textContent).toMatch(/有 20 条新动态/)
    expect(btn!.textContent).toMatch(/另有 21 条较早动态已省略/)

    await act(async () => { btn!.click() })

    const store = useHomeStore.getState().activities
    // Seed + 20 flushed newest, but cap is 20 total — only newest 20 remain.
    expect(store.length).toBe(ACTIVITY_HISTORY_CAP)
    // Newest of the 41 is live-40 (emit order i=0..40, prepended so 40 is newest).
    expect(store[0].id).toBe('live-40')
    // Oldest retained among the flush is live-21 (20 newest: 21..40).
    expect(store.some(a => a.id === 'live-0')).toBe(false)
    expect(store.some(a => a.id === 'live-20')).toBe(false)
    expect(store.some(a => a.id === 'live-21')).toBe(true)
  })

  it('soft-cap 205 under StrictMode: 200 retained / 5 dropped (no double count)', async () => {
    await act(async () => {
      root.render(
        <StrictMode>
          <ActivityStream />
        </StrictMode>,
      )
    })
    await act(async () => { pauseButton()!.click() })

    await act(async () => { emit(205) })

    const btn = flushButton()
    expect(btn).toBeTruthy()
    // Soft-cap 200 in buffer; store still only keeps 20 on flush.
    // Dropped while paused = 5; omitted from history on flush = 200-20 + 5 = 185.
    expect(btn!.getAttribute('data-retained')).toBe(String(ACTIVITY_HISTORY_CAP))
    expect(Number(btn!.getAttribute('data-omitted'))).toBe(200 - ACTIVITY_HISTORY_CAP + 5)
    expect(btn!.textContent).toMatch(/省略/)
    // Critical: StrictMode must not double the dropped counter (would be 10).
    expect(btn!.textContent).not.toMatch(/另有 190 条/)
    expect(btn!.textContent).toMatch(/另有 185 条较早动态已省略/)
  })
})

describe('flushDisclosure pure helper', () => {
  it('matches store retention math', () => {
    expect(flushDisclosure({ events: new Array(15).fill(null).map((_, i) => ({
      id: String(i), type: 'join' as const, timestamp: i, message: 'm',
    })), dropped: 0 })).toEqual({
      retained: 15,
      omitted: 0,
      label: '有 15 条新动态',
    })

    expect(flushDisclosure({ events: new Array(41).fill(null).map((_, i) => ({
      id: String(i), type: 'join' as const, timestamp: i, message: 'm',
    })), dropped: 0 }).omitted).toBe(21)

    expect(flushDisclosure({
      events: new Array(200).fill(null).map((_, i) => ({
        id: String(i), type: 'join' as const, timestamp: i, message: 'm',
      })),
      dropped: 5,
    }).omitted).toBe(185)
  })
})
