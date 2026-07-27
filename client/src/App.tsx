import { Component, lazy, Suspense, useLayoutEffect, useRef, type ErrorInfo, type ReactNode } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigationType } from 'react-router-dom'
import TopNav from '@/components/layout/TopNav'
import UpdateBanner from '@/components/features/UpdateBanner'
import { useAuthStore } from '@/store/auth'
import { appBasePath } from '@/lib/appBase'

const Home = lazy(() => import('@/pages/Home'))
const Network = lazy(() => import('@/pages/Network'))
const Join = lazy(() => import('@/pages/Join'))
const ACGN = lazy(() => import('@/pages/ACGN'))
const Terms = lazy(() => import('@/pages/Terms'))
const Privacy = lazy(() => import('@/pages/Privacy'))

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const isConnected = useAuthStore(s => s.isConnected)
  if (!isConnected) return <Navigate to="/" replace />
  return <>{children}</>
}

export default function App() {
  const basename = appBasePath()

  return (
    <BrowserRouter basename={basename}>
      {/* A11Y-006: a keyboard user landing on any page had to tab through
          the whole nav before reaching content, and there was no target to
          skip to. The link is visually hidden until focused. */}
      <a href="#main-content" className="misaka-skip-link">跳到主要内容</a>
      <TopNav />
      <AnimatedRoutes />
      {/* P0-9: surfaces "new version available — reload" when sw.js sends
          a postMessage after activating. Sits outside the route tree so it
          persists across navigations. */}
      <UpdateBanner />
    </BrowserRouter>
  )
}

// ── BUG-028: lazy-route error boundary ───────────────────────────────
// A failed `import()` — offline with a stale precache, or a deploy that
// rotated the chunk hashes while the tab was open — rejected inside
// <Suspense> with nobody catching it. React unmounted the whole tree and
// the user got a blank page and a console stack. Catch it and offer the two
// recoveries that actually work: retry the import, or hard-reload to pick
// up the new chunk manifest.

interface BoundaryState { error: Error | null }

class RouteErrorBoundary extends Component<{ children: ReactNode; resetKey: string }, BoundaryState> {
  state: BoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error }
  }

  componentDidUpdate(prev: { resetKey: string }) {
    // Navigating away from the broken route clears the error.
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null })
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[route] render failed', error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children

    const offline = typeof navigator !== 'undefined' && navigator.onLine === false
    return (
      <div
        className="min-h-screen pt-nav flex flex-col items-center justify-center gap-4 px-6 text-center"
        style={{ background: 'var(--bg-primary)', color: 'var(--text-on-blue)' }}
        role="alert"
      >
        <div className="font-kanji font-bold text-lg">页面加载失败</div>
        <p className="font-kanji text-sm text-[var(--text-on-blue-2)] max-w-[420px] leading-relaxed">
          {offline
            ? '当前设备已离线，无法载入这个页面。请恢复网络后重试。'
            : '这个页面的资源没有载入成功，可能是刚刚发布了新版本。重新载入即可继续。'}
        </p>
        <div className="flex flex-wrap gap-2 justify-center">
          <button className="nav-pill text-sm" onClick={() => this.setState({ error: null })}>
            重试
          </button>
          <button className="nav-pill text-sm" onClick={() => window.location.reload()}>
            重新载入页面
          </button>
        </div>
      </div>
    )
  }
}

// ── UX-LAYOUT-008: forward navigation must reset the viewport ─────────
// `navigate('/network')` after a successful login preserved the scroll
// position from the bottom of Home (scrollY=72 on a 390×844 run), which put
// the Network page's 节点/信道/任务 tabs underneath the fixed nav — they
// looked absent. Browser-driven history moves (POP) keep their restored
// scroll, which is what the user expects there.
function ForwardNavigationReset({ pathname }: { pathname: string }) {
  const navigationType = useNavigationType()
  const first = useRef(true)

  useLayoutEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    if (navigationType === 'POP') return
    // Layout effect + instant scroll: doing this in a passive effect let the
    // new page paint at the old offset for a frame first.
    window.scrollTo(0, 0)
    const main = document.getElementById('main-content')
    if (main) {
      // Move AT focus to the new page so a screen-reader user is told where
      // they landed instead of being left on a control that no longer exists.
      try { main.focus({ preventScroll: true }) } catch { /* ignore */ }
    }
  }, [pathname, navigationType])

  return null
}

function AnimatedRoutes() {
  const location = useLocation()

  return (
    <>
      <ForwardNavigationReset pathname={location.pathname} />
      {/* A11Y-006: exactly one <main> landmark for the whole app; the pages
          render plain sections inside it. */}
      <main id="main-content" tabIndex={-1} style={{ outline: 'none' }}>
        <RouteErrorBoundary resetKey={location.pathname}>
          <Suspense fallback={
            <div className="min-h-screen pt-24 text-center font-kanji text-sm page-enter" style={{ background: 'var(--bg-primary)', color: 'var(--text-on-blue)' }}>
              正在同步网络…
            </div>
          }>
            <div key={location.pathname} className="page-enter">
              <Routes location={location}>
                <Route path="/" element={<Home />} />
                <Route path="/join" element={<Join />} />
                <Route path="/network" element={
                  <ProtectedRoute><Network /></ProtectedRoute>
                } />
                <Route path="/acgn" element={<ACGN />} />
                <Route path="/tos" element={<Terms />} />
                <Route path="/privacy" element={<Privacy />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </div>
          </Suspense>
        </RouteErrorBoundary>
      </main>
    </>
  )
}
