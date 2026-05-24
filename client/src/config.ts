// ── Runtime configuration ──────────────────────────────────────────
// Priority (production): window.__MISAKA_CONFIG__ > runtime config.json >
//                        Vite env > hard-coded project default
//
// The project default points at the official public signaling server
// (https://misaka.konata.tv) so a fresh GitHub Pages deployment of the
// repo works out of the box without anyone having to edit config.json.
// Forks can still override via public/config.json or VITE_API_BASE.
//
// In local dev (`vite dev`), defaults are empty so the Vite proxy at
// /api and /ws takes over — keeps the dev loop self-contained.

const DEFAULT_API_BASE = 'https://misaka.konata.tv'
const DEFAULT_WS_URL = 'wss://misaka.konata.tv/ws'

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

function resolveApiBase(runtime: Partial<AppConfig>): string {
  if (import.meta.env.DEV) {
    return import.meta.env.VITE_API_BASE || runtime.API_BASE || ''
  }
  return runtime.API_BASE || import.meta.env.VITE_API_BASE || DEFAULT_API_BASE
}

function resolveWsUrl(runtime: Partial<AppConfig>): string {
  if (import.meta.env.DEV) {
    return import.meta.env.VITE_WS_URL || runtime.WS_URL || ''
  }
  return runtime.WS_URL || import.meta.env.VITE_WS_URL || DEFAULT_WS_URL
}

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
    API_BASE: resolveApiBase(runtime),
    WS_URL: resolveWsUrl(runtime),
  }

  return _config
}

export function getConfig(): AppConfig {
  if (!_config) {
    // If loadConfig hasn't been called yet, use what's available synchronously.
    const runtime = window.__MISAKA_CONFIG__ ?? {}
    return {
      API_BASE: resolveApiBase(runtime),
      WS_URL: resolveWsUrl(runtime),
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
