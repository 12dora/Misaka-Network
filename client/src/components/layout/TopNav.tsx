import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useAuthStore } from '@/store/auth'
import MisakaKanjiBlock from '@/components/ui/MisakaKanjiBlock'
import QRModal from '@/components/features/QRModal'
import ScanModal from '@/components/features/ScanModal'
import SettingsModal from '@/components/features/SettingsModal'

const LINKS = [
  { to: '/',        label: '首页',  kanji: '首' },
  { to: '/network', label: '网络',  kanji: '网' },
  { to: '/acgn',   label: 'ACGN', kanji: 'A' },
]

export default function TopNav() {
  const location   = useLocation()
  const isConnected = useAuthStore(s => s.isConnected)
  const identity    = useAuthStore(s => s.identity)
  const [menuOpen, setMenuOpen] = useState(false)
  const [showQR, setShowQR]         = useState(false)
  const [showScan, setShowScan]     = useState(false)
  const [showSettings, setShowSettings] = useState(false)

  function isActive(to: string) {
    return to === '/' ? location.pathname === '/' : location.pathname.startsWith(to)
  }

  return (
    <>
      <nav
        className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between h-16"
        style={{
          paddingLeft:  'clamp(1rem, 4vw, 2rem)',
          paddingRight: 'clamp(1rem, 4vw, 2rem)',
          background: 'rgba(26,79,196,0.78)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          borderBottom: '1px solid rgba(255,255,255,0.15)',
        }}
      >
        {/* Logo */}
        <Link to="/" className="flex items-center gap-2 no-underline flex-shrink-0">
          <MisakaKanjiBlock char="御" size="md" />
          <span className="font-kanji font-bold text-white leading-tight">
            <span className="text-base">御坂网络</span>
            <span className="hidden sm:block font-mono text-[10px] font-normal text-[var(--text-on-blue-2)] tracking-widest">
              MISAKA NETWORK
            </span>
          </span>
        </Link>

        {/* Desktop nav pills */}
        <div className="hidden sm:flex items-center gap-2">
          {LINKS.map(({ to, label }) => {
            const needsAuth = to === '/network' && !isConnected
            if (needsAuth) {
              return (
                <button
                  key={to}
                  className="nav-pill text-sm opacity-40 cursor-not-allowed"
                  disabled
                  title="请先接入网络"
                >
                  {label}
                </button>
              )
            }
            return (
              <Link key={to} to={to} className="no-underline">
                <button className={`nav-pill text-sm${isActive(to) ? ' active' : ''}`}>
                  {label}
                </button>
              </Link>
            )
          })}
        </div>

        {/* Right: QR / scan / status / mobile menu */}
        <div className="flex items-center gap-3">
          {isConnected && (
            <>
              <button className="nav-pill text-sm !px-3" onClick={() => setShowQR(true)}>
                🔲 我的 QR
              </button>
              <button className="nav-pill text-sm !px-3" onClick={() => setShowScan(true)}>
                📷 扫描
              </button>
            </>
          )}

          {/* Settings */}
          <button
            className="w-8 h-8 flex items-center justify-center rounded-full cursor-pointer hover:opacity-70 transition-opacity"
            style={{ border: 'none', background: 'transparent', fontSize: '1.1rem' }}
            onClick={() => setShowSettings(true)}
            aria-label="设置"
          >
            ⚙
          </button>

          {/* Status */}
          <span className="flex items-center gap-1.5 text-xs font-mono text-[var(--text-on-blue-2)]">
            <span
              className={isConnected ? 'pulse-dot' : ''}
              style={{
                display: 'inline-block',
                width: 8, height: 8, borderRadius: '50%',
                background: isConnected ? 'var(--state-success)' : 'var(--text-muted)',
              }}
            />
            <span className="hidden xs:inline">{isConnected ? '已接入' : '未接入'}</span>
          </span>

          {/* Mobile hamburger */}
          <button
            className="sm:hidden flex flex-col justify-center items-center gap-1 w-8 h-8 cursor-pointer"
            style={{ border: 'none', background: 'transparent' }}
            onClick={() => setMenuOpen(o => !o)}
            aria-label="菜单"
          >
            <span
              className="block w-5 h-0.5 bg-white rounded transition-all duration-200"
              style={menuOpen ? { transform: 'translateY(5px) rotate(45deg)' } : {}}
            />
            <span
              className="block w-5 h-0.5 bg-white rounded transition-all duration-200"
              style={menuOpen ? { opacity: 0 } : {}}
            />
            <span
              className="block w-5 h-0.5 bg-white rounded transition-all duration-200"
              style={menuOpen ? { transform: 'translateY(-5px) rotate(-45deg)' } : {}}
            />
          </button>
        </div>
      </nav>

      {/* Mobile dropdown menu */}
      {menuOpen && (
        <div
          className="fixed top-16 left-0 right-0 z-40 sm:hidden flex flex-col"
          style={{
            background: 'rgba(14,42,107,0.97)',
            backdropFilter: 'blur(20px)',
            borderBottom: '1px solid rgba(255,255,255,0.12)',
          }}
        >
          {LINKS.map(({ to, label, kanji }) => {
            const needsAuth = to === '/network' && !isConnected
            if (needsAuth) {
              return (
                <div
                  key={to}
                  className="flex items-center gap-3 px-6 py-4 border-b opacity-40"
                  style={{
                    borderColor: 'rgba(255,255,255,0.08)',
                  }}
                >
                  <MisakaKanjiBlock char={kanji} size="sm" />
                  <span className="font-kanji font-semibold text-white">{label}</span>
                  <span className="ml-auto font-kanji text-[10px] text-[var(--text-muted)]">需登录</span>
                </div>
              )
            }
            return (
              <Link
                key={to}
                to={to}
                className="no-underline"
                onClick={() => setMenuOpen(false)}
              >
                <div
                  className="flex items-center gap-3 px-6 py-4 border-b"
                  style={{
                    borderColor: 'rgba(255,255,255,0.08)',
                    background: isActive(to) ? 'rgba(255,255,255,0.08)' : 'transparent',
                  }}
                >
                  <MisakaKanjiBlock char={kanji} size="sm" />
                  <span className="font-kanji font-semibold text-white">{label}</span>
                  {isActive(to) && (
                    <span
                      className="ml-auto w-1.5 h-1.5 rounded-full"
                      style={{ background: 'var(--accent-cyan)' }}
                    />
                  )}
                </div>
              </Link>
            )
          })}
          {isConnected && (
            <div className="flex gap-2 p-4">
              <button className="nav-pill text-sm flex-1" onClick={() => { setMenuOpen(false); setShowQR(true) }}>
                🔲 我的 QR
              </button>
              <button className="nav-pill text-sm flex-1" onClick={() => { setMenuOpen(false); setShowScan(true) }}>
                📷 扫描
              </button>
            </div>
          )}
        </div>
      )}

      {/* Modals */}
      {showQR && (
        <QRModal
          nodeId={identity.nodeId}
          passCode={identity.passCode}
          onClose={() => setShowQR(false)}
        />
      )}
      {showScan && (
        <ScanModal onClose={() => setShowScan(false)} />
      )}
      {showSettings && (
        <SettingsModal onClose={() => setShowSettings(false)} />
      )}
    </>
  )
}
