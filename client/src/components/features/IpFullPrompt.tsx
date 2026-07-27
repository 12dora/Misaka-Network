import { useRef, useState } from 'react'
import MisakaKanjiBlock from '@/components/ui/MisakaKanjiBlock'
import MisakaButton from '@/components/ui/MisakaButton'
import MisakaDialog from '@/components/ui/MisakaDialog'

interface Props {
  // Confirm callback returns the number of released slots; the caller can
  // decide whether to auto-retry connect when released > 0.
  onConfirm: () => Promise<number>
  onCancel: () => void
  busy?: boolean
}

/**
 * Shared IP-quota-exceeded prompt. Previously this UI was inlined in
 * LoginCard, which meant the Join flow had no way to surface the same
 * "本机 IP 已满" recovery hint. Extracted so both entry points show the
 * same modal and route through the same release-and-retry logic.
 *
 * A11Y-001 / UX-LAYOUT-001: now goes through the shared dialog primitive, so
 * it portals to <body> (it used to render inside the transform-animated
 * route wrapper, which made `position: fixed` resolve against the route div
 * rather than the viewport) and gains focus containment, an inert
 * background, scroll lock and focus restoration.
 *
 * The unauthenticated recovery proof is intentionally identity-scoped:
 * nodeId + passcode can release only matching sessions on this IP. The
 * actual server count is displayed below, including zero.
 */
export default function IpFullPrompt({ onConfirm, onCancel, busy = false }: Props) {
  const confirmRef = useRef<HTMLButtonElement>(null)
  const [confirming, setConfirming] = useState(false)
  const [releaseResult, setReleaseResult] = useState<number | null>(null)
  const isBusy = busy || confirming

  async function confirmScopedRelease() {
    if (isBusy) return
    setConfirming(true)
    setReleaseResult(null)
    try {
      setReleaseResult(await onConfirm())
    } finally {
      setConfirming(false)
    }
  }

  return (
    <MisakaDialog
      title="本机节点已满"
      description="当前 IP 已达到节点上限"
      onRequestClose={onCancel}
      initialFocusRef={confirmRef}
      // Sits above the other modals — LoginCard can raise it while ScanModal
      // is open.
      backdropStyle={{ background: 'rgba(14,42,107,0.75)', backdropFilter: 'blur(8px)', zIndex: 110 }}
      panelClassName="misaka-card w-full max-w-[380px] p-6"
      renderHeader={({ titleId, descriptionId }) => (
        <>
          <div className="flex items-center gap-2 mb-1">
            <MisakaKanjiBlock char="満" size="md" />
            <h2 id={titleId} className="font-kanji font-bold text-lg text-[var(--text-on-white)] m-0">
              本机节点已满
            </h2>
          </div>
          <p id={descriptionId} className="font-kanji text-xs text-[var(--text-on-white-2)] mb-3">
            当前 IP 已达到节点上限
          </p>
        </>
      )}
    >
      <p className="font-kanji text-sm text-[var(--text-on-white)] mb-5">
        本机 IP 同时最多允许 10 个节点。可验证当前节点编号与通行码，并仅释放此 IP 上同一身份的会话；
        其他身份的节点不会被删除。
      </p>
      {releaseResult !== null && (
        <p
          role="status"
          className="font-kanji text-xs mb-3"
          style={{ color: releaseResult > 0 ? 'var(--state-success-on-light)' : 'var(--state-warn-on-light)' }}
        >
          {releaseResult > 0
            ? `已释放同一身份的 ${releaseResult} 个节点，正在重试接入。`
            : '未释放任何节点，因此没有自动重试。请确认节点编号和通行码，或稍后再试。'}
        </p>
      )}
      <div className="flex gap-2">
        <MisakaButton
          ref={confirmRef}
          variant="primary"
          fullWidth
          disabled={isBusy}
          onClick={() => { void confirmScopedRelease() }}
        >
          {isBusy ? '释放中…' : '释放同一身份并重试'}
        </MisakaButton>
        <MisakaButton variant="pill" fullWidth disabled={isBusy} onClick={onCancel}>
          取消
        </MisakaButton>
      </div>
    </MisakaDialog>
  )
}
