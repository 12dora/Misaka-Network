import type { NodeStatus } from '@/types'

interface Props {
  status: NodeStatus
  className?: string
}

const config: Record<NodeStatus, { color: string; label: string }> = {
  online:        { color: 'var(--state-success)', label: '脑波同步中' },
  transferring:  { color: 'var(--accent-cyan)',   label: '数据流注入中' },
  connecting:    { color: 'var(--state-warn)',    label: '信道协商中' },
  unauthorized:  { color: 'var(--state-danger)',  label: '通行码错误' },
  offline:       { color: 'var(--text-muted)',    label: '通信终止' },
}

export default function MisakaStatusBadge({ status, className = '' }: Props) {
  const { color, label } = config[status]
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
      <span style={{ color }}>{label}</span>
    </span>
  )
}
