import { Link } from 'react-router-dom'

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
        <div className="mt-1 flex items-center justify-center gap-3 text-xs">
          <a
            href="https://github.com/12dora/Misaka-Network"
            target="_blank"
            rel="noreferrer"
            className="underline decoration-dotted"
          >
            GitHub
          </a>
          <span aria-hidden="true" className="opacity-50">·</span>
          <Link to="/privacy" className="underline decoration-dotted">
            隐私政策
          </Link>
          <span aria-hidden="true" className="opacity-50">·</span>
          <Link to="/tos" className="underline decoration-dotted">
            服务条款
          </Link>
        </div>
      </div>
    </footer>
  )
}
