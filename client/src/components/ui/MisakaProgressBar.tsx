interface Props {
  value: number  // 0-1
  className?: string
}

export default function MisakaProgressBar({ value, className = '' }: Props) {
  const pct = Math.max(0, Math.min(1, value)) * 100
  return (
    <div
      className={`relative overflow-hidden rounded-full ${className}`}
      style={{ height: 6, background: 'var(--surface-tint)' }}
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      {/* P1: was `transition-all duration-300` which makes the fill chase
          high-frequency `onProgress` updates ~3× slower than they arrive on
          large files — the bar looks like it lags 30% behind the percentage
          counter. Transition only `width` at 150ms so the fill keeps up while
          still feeling animated rather than jumpy. */}
      <div
        className="h-full rounded-full"
        style={{
          width: `${pct}%`,
          background: 'linear-gradient(90deg, var(--bg-deep), var(--accent-cyan))',
          transition: 'width 150ms linear',
        }}
      />
      {pct > 0 && pct < 100 && (
        <div
          className="absolute top-0 h-full w-8 pointer-events-none"
          style={{
            left: `calc(${pct}% - 1px)`,
            background: 'linear-gradient(90deg, transparent, var(--accent-cyan))',
            opacity: 0.8,
          }}
        />
      )}
    </div>
  )
}
