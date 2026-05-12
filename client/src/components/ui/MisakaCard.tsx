import { HTMLAttributes } from 'react'

interface Props extends HTMLAttributes<HTMLDivElement> {
  padding?: 'sm' | 'md' | 'lg' | 'none'
}

const paddings = {
  none: '',
  sm:   'p-4',
  md:   'p-6',
  lg:   'p-7 sm:p-8',
}

export default function MisakaCard({ padding = 'md', className = '', children, ...rest }: Props) {
  return (
    <div className={`misaka-card ${paddings[padding]} ${className}`} {...rest}>
      {children}
    </div>
  )
}
