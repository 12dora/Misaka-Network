import { ButtonHTMLAttributes } from 'react'

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'pill' | 'ghost'
  size?: 'sm' | 'md'
  fullWidth?: boolean
}

export default function MisakaButton({
  variant = 'primary',
  size = 'md',
  fullWidth = false,
  className = '',
  children,
  ...rest
}: Props) {
  const widthCls = fullWidth ? 'w-full' : ''
  // P2-13: disabled buttons used to render at full opacity with a plain
  // cursor — visually identical to active ones. Apply a consistent dim +
  // not-allowed cursor across all three variants. We keep the `disabled`
  // attribute (browser already blocks the click) and just layer the
  // visual cue on top via Tailwind's `disabled:` modifier.
  const disabledCls = 'disabled:opacity-40 disabled:cursor-not-allowed'

  if (variant === 'primary') {
    const sizeCls = size === 'sm' ? 'py-2 px-4 text-sm rounded-lg' : 'py-[0.85rem] px-6 text-base rounded-xl'
    return (
      <button
        className={`btn-primary ${sizeCls} ${widthCls} ${disabledCls} ${className}`}
        {...rest}
      >
        {children}
      </button>
    )
  }

  if (variant === 'pill') {
    const sizeCls = size === 'sm' ? 'py-1.5 px-4 text-sm' : 'py-2 px-5 text-base'
    return (
      <button
        className={`nav-pill ${sizeCls} ${widthCls} ${disabledCls} ${className}`}
        {...rest}
      >
        {children}
      </button>
    )
  }

  // ghost
  return (
    <button
      className={`btn-ghost ${size === 'sm' ? 'py-1.5 px-3 text-sm' : 'py-2 px-4 text-base'} ${widthCls} ${disabledCls} ${className}`}
      {...rest}
    >
      {children}
    </button>
  )
}
