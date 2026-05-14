interface AppFooterProps {
  id?: string
}

export default function AppFooter({ id }: AppFooterProps) {
  return (
    <footer
      id={id}
      className="px-6 py-4 text-center"
      style={{ background: 'var(--bg-deep)' }}
    >
      <div className="font-jp text-xs md:text-sm text-[var(--text-on-blue-2)] leading-snug">
        <p className="text-white text-sm md:text-base font-kanji font-semibold">© Master Huang · Misaka Network</p>
        <a
          href="https://github.com/12dora/Misaka-Network"
          target="_blank"
          rel="noreferrer"
          className="inline-block mt-1 text-xs underline decoration-dotted"
        >
          GitHub
        </a>
      </div>
    </footer>
  )
}
