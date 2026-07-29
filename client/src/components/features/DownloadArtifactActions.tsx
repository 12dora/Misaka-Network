import { useState } from 'react'
import MisakaButton from '@/components/ui/MisakaButton'
import { markDownloadArtifactStarted, releaseDownloadArtifact } from '@/store/network'

interface Props {
  id: string
  url: string
  fileName: string
}

/**
 * Blob URL downloads expose no completion event. OPFS-backed File objects
 * are lazy, so a large download may still be reading long after the click.
 * Keep the backing entry until the user confirms that browser saving ended.
 */
export default function DownloadArtifactActions({ id, url, fileName }: Props) {
  const [started, setStarted] = useState(false)
  const [released, setReleased] = useState(false)
  const [releasing, setReleasing] = useState(false)

  function download() {
    markDownloadArtifactStarted(url)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = fileName || 'download'
    anchor.click()
    setStarted(true)
  }

  async function confirmSaved() {
    if (releasing || released) return
    setReleasing(true)
    await releaseDownloadArtifact(url)
    setReleased(true)
    setReleasing(false)
  }

  if (released) {
    return <span className="text-[10px] font-mono shrink-0" style={{ color: 'var(--state-success-on-light)' }}>✓ 临时副本已释放</span>
  }

  if (started) {
    return (
      <div className="flex flex-col items-end gap-1 shrink-0">
        <span className="text-[10px] font-mono" style={{ color: 'var(--state-success-on-light)' }}>✓ 已开始下载</span>
        {/* 08 P2: was a 10px zero-padding text button — far below the project's
            44px tap standard. Mis-tapping deletes the retained temporary copy. */}
        <MisakaButton
          variant="pill"
          size="sm"
          data-testid={`release-download-${id}`}
          disabled={releasing}
          onClick={() => { void confirmSaved() }}
          className="text-xs min-h-11 px-2 tap-target"
          title="确认浏览器已完成保存后，删除本站保留的临时副本"
        >
          {releasing ? '释放中…' : '确认已保存并释放临时副本'}
        </MisakaButton>
      </div>
    )
  }

  return (
    <MisakaButton
      variant="primary"
      size="sm"
      className="text-xs py-0.5 px-2 shrink-0"
      onClick={download}
    >
      ↓ 下载
    </MisakaButton>
  )
}
