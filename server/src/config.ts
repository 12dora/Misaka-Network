// ── Server Configuration ─────────────────────────────────────────────
// All tuneable constants in one place.
// Runtime values are read from environment variables with documented defaults.

// ── HTTP / Process ────────────────────────────────────────────────────
export const PORT = parseInt(process.env.PORT ?? '9080', 10)
export const SHUTDOWN_TIMEOUT_MS = 5_000

// ── Node limits ───────────────────────────────────────────────────────
export const MAX_NODES = parseInt(process.env.MAX_NODES ?? '0', 10) || Infinity
export const MAX_NODES_PER_IP = 10
export const NODE_ID_MIN = 1
export const NODE_ID_MAX = 20001

// ── Auth & locking ────────────────────────────────────────────────────
export const MAX_ATTEMPTS = 3
export const LOCK_DURATION_MS = 5 * 60 * 1000       // 5 minutes

// ── Sessions & tokens ─────────────────────────────────────────────────
export const SESSION_TTL_MS = parseInt(process.env.SESSION_TTL_MS ?? '0', 10) || 30 * 60 * 1000
export const QR_TOKEN_TTL_MS = 5 * 60 * 1000

// ── Rate limiting ─────────────────────────────────────────────────────
export const RATE_LIMIT_PER_MIN = parseInt(process.env.RATE_LIMIT_PER_MIN ?? '60', 10)
export const RATE_WINDOW_MS = 60_000

// ── Reporting ─────────────────────────────────────────────────────────
export const REPORT_RATE_MAX = 5                     // max reports per IP per window
export const REPORT_RATE_WINDOW_MS = 10 * 60_000    // 10 minutes
export const REPORT_WARN_COUNT = 3                   // reports on same target → broadcast warning
export const REPORT_WARN_WINDOW_MS = 60_000          // 1 minute

// ── Cleanup ───────────────────────────────────────────────────────────
// Env overrides exist so the integration tests can run cleanup at sub-second
// cadence; production sticks with the defaults below.
export const CLEANUP_INTERVAL_MS = parseInt(process.env.CLEANUP_INTERVAL_MS ?? '2000', 10)
export const DISCONNECTED_TTL_MS = parseInt(process.env.DISCONNECTED_TTL_MS ?? '10000', 10)   // grace period before clearing stale sessions
export const REPORT_TTL_MS = 60 * 60 * 1000         // 1 hour

// ── TURN auto-provisioning (Cloudflare Realtime TURN) ────────────────
// API token / key id / account tag MUST be supplied via env. Never hard-coded.
// Issuing short-lived credentials per session, monitored via CF Analytics.
export const TURN_AUTO_ENABLED = (process.env.TURN_AUTO_ENABLED ?? 'true').toLowerCase() === 'true'
export const TURN_PROVIDER = (process.env.TURN_PROVIDER ?? 'cloudflare').toLowerCase()
export const TURN_CF_KEY_ID = process.env.TURN_CF_KEY_ID ?? ''
export const TURN_CF_API_TOKEN = process.env.TURN_CF_API_TOKEN ?? ''
export const TURN_CF_ACCOUNT_TAG = process.env.TURN_CF_ACCOUNT_TAG ?? ''
export const TURN_CF_ANALYTICS_API_TOKEN = process.env.TURN_CF_ANALYTICS_API_TOKEN ?? TURN_CF_API_TOKEN

// Per-credential lifetime. Revocation takes effect at most one TTL later
// even if a CF revoke call fails.
export const TURN_CREDENTIAL_TTL_SEC = parseInt(process.env.TURN_CREDENTIAL_TTL_SEC ?? '300', 10)

// Per-session / per-IP abuse caps.
export const TURN_MAX_BYTES_PER_SESSION = parseFloat(process.env.TURN_MAX_BYTES_PER_SESSION ?? '1073741824')             // 1 GB
export const TURN_MAX_BYTES_PER_HOUR_PER_IP = parseFloat(process.env.TURN_MAX_BYTES_PER_HOUR_PER_IP ?? '10737418240')   // 10 GB
export const TURN_MAX_ISSUE_PER_HOUR_PER_IP = parseInt(process.env.TURN_MAX_ISSUE_PER_HOUR_PER_IP ?? '60', 10)

// Global monthly kill-switch (defend the free 1 TB quota).
export const TURN_GLOBAL_MONTHLY_BYTES_LIMIT = parseFloat(process.env.TURN_GLOBAL_MONTHLY_BYTES_LIMIT ?? '1099511627776') // 1 TB
export const TURN_GLOBAL_THRESHOLD_PCT = parseFloat(process.env.TURN_GLOBAL_THRESHOLD_PCT ?? '90')
export const TURN_REVOKE_ALL_ON_KILL = (process.env.TURN_REVOKE_ALL_ON_KILL ?? 'false').toLowerCase() === 'true'

// Pessimistic byte estimate per credential — used by the no-delay fast path
// while CF Analytics catches up (CF reports lag 1~5 min).
export const TURN_PESSIMISTIC_RATE_BPS = parseFloat(process.env.TURN_PESSIMISTIC_RATE_BPS ?? '10000000')                // 10 Mbps

// Polling cadence.
export const TURN_ABUSE_POLL_SEC = parseInt(process.env.TURN_ABUSE_POLL_SEC ?? '30', 10)
export const TURN_GLOBAL_POLL_SEC = parseInt(process.env.TURN_GLOBAL_POLL_SEC ?? '120', 10)

// Deny-list TTL.
export const TURN_BAN_DURATION_SEC = parseInt(process.env.TURN_BAN_DURATION_SEC ?? '86400', 10)                          // 24h

// Persistence.
export const TURN_PERSIST_DIR = process.env.TURN_PERSIST_DIR ?? './data'
export const TURN_PERSIST_INTERVAL_SEC = parseInt(process.env.TURN_PERSIST_INTERVAL_SEC ?? '10', 10)

// ── Global brute-force freeze (per-nodeId, IP-rotation defence) ──────
// Independent of the per-(IP,nodeId) lock: this triggers when many distinct
// IPs all fail against the same nodeId, which is the classic "rotate proxies
// to keep guessing" attack. While frozen, every register attempt against
// that nodeId is rejected — even ones with the correct passcode — until the
// freeze TTL expires. The owner reconnecting from a known IP would only
// re-attach to their existing session (already open), so honest users are
// unaffected.
export const NODE_FREEZE_THRESHOLD = parseInt(process.env.NODE_FREEZE_THRESHOLD ?? '20', 10)
export const NODE_FREEZE_WINDOW_MS = parseInt(process.env.NODE_FREEZE_WINDOW_MS ?? String(60 * 60_000), 10)
export const NODE_FREEZE_DURATION_MS = parseInt(process.env.NODE_FREEZE_DURATION_MS ?? String(60 * 60_000), 10)

// ── qr-redeem dedicated rate limit (per IP) ──────────────────────────
export const QR_REDEEM_RATE_LIMIT = parseInt(process.env.QR_REDEEM_RATE_LIMIT ?? '10', 10)
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
export const WS_AUTH_GRACE_MS = parseInt(process.env.WS_AUTH_GRACE_MS ?? '5000', 10)

// CF revoke retry cadence (P1-6). Failed CF revoke calls are queued; this
// timer walks the queue and retries each. We keep the entry until the call
// either succeeds (drop) or the credential naturally expires (drop).
export const TURN_REVOKE_RETRY_INTERVAL_MS = parseInt(process.env.TURN_REVOKE_RETRY_INTERVAL_MS ?? '60000', 10)
