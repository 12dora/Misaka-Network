export interface IncomingFileNotice {
  peerNodeId?: number
  fileName: string
  fileSize: number
  /** Unique per transfer so same-name files from different peers don't collapse. */
  transferId?: string
}

function formatBytes(size: number): string {
  if (size >= 1e9) return `${(size / 1e9).toFixed(1)} GB`
  if (size >= 1e6) return `${(size / 1e6).toFixed(1)} MB`
  return `${(size / 1e3).toFixed(0)} KB`
}

export async function ensureNotificationPermission(): Promise<NotificationPermission> {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'denied'
  if (Notification.permission === 'granted') return 'granted'
  if (Notification.permission === 'denied') return 'denied'
  try {
    return await Notification.requestPermission()
  } catch {
    return 'denied'
  }
}

export function notifyIncomingFile({ peerNodeId, fileName, fileSize, transferId }: IncomingFileNotice) {
  if (typeof window === 'undefined' || !('Notification' in window)) return
  if (document.visibilityState === 'visible') return
  if (Notification.permission !== 'granted') return

  const title = peerNodeId ? `御坂 ${peerNodeId} 号发送了文件` : '收到新文件'
  const body = `${fileName} · ${formatBytes(fileSize)}`
  // Tag must be unique per transfer. Same fileName from two peers used to
  // collapse into one notification and the user missed an inbound transfer.
  const tag = transferId
    ? `misaka-file-${transferId}`
    : `misaka-file-${peerNodeId ?? 'unknown'}-${fileName}`
  try {
    new Notification(title, { body, tag })
  } catch {
    // ignore notification failures
  }
}
