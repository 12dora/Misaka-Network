import { useState } from 'react'

const EXIT_MS = 180

export function useModalExit(onClose: () => void) {
  const [closing, setClosing] = useState(false)

  function requestClose() {
    if (closing) return
    setClosing(true)
    window.setTimeout(onClose, EXIT_MS)
  }

  return {
    closing,
    requestClose,
    backdropClass: closing ? 'modal-backdrop-out' : 'modal-backdrop-in',
    panelClass: closing ? 'modal-panel-out' : 'modal-panel-in',
  }
}
