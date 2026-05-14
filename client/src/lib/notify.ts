export interface IncomingFileNotice {
  peerNodeId?: number
  fileName: string
  fileSize: number
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

export function notifyIncomingFile({ peerNodeId, fileName, fileSize }: IncomingFileNotice) {
  if (typeof window === 'undefined' || !('Notification' in window)) return
  if (document.visibilityState === 'visible') return
  if (Notification.permission !== 'granted') return

  const title = peerNodeId ? `御坂 ${peerNodeId} 号发送了文件` : '收到新文件'
  const body = `${fileName} · ${formatBytes(fileSize)}`
  try {
    new Notification(title, { body, tag: `misaka-file-${fileName}` })
  } catch {
    // ignore notification failures
  }
}
