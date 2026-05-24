import MisakaCard from '@/components/ui/MisakaCard'
import MisakaKanjiBlock from '@/components/ui/MisakaKanjiBlock'
import MisakaButton from '@/components/ui/MisakaButton'

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
 */
export default function IpFullPrompt({ onConfirm, onCancel, busy = false }: Props) {
  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center p-4"
      style={{ background: 'rgba(14,42,107,0.75)', backdropFilter: 'blur(8px)' }}
      role="dialog"
      aria-modal="true"
      aria-label="本机节点已满"
    >
      <MisakaCard padding="lg" className="w-full max-w-[380px]">
        <div className="flex items-center gap-2 mb-1">
          <MisakaKanjiBlock char="満" size="md" />
          <span className="font-kanji font-bold text-lg text-[var(--text-on-white)]">本机节点已满</span>
        </div>
        <p className="font-kanji text-xs text-[var(--text-on-white-2)] mb-3">当前 IP 已达到节点上限</p>
        <p className="font-kanji text-sm text-[var(--text-on-white)] mb-5">
          本机 IP 同时最多允许 10 个节点。是否销毁本机所有已注册节点后重新接入？
        </p>
        <div className="flex gap-2">
          <MisakaButton variant="primary" fullWidth disabled={busy} onClick={() => { void onConfirm() }}>
            {busy ? '释放中…' : '全部销毁并重试'}
          </MisakaButton>
          <MisakaButton variant="pill" fullWidth disabled={busy} onClick={onCancel}>
            取消
          </MisakaButton>
        </div>
      </MisakaCard>
    </div>
  )
}
