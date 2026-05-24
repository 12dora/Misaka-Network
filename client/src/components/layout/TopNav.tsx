import { useEffect, useState } from 'react'
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
  const [installPrompt, setInstallPrompt] = useState<null | {
    prompt: () => Promise<void>
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
  }>(null)

  useEffect(() => {
    const onBeforeInstallPrompt = (e: Event) => {
      e.preventDefault()
      setInstallPrompt(e as unknown as {
        prompt: () => Promise<void>
        userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
      })
    }
    const onAppInstalled = () => setInstallPrompt(null)
    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt)
    window.addEventListener('appinstalled', onAppInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt)
      window.removeEventListener('appinstalled', onAppInstalled)
    }
  }, [])

  async function handleInstallApp() {
    if (!installPrompt) return
    await installPrompt.prompt()
    try {
      // beforeinstallprompt events are single-use per spec — once `prompt()`
      // resolves the event is consumed regardless of accepted/dismissed, so
      // clear it either way. Leaving it around would leave a dead "安装应用"
      // button that no longer does anything.
      await installPrompt.userChoice
    } catch {
      // ignore — user choice may reject in some browsers
    } finally {
      setInstallPrompt(null)
    }
  }

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

        {/* Right: QR / scan / status / mobile menu.
            Install / QR / Scan are duplicated inside the mobile hamburger
            dropdown below — hiding them on <sm prevents the nav from
            overflowing on 320–390 px phones and pushing the hamburger
            off-screen (P0-6). */}
        <div className="flex items-center gap-3 h-8">
          {isConnected && (
            <div className="hidden sm:flex items-center gap-3">
              {installPrompt && (
                <button className="nav-pill text-sm !px-3" onClick={handleInstallApp}>
                  ⬇ 安装应用
                </button>
              )}
              <button className="nav-pill text-sm !px-3" onClick={() => setShowQR(true)}>
                🔲 我的 QR
              </button>
              <button className="nav-pill text-sm !px-3" onClick={() => setShowScan(true)}>
                📷 扫描
              </button>
            </div>
          )}

          {/* Settings */}
          <button
            className="w-8 h-8 inline-grid place-items-center rounded-full cursor-pointer hover:opacity-70 transition-opacity leading-none"
            style={{ border: 'none', background: 'transparent', lineHeight: 0, padding: 0 }}
            onClick={() => { setMenuOpen(false); setShowSettings(true) }}
            aria-label="设置"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path
                d="M12 8.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6Zm8.2 4.7v-1.8l-2.1-.4a6.7 6.7 0 0 0-.7-1.7l1.2-1.8-1.3-1.3-1.8 1.2a6.7 6.7 0 0 0-1.7-.7L13.4 4h-1.8l-.4 2.1a6.7 6.7 0 0 0-1.7.7L7.7 5.6 6.4 6.9 7.6 8.7a6.7 6.7 0 0 0-.7 1.7l-2.1.4v1.8l2.1.4c.2.6.4 1.2.7 1.7l-1.2 1.8 1.3 1.3 1.8-1.2c.5.3 1.1.5 1.7.7l.4 2.1h1.8l.4-2.1c.6-.2 1.2-.4 1.7-.7l1.8 1.2 1.3-1.3-1.2-1.8c.3-.5.5-1.1.7-1.7l2.1-.4Z"
                fill="currentColor"
              />
            </svg>
          </button>

          {/* Status */}
          <span className="h-8 inline-flex items-center gap-1.5 text-xs font-mono leading-none text-[var(--text-on-blue-2)]">
            <span
              className={isConnected ? 'pulse-dot' : ''}
              style={{
                display: 'inline-block',
                width: 8, height: 8, borderRadius: '50%',
                background: isConnected ? 'var(--state-success)' : 'var(--text-muted)',
                flexShrink: 0,
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
              {installPrompt && (
                <button className="nav-pill text-sm flex-1" onClick={() => { setMenuOpen(false); handleInstallApp() }}>
                  ⬇ 安装应用
                </button>
              )}
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
