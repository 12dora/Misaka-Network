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
 * `originOrNull` is the value as the request sent it (or null if absent).
 * Returns true if either:
 *   - No Origin header was sent (non-browser caller; not a CSRF vector).
 *   - Origin matches the configured allow-list.
 */
export function isOriginAllowed(originOrNull: string | null | undefined): boolean {
  if (!originOrNull) return true
  return allowedOrigins().includes(originOrNull)
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
 * OR Referer is present they MUST be in the allow-list. This blocks the
 * classic CSRF where the attacker's page can't suppress Origin.
 */
export function isHttpOriginAllowed(req: { headers: Record<string, unknown> | IncomingMessage['headers'] }): boolean {
  const origin = getRequestOrigin(req)
  if (!origin) return true
  return allowedOrigins().includes(origin)
}
