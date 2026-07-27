import { useCallback, useEffect, useRef, useState } from 'react'
import { prefersReducedMotion } from '@/hooks/useReducedMotion'

const EXIT_MS = 180

// UX-MOTION-001: the exit delay exists purely to let the `modal-panel-out`
// animation play. Under `prefers-reduced-motion: reduce` the CSS clamps that
// animation to 0.01 ms, so the 180 ms wait became dead time where the dialog
// was visually gone but still mounted, still trapping focus, and still
// swallowing Escape. Finish immediately instead.
function exitDelay(): number {
  return prefersReducedMotion() ? 0 : EXIT_MS
}

export function useModalExit(onClose: () => void) {
  const [closing, setClosing] = useState(false)
  // Guard against a double-close (Escape while the backdrop click is already
  // in flight) firing `onClose` twice, and against the timer surviving
  // unmount.
  const closedRef = useRef(false)
  const timerRef = useRef<number | null>(null)

  const requestClose = useCallback(() => {
    if (closedRef.current) return
    closedRef.current = true
    setClosing(true)
    const delay = exitDelay()
    if (delay === 0) {
      onClose()
      return
    }
    timerRef.current = window.setTimeout(onClose, delay)
  }, [onClose])

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
  }, [])

  // Global Escape-to-close. Each mounted modal owns its own listener; React
  // tears it down when the modal unmounts, so stacking dialogs still works.
  // We guard against double-fire via `closedRef` inside requestClose.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      if (closedRef.current) return
      e.stopPropagation()
      requestClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [requestClose])

  return {
    closing,
    requestClose,
    backdropClass: closing ? 'modal-backdrop-out' : 'modal-backdrop-in',
    panelClass: closing ? 'modal-panel-out' : 'modal-panel-in',
  }
}
