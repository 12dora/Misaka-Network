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
import { TRUST_PROXY_ENABLED } from './config.js'

// Express' compiled `trust proxy fn`, installed from index.ts. Same predicate
// the WS IP path uses — Origin scheme resolution must never honour
// X-Forwarded-Proto from an untrusted peer just because *some* trust policy
// is configured (CIDR/preset).
type TrustFn = (addr: string, hopIndex: number) => boolean
let trustProxyFn: TrustFn | null = null

export function setOriginTrustProxyFn(fn: TrustFn) {
  trustProxyFn = fn
}

const DEFAULT_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
]

let cachedList: string[] | null = null
let cachedWildcard: boolean | null = null

/**
 * "Public signaling" mode — server accepts any Origin. Triggered by:
 *   - ALLOWED_ORIGINS=*     → explicit opt-in.
 *   - ALLOWED_ORIGINS unset → default. The project's design goal is "low-
 *     barrier public signaling": anyone in the world should be able to
 *     point a fork at this server. CSRF risk is mitigated by the other
 *     defences (scrypt 6-digit passcode, 5s WS AUTH grace, per-nodeId
 *     global brute-force freeze, per-IP rate limits, 64KB body cap).
 *
 * Private deployments lock down by setting `ALLOWED_ORIGINS` to an
 * explicit comma-separated list of trusted browser origins.
 */
export function isWildcardOriginMode(): boolean {
  if (cachedWildcard !== null) return cachedWildcard
  const raw = process.env.ALLOWED_ORIGINS
  // Treat "unset" (undefined) and "*" identically. An EMPTY string is
  // explicit lockdown intent — keep strict in that case so an operator
  // who writes `ALLOWED_ORIGINS=` doesn't silently get wildcard.
  cachedWildcard = raw === undefined || raw.trim() === '*'
  return cachedWildcard
}

/**
 * Three distinct modes:
 *   - unset / `*`  → wildcard (public signaling); allowlist is just dev defaults
 *   - explicit empty (`ALLOWED_ORIGINS=`) → total lockdown: NO browser origin,
 *     not even the localhost defaults
 *   - comma list → those origins UNION the localhost defaults (so `npm run dev`
 *     still works without every private deploy listing localhost)
 */
export function allowedOrigins(): string[] {
  if (cachedList) return cachedList
  const raw = process.env.ALLOWED_ORIGINS
  if (raw === undefined || raw.trim() === '*') {
    cachedList = [...DEFAULT_ORIGINS]
    return cachedList
  }
  // Explicit empty → total lockdown. Documented as "no browser origin".
  if (raw.trim() === '') {
    cachedList = []
    return cachedList
  }
  const fromEnv = raw.split(',').map(s => s.trim()).filter(s => s.length > 0 && s !== '*')
  cachedList = Array.from(new Set([...DEFAULT_ORIGINS, ...fromEnv]))
  return cachedList
}

// Test hook — production never calls this.
export function _resetAllowedOriginsCache() {
  cachedList = null
  cachedWildcard = null
}

/**
 * Same-origin auto-allow: if the request's Origin equals the host the request
 * was sent to (i.e. the browser is hitting our own host with our own page),
 * it is not a cross-site request by definition and cannot be CSRF. Without
 * this, single-host deployments (frontend + backend both on misaka.example)
 * would need to manually echo their own domain in ALLOWED_ORIGINS, which is
 * a foot-gun that broke production after the Origin check landed.
 */
/**
 * Derive the single external scheme the request was served under.
 *
 * Prefer Express's request-aware `protocol` (already applies the compiled
 * trust-proxy predicate to the immediate peer). Fall back to the same
 * predicate for plain IncomingMessage / test stubs: X-Forwarded-Proto is
 * honoured ONLY when the peer address is a trusted hop. `TRUST_PROXY_ENABLED`
 * alone is not enough — under a CIDR/preset, a direct untrusted caller must
 * not unlock `Origin: https://Host` by spoofing XFP.
 */
function externalScheme(req: {
  headers: Record<string, unknown> | IncomingMessage['headers']
  secure?: boolean
  protocol?: string
  socket?: { encrypted?: boolean; remoteAddress?: string | null }
}): string {
  // Express Request: protocol getter already walks trust-proxy correctly.
  if (typeof req.protocol === 'string') {
    const p = req.protocol.toLowerCase()
    if (p === 'http' || p === 'https') return p
  }

  const peer = req.socket?.remoteAddress ?? undefined
  const peerTrusted = Boolean(
    TRUST_PROXY_ENABLED
    && trustProxyFn
    && peer
    && trustProxyFn(peer, 0),
  )
  if (peerTrusted) {
    const h = req.headers as Record<string, string | string[] | undefined>
    const xfRaw = h['x-forwarded-proto']
    const xf = typeof xfRaw === 'string' ? xfRaw.split(',')[0]?.trim().toLowerCase() : undefined
    if (xf === 'http' || xf === 'https') return xf
  }
  if (req.secure === true) return 'https'
  if (req.socket?.encrypted === true) return 'https'
  return 'http'
}

/** True when the operator set ALLOWED_ORIGINS= (empty) for total lockdown. */
export function isEmptyOriginLockdown(): boolean {
  return !isWildcardOriginMode() && allowedOrigins().length === 0
}

function isSameOrigin(origin: string, req: {
  headers: Record<string, unknown> | IncomingMessage['headers']
  secure?: boolean
  protocol?: string
  socket?: { encrypted?: boolean; remoteAddress?: string | null }
}): boolean {
  const h = req.headers as Record<string, string | string[] | undefined>
  const host = typeof h['host'] === 'string' ? h['host'] : undefined
  if (!host) return false
  const scheme = externalScheme(req)
  return origin === `${scheme}://${host}`
}

/**
 * Header-less variant kept for callers that only have the Origin string and no
 * request context. Auto-allow rules can't apply here so it consults the static
 * allowlist (or wildcard mode).
 */
export function isOriginAllowed(originOrNull: string | null | undefined): boolean {
  if (!originOrNull) return true
  if (isWildcardOriginMode()) return true
  return allowedOrigins().includes(originOrNull)
}

/**
 * Request-aware Origin check. Allows the request when ANY of:
 *   - Wildcard mode (ALLOWED_ORIGINS=*) is on.
 *   - No Origin header (non-browser caller — not a CSRF vector).
 *   - Origin in the configured allow-list.
 *   - Origin equals the request's own host (same-origin deployment).
 *
 * Explicit empty lockdown (`ALLOWED_ORIGINS=`) short-circuits browser Origins
 * — same-origin auto-allow is intentionally OFF so the operator's lockdown
 * is total.
 */
export function isOriginAllowedForRequest(req: { headers: Record<string, unknown> | IncomingMessage['headers'] }): boolean {
  if (isWildcardOriginMode()) return true
  const h = req.headers as Record<string, string | string[] | undefined>
  const origin = typeof h['origin'] === 'string' ? h['origin'] : undefined
  if (!origin) return true
  if (isEmptyOriginLockdown()) return false
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
 *
 * Explicit empty lockdown refuses every browser-supplied Origin/Referer.
 */
export function isHttpOriginAllowed(req: { headers: Record<string, unknown> | IncomingMessage['headers'] }): boolean {
  if (isWildcardOriginMode()) return true
  const origin = getRequestOrigin(req)
  if (!origin) return true
  if (isEmptyOriginLockdown()) return false
  if (allowedOrigins().includes(origin)) return true
  return isSameOrigin(origin, req)
}
