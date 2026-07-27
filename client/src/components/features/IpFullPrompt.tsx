import { useRef } from 'react'
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
 * NOTE: the recovery *wording* here is UX-COPY-002 and is owned by the
 * cross-stack fix that also changes the release semantics. Do not adjust the
 * copy in isolation — the current text overstates the deletion scope, and
 * correcting it requires the server-side released-count change too.
 */
export default function IpFullPrompt({ onConfirm, onCancel, busy = false }: Props) {
  const confirmRef = useRef<HTMLButtonElement>(null)

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
        本机 IP 同时最多允许 10 个节点。是否销毁本机所有已注册节点后重新接入？
      </p>
      <div className="flex gap-2">
        <MisakaButton
          ref={confirmRef}
          variant="primary"
          fullWidth
          disabled={busy}
          onClick={() => { void onConfirm() }}
        >
          {busy ? '释放中…' : '全部销毁并重试'}
        </MisakaButton>
        <MisakaButton variant="pill" fullWidth disabled={busy} onClick={onCancel}>
          取消
        </MisakaButton>
      </div>
    </MisakaDialog>
  )
}
