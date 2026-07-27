// ── Server Configuration ─────────────────────────────────────────────
// All tuneable constants in one place.
// Runtime values are read from environment variables with documented defaults.

// ── Env parsing (CONFIG-007) ─────────────────────────────────────────
// Every numeric knob used to go through a bare `parseInt`/`parseFloat`, which
// silently accepts garbage: `parseInt('abc')` → NaN (and every `NaN >= limit`
// comparison then fails OPEN), `parseInt('10s')` → 10, `parseInt('0')` → a
// zero-millisecond interval that turns a timer into a busy loop. A deployment
// could therefore disable a security or cost control with a typo and never
// notice.
//
// The readers below validate at import time and abort the process with the
// offending variable name. Fail-fast is deliberate: a signaling server whose
// TURN kill-switch threshold is NaN must not start.

function fail(name: string, raw: string, why: string): never {
  const msg = `[config] 环境变量 ${name}="${raw}" 无效：${why}`
  console.error(msg)
  throw new Error(msg)
}

interface NumOpts { min?: number; max?: number; integer?: boolean }

function readNum(name: string, fallback: number, opts: NumOpts = {}): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const s = raw.trim()
  // `Number()` (unlike parseInt/parseFloat) refuses partial parses: '10s',
  // '1,000' and '' all become NaN instead of a plausible-looking prefix.
  const n = Number(s)
  if (!Number.isFinite(n)) fail(name, raw, '必须是有限数字')
  if (opts.integer && !Number.isInteger(n)) fail(name, raw, '必须是整数')
  if (opts.min !== undefined && n < opts.min) fail(name, raw, `不得小于 ${opts.min}`)
  if (opts.max !== undefined && n > opts.max) fail(name, raw, `不得大于 ${opts.max}`)
  return n
}

function readInt(name: string, fallback: number, opts: Omit<NumOpts, 'integer'> = {}): number {
  return readNum(name, fallback, { ...opts, integer: true })
}

function readBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const s = raw.trim().toLowerCase()
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false
  return fail(name, raw, '必须是 true/false')
}

// ── HTTP / Process ────────────────────────────────────────────────────
export const PORT = readInt('PORT', 9080, { min: 1, max: 65535 })
export const SHUTDOWN_TIMEOUT_MS = 5_000

// Whether to trust the `X-Forwarded-For` header when deriving the client IP.
// SECURITY: this MUST default to off. Every per-IP defence (register IP cap,
// brute-force lock, qr-redeem/global rate limits, TURN accounting) keys on the
// client IP; if we blindly trust a client-supplied XFF header on a directly
// internet-facing (zero-config) deployment, an attacker rotates the header per
// request and bypasses all of them. Operators running behind exactly one
// reverse proxy that appends the real client IP set `TRUST_PROXY=1` (the hop
// count); a CIDR/preset list (e.g. `loopback, 10.0.0.0/8`) is also accepted and
// passed through to Express verbatim.
function parseTrustProxy(raw: string | undefined): number | boolean | string {
  if (raw === undefined || raw === '' || raw.toLowerCase() === 'false' || raw === '0') return false
  if (raw.toLowerCase() === 'true') return true
  if (/^\d+$/.test(raw)) return parseInt(raw, 10)
  return raw
}
export const TRUST_PROXY = parseTrustProxy(process.env.TRUST_PROXY)
export const TRUST_PROXY_ENABLED = TRUST_PROXY !== false

// ── Node limits ───────────────────────────────────────────────────────
// SECURITY-014: the default used to be Infinity, so a public deployment had
// no population ceiling at all — every O(n) sweep (activity broadcast, node
// conflict scan, cleanup) grew without bound and memory with it. The default
// is now a finite, generous budget; `MAX_NODES=0` remains the explicit
// operator opt-out for "truly unlimited".
const MAX_NODES_RAW = readInt('MAX_NODES', 5000, { min: 0 })
export const MAX_NODES = MAX_NODES_RAW === 0 ? Infinity : MAX_NODES_RAW
export const MAX_NODES_PER_IP = 10
export const NODE_ID_MIN = 1
export const NODE_ID_MAX = 20001

