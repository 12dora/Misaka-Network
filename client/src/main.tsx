import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { loadConfig } from './config'

async function boot() {
  await loadConfig()

  if ('serviceWorker' in navigator) {
    const swUrl = `${import.meta.env.BASE_URL}sw.js`
    window.addEventListener('load', () => {
      navigator.serviceWorker.register(swUrl).catch((err) => {
        console.warn('[sw] register failed', err)
      })
    })
  }

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

boot()
