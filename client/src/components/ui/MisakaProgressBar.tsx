interface Props {
  value: number  // 0-1
  className?: string
  /** Accessible name so multi-file panels can distinguish bars. */
  label?: string
  /** Optional valuetext override (defaults to "N%"). */
  valueText?: string
}

export default function MisakaProgressBar({ value, className = '', label, valueText }: Props) {
  const pct = Math.max(0, Math.min(1, value)) * 100
  const rounded = Math.round(pct)
  return (
    <div
      className={`relative overflow-hidden rounded-full ${className}`}
      style={{ height: 6, background: 'var(--surface-tint)' }}
      role="progressbar"
      aria-valuenow={rounded}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={valueText ?? `${rounded}%`}
      aria-label={label}
    >
      {/* Composited fill: full-width element scaled via transform so we avoid
          layout thrashing from animating `width` on every progress tick. */}
      <div
        className="h-full rounded-full origin-left"
        style={{
          width: '100%',
          transform: `scaleX(${Math.max(0, Math.min(1, value))})`,
          background: 'linear-gradient(90deg, var(--bg-deep), var(--accent-cyan))',
          transition: 'transform 150ms linear',
        }}
      />
      {pct > 0 && pct < 100 && (
        <div
          className="absolute top-0 h-full w-8 pointer-events-none"
          style={{
            left: 0,
            transform: `translateX(calc(${pct}% - 1px))`,
            background: 'linear-gradient(90deg, transparent, var(--accent-cyan))',
            opacity: 0.8,
          }}
        />
      )}
    </div>
  )
}