// ── Auth & locking ────────────────────────────────────────────────────
export const MAX_ATTEMPTS = 3
export const LOCK_DURATION_MS = 5 * 60 * 1000       // 5 minutes

// ── Sessions & tokens ─────────────────────────────────────────────────
// SECURITY-001: this is an ABSOLUTE session lifetime, stamped onto the
// NodeSession at register time and enforced by the single token resolver
// (findSessionByToken), the WS message loop and the cleanup sweep. It is not
// an idle timeout — reconnecting with the same token does NOT extend it.
export const SESSION_TTL_MS = readInt('SESSION_TTL_MS', 30 * 60 * 1000, { min: 1000, max: 7 * 24 * 60 * 60 * 1000 })
export const QR_TOKEN_TTL_MS = 5 * 60 * 1000

// ── Rate limiting ─────────────────────────────────────────────────────
export const RATE_LIMIT_PER_MIN = readInt('RATE_LIMIT_PER_MIN', 60, { min: 1 })
export const RATE_WINDOW_MS = 60_000

// ── Reporting ─────────────────────────────────────────────────────────
export const REPORT_RATE_MAX = 5                     // max reports per IP per window
export const REPORT_RATE_WINDOW_MS = 10 * 60_000    // 10 minutes
export const REPORT_WARN_COUNT = 3                   // reports on same target → broadcast warning
export const REPORT_WARN_WINDOW_MS = 60_000          // 1 minute

// ── Public transfer stats (SECURITY-018) ─────────────────────────────
// /api/transfer-done is self-reported by any registered client, so the values
// have to be bounded on both axes: a realistic per-call byte ceiling (so a
// single call cannot push the public counter to Infinity) and a per-IP call
// rate (so a loop cannot inflate it either).
export const MAX_TRANSFER_BYTES = readNum('MAX_TRANSFER_BYTES', 64 * 1024 * 1024 * 1024, { min: 0, max: Number.MAX_SAFE_INTEGER })
export const TRANSFER_DONE_RATE_LIMIT = readInt('TRANSFER_DONE_RATE_LIMIT', 60, { min: 1 })
export const TRANSFER_DONE_RATE_WINDOW_MS = 60_000

// ── Cleanup ───────────────────────────────────────────────────────────
// Env overrides exist so the integration tests can run cleanup at sub-second
// cadence; production sticks with the defaults below.
export const CLEANUP_INTERVAL_MS = readInt('CLEANUP_INTERVAL_MS', 2000, { min: 50 })
export const DISCONNECTED_TTL_MS = readInt('DISCONNECTED_TTL_MS', 10000, { min: 0 })   // grace period before clearing stale sessions
export const REPORT_TTL_MS = 60 * 60 * 1000         // 1 hour

// ── TURN auto-provisioning (Cloudflare Realtime TURN) ────────────────
// API token / key id / account tag MUST be supplied via env. Never hard-coded.
// Issuing short-lived credentials per session, monitored via CF Analytics.
export const TURN_AUTO_ENABLED = readBool('TURN_AUTO_ENABLED', true)
export const TURN_PROVIDER = (process.env.TURN_PROVIDER ?? 'cloudflare').toLowerCase()
export const TURN_CF_KEY_ID = process.env.TURN_CF_KEY_ID ?? ''
export const TURN_CF_API_TOKEN = process.env.TURN_CF_API_TOKEN ?? ''
export const TURN_CF_ACCOUNT_TAG = process.env.TURN_CF_ACCOUNT_TAG ?? ''
export const TURN_CF_ANALYTICS_API_TOKEN = process.env.TURN_CF_ANALYTICS_API_TOKEN ?? TURN_CF_API_TOKEN

// Per-credential lifetime. Revocation takes effect at most one TTL later
// even if a CF revoke call fails.
export const TURN_CREDENTIAL_TTL_SEC = readInt('TURN_CREDENTIAL_TTL_SEC', 300, { min: 30, max: 86400 })

