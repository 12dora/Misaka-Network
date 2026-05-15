// ── Runtime configuration ──────────────────────────────────────────
// Priority: window.__MISAKA_CONFIG__ > Vite env vars > defaults
//
// On GitHub Pages, edit public/config.json to point to your server.
// In local dev, use VITE_ env vars or the Vite proxy (defaults work).

interface AppConfig {
  API_BASE: string
  WS_URL: string
  APP_BASE?: string
}

declare global {
  interface Window {
    __MISAKA_CONFIG__?: Partial<AppConfig>
  }
}

let _config: AppConfig | null = null

export async function loadConfig(): Promise<AppConfig> {
  // Already loaded
  if (_config) return _config

  // Try loading runtime config.json
  try {
    const resp = await fetch(new URL('config.json', document.baseURI))
    if (resp.ok) {
      const data = (await resp.json()) as Partial<AppConfig>
      window.__MISAKA_CONFIG__ = data
    }
  } catch {
    // config.json not available — use defaults
  }

  const runtime = window.__MISAKA_CONFIG__ ?? {}

  _config = {
    API_BASE: runtime.API_BASE || import.meta.env.VITE_API_BASE || '',
    WS_URL: runtime.WS_URL || import.meta.env.VITE_WS_URL || '',
  }

  return _config
}

export function getConfig(): AppConfig {
  if (!_config) {
    // If loadConfig hasn't been called yet, use what's available synchronously
    const runtime = window.__MISAKA_CONFIG__ ?? {}
    return {
      API_BASE: runtime.API_BASE || import.meta.env.VITE_API_BASE || '',
      WS_URL: runtime.WS_URL || import.meta.env.VITE_WS_URL || '',
    }
  }
  return _config
}

export function apiUrl(path: string): string {
  const cfg = getConfig()
  return cfg.API_BASE ? `${cfg.API_BASE}${path}` : path
}

export function wsUrl(): string {
  const cfg = getConfig()
  if (cfg.WS_URL) return cfg.WS_URL
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${location.host}/ws`
}
