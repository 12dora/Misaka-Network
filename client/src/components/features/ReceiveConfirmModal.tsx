import { useEffect } from 'react'
import MisakaKanjiBlock from '@/components/ui/MisakaKanjiBlock'
import MisakaButton from '@/components/ui/MisakaButton'

interface IncomingTransfer {
  sourceNodeId: number
  fileName: string
  fileSize: number
  channelType: string
  fileHash?: string
}

interface Props {
  transfer: IncomingTransfer
  onAccept: () => void
  onReject: () => void
  onBlock: () => void
}

function formatBytes(b: number) {
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`
  return `${(b / 1e3).toFixed(0)} KB`
}

function channelLabel(t: string) {
  return { direct: '直接信道（局域网）', stun: '标准信道（STUN）', relay: '中继信道（TURN）', ws: '备用信道（WS）' }[t] ?? t
}

export default function ReceiveConfirmModal({ transfer, onAccept, onReject, onBlock }: Props) {
  // Lock body scroll
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center p-4"
      style={{ background: 'rgba(14,42,107,0.55)', backdropFilter: 'blur(8px)' }}
    >
      {/* Modal card */}
      <div
        className="relative flex flex-col items-center gap-5 rounded-2xl p-8 card-in"
        style={{
          background: 'var(--surface)',
          boxShadow: 'var(--shadow-float)',
          maxWidth: 360,
          width: '100%',
        }}
      >
        {/* Header */}
        <div className="flex flex-col items-center gap-3">
          <MisakaKanjiBlock char="入" size="lg" />
          <div className="text-center">
            <div className="font-kanji font-bold text-lg text-[var(--text-on-white)]">
              检测到数据包传入
            </div>
            <div className="font-jp text-xs text-[var(--text-on-white-2)] mt-0.5">
              データ着信検知
            </div>
          </div>
        </div>

        {/* Accent line */}
        <div className="w-12 h-0.5" style={{ background: 'var(--accent-cyan)' }} />

        {/* Metadata list */}
        <div
          className="w-full rounded-xl p-4 flex flex-col gap-2"
          style={{ background: 'var(--surface-tint)' }}
        >
          {[
            { key: '来源', val: `御坂 ${transfer.sourceNodeId} 号` },
            { key: '文件名', val: transfer.fileName },
            { key: '大小', val: formatBytes(transfer.fileSize) },
            { key: '信道', val: channelLabel(transfer.channelType) },
            ...(transfer.fileHash ? [{ key: '哈希', val: `${transfer.fileHash.slice(0, 12)}…` }] : []),
          ].map(({ key, val }) => (
            <div key={key} className="flex justify-between items-baseline">
              <span className="font-kanji text-xs text-[var(--text-on-white-2)] tabular">
                {key}
              </span>
              <span className="font-mono text-xs text-[var(--text-on-white)] tabular truncate ml-4">
                {val}
              </span>
            </div>
          ))}
        </div>

        {/* Actions */}
        <div className="flex flex-col gap-2 w-full">
          <MisakaButton variant="primary" size="md" fullWidth onClick={onAccept}>
            接收
          </MisakaButton>
          <div className="flex gap-2">
            <MisakaButton variant="pill" size="sm" fullWidth onClick={onReject}>
              拒绝
            </MisakaButton>
            <MisakaButton
              variant="pill"
              size="sm"
              fullWidth
              onClick={onBlock}
            >
              <span style={{ color: 'var(--state-danger)' }}>屏蔽来源</span>
            </MisakaButton>
          </div>
        </div>
      </div>
    </div>
  )
}
