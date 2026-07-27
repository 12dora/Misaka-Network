// UX-MOTION-001 — reduced motion still kept scripted smooth scrolling.
// BUG-029  — the update reload could interrupt an active transfer.
//
// Both fixes are extractable, non-visual logic: a media-query helper that
// every scripted scroll routes through, and a probe registry the always-
// mounted update banner consults before arming its reload.
//
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  prefersReducedMotion, scrollBehavior, scrollIntoViewSafely, scrollWindowTo,
} from '../../src/hooks/useReducedMotion'
import {
  registerActiveWorkProbe, hasActiveWork, subscribeActiveWork,
  notifyActiveWorkChanged, __resetActiveWork,
} from '../../src/hooks/activeWork'

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

describe('UX-MOTION-001: reduced-motion helper', () => {
  afterEach(() => { window.matchMedia = realMatchMedia })

  it('happy path — motion allowed means smooth scripted scrolling', () => {
    setReducedMotion(false)
    expect(prefersReducedMotion()).toBe(false)
    expect(scrollBehavior()).toBe('smooth')
  })

  it('REGRESSION — reduced motion downgrades scripted scrolling to instant', () => {
    setReducedMotion(true)
    expect(prefersReducedMotion()).toBe(true)
    expect(scrollBehavior()).toBe('auto')
  })

  it('scrollIntoViewSafely passes the derived behavior through', () => {
    setReducedMotion(true)
    const el = { scrollIntoView: vi.fn() } as unknown as Element
    scrollIntoViewSafely(el, { block: 'center' })
    expect(el.scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'auto' })

    setReducedMotion(false)
    scrollIntoViewSafely(el, { block: 'center' })
    expect(el.scrollIntoView).toHaveBeenLastCalledWith({ block: 'center', behavior: 'smooth' })
  })

  it('EDGE — a null element is a no-op rather than a crash', () => {
    setReducedMotion(false)
    expect(() => scrollIntoViewSafely(null)).not.toThrow()
    expect(() => scrollIntoViewSafely(undefined)).not.toThrow()
  })

  it('EDGE — a missing/throwing matchMedia falls back to "motion allowed"', () => {
    // @ts-expect-error deliberately removing the API
    window.matchMedia = undefined
    expect(prefersReducedMotion()).toBe(false)

    window.matchMedia = vi.fn(() => { throw new Error('blocked') }) as unknown as typeof window.matchMedia
    expect(prefersReducedMotion()).toBe(false)
  })

  it('scrollWindowTo falls back to the positional form when the options form throws', () => {
    setReducedMotion(false)
    const spy = vi.spyOn(window, 'scrollTo')
      .mockImplementationOnce(() => { throw new Error('no options form') })
      .mockImplementation(() => {})
    scrollWindowTo(0)
    expect(spy).toHaveBeenLastCalledWith(0, 0)
    spy.mockRestore()
  })
})

describe('BUG-029: active-work registry gates the update reload', () => {
  beforeEach(__resetActiveWork)
  afterEach(__resetActiveWork)

  it('happy path — no registrations means it is safe to reload', () => {
    expect(hasActiveWork()).toBe(false)
  })

  it('REGRESSION — a registered in-flight transfer blocks the reload', () => {
    let transferring = true
    registerActiveWorkProbe(() => transferring)
    expect(hasActiveWork()).toBe(true)

    transferring = false
    expect(hasActiveWork()).toBe(false)
  })

  it('unregistering removes the probe', () => {
    const off = registerActiveWorkProbe(() => true)
    expect(hasActiveWork()).toBe(true)
    off()
    expect(hasActiveWork()).toBe(false)
  })

  it('any busy probe wins over idle ones', () => {
    registerActiveWorkProbe(() => false)
    registerActiveWorkProbe(() => true)
    expect(hasActiveWork()).toBe(true)
  })

  it('EDGE — a throwing probe reports busy rather than silently allowing a reload', () => {
    registerActiveWorkProbe(() => { throw new Error('store torn down') })
    expect(hasActiveWork()).toBe(true)
  })

  it('subscribers are notified on register, unregister and explicit change', () => {
    const seen = vi.fn()
    const off = subscribeActiveWork(seen)

    const offProbe = registerActiveWorkProbe(() => false)
    expect(seen).toHaveBeenCalledTimes(1)

    notifyActiveWorkChanged()
    expect(seen).toHaveBeenCalledTimes(2)

    offProbe()
    expect(seen).toHaveBeenCalledTimes(3)

    off()
    notifyActiveWorkChanged()
    expect(seen).toHaveBeenCalledTimes(3)
  })

  it('EDGE — a throwing subscriber does not block the others', () => {
    const ok = vi.fn()
    subscribeActiveWork(() => { throw new Error('boom') })
    subscribeActiveWork(ok)
    notifyActiveWorkChanged()
    expect(ok).toHaveBeenCalled()
  })
})
