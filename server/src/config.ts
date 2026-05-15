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