// Per-session / per-IP abuse caps.
export const TURN_MAX_BYTES_PER_SESSION = readNum('TURN_MAX_BYTES_PER_SESSION', 1073741824, { min: 0 })             // 1 GB
export const TURN_MAX_BYTES_PER_HOUR_PER_IP = readNum('TURN_MAX_BYTES_PER_HOUR_PER_IP', 10737418240, { min: 0 })    // 10 GB
export const TURN_MAX_ISSUE_PER_HOUR_PER_IP = readInt('TURN_MAX_ISSUE_PER_HOUR_PER_IP', 60, { min: 1 })

// Global monthly kill-switch (defend the free 1 TB quota).
export const TURN_GLOBAL_MONTHLY_BYTES_LIMIT = readNum('TURN_GLOBAL_MONTHLY_BYTES_LIMIT', 1099511627776, { min: 1 }) // 1 TB
export const TURN_GLOBAL_THRESHOLD_PCT = readNum('TURN_GLOBAL_THRESHOLD_PCT', 90, { min: 0, max: 100 })
export const TURN_REVOKE_ALL_ON_KILL = readBool('TURN_REVOKE_ALL_ON_KILL', false)

// Pessimistic byte estimate per credential — used by the no-delay fast path
// while CF Analytics catches up (CF reports lag 1~5 min).
export const TURN_PESSIMISTIC_RATE_BPS = readNum('TURN_PESSIMISTIC_RATE_BPS', 10000000, { min: 0 })                // 10 Mbps

// Polling cadence.
export const TURN_ABUSE_POLL_SEC = readInt('TURN_ABUSE_POLL_SEC', 30, { min: 1 })
export const TURN_GLOBAL_POLL_SEC = readInt('TURN_GLOBAL_POLL_SEC', 120, { min: 1 })

// Deny-list TTL. SECURITY-010: this was configured but read by nobody — an
// abusive session was revoked and could re-sign immediately. It now drives a
// persisted deny list (`TurnState.denyList`). 0 disables denial entirely.
export const TURN_BAN_DURATION_SEC = readInt('TURN_BAN_DURATION_SEC', 86400, { min: 0 })                            // 24h
// How many distinct abusive sessions an IP has to produce inside the deny
// window before the IP ITSELF is denied. Session-level denial is immediate;
// the IP level needs a strike count because carrier-grade NAT collapses many
// unrelated users onto one address.
export const TURN_IP_BAN_STRIKES = readInt('TURN_IP_BAN_STRIKES', 3, { min: 1 })

// BUG-022: wall-clock deadline for every Cloudflare call (credential issue,
// revoke, analytics). Without it a provider that accepts the connection and
// then never finishes parks the reservation — and the HTTP request — forever.
export const TURN_CF_TIMEOUT_MS = readInt('TURN_CF_TIMEOUT_MS', 8000, { min: 200, max: 120_000 })

// BUG-024: the analytics queries used to carry hard-coded 1,000 / 10,000 row
// limits with no pagination, so a high-cardinality month silently under-reported
// (and the monthly kill switch could therefore never trip). Per-identifier
// queries now page with a cursor; hitting MAX_PAGES is an explicit degraded
// state rather than a silent truncation.
export const TURN_ANALYTICS_PAGE_LIMIT = readInt('TURN_ANALYTICS_PAGE_LIMIT', 1000, { min: 1, max: 10_000 })
export const TURN_ANALYTICS_MAX_PAGES = readInt('TURN_ANALYTICS_MAX_PAGES', 20, { min: 1, max: 10_000 })

// SECURITY-017: bearer token that unlocks the DETAILED /api/turn-status view
// (monthly spend, threshold, kill-switch state, deny-list size). Unset means
// the detailed view is unavailable to everyone and only the coarse public
// availability is served.
export const TURN_OPERATOR_TOKEN = process.env.TURN_OPERATOR_TOKEN ?? ''

// Persistence.
export const TURN_PERSIST_DIR = process.env.TURN_PERSIST_DIR ?? './data'
export const TURN_PERSIST_INTERVAL_SEC = readInt('TURN_PERSIST_INTERVAL_SEC', 10, { min: 1 })

