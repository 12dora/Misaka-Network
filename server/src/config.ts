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
export const CLEANUP_INTERVAL_MS = 2_000
export const DISCONNECTED_TTL_MS = 10_000            // grace period before clearing stale sessions
export const REPORT_TTL_MS = 60 * 60 * 1000         // 1 hour

// ── TURN auto-provisioning (Cloudflare Realtime TURN) ────────────────
// API token / key id / account tag MUST be supplied via env. Never hard-coded.
// Issuing short-lived credentials per session, monitored via CF Analytics.
export const TURN_AUTO_ENABLED = (process.env.TURN_AUTO_ENABLED ?? 'true').toLowerCase() === 'true'
export const TURN_PROVIDER = (process.env.TURN_PROVIDER ?? 'cloudflare').toLowerCase()
export const TURN_CF_KEY_ID = process.env.TURN_CF_KEY_ID ?? ''
export const TURN_CF_API_TOKEN = process.env.TURN_CF_API_TOKEN ?? ''
export const TURN_CF_ACCOUNT_TAG = process.env.TURN_CF_ACCOUNT_TAG ?? ''

// Per-credential lifetime. Short on purpose: revoke + deny-list take effect
// at most one TTL later even if a CF revoke call fails.
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
