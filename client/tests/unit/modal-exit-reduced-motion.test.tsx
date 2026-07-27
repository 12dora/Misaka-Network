// UX-MOTION-001 — `useModalExit` waited a fixed 180 ms for an exit
// animation that reduced-motion users never see.
//
// The CSS clamps `modal-panel-out` to 0.01 ms under
// `prefers-reduced-motion: reduce`, so those 180 ms were dead time in which
// the dialog was visually gone but still mounted — still trapping focus,
// still holding the scroll lock, still swallowing Escape.
//
// The hook also had no unmount guard, so its timer could fire `onClose` on
// an unmounted component, and no re-entrancy guard beyond a `closing` state
// that the Escape listener read from a stale closure.
//
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { useModalExit } from '../../src/hooks/useModalExit'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const realMatchMedia = window.matchMedia

function setReducedMotion(reduce: boolean) {
  window.matchMedia = vi.fn((q: string) => ({
    matches: q.includes('prefers-reduced-motion') ? reduce : false,
    media: q,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia
}

let container: HTMLDivElement
let root: Root
let api: ReturnType<typeof useModalExit>

function Probe({ onClose }: { onClose: () => void }) {
  api = useModalExit(onClose)
  return <div className={api.panelClass} />
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  window.matchMedia = realMatchMedia
  vi.useRealTimers()
})

describe('UX-MOTION-001: modal exit timing', () => {
  it('happy path — motion allowed keeps the 180 ms exit animation window', () => {
    vi.useFakeTimers()
    setReducedMotion(false)
    const onClose = vi.fn()
    act(() => { root.render(<Probe onClose={onClose} />) })

    act(() => { api.requestClose() })
    expect(onClose).not.toHaveBeenCalled()
    expect(api.panelClass).toBe('modal-panel-out')

    act(() => { vi.advanceTimersByTime(180) })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('REGRESSION — reduced motion closes synchronously, no dead 180 ms', () => {
    vi.useFakeTimers()
    setReducedMotion(true)
    const onClose = vi.fn()
    act(() => { root.render(<Probe onClose={onClose} />) })

    act(() => { api.requestClose() })

    // No timer advance: the dialog is already gone, so focus trap, scroll
    // lock and Escape handling are released immediately.
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Escape closes the dialog', () => {
    setReducedMotion(true)
    const onClose = vi.fn()
    act(() => { root.render(<Probe onClose={onClose} />) })

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('EDGE — a second close request never double-fires onClose', () => {
    setReducedMotion(true)
    const onClose = vi.fn()
    act(() => { root.render(<Probe onClose={onClose} />) })

    act(() => {
      api.requestClose()
      api.requestClose()
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('EDGE — unmounting mid-animation cancels the pending onClose', () => {
    vi.useFakeTimers()
    setReducedMotion(false)
    const onClose = vi.fn()
    act(() => { root.render(<Probe onClose={onClose} />) })

    act(() => { api.requestClose() })
    act(() => { root.render(null) })
    act(() => { vi.advanceTimersByTime(500) })

    expect(onClose).not.toHaveBeenCalled()
  })
})
