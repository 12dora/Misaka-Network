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
  // Optional callback run after the exit animation (or immediately under
  // reduced motion). Callers that navigate on close must use `requestCloseThen`
  // instead of hardcoding EXIT_MS — otherwise reduced-motion still waits 180 ms.
  const afterCloseRef = useRef<(() => void) | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  const finish = useCallback(() => {
    onCloseRef.current()
    const after = afterCloseRef.current
    afterCloseRef.current = null
    after?.()
  }, [])

  const beginClose = useCallback((afterClose?: () => void) => {
    if (closedRef.current) return
    closedRef.current = true
    afterCloseRef.current = afterClose ?? null
    setClosing(true)
    const delay = exitDelay()
    if (delay === 0) {
      finish()
      return
    }
    timerRef.current = window.setTimeout(finish, delay)
  }, [finish])

  /**
   * Begin the close animation. Safe to pass as an `onClick` handler — it
   * ignores event arguments so a MouseEvent is never treated as afterClose.
   */
  const requestClose = useCallback(() => {
    beginClose()
  }, [beginClose])

  /**
   * Begin the close animation and run `afterClose` only after the exit
   * completes (or immediately when reduced-motion is on).
   */
  const requestCloseThen = useCallback((afterClose: () => void) => {
    beginClose(afterClose)
  }, [beginClose])

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
  }, [])

  return {
    closing,
    requestClose,
    requestCloseThen,
    /** @deprecated alias — prefer requestCloseThen */
    onExited: requestCloseThen,
    backdropClass: closing ? 'modal-backdrop-out' : 'modal-backdrop-in',
    panelClass: closing ? 'modal-panel-out' : 'modal-panel-in',
  }
}

export { EXIT_MS }