// ── Global brute-force freeze (per-nodeId, IP-rotation defence) ──────
// Independent of the per-(IP,nodeId) lock: this triggers when many distinct
// IPs all fail against the same nodeId, which is the classic "rotate proxies
// to keep guessing" attack. While frozen, every register attempt against
// that nodeId is rejected — even ones with the correct passcode — until the
// freeze TTL expires. The owner reconnecting from a known IP would only
// re-attach to their existing session (already open), so honest users are
// unaffected.
export const NODE_FREEZE_THRESHOLD = readInt('NODE_FREEZE_THRESHOLD', 20, { min: 1 })
export const NODE_FREEZE_WINDOW_MS = readInt('NODE_FREEZE_WINDOW_MS', 60 * 60_000, { min: 1000 })
export const NODE_FREEZE_DURATION_MS = readInt('NODE_FREEZE_DURATION_MS', 60 * 60_000, { min: 1000 })

// ── qr-redeem dedicated rate limit (per IP) ──────────────────────────
export const QR_REDEEM_RATE_LIMIT = readInt('QR_REDEEM_RATE_LIMIT', 10, { min: 1 })
export const QR_REDEEM_RATE_WINDOW_MS = 60_000

// ── customIdentifier secret + WS unauth-grace ────────────────────────
// Used to make customIdentifier opaque to anyone who only sees CF logs —
// sessionId no longer leaks through it. If unset we generate a random
// runtime secret and warn loudly; this means CF entries from before a
// restart cannot be correlated, which is the correct degraded mode for an
// unset secret. Production deployments MUST set this.
import { randomBytes } from 'crypto'
let _serverSecret = process.env.SERVER_SECRET ?? ''
if (!_serverSecret) {
  _serverSecret = randomBytes(32).toString('hex')
  console.warn('[config] SERVER_SECRET not set; using a random per-process secret. Set SERVER_SECRET in production so customIdentifier is stable across restarts.')
}
export const SERVER_SECRET = _serverSecret

// Time a freshly-opened WS has to send AUTH before we close it with 4001.
// Idle connections were free to sit forever before this, which let an
// attacker exhaust the WS server's connection limit at zero cost.
export const WS_AUTH_GRACE_MS = readInt('WS_AUTH_GRACE_MS', 5000, { min: 100 })

// ── WebSocket resource boundaries (SECURITY-002 / SECURITY-003) ──────
//
// WS_MAX_PAYLOAD_BYTES is the TRANSPORT ceiling handed to `ws` as
// `maxPayload`. It is what actually protects memory: the receiver aborts the
// connection (close 1009) as soon as the accumulated frame length crosses it,
// so an oversize or endlessly-fragmented message is never buffered in full.
// The application-level check that used to be the only limit ran *after* the
// whole message had been buffered and stringified, which is exactly the
// amplification SECURITY-002 describes.
//
// WS_MAX_MESSAGE_BYTES is the APPLICATION policy limit. It defaults to the
// same value, so out of the box the transport rejects first and the app check
// is pure defence-in-depth. Deployments that terminate WS at a proxy which
// re-frames messages can raise the transport ceiling above the policy limit;
// the app path then answers with `ERROR MESSAGE_TOO_LARGE` and drops the
// socket (1009) after WS_MAX_OVERSIZE_STRIKES violations.
export const WS_MAX_MESSAGE_BYTES = readInt('WS_MAX_MESSAGE_BYTES', 64 * 1024, { min: 1024, max: 16 * 1024 * 1024 })
export const WS_MAX_PAYLOAD_BYTES = readInt('WS_MAX_PAYLOAD_BYTES', WS_MAX_MESSAGE_BYTES, { min: 1024, max: 64 * 1024 * 1024 })
export const WS_MAX_OVERSIZE_STRIKES = readInt('WS_MAX_OVERSIZE_STRIKES', 3, { min: 1 })

// Per-socket inbound budget. A token bucket: WS_MSG_BURST messages may arrive
// back-to-back (ICE trickle really does burst), refilled at WS_MSG_RATE_PER_SEC.
// Over-budget frames are DROPPED, not queued; a socket that keeps overrunning
// for WS_MAX_RATE_VIOLATIONS frames is closed with 1008.
// Sized well above legitimate use: the WS carries only AUTH/JOIN/SDP/ICE/
// PING/BLOCK (file bytes go over the DataChannel), so even a multi-peer ICE
// trickle storm stays far below this while an abusive stream does not.
export const WS_MSG_BURST = readInt('WS_MSG_BURST', 240, { min: 1 })
export const WS_MSG_RATE_PER_SEC = readInt('WS_MSG_RATE_PER_SEC', 60, { min: 1 })
export const WS_MAX_RATE_VIOLATIONS = readInt('WS_MAX_RATE_VIOLATIONS', 200, { min: 1 })

