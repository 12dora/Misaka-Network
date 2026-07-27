import { useEffect, useState } from 'react'

// UX-MOTION-001 — a single place that answers "may I animate / scroll
// smoothly right now?".
//
// The CSS media query alone was not enough: the app also does *scripted*
// motion (`scrollIntoView({behavior:'smooth'})`, `scrollTo({behavior:
// 'smooth'})`) and *timed* motion (the modal exit hook waits 180 ms for an
// animation that reduced-motion users never see). Both bypass CSS entirely.

const QUERY = '(prefers-reduced-motion: reduce)'

/**
 * Synchronous read — safe to call outside React (event handlers, module
 * scope, the modal exit timer). Returns false when matchMedia is missing
 * (jsdom without a stub, very old browsers) so behaviour is unchanged.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try {
    return window.matchMedia(QUERY).matches
  } catch {
    return false
  }
}

/**
 * `behavior` value for any scripted scroll. Always route scripted scrolling
 * through this — a hard-coded `'smooth'` moves the viewport under users who
 * asked the OS not to.
 */
export function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? 'auto' : 'smooth'
}

/** `element.scrollIntoView` that honours the reduced-motion preference. */
export function scrollIntoViewSafely(
  el: Element | null | undefined,
  options: Omit<ScrollIntoViewOptions, 'behavior'> = {},
) {
  if (!el) return
  el.scrollIntoView({ ...options, behavior: scrollBehavior() })
}

/** `window.scrollTo` that honours the reduced-motion preference. */
export function scrollWindowTo(top: number, left = 0) {
  if (typeof window === 'undefined') return
  try {
    window.scrollTo({ top, left, behavior: scrollBehavior() })
  } catch {
    window.scrollTo(left, top)
  }
}

/**
 * Reactive variant for render-time decisions (e.g. whether to mount a
 * marquee at all). Re-renders when the user flips the OS setting.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion)

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    let mql: MediaQueryList
    try {
      mql = window.matchMedia(QUERY)
    } catch {
      return
    }
    const onChange = () => setReduced(mql.matches)
    onChange()
    // Safari < 14 only has the deprecated addListener signature.
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange)
      return () => mql.removeEventListener('change', onChange)
    }
    mql.addListener?.(onChange)
    return () => mql.removeListener?.(onChange)
  }, [])

  return reduced
}

/**
 * True when the primary pointer is coarse (touch). Used to default moving
 * content to a stopped state — a touch user cannot hover to pause it.
 */
export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    try { return window.matchMedia('(pointer: coarse)').matches } catch { return false }
  })

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    let mql: MediaQueryList
    try { mql = window.matchMedia('(pointer: coarse)') } catch { return }
    const onChange = () => setCoarse(mql.matches)
    onChange()
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange)
      return () => mql.removeEventListener('change', onChange)
    }
    mql.addListener?.(onChange)
    return () => mql.removeListener?.(onChange)
  }, [])

  return coarse
}
