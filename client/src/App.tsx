import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import Home from '@/pages/Home'
import Network from '@/pages/Network'
import Join from '@/pages/Join'
import ACGN from '@/pages/ACGN'
import Terms from '@/pages/Terms'
import Privacy from '@/pages/Privacy'
import TopNav from '@/components/layout/TopNav'
import { useAuthStore } from '@/store/auth'

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const isConnected = useAuthStore(s => s.isConnected)
  if (!isConnected) return <Navigate to="/" replace />
  return <>{children}</>
}

const basename = import.meta.env.BASE_URL.replace(/\/$/, '')

export default function App() {
  return (
    <BrowserRouter basename={basename}>
      <TopNav />
      <Routes>
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
    </BrowserRouter>
  )
}