// Slow-reader (outbound) backpressure. Above the soft mark we stop enqueueing
// forwarded/broadcast frames for that socket; above the hard mark the peer is
// not draining at all and we close it rather than let the send queue grow
// without bound.
export const WS_MAX_BUFFERED_BYTES = readInt('WS_MAX_BUFFERED_BYTES', 1024 * 1024, { min: 1024 })
export const WS_MAX_BUFFERED_HARD_BYTES = readInt('WS_MAX_BUFFERED_HARD_BYTES', 8 * 1024 * 1024, { min: 1024 })
// How long a socket may sit above the soft mark before we give up on it. A
// mobile link hiccuping through one activity burst recovers well inside this;
// a socket that never drains does not. Without the grace clock the soft mark
// alone would keep a permanently-stuck peer connected forever (we'd drop its
// frames but never reach the hard mark, because dropping is what stops the
// queue from growing).
export const WS_SLOW_CONSUMER_GRACE_MS = readInt('WS_SLOW_CONSUMER_GRACE_MS', 10_000, { min: 100 })

// ── Activity broadcast budget (SECURITY-014) ─────────────────────────
// One activity event fans out to every authenticated socket. Cap how many
// events per second may fan out at all, so a join/leave/report storm cannot
// turn into an unbounded serialize-and-send loop.
export const ACTIVITY_MAX_PER_SEC = readInt('ACTIVITY_MAX_PER_SEC', 20, { min: 1 })

// ── scrypt work budget (SECURITY-013) ────────────────────────────────
// scrypt now runs on the libuv threadpool instead of blocking the event loop,
// but the threadpool is shared with fs/dns, so unbounded concurrency would
// still starve persistence. Admissions above the queue depth are refused with
// 503 rather than queued forever.
export const SCRYPT_MAX_CONCURRENT = readInt('SCRYPT_MAX_CONCURRENT', 4, { min: 1, max: 64 })
export const SCRYPT_MAX_QUEUE = readInt('SCRYPT_MAX_QUEUE', 64, { min: 1 })

// CF revoke retry cadence (P1-6). Failed CF revoke calls are queued; this
// timer walks the queue and retries each. We keep the entry until the call
// either succeeds (drop) or the credential naturally expires (drop).
export const TURN_REVOKE_RETRY_INTERVAL_MS = readInt('TURN_REVOKE_RETRY_INTERVAL_MS', 60000, { min: 1000 })

// ── E2E-only escape hatches ──────────────────────────────────────────
// SECURITY-016: `E2E_ALLOW_UNAUTH_RELEASE_BY_IP` turns /api/release-by-ip into
// an unauthenticated "wipe every session on my apparent IP" endpoint so the
// Playwright suite can reset state between specs. It is only ever honoured
// when the process is NOT a production build; the route additionally requires
// the caller to be on the loopback interface (see http.ts). Both conditions
// have to hold, so a production misconfiguration alone cannot open it.
export const IS_PRODUCTION = (process.env.NODE_ENV ?? '').toLowerCase() === 'production'
export const E2E_UNAUTH_RELEASE_ALLOWED = !IS_PRODUCTION && process.env.E2E_ALLOW_UNAUTH_RELEASE_BY_IP === '1'
if (process.env.E2E_ALLOW_UNAUTH_RELEASE_BY_IP === '1') {
  if (E2E_UNAUTH_RELEASE_ALLOWED) {
    console.warn('[config] E2E_ALLOW_UNAUTH_RELEASE_BY_IP=1 — /api/release-by-ip accepts UNAUTHENTICATED loopback callers. Never set this outside the test harness.')
  } else {
    console.warn('[config] E2E_ALLOW_UNAUTH_RELEASE_BY_IP=1 ignored: NODE_ENV=production.')
  }
}
