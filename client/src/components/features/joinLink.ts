// SECURITY-006 — allow-list for anything the QR scanner is about to hand to
// `window.location.href`.
//
// The previous implementation did `new URL(raw)` and, on success, navigated:
// same-origin values kept their path, everything else was assigned verbatim.
// That accepted `https://phishing.example/…`, `javascript:alert(1)` and
// `data:text/html,…` — a scanned or pasted code could navigate the user off
// the app entirely, and script execution was left to the browser and CSP.
//
// Rules enforced here (all must hold):
//   1. scheme is `http:`/`https:` — or the `misaka://` app scheme, which is
//      rewritten onto our own origin before validation;
//   2. no embedded credentials (`https://user:pw@host/`);
//   3. origin is exactly `location.origin`;
//   4. path is exactly the configured join route (`appPath('/join')`);
//   5. every query parameter is on the allow-list and passes its own
//      format/range check; unknown parameters are rejected outright;
//   6. the fragment is dropped.
//
// The return value is a *relative* path, never a caller-supplied string, so
// there is no way for an unvalidated value to reach the navigation.

import { appPath } from '@/lib/appBase'
import { NODE_ID_MAX, NODE_ID_MIN } from '@/constants'

export type JoinLinkRejection =
  | 'EMPTY'
  | 'MALFORMED'
  | 'BAD_SCHEME'
  | 'HAS_CREDENTIALS'
  | 'FOREIGN_ORIGIN'
  | 'WRONG_ROUTE'
  | 'BAD_PARAM'

export type ParsedJoinLink =
  | { ok: true; path: string }
  | { ok: false; reason: JoinLinkRejection }

const APP_SCHEME = 'misaka://'
const ALLOWED_TYPES = new Set(['node', 'file', 'channel'])
/** QR tokens are server-generated opaque ids; keep the charset tight. */
const TOKEN_RE = /^[A-Za-z0-9_-]{8,128}$/
/** file-session / channel ids are uuid-ish opaque ids. */
const OPAQUE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
/** `c` carries a base64 passcode (btoa of six digits → 8 chars). */
const B64_RE = /^[A-Za-z0-9+/]{1,32}={0,2}$/

const ALLOWED_PARAMS = new Set(['type', 'id', 't', 'fid', 'cid', 'c'])

function normalisePath(p: string): string {
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p
}

/**
 * Validate a scanned/pasted value and return the same-origin relative path
 * to navigate to.
 *
 * @param origin injected for tests; defaults to the live document origin.
 * @param joinRoute injected for tests; defaults to the configured app base.
 */
export function parseJoinLink(
  raw: string,
  origin: string = typeof location !== 'undefined' ? location.origin : '',
  joinRoute: string = appPath('/join'),
): ParsedJoinLink {
  const input = (raw ?? '').trim()
  if (!input) return { ok: false, reason: 'EMPTY' }

  let candidate = input

  // `misaka://join?...` is our own app scheme. Rewrite it onto our origin so
  // it goes through exactly the same route/param validation as an https URL.
  if (candidate.toLowerCase().startsWith(APP_SCHEME)) {
    const rest = candidate.slice(APP_SCHEME.length)
    const withSlash = rest.startsWith('/') ? rest : `/${rest}`
    candidate = `${origin}${withSlash}`
  }

  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return { ok: false, reason: 'MALFORMED' }
  }

  // `javascript:`, `data:`, `blob:`, `file:`, `vbscript:`, custom schemes…
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'BAD_SCHEME' }
  }
  // `https://evil@our.origin/...` renders as our origin in some UIs but the
  // credentials are sent to the host; refuse rather than strip.
  if (url.username || url.password) {
    return { ok: false, reason: 'HAS_CREDENTIALS' }
  }
  if (!origin || url.origin !== origin) {
    return { ok: false, reason: 'FOREIGN_ORIGIN' }
  }
  if (normalisePath(url.pathname) !== normalisePath(joinRoute)) {
    return { ok: false, reason: 'WRONG_ROUTE' }
  }

  const params = url.searchParams
  for (const key of params.keys()) {
    if (!ALLOWED_PARAMS.has(key)) return { ok: false, reason: 'BAD_PARAM' }
    // Repeated keys let an attacker smuggle a second value past a naive
    // `get()`-based consumer (Join.tsx reads the first).
    if (params.getAll(key).length > 1) return { ok: false, reason: 'BAD_PARAM' }
  }

  const type = params.get('type') ?? 'node'
  if (!ALLOWED_TYPES.has(type)) return { ok: false, reason: 'BAD_PARAM' }

  const rawId = params.get('id')
  if (rawId === null || !/^\d{1,6}$/.test(rawId)) return { ok: false, reason: 'BAD_PARAM' }
  const id = Number(rawId)
  if (!Number.isInteger(id) || id < NODE_ID_MIN || id > NODE_ID_MAX) {
    return { ok: false, reason: 'BAD_PARAM' }
  }

  const token = params.get('t')
  if (!token || !TOKEN_RE.test(token)) return { ok: false, reason: 'BAD_PARAM' }

  for (const key of ['fid', 'cid'] as const) {
    const v = params.get(key)
    if (v !== null && !OPAQUE_ID_RE.test(v)) return { ok: false, reason: 'BAD_PARAM' }
  }

  const c = params.get('c')
  if (c !== null && !B64_RE.test(c)) return { ok: false, reason: 'BAD_PARAM' }

  // Rebuild the query from validated values only — never echo the caller's
  // raw search string, and drop the fragment.
  const clean = new URLSearchParams()
  clean.set('type', type)
  clean.set('id', String(id))
  clean.set('t', token)
  if (params.get('fid')) clean.set('fid', params.get('fid') as string)
  if (params.get('cid')) clean.set('cid', params.get('cid') as string)
  if (c) clean.set('c', c)

  return { ok: true, path: `${normalisePath(joinRoute)}?${clean.toString()}` }
}

/** User-facing copy for a rejection. Never echoes the rejected value. */
export function describeJoinLinkRejection(reason: JoinLinkRejection): string {
  switch (reason) {
    case 'EMPTY':
      return '请扫描或粘贴本站生成的接入链接。'
    case 'FOREIGN_ORIGIN':
    case 'BAD_SCHEME':
    case 'HAS_CREDENTIALS':
      return '仅扫描御坂网络接入码。请扫描或粘贴本站生成的接入链接。'
    case 'WRONG_ROUTE':
    case 'BAD_PARAM':
    case 'MALFORMED':
    default:
      return '请扫描或粘贴本站生成的接入链接。'
  }
}
