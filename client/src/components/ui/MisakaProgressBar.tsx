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
      <div
        className="h-full rounded-full transition-all duration-300"
        style={{
          width: `${pct}%`,
          background: 'linear-gradient(90deg, var(--bg-deep), var(--accent-cyan))',
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
