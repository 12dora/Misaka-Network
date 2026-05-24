// Shared origin allow-list logic used by both HTTP (CSRF-like guard on
// state-changing routes) and the WebSocket upgrade handshake.
//
// Rationale:
//   - Browsers always send an Origin header on cross-site fetch and on every
//     WebSocket upgrade. We use that to refuse requests initiated by a
//     third-party page from talking to our signaling server even if the user
//     happens to also have a valid Misaka session token in another tab.
//   - Server-to-server / curl / native clients do NOT send an Origin header
//     and we don't want to break those (they cannot be tricked by a malicious
//     page). When Origin is missing we fall through to the existing token
//     auth.
//   - The allow-list lives in env (`ALLOWED_ORIGINS`, comma-separated) so a
//     deployment can add its production domain without a code change. We
//     always include localhost dev origins so `npm run dev` keeps working.
//
// Test scripts hit the API directly with `fetch()` from Node — Node's fetch
// does NOT set an Origin header. That's the same case as curl, so the tests
// keep passing without each test having to know about the allow-list.

import { IncomingMessage } from 'http'

const DEFAULT_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
]

let cachedList: string[] | null = null

export function allowedOrigins(): string[] {
  if (cachedList) return cachedList
  const raw = process.env.ALLOWED_ORIGINS ?? ''
  const fromEnv = raw.split(',').map(s => s.trim()).filter(Boolean)
  cachedList = Array.from(new Set([...DEFAULT_ORIGINS, ...fromEnv]))
  return cachedList
}

// Test hook — production never calls this.
export function _resetAllowedOriginsCache() {
  cachedList = null
}

/**
 * Same-origin auto-allow: if the request's Origin equals the host the request
 * was sent to (i.e. the browser is hitting our own host with our own page),
 * it is not a cross-site request by definition and cannot be CSRF. Without
 * this, single-host deployments (frontend + backend both on misaka.example)
 * would need to manually echo their own domain in ALLOWED_ORIGINS, which is
 * a foot-gun that broke production after the Origin check landed.
 */
function isSameOrigin(origin: string, req: { headers: Record<string, unknown> | IncomingMessage['headers'] }): boolean {
  const h = req.headers as Record<string, string | string[] | undefined>
  const host = typeof h['host'] === 'string' ? h['host'] : undefined
  if (!host) return false
  // Behind Caddy/nginx the original scheme is in X-Forwarded-Proto.
  const xfProto = typeof h['x-forwarded-proto'] === 'string' ? h['x-forwarded-proto'] : undefined
  const scheme = xfProto || (typeof (h as { encrypted?: unknown }).encrypted !== 'undefined' ? 'https' : 'http')
  return origin === `${scheme}://${host}` || origin === `https://${host}` || origin === `http://${host}`
}

/**
 * Header-less variant kept for callers that only have the Origin string and no
 * request context. Auto-allow rules can't apply here so it still consults the
 * static allowlist only.
 */
export function isOriginAllowed(originOrNull: string | null | undefined): boolean {
  if (!originOrNull) return true
  return allowedOrigins().includes(originOrNull)
}

/**
 * Request-aware Origin check. Allows the request when ANY of:
 *   - No Origin header (non-browser caller — not a CSRF vector).
 *   - Origin in the configured allow-list.
 *   - Origin equals the request's own host (same-origin deployment).
 */
export function isOriginAllowedForRequest(req: { headers: Record<string, unknown> | IncomingMessage['headers'] }): boolean {
  const h = req.headers as Record<string, string | string[] | undefined>
  const origin = typeof h['origin'] === 'string' ? h['origin'] : undefined
  if (!origin) return true
  if (allowedOrigins().includes(origin)) return true
  return isSameOrigin(origin, req)
}

export function getRequestOrigin(req: { headers: Record<string, unknown> | IncomingMessage['headers'] }): string | null {
  const h = req.headers as Record<string, string | string[] | undefined>
  const origin = h['origin']
  if (typeof origin === 'string' && origin.length > 0) return origin
  // Fall back to Referer's origin only for state-changing HTTP routes.
  const referer = h['referer'] ?? h['referrer']
  if (typeof referer === 'string') {
    try {
      const u = new URL(referer)
      return `${u.protocol}//${u.host}`
    } catch { /* invalid url, treat as no origin */ }
  }
  return null
}

/**
 * Stricter variant for HTTP CSRF-sensitive routes (e.g. /api/register):
 * we still allow missing Origin (non-browser caller), but if either Origin
 * OR Referer is present they MUST be in the allow-list OR same-origin. This
 * blocks the classic CSRF where the attacker's page can't suppress Origin,
 * while still letting same-host production deployments work zero-config.
 */
export function isHttpOriginAllowed(req: { headers: Record<string, unknown> | IncomingMessage['headers'] }): boolean {
  const origin = getRequestOrigin(req)
  if (!origin) return true
  if (allowedOrigins().includes(origin)) return true
  return isSameOrigin(origin, req)
}
