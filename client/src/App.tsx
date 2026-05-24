import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
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
      <TopNav />
      <AnimatedRoutes />
      {/* P0-9: surfaces "new version available — reload" when sw.js sends
          a postMessage after activating. Sits outside the route tree so it
          persists across navigations. */}
      <UpdateBanner />
    </BrowserRouter>
  )
}

function AnimatedRoutes() {
  const location = useLocation()

  return (
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
  )
}
