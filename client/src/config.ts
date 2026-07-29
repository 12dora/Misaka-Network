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

import { publicAssetUrl } from '@/lib/appBase'

const DEFAULT_API_BASE = 'https://misaka.konata.tv'
const DEFAULT_WS_URL = 'wss://misaka.konata.tv/ws'

// BUG-028: a hanging `config.json` request blocked `boot()` forever and the
// user stared at an empty <div id="root">. Bound the wait; falling back to
// the compiled defaults is always better than a blank page.
const CONFIG_FETCH_TIMEOUT_MS = 4_000

interface AppConfig {
  API_BASE: string
  WS_URL: string
}

declare global {
  interface Window {
    __MISAKA_CONFIG__?: Partial<AppConfig>
  }
}

let _config: AppConfig | null = null

// ── Schema validation ────────────────────────────────────────────────
// CONFIG-006: values arriving from `config.json` are operator input from a
// separate file that ships with the build. Anything that is not a usable
// absolute http(s) / ws(s) URL is dropped rather than silently poisoning
// every later `apiUrl()` call.

/**
 * API_BASE must be a consumable absolute http(s) origin/prefix:
 * no credentials, no hash, no query (query breaks path concatenation).
 */
function isHttpUrl(v: unknown): v is string {
  if (typeof v !== 'string' || v === '') return false
  try {
    const u = new URL(v)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    if (u.username || u.password) return false
    if (u.hash) return false
    if (u.search) return false
    return true
  } catch {
    return false
  }
}

/**
 * WS_URL must be constructible for `new WebSocket()`:
 * no credentials, no hash (fragment throws synchronously).
 * Query is allowed (rare, but WebSocket accepts it).
 */
function isWsUrl(v: unknown): v is string {
  if (typeof v !== 'string' || v === '') return false
  try {
    const u = new URL(v)
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return false
    if (u.username || u.password) return false
    if (u.hash) return false
    return true
  } catch {
    return false
  }
}

/** Keep only well-formed fields; log and drop the rest. */
export function validateConfig(raw: unknown, source: string): Partial<AppConfig> {
  const out: Partial<AppConfig> = {}
  if (!raw || typeof raw !== 'object') return out
  const data = raw as Record<string, unknown>

  if ('API_BASE' in data) {
    if (isHttpUrl(data.API_BASE)) out.API_BASE = data.API_BASE
    else console.warn(`[config] ignoring invalid API_BASE from ${source}`, data.API_BASE)
  }
  if ('WS_URL' in data) {
    if (isWsUrl(data.WS_URL)) out.WS_URL = data.WS_URL
    else console.warn(`[config] ignoring invalid WS_URL from ${source}`, data.WS_URL)
  }
  return out
}

/**
 * CONFIG-006 — the documented contract is
 *   host-injected  >  config.json  >  Vite env  >  built-in default
 * but `loadConfig()` used to do `window.__MISAKA_CONFIG__ = data`, replacing
 * the host-injected object wholesale. Since `public/config.json` always
 * ships with the official endpoints, an embedder that injected a private
 * backend had it silently swapped for the public one the moment the JSON
 * landed — the exact inverse of the contract.
 *
 * Merge order here is explicit: injected wins field by field, fetched JSON
 * only fills the gaps.
 */
export function mergeRuntimeConfig(
  injected: Partial<AppConfig>,
  fetched: Partial<AppConfig>,
): Partial<AppConfig> {
  return { ...fetched, ...injected }
}

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

async function fetchRuntimeJson(timeoutMs: number): Promise<Partial<AppConfig>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    // Anchored on the deployment base, not `document.baseURI` — the latter
    // drifts with the current route, so `/network` and `/network/` used to
    // resolve to different config URLs. See lib/appBase.ts.
    const resp = await fetch(publicAssetUrl('config.json'), {
      signal: controller.signal,
      cache: 'no-cache',
    })
    if (!resp.ok) return {}
    return validateConfig(await resp.json(), 'config.json')
  } catch {
    // Missing, offline, malformed JSON, or past the deadline — defaults win.
    return {}
  } finally {
    clearTimeout(timer)
  }
}

export async function loadConfig(timeoutMs = CONFIG_FETCH_TIMEOUT_MS): Promise<AppConfig> {
  // Already loaded
  if (_config) return _config

  // Snapshot host-injected values BEFORE the fetch — an embedder may inject
  // synchronously at document head time, and this is the highest-priority
  // source. Taking the snapshot first also means a slow JSON response can't
  // race a late injection into the wrong precedence order.
  const injected = validateConfig(window.__MISAKA_CONFIG__ ?? {}, 'window.__MISAKA_CONFIG__')
  const fetched = await fetchRuntimeJson(timeoutMs)
  const runtime = mergeRuntimeConfig(injected, fetched)

  // Publish the merged backend configuration for synchronous readers.
  window.__MISAKA_CONFIG__ = runtime

  _config = {
    API_BASE: resolveApiBase(runtime),
    WS_URL: resolveWsUrl(runtime),
  }

  return _config
}

export function getConfig(): AppConfig {
  if (!_config) {
    // If loadConfig hasn't been called yet, use what's available synchronously.
    const runtime = validateConfig(window.__MISAKA_CONFIG__ ?? {}, 'window.__MISAKA_CONFIG__')
    return {
      API_BASE: resolveApiBase(runtime),
      WS_URL: resolveWsUrl(runtime),
    }
  }
  return _config
}

/** Test helper — drop the memoised config so a new precedence can be built. */
export function __resetConfig() {
  _config = null
}

/**
 * Join `path` onto API_BASE with the URL API so a trailing slash / missing
 * slash on the base never string-concatenates into a broken route.
 * Paths are treated as relative to the base prefix (not site-root absolute).
 */
export function apiUrl(path: string): string {
  const cfg = getConfig()
  if (!cfg.API_BASE) return path
  const base = cfg.API_BASE.endsWith('/') ? cfg.API_BASE : `${cfg.API_BASE}/`
  const rel = path.startsWith('/') ? path.slice(1) : path
  return new URL(rel, base).href
}

export function wsUrl(): string {
  const cfg = getConfig()
  if (cfg.WS_URL) return cfg.WS_URL
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${location.host}/ws`
}
