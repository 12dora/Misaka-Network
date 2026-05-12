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

  if (variant === 'primary') {
    const sizeCls = size === 'sm' ? 'py-2 px-4 text-sm rounded-lg' : 'py-[0.85rem] px-6 text-base rounded-xl'
    return (
      <button
        className={`btn-primary ${sizeCls} ${widthCls} ${className}`}
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
        className={`nav-pill ${sizeCls} ${widthCls} ${className}`}
        {...rest}
      >
        {children}
      </button>
    )
  }

  // ghost
  return (
    <button
      className={`btn-ghost ${size === 'sm' ? 'py-1.5 px-3 text-sm' : 'py-2 px-4 text-base'} ${widthCls} ${className}`}
      {...rest}
    >
      {children}
    </button>
  )
}
