import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { loadConfig } from './config'
import { publicAssetUrl } from '@/lib/appBase'

// BUG-028 — bootstrap could hang on a blank page.
//
// `boot()` used to `await loadConfig()` before creating the React root, and
// `loadConfig()` had no deadline on its `config.json` request. A hanging
// request (captive portal, dead CDN edge, offline with the file uncached)
// meant `<div id="root">` stayed empty forever with no spinner, no error and
// no way to retry. `loadConfig()` now bounds itself, and here we render a
// shell immediately so *something* is on screen from the first frame, then
// re-render the app once config resolves.

const rootEl = document.getElementById('root')

function BootShell() {
  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center gap-3 font-kanji text-sm"
      style={{ background: 'var(--bg-primary)', color: 'var(--text-on-blue)' }}
      role="status"
      aria-live="polite"
    >
      <div className="w-12 h-1 rounded-full" style={{ background: 'var(--accent-cyan-on-blue)' }} />
      正在同步网络…
    </div>
  )
}

async function boot() {
  if (!rootEl) {
    console.error('[boot] #root element missing')
    return
  }
  const root = createRoot(rootEl)

  // Paint the shell first. If config resolution is slow the user sees a live
  // page instead of white, and if it throws we still mount the app below.
  root.render(<StrictMode><BootShell /></StrictMode>)

  try {
    await loadConfig()
  } catch (err) {
    // loadConfig already swallows fetch failures; this only fires on a
    // programming error. Mount anyway with compiled-in defaults.
    console.warn('[boot] config load failed, using defaults', err)
  }

  if ('serviceWorker' in navigator) {
    const swUrl = publicAssetUrl('sw.js')
    const register = () => {
      navigator.serviceWorker.register(swUrl).catch((err) => {
        console.warn('[sw] register failed', err)
      })
    }
    // `load` may already have fired by the time config resolved — that used
    // to silently skip service-worker registration on slow-config sessions.
    if (document.readyState === 'complete') register()
    else window.addEventListener('load', register, { once: true })
  }

  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

boot()
