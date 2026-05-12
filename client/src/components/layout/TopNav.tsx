import { Link, useLocation } from 'react-router-dom'
import { useAuthStore } from '@/store/auth'
import MisakaKanjiBlock from '@/components/ui/MisakaKanjiBlock'

const LINKS = [
  { to: '/',        label: '首页',  short: 'HOME' },
  { to: '/network', label: '网络',  short: 'NETWORK' },
  { to: '/acgn',    label: 'ACGN', short: 'ACGN' },
]

export default function TopNav() {
  const location = useLocation()
  const isConnected = useAuthStore(s => s.isConnected)

  return (
    <nav
      className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-8 h-16"
      style={{
        background: 'rgba(26,79,196,0.72)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        borderBottom: '1px solid rgba(255,255,255,0.15)',
      }}
    >
      {/* Logo */}
      <Link to="/" className="flex items-center gap-2 no-underline">
        <MisakaKanjiBlock char="御" size="md" />
        <span className="font-kanji font-bold text-white text-base leading-tight">
          御坂网络
          <span className="block font-mono text-[10px] font-normal text-[var(--text-on-blue-2)] tracking-widest">
            MISAKA NETWORK
          </span>
        </span>
      </Link>

      {/* Navigation Pills */}
      <div className="flex items-center gap-2">
        {LINKS.map(({ to, label }) => {
          const active = to === '/'
            ? location.pathname === '/'
            : location.pathname.startsWith(to)
          return (
            <Link key={to} to={to} className="no-underline">
              <button className={`nav-pill text-sm${active ? ' active' : ''}`}>
                {label}
              </button>
            </Link>
          )
        })}
      </div>

      {/* Right Status */}
      <div className="flex items-center gap-3">
        <span className="flex items-center gap-1.5 text-xs font-mono text-[var(--text-on-blue-2)]">
          <span
            className={isConnected ? 'pulse-dot' : ''}
            style={{
              display: 'inline-block',
              width: 8, height: 8, borderRadius: '50%',
              background: isConnected ? 'var(--state-success)' : 'var(--text-muted)',
            }}
          />
          {isConnected ? '已接入' : '未接入'}
        </span>
      </div>
    </nav>
  )
}
