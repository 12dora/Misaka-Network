interface Props {
  char: string
  size?: 'sm' | 'md' | 'lg' | 'xl'
  className?: string
}

const sizes = {
  sm: 'text-sm w-5 h-5',
  md: 'text-base w-6 h-6',
  lg: 'text-xl w-8 h-8',
  xl: 'text-3xl w-12 h-12',
}

export default function MisakaKanjiBlock({ char, size = 'md', className = '' }: Props) {
  return (
    <span
      className={`kanji-block rounded-[2px] ${sizes[size]} ${className}`}
      aria-hidden="true"
    >
      {char}
    </span>
  )
}
