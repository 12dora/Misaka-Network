import { useEffect, useState } from 'react'

const EXIT_MS = 180

export function useModalExit(onClose: () => void) {
  const [closing, setClosing] = useState(false)

  function requestClose() {
    if (closing) return
    setClosing(true)
    window.setTimeout(onClose, EXIT_MS)
  }

  // Global Escape-to-close. Each mounted modal owns its own listener; React
  // tears it down when the modal unmounts, so stacking dialogs still works.
  // We guard against double-fire by checking `closing` inside the handler.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      if (closing) return
      e.stopPropagation()
      setClosing(true)
      window.setTimeout(onClose, EXIT_MS)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closing, onClose])

  return {
    closing,
    requestClose,
    backdropClass: closing ? 'modal-backdrop-out' : 'modal-backdrop-in',
    panelClass: closing ? 'modal-panel-out' : 'modal-panel-in',
  }
}
