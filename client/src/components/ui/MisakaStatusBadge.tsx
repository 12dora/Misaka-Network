import type { NodeStatus } from '@/types'

interface Props {
  status: NodeStatus
  className?: string
  /** Which background the badge sits on — picks the AA-verified text colour. */
  surface?: 'light' | 'blue'
}

// A11Y-002: `color` is the dot FILL; `textColor` is the AA-verified
// foreground for the same state rendered as 12 px text. The badge is used on
// both light cards and the blue page background, so each state carries both
// variants and the caller picks via `surface`.
// Functional-page vocabulary (07 P2): 连接 / 正在连接 / 正在恢复连接 / 已断开 /
// 正在传输. ACGN lore terms (脑波 / 数据流 / 通信终止) stay on the activity
// stream and ACGN page only.
const config: Record<NodeStatus, { color: string; onLight: string; onBlue: string; label: string }> = {
  online:        { color: 'var(--state-success)', onLight: 'var(--state-success-on-light)', onBlue: 'var(--state-success-on-blue)', label: '连接' },
  transferring:  { color: 'var(--accent-cyan)',   onLight: 'var(--text-on-white)',          onBlue: 'var(--accent-cyan-on-blue)',   label: '正在传输' },
  connecting:    { color: 'var(--state-warn)',    onLight: 'var(--state-warn-on-light)',    onBlue: 'var(--state-warn-on-blue)',    label: '正在连接' },
  reconnecting:  { color: 'var(--state-warn)',    onLight: 'var(--state-warn-on-light)',    onBlue: 'var(--state-warn-on-blue)',    label: '正在恢复连接' },
  unauthorized:  { color: 'var(--state-danger)',  onLight: 'var(--state-danger-on-light)',  onBlue: 'var(--state-danger-on-blue)',  label: '通行码错误' },
  offline:       { color: 'var(--text-muted)',    onLight: 'var(--text-muted-on-light)',    onBlue: 'var(--text-on-blue-2)',        label: '已断开' },
}

export default function MisakaStatusBadge({ status, className = '', surface = 'light' }: Props) {
  const cfg = config[status]
  const color = cfg.color
  const textColor = surface === 'blue' ? cfg.onBlue : cfg.onLight
  const label = cfg.label
  const isTransferring = status === 'transferring'
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-mono ${className}`}>
      <span
        className={isTransferring ? 'pulse-dot' : ''}
        style={{
          display: 'inline-block',
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: color,
          flexShrink: 0,
        }}
      />
      <span style={{ color: textColor }}>{label}</span>
    </span>
  )
}
