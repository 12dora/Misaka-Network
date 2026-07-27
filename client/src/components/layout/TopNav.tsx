import { useEffect, useId, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useAuthStore } from '@/store/auth'
import MisakaKanjiBlock from '@/components/ui/MisakaKanjiBlock'
import QRModal from '@/components/features/QRModal'
import ScanModal from '@/components/features/ScanModal'
import SettingsModal from '@/components/features/SettingsModal'
import { scrollIntoViewSafely } from '@/hooks/useReducedMotion'

const LINKS = [
  { to: '/',        label: '首页',  kanji: '首' },
  { to: '/network', label: '网络',  kanji: '网' },
  { to: '/acgn',   label: 'ACGN', kanji: 'A' },
]

export default function TopNav() {
  const location   = useLocation()
  const navigate   = useNavigate()
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
  // P2: PWA install used to be silent — the prompt button vanished after the
  // user resolved the system dialog with no confirmation either way. Surface
  // the outcome so a deferred install doesn't look like a broken click.
  const [installToast, setInstallToast] = useState<string | null>(null)
  const menuId = useId()

  // A11Y-006: close the dropdown on route change so `aria-expanded` never
  // reports a menu that navigation already dismissed.
  useEffect(() => { setMenuOpen(false) }, [location.pathname])

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
      const choice = await installPrompt.userChoice
      if (choice.outcome === 'accepted') {
        setInstallToast('已开始安装到主屏 / 应用列表')
      } else {
        setInstallToast('已取消安装；稍后可通过浏览器菜单再次安装')
      }
    } catch {
      // ignore — user choice may reject in some browsers
      setInstallToast('安装请求未完成，请稍后再试')
    } finally {
      setInstallPrompt(null)
      // Clear via state-equality guard so a concurrent toast doesn't get
      // wiped by a delayed timer from an earlier install attempt.
      const current = installToast
      setTimeout(() => setInstallToast(prev => (prev === current ? null : prev)), 3000)
    }
  }

  function isActive(to: string) {
    return to === '/' ? location.pathname === '/' : location.pathname.startsWith(to)
  }

  // P2-15: when an unauthenticated user clicks the disabled "网络" pill we
  // used to do nothing — the pointer cursor changed to not-allowed and that
  // was the entire feedback. Bounce them to the home page (where LoginCard
  // lives) and surface a tiny toast so they know why. We also try to scroll
  // the login card into view after navigation completes.
  function nudgeToLogin() {
    setInstallToast('请先在首页接入御坂网络')
    setTimeout(() => setInstallToast(prev => (prev === '请先在首页接入御坂网络' ? null : prev)), 2400)
    navigate('/')
    // Wait a tick for the home page to mount before attempting to scroll.
    // UX-MOTION-001: scripted smooth scrolling ignored `prefers-reduced-
    // motion` entirely — route it through the shared helper.
    setTimeout(() => {
      scrollIntoViewSafely(document.querySelector('[data-login-card]'), { block: 'center' })
    }, 180)
  }

  return (
    <>
      <nav
        aria-label="主导航"
        className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between"
        style={{
          paddingLeft:  'clamp(1rem, 4vw, 2rem)',
          paddingRight: 'clamp(1rem, 4vw, 2rem)',
          // UX-LAYOUT-007: a bare `h-16` put the nav content under the iOS
          // status bar / notch when launched from the Home Screen. The
          // shared token adds the top safe-area inset to the 64 px chrome.
          height: 'var(--nav-h-total)',
          paddingTop: 'var(--safe-top)',
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
            <span className="hidden md:block font-mono text-[10px] font-normal text-[var(--text-on-blue-2)] tracking-widest">
              MISAKA NETWORK
            </span>
          </span>
        </Link>

        {/* Desktop nav pills.
            UX-LAYOUT-004: these used to appear at `sm` (640 px) together
            with the connected action group and the status chip. Their
            intrinsic no-wrap widths overflow a 640–800 px viewport, and
            `body { overflow-x: hidden }` silently clips whatever doesn't
            fit. Everything now switches at `md` (768 px), where the full
            row demonstrably fits; below that the hamburger owns it.
            A11Y-006: `Link` is styled as the pill directly — the old
            `<Link><button/></Link>` nested two interactive elements, giving
            duplicate tab stops and inconsistent activation across
            browsers. */}
        <div className="hidden md:flex items-center gap-2">
          {LINKS.map(({ to, label }) => {
            const needsAuth = to === '/network' && !isConnected
            if (needsAuth) {
              return (
                <button
                  key={to}
                  type="button"
                  className="nav-pill text-sm opacity-60 cursor-pointer"
                  onClick={nudgeToLogin}
                  title="请先接入网络"
                  aria-label="网络（需先接入）"
                >
                  {label}
                </button>
              )
            }
            return (
              <Link
                key={to}
                to={to}
                className={`nav-pill text-sm${isActive(to) ? ' active' : ''}`}
                aria-current={isActive(to) ? 'page' : undefined}
              >
                {label}
              </Link>
            )
          })}
        </div>

        {/* Right: QR / scan / status / mobile menu.
            Install / QR / Scan are duplicated inside the mobile hamburger
            dropdown below — hiding them below `md` prevents the nav from
            overflowing on 320–800 px viewports and pushing the hamburger
            off-screen (P0-6, UX-LAYOUT-004). */}
        <div className="flex items-center gap-3 h-8">
          {isConnected && (
            <div className="hidden md:flex items-center gap-3">
              {installPrompt && (
                <button type="button" className="nav-pill text-sm !px-3" onClick={handleInstallApp}>
                  ⬇ 安装应用
                </button>
              )}
              <button type="button" className="nav-pill text-sm !px-3" onClick={() => setShowQR(true)}>
                🔲 我的 QR
              </button>
              <button type="button" className="nav-pill text-sm !px-3" onClick={() => setShowScan(true)}>
                📷 扫描
              </button>
            </div>
          )}

          {/* Settings — A11Y-007: `.tap-target` grows the hit area to 44 px
              on coarse pointers without changing the 32 px visual. */}
          <button
            type="button"
            className="tap-target w-8 h-8 inline-grid place-items-center rounded-full cursor-pointer hover:opacity-70 transition-opacity leading-none"
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

          {/* Mobile hamburger — A11Y-006: expose the menu's expanded state
              and what it controls. */}
          <button
            type="button"
            className="tap-target md:hidden flex flex-col justify-center items-center gap-1 w-8 h-8 cursor-pointer"
            style={{ border: 'none', background: 'transparent' }}
            onClick={() => setMenuOpen(o => !o)}
            aria-label={menuOpen ? '关闭菜单' : '打开菜单'}
            aria-expanded={menuOpen}
            aria-controls={menuId}
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

      {/* Mobile dropdown menu.
          UX-LAYOUT-007: `top-16` ignored the safe-area inset, so on a notched
          iPhone in standalone mode the dropdown overlapped the nav. */}
      {menuOpen && (
        <div
          id={menuId}
          className="fixed left-0 right-0 z-40 md:hidden flex flex-col"
          style={{
            top: 'var(--nav-h-total)',
            background: 'rgba(14,42,107,0.97)',
            backdropFilter: 'blur(20px)',
            borderBottom: '1px solid rgba(255,255,255,0.12)',
          }}
        >
          {LINKS.map(({ to, label, kanji }) => {
            const needsAuth = to === '/network' && !isConnected
            if (needsAuth) {
              return (
                <button
                  key={to}
                  type="button"
                  onClick={() => { setMenuOpen(false); nudgeToLogin() }}
                  className="flex items-center gap-3 px-6 py-4 border-b opacity-70 text-left cursor-pointer"
                  style={{
                    borderColor: 'rgba(255,255,255,0.08)',
                    background: 'transparent',
                    width: '100%',
                  }}
                  aria-label="网络（需先接入）"
                >
                  <MisakaKanjiBlock char={kanji} size="sm" />
                  <span className="font-kanji font-semibold text-white">{label}</span>
                  {/* A11Y-002: --text-muted is a fill token; on the deep-blue
                      dropdown the AA-verified text token is --text-on-blue-2. */}
                  <span className="ml-auto font-kanji text-[10px] text-[var(--text-on-blue-2)]">需登录</span>
                </button>
              )
            }
            return (
              <Link
                key={to}
                to={to}
                className="no-underline flex items-center gap-3 px-6 py-4 border-b"
                onClick={() => setMenuOpen(false)}
                aria-current={isActive(to) ? 'page' : undefined}
                style={{
                  minHeight: 44,
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
                    aria-hidden="true"
                  />
                )}
              </Link>
            )
          })}
          {isConnected && (
            <div className="flex flex-wrap gap-2 p-4">
              {installPrompt && (
                <button type="button" className="nav-pill text-sm flex-1 min-w-0" onClick={() => { setMenuOpen(false); handleInstallApp() }}>
                  ⬇ 安装应用
                </button>
              )}
              <button type="button" className="nav-pill text-sm flex-1 min-w-0" onClick={() => { setMenuOpen(false); setShowQR(true) }}>
                🔲 我的 QR
              </button>
              <button type="button" className="nav-pill text-sm flex-1 min-w-0" onClick={() => { setMenuOpen(false); setShowScan(true) }}>
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

      {/* P2: PWA install confirmation toast.
          UX-LAYOUT-009: moved onto the shared `.misaka-notify` layer so it
          reserves the mobile action bar + home-indicator space and hides
          itself while a dialog is open, instead of sitting at z-[120] over
          everything including modals. */}
      {installToast && (
        <div
          className="misaka-notify px-4 py-2 rounded-lg text-sm font-kanji shadow-lg text-center"
          style={{ background: 'var(--bg-deep)', color: '#fff' }}
          role="status"
        >
          {installToast}
        </div>
      )}
    </>
  )
}
