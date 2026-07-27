// ── Cloudflare Realtime TURN — auto provisioning + abuse policy ──────
// Issues short-lived TURN credentials per WS session, monitors usage via
// CF GraphQL Analytics, and applies per-session / per-IP / global limits.
//
// Security model:
//   - API token (TURN_CF_API_TOKEN) is read from env, never logged, never
//     returned to clients.
//   - All enforcement runs server-side. Clients are pure consumers: a hooked
//     client cannot grant itself credentials, raise its byte cap, or evade
//     — every issuance round-trips through this module.
//   - Credentials are short (default 5 min) so a failed CF revoke still
//     bounds the abuse window. CF revoke is best-effort on top.
//   - We FAIL CLOSED: if the persisted TURN state could not be loaded
//     (SECURITY-009) we refuse to issue rather than spend against an unknown
//     month, and every provider call carries a deadline (BUG-022) so a stalled
//     Cloudflare can never park a reservation forever.

import { randomBytes, timingSafeEqual } from 'crypto'
import {
  TURN_AUTO_ENABLED, TURN_PROVIDER, TURN_CF_KEY_ID, TURN_CF_API_TOKEN, TURN_CF_ACCOUNT_TAG, TURN_CF_ANALYTICS_API_TOKEN,
  TURN_CREDENTIAL_TTL_SEC,
  TURN_MAX_BYTES_PER_SESSION, TURN_MAX_BYTES_PER_HOUR_PER_IP, TURN_MAX_ISSUE_PER_HOUR_PER_IP,
  TURN_GLOBAL_MONTHLY_BYTES_LIMIT, TURN_GLOBAL_THRESHOLD_PCT, TURN_REVOKE_ALL_ON_KILL,
  TURN_PESSIMISTIC_RATE_BPS,
  TURN_ABUSE_POLL_SEC, TURN_GLOBAL_POLL_SEC, TURN_REVOKE_RETRY_INTERVAL_MS,
  TURN_BAN_DURATION_SEC, TURN_IP_BAN_STRIKES,
  TURN_CF_TIMEOUT_MS, TURN_ANALYTICS_PAGE_LIMIT, TURN_ANALYTICS_MAX_PAGES,
  TURN_OPERATOR_TOKEN,
} from './config.js'
import {
  getTurnState, markDirty, rollMonthIfNeeded, isTurnStateReady, markTurnStateRecovered,
  type ActiveCredential,
} from './persist.js'
import { deriveCustomIdentifier, redactCustomIdentifier } from './store.js'

const CF_API_BASE = 'https://rtc.live.cloudflare.com/v1'
const CF_GRAPHQL = 'https://api.cloudflare.com/client/v4/graphql'

export type IssueResult =
  | { ok: true; iceServers: RTCIceServerLike[]; expiresAt: number; customIdentifier: string }
  | { ok: false; reason: IssueReject }

export type IssueReject =
  | 'DISABLED'
  | 'NOT_CONFIGURED'
  | 'STATE_UNAVAILABLE'
  | 'GLOBAL_QUOTA_EXCEEDED'
  | 'IP_RATE_LIMITED'
  | 'IP_BYTES_LIMITED'
  | 'IP_BANNED'
  | 'SESSION_BANNED'
  | 'CF_ERROR'

export interface RTCIceServerLike {
  urls: string | string[]
  username?: string
  credential?: string
}

// ── Provider error taxonomy (BUG-022 / SECURITY-017) ─────────────────
// Raw Cloudflare diagnostics stay in the server log. Everything that leaves
// this module — including the operator status view — carries one of these
// stable codes instead.
export type CfErrorCode = 'CF_TIMEOUT' | 'CF_HTTP' | 'CF_NETWORK' | 'CF_SCHEMA' | 'CF_GRAPHQL'

class CfError extends Error {
  constructor(public readonly code: CfErrorCode, message: string) {
    super(message)
    this.name = 'CfError'
  }
}

function errorCodeOf(err: unknown): CfErrorCode {
  return err instanceof CfError ? err.code : 'CF_NETWORK'
}

let pollers: NodeJS.Timeout[] = []
let initialGlobalPoller: NodeJS.Timeout | null = null

// ── Public API ───────────────────────────────────────────────────────

export function turnConfigured(): boolean {
  return TURN_AUTO_ENABLED
    && TURN_PROVIDER === 'cloudflare'
    && !!TURN_CF_KEY_ID
    && !!TURN_CF_API_TOKEN
    && !!TURN_CF_ACCOUNT_TAG
}

// SECURITY-008: one in-flight issuance per session plus the currently valid
// credential, both keyed by customIdentifier (a deterministic derivation of the
// sessionId). Without this, N concurrent /api/turn-credentials calls for one
// session each reserved their own quota row and then all wrote the SAME
// accounting key — six Cloudflare grants behind a single 10-byte entry. The
// credential itself is deliberately memory-only: it is a live secret and has no
// business in the on-disk snapshot.
interface CachedCredential {
  reservationId: string
  iceServers: RTCIceServerLike[]
  expiresAt: number
}
const credentialCache = new Map<string, CachedCredential>()
const inFlightIssues = new Map<string, Promise<IssueResult>>()

/** Don't hand out a cached credential that is about to expire mid-call. */
function reuseFloorMs(): number {
  return Math.max(15_000, Math.floor(TURN_CREDENTIAL_TTL_SEC * 1000 * 0.1))
}

function dropCachedCredential(customIdentifier: string) {
  credentialCache.delete(customIdentifier)
}

/**
 * Issue short-lived TURN credentials for a session. All gates run here so
 * that a malicious client cannot bypass enforcement by hooking its own code.
 */
export async function issueCredentials(sessionId: string, ip: string): Promise<IssueResult> {
  if (!TURN_AUTO_ENABLED) return { ok: false, reason: 'DISABLED' }
  if (!turnConfigured()) return { ok: false, reason: 'NOT_CONFIGURED' }
  // SECURITY-009: an unreadable snapshot means we do not know this month's
  // spend, which locks and freezes are live, or whether the kill switch was
  // engaged. Refuse rather than spend blind.
  if (!isTurnStateReady()) return { ok: false, reason: 'STATE_UNAVAILABLE' }

  const state = getTurnState()
  const now = Date.now()

  rollMonthIfNeeded()
  pruneIssuanceHistory(now)
  pruneActiveCredentials(now)
  pruneIpByteLedger(now)
  pruneDenyList(now)

  // Global kill-switch
  if (state.monthlyUsage.killSwitchActive) {
    return { ok: false, reason: 'GLOBAL_QUOTA_EXCEEDED' }
  }

  // customIdentifier is a one-way derivation of (sessionId, SERVER_SECRET);
  // CF logs never see the sessionId directly.
  const customIdentifier = deriveCustomIdentifier(sessionId)

  // SECURITY-010: durable denial. Checked before the cache so a session that
  // was revoked for abuse cannot keep replaying its cached grant.
  if (isDenied(`ip:${ip}`, now)) return { ok: false, reason: 'IP_BANNED' }
  if (isDenied(`cid:${customIdentifier}`, now)) return { ok: false, reason: 'SESSION_BANNED' }

  const running = inFlightIssues.get(customIdentifier)
  if (running) return running

  const cached = credentialCache.get(customIdentifier)
  if (cached) {
    const stillReserved = state.activeCredentials[customIdentifier]?.reservationId === cached.reservationId
    if (stillReserved && cached.expiresAt - now > reuseFloorMs()) {
      return { ok: true, iceServers: cached.iceServers, expiresAt: cached.expiresAt, customIdentifier }
    }
    dropCachedCredential(customIdentifier)
  }

  const task = issueFreshCredentials(sessionId, ip, customIdentifier)
  inFlightIssues.set(customIdentifier, task)
  try {
    return await task
  } finally {
    inFlightIssues.delete(customIdentifier)
  }
}

async function issueFreshCredentials(sessionId: string, ip: string, customIdentifier: string): Promise<IssueResult> {
  const state = getTurnState()
  const now = Date.now()

  // Per-IP issuance rate (anti-spam: small file with the request count itself)
  const issueWindowStart = now - 60 * 60 * 1000
  const recentIssuesForIp = state.ipIssuanceHistory.filter(r => r.ip === ip && r.issuedAt >= issueWindowStart).length
  if (recentIssuesForIp >= TURN_MAX_ISSUE_PER_HOUR_PER_IP) {
    return { ok: false, reason: 'IP_RATE_LIMITED' }
  }

  // Per-IP hourly byte cap: in-flight pessimistic estimate for still-active
  // credentials PLUS CF-confirmed actual bytes of expired credentials over the
  // rolling hour. (The old active-only sum could never accumulate an hour since
  // credentials are pruned at their 5-min TTL — see sumHourlyBytesForIp.)
  const hourlyIpBytes = sumHourlyBytesForIp(ip, now)
  if (hourlyIpBytes >= TURN_MAX_BYTES_PER_HOUR_PER_IP) {
    return { ok: false, reason: 'IP_BYTES_LIMITED' }
  }

  const expiresAt = now + TURN_CREDENTIAL_TTL_SEC * 1000
  const pessimisticBytes = Math.floor((TURN_PESSIMISTIC_RATE_BPS / 8) * TURN_CREDENTIAL_TTL_SEC)
  const reservationId = randomBytes(8).toString('hex')

  // RESERVE the slot synchronously BEFORE the CF round-trip. The cap checks
  // above read state that is only mutated here; `await cfGenerateCredentials`
  // yields the event loop, so if we mutated only after the await, N concurrent
  // requests from one IP would all observe pre-mutation state and blow past
  // both the issuance-rate and per-IP byte caps (TOCTOU). Reserving first makes
  // check-and-reserve atomic on the single-threaded loop; we roll back on CF
  // failure below.
  const active: ActiveCredential = {
    sessionId,
    customIdentifier,
    ip,
    issuedAt: now,
    expiresAt,
    pessimisticBytes,
    reservationId,
  }
  const issuanceRecord = { ip, issuedAt: now }
  state.activeCredentials[customIdentifier] = active
  state.ipIssuanceHistory.push(issuanceRecord)
  state.monthlyUsage.pessimisticBytesObserved += pessimisticBytes
  state.monthlyUsage.bytesObserved = Math.max(
    state.monthlyUsage.cfBytesObserved,
    state.monthlyUsage.pessimisticBytesObserved,
  )
  markDirty()

  // BUG-023: evaluate the global threshold against the PROJECTED usage right
  // here — synchronously, between the reservation and the provider call. It
  // used to run only after the await, so every request in a burst saw the
  // switch still off and called Cloudflare, and a burst could overshoot the
  // threshold arbitrarily far.
  //
  // Cross-threshold policy (deliberate): at most ONE reservation may cross the
  // threshold. The request that crosses it is honoured — its bytes are already
  // reserved, and refunding them would simply let the identical burst repeat —
  // while every subsequent request is refused above, before any provider call.
  // A provider failure rolls that reservation back but does NOT un-trip the
  // switch; only an authoritative Cloudflare sync clears it.
  evaluateGlobalKillSwitch()

  let cfResp: unknown
  let iceServers: RTCIceServerLike[]
  try {
    cfResp = await cfGenerateCredentials(customIdentifier, TURN_CREDENTIAL_TTL_SEC)
    // BUG-022: a 200 with an unexpected body used to fall through to an EMPTY
    // iceServers array and still be reported as a success.
    iceServers = normalizeIceServers(cfResp)
  } catch (err) {
    rollbackReservation(customIdentifier, reservationId, issuanceRecord, pessimisticBytes)
    console.error('[turn] cf issue failed for', redactCustomIdentifier(customIdentifier), '-',
      errorCodeOf(err), (err as Error).message)
    return { ok: false, reason: 'CF_ERROR' }
  }

  credentialCache.set(customIdentifier, { reservationId, iceServers, expiresAt })
  return { ok: true, iceServers, expiresAt, customIdentifier }
}

/**
 * SECURITY-008: roll back ONLY the instance that failed. Comparing the
 * reservationId means a late failure can never delete a sibling reservation
 * that succeeded under the same (deterministic) customIdentifier, and splicing
 * the issuance record by identity means we never drop somebody else's row.
 */
function rollbackReservation(
  customIdentifier: string,
  reservationId: string,
  issuanceRecord: { ip: string; issuedAt: number },
  pessimisticBytes: number,
) {
  const state = getTurnState()
  const current = state.activeCredentials[customIdentifier]
  if (current && current.reservationId === reservationId) {
    delete state.activeCredentials[customIdentifier]
    dropCachedCredential(customIdentifier)
  }
  const idx = state.ipIssuanceHistory.indexOf(issuanceRecord)
  if (idx >= 0) state.ipIssuanceHistory.splice(idx, 1)
  state.monthlyUsage.pessimisticBytesObserved = Math.max(0, state.monthlyUsage.pessimisticBytesObserved - pessimisticBytes)
  state.monthlyUsage.bytesObserved = Math.max(
    state.monthlyUsage.cfBytesObserved,
    state.monthlyUsage.pessimisticBytesObserved,
  )
  markDirty()
}

/**
 * Best-effort revoke. Used both on abuse and on global kill (if configured).
 * Logs failures but never throws to caller. Returns whether the CF call
 * succeeded; callers that care use it to decide whether to drop or queue
 * the entry for retry.
 */
export async function revokeCustomIdentifier(customIdentifier: string): Promise<boolean> {
  const url = `${CF_API_BASE}/turn/keys/${encodeURIComponent(TURN_CF_KEY_ID)}/credentials/${encodeURIComponent(customIdentifier)}/revoke`
  try {
    await withDeadline(async (signal) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${TURN_CF_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        signal,
      })
      if (!res.ok) throw new CfError('CF_HTTP', `revoke: HTTP ${res.status}`)
    }, 'revoke')
    dropCachedCredential(customIdentifier)
    return true
  } catch (err) {
    console.error(`[turn] revoke ${redactCustomIdentifier(customIdentifier)} failed:`,
      errorCodeOf(err), (err as Error).message)
    return false
  }
}

// ── Deny list (SECURITY-010) ─────────────────────────────────────────

function pruneDenyList(now: number) {
  const state = getTurnState()
  let changed = false
  for (const [key, entry] of Object.entries(state.denyList)) {
    if (entry.until <= now) {
      delete state.denyList[key]
      changed = true
    }
  }
  if (changed) markDirty()
}

function isDenied(key: string, now: number): boolean {
  const entry = getTurnState().denyList[key]
  return !!entry && entry.until > now
}

/**
 * Persist a denial for the abusive session and, once an IP has produced enough
 * abusive sessions, for the IP itself. Session denial is immediate; the IP
 * level needs a strike count because carrier-grade NAT collapses many unrelated
 * users onto one address. `TURN_BAN_DURATION_SEC=0` disables denial entirely.
 */
function applyDeny(customIdentifier: string, ip: string, reason: string) {
  if (TURN_BAN_DURATION_SEC <= 0) return
  const state = getTurnState()
  const now = Date.now()
  const until = now + TURN_BAN_DURATION_SEC * 1000
  state.denyList[`cid:${customIdentifier}`] = { until, at: now, reason, ip }

  const strikes = Object.entries(state.denyList)
    .filter(([key, entry]) => key.startsWith('cid:') && entry.ip === ip && entry.until > now)
    .length
  if (strikes >= TURN_IP_BAN_STRIKES) {
    state.denyList[`ip:${ip}`] = { until, at: now, reason: `${reason}_STRIKES_${strikes}`, ip }
    console.warn(`[turn] deny ip ${ip} for ${TURN_BAN_DURATION_SEC}s after ${strikes} abusive session(s)`)
  }
  markDirty()
}

// ── Status ───────────────────────────────────────────────────────────

/**
 * SECURITY-017: what an UNAUTHENTICATED caller may know. Coarse availability
 * only — no spend, no limit, no threshold, no kill-switch state, no provider
 * diagnostics. A client needs exactly one bit to decide whether to bother
 * asking for credentials; anything more is cost/kill-switch reconnaissance.
 */
export function getPublicTurnStatus() {
  const configured = turnConfigured()
  const state = getTurnState()
  let reason: 'DISABLED' | 'NOT_CONFIGURED' | 'UNAVAILABLE' | undefined
  if (!TURN_AUTO_ENABLED) reason = 'DISABLED'
  else if (!configured) reason = 'NOT_CONFIGURED'
  else if (!isTurnStateReady() || state.monthlyUsage.killSwitchActive) reason = 'UNAVAILABLE'
  return {
    enabled: TURN_AUTO_ENABLED,
    configured,
    provider: TURN_PROVIDER,
    credentialTtlSec: TURN_CREDENTIAL_TTL_SEC,
    available: reason === undefined,
    ...(reason ? { reason } : {}),
    detailed: false as const,
  }
}

/** Detailed view — operator-authenticated only. Still carries no secrets. */
export function getOperatorTurnStatus() {
  const state = getTurnState()
  const u = state.monthlyUsage
  const limit = TURN_GLOBAL_MONTHLY_BYTES_LIMIT
  const used = u.lastCfSyncAt > 0 ? u.cfBytesObserved : u.bytesObserved
  const stateReady = isTurnStateReady()
  const degradedReason = !stateReady ? 'STATE_UNAVAILABLE'
    : u.analyticsTruncated === true ? 'ANALYTICS_TRUNCATED'
    : u.lastCfSyncErrorCode
  let revokePendingCount = 0
  for (const c of Object.values(state.activeCredentials)) if (c.revokePending) revokePendingCount++
  return {
    ...getPublicTurnStatus(),
    detailed: true as const,
    monthKey: u.monthKey,
    monthlyBytesUsed: used,
    monthlyBytesEffective: u.bytesObserved,
    monthlyUsageSource: u.lastCfSyncAt > 0 ? 'cloudflare' : 'pessimistic',
    monthlyBytesLimit: limit,
    percentUsed: limit > 0 ? (used / limit) * 100 : 0,
    thresholdPct: TURN_GLOBAL_THRESHOLD_PCT,
    killSwitchActive: u.killSwitchActive,
    killSwitchTriggeredAt: u.killSwitchTriggeredAt,
    lastCfSyncAt: u.lastCfSyncAt,
    // Stable code only — the raw Cloudflare text never leaves the log.
    ...(u.lastCfSyncErrorCode ? { lastCfSyncErrorCode: u.lastCfSyncErrorCode } : {}),
    activeCredentials: Object.keys(state.activeCredentials).length,
    revokePendingCount,
    denyListSize: Object.keys(state.denyList).length,
    stateLoaded: stateReady,
    analyticsTruncated: u.analyticsTruncated === true,
    degraded: degradedReason !== undefined,
    ...(degradedReason ? { degradedReason } : {}),
  }
}

/** Back-compat alias: the operator view is the historical `getTurnStatus()`. */
export function getTurnStatus() {
  return getOperatorTurnStatus()
}

export type TurnStatusAudience = 'public' | 'operator' | 'invalid'

/**
 * Classify an Authorization header for /api/turn-status. No header at all →
 * public. A Bearer that doesn't match (or any Bearer when no operator token is
 * configured) → invalid, so an operator notices a typo instead of silently
 * getting the coarse view.
 */
export function classifyTurnStatusAuth(authHeader: string | undefined): TurnStatusAudience {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return 'public'
  if (!TURN_OPERATOR_TOKEN) return 'invalid'
  const provided = Buffer.from(authHeader.slice(7))
  const expected = Buffer.from(TURN_OPERATOR_TOKEN)
  if (provided.length !== expected.length) return 'invalid'
  return timingSafeEqual(provided, expected) ? 'operator' : 'invalid'
}

// ── Pollers ──────────────────────────────────────────────────────────

export function startTurnPollers() {
  if (!turnConfigured()) {
    console.log('[turn] auto-provisioning disabled or not configured; pollers not started')
    return
  }

  console.log(`[turn] starting pollers (abuse=${TURN_ABUSE_POLL_SEC}s, global=${TURN_GLOBAL_POLL_SEC}s)`)
  const abusePoller = setInterval(() => {
    pollPerIdentifierUsage().catch(err => console.error('[turn] abuse poll error:', err.message))
  }, TURN_ABUSE_POLL_SEC * 1000)
  abusePoller.unref?.()
  pollers.push(abusePoller)

  const globalPoller = setInterval(() => {
    pollGlobalUsage().catch(err => console.error('[turn] global poll error:', err.message))
  }, TURN_GLOBAL_POLL_SEC * 1000)
  globalPoller.unref?.()
  pollers.push(globalPoller)

  // Run an initial global sync soon after startup to calibrate persisted counter.
  initialGlobalPoller = setTimeout(() => {
    initialGlobalPoller = null
    pollGlobalUsage().catch(err => console.error('[turn] initial global poll error:', err.message))
  }, 2000)
  initialGlobalPoller.unref?.()
}

export function stopTurnPollers() {
  for (const p of pollers) clearInterval(p)
  pollers = []
  if (initialGlobalPoller) {
    clearTimeout(initialGlobalPoller)
    initialGlobalPoller = null
  }
}

// ── Revoke-retry loop (P1-6 / SECURITY-010) ──────────────────────────
//
// When a CF revoke call fails (HTTP 5xx, transient network, etc.) we leave
// the credential in activeCredentials with `revokePending = true`. This
// background loop walks every pending entry on a slow cadence and retries.
// On success the entry is dropped; on failure we just bump the attempt
// counter for log triage and try again next tick. Natural TTL expiry
// (pruneActiveCredentials) is still the final backstop, and the usage is
// always settled into the per-IP ledger BEFORE the entry can disappear.

let revokeRetryTimer: NodeJS.Timeout | null = null
let retryRunning = false

export function startTurnRevokeRetry() {
  if (revokeRetryTimer) return
  revokeRetryTimer = setInterval(() => {
    retryPendingRevokes().catch(err => console.error('[turn] revoke retry error:', err.message))
  }, TURN_REVOKE_RETRY_INTERVAL_MS)
  revokeRetryTimer.unref?.()
}

export function stopTurnRevokeRetry() {
  if (revokeRetryTimer) {
    clearInterval(revokeRetryTimer)
    revokeRetryTimer = null
  }
}

async function retryPendingRevokes() {
  if (retryRunning) return
  retryRunning = true
  try {
    const state = getTurnState()
    const now = Date.now()
    // Snapshot to avoid mutating-while-iterating; revokes are sequential to
    // keep CF rate-limit pressure minimal.
    const pending = Object.entries(state.activeCredentials).filter(([, c]) => c.revokePending)
    if (pending.length === 0) return
    for (const [cid, active] of pending) {
      if (active.expiresAt < now) {
        // The credential has aged out anyway — settle its usage, then drop it.
        settleCredentialUsage(active)
        delete state.activeCredentials[cid]
        dropCachedCredential(cid)
        markDirty()
        continue
      }
      const ok = await revokeCustomIdentifier(cid)
      if (ok) {
        settleCredentialUsage(active)
        delete state.activeCredentials[cid]
        dropCachedCredential(cid)
        markDirty()
      } else {
        active.revokeAttempts = (active.revokeAttempts ?? 0) + 1
        active.lastRevokeAttemptAt = now
        markDirty()
      }
    }
  } finally {
    retryRunning = false
  }
}

// Test-only hooks: drive a single pass synchronously. Production code uses the
// timers above.
export async function _retryPendingRevokesNow() {
  await retryPendingRevokes()
}
export async function _pollPerIdentifierUsageNow() {
  await pollPerIdentifierUsage()
}
export async function _revokeAllActiveNow() {
  await revokeAllActive()
}

// ── Internals ────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const CF_DEFAULT_URLS = [
  'stun:stun.cloudflare.com:3478',
  'turn:turn.cloudflare.com:3478?transport=udp',
  'turn:turn.cloudflare.com:3478?transport=tcp',
  'turns:turn.cloudflare.com:5349?transport=tcp',
]

function normalizeUrls(raw: unknown): string[] {
  if (typeof raw === 'string') return raw.length > 0 ? [raw] : []
  if (Array.isArray(raw)) return raw.filter((u): u is string => typeof u === 'string' && u.length > 0)
  return []
}

/**
 * BUG-022: strict validation of the provider's success body. CF returns either
 * a single `iceServers` object (new generate-ica), an array of them, or a flat
 * username/credential pair. Anything else — including a 200 that carries no
 * usable server — is an error, NOT an empty credential set.
 */
function normalizeIceServers(resp: unknown): RTCIceServerLike[] {
  if (!isRecord(resp)) throw new CfError('CF_SCHEMA', 'credential response is not an object')

  const out: RTCIceServerLike[] = []
  const push = (entry: unknown) => {
    if (!isRecord(entry)) return
    const urls = normalizeUrls(entry.urls)
    if (urls.length === 0) return
    out.push({
      urls,
      ...(typeof entry.username === 'string' ? { username: entry.username } : {}),
      ...(typeof entry.credential === 'string' ? { credential: entry.credential } : {}),
    })
  }

  if (resp.iceServers !== undefined) {
    const list = Array.isArray(resp.iceServers) ? resp.iceServers : [resp.iceServers]
    for (const entry of list) push(entry)
  } else if (typeof resp.username === 'string' && typeof resp.credential === 'string') {
    out.push({ urls: [...CF_DEFAULT_URLS], username: resp.username, credential: resp.credential })
  }

  if (out.length === 0) throw new CfError('CF_SCHEMA', 'credential response carries no usable ICE server')
  if (!out.some(s => !!s.username && !!s.credential)) {
    throw new CfError('CF_SCHEMA', 'credential response carries no username/credential pair')
  }
  return out
}

/**
 * BUG-022: every provider call gets a wall-clock deadline AND an AbortSignal.
 * The signal is the polite half — it lets the runtime tear the socket down. The
 * race is the load-bearing half: a proxy (or a body that never finishes
 * streaming) can ignore the signal, and the reservation must not stay parked
 * regardless.
 */
async function withDeadline<T>(fn: (signal: AbortSignal) => Promise<T>, label: string): Promise<T> {
  const controller = new AbortController()
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new CfError('CF_TIMEOUT', `${label} exceeded the ${TURN_CF_TIMEOUT_MS}ms deadline`))
    }, TURN_CF_TIMEOUT_MS)
  })
  const work = (async () => {
    try {
      return await fn(controller.signal)
    } catch (err) {
      if (err instanceof CfError) throw err
      const e = err as Error
      if (e.name === 'AbortError' || e.name === 'TimeoutError') {
        throw new CfError('CF_TIMEOUT', `${label} aborted at the deadline`)
      }
      throw new CfError('CF_NETWORK', `${label}: ${e.message}`)
    }
  })()
  // If the deadline wins the race the work promise may still settle later;
  // swallow it so it can never surface as an unhandled rejection.
  work.catch(() => { /* already answered by the deadline */ })
  try {
    return await Promise.race([work, deadline])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function cfGenerateCredentials(customIdentifier: string, ttlSec: number): Promise<unknown> {
  const url = `${CF_API_BASE}/turn/keys/${encodeURIComponent(TURN_CF_KEY_ID)}/credentials/generate`
  return withDeadline(async (signal) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TURN_CF_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttl: ttlSec, customIdentifier }),
      signal,
    })
    if (!res.ok) {
      // do not log res body — CF echoes the API token request id only; still play safe
      throw new CfError('CF_HTTP', `issue: HTTP ${res.status}`)
    }
    try {
      return await res.json() as unknown
    } catch {
      throw new CfError('CF_SCHEMA', 'issue: response body is not JSON')
    }
  }, 'issue')
}

function pruneIssuanceHistory(now: number) {
  const state = getTurnState()
  const cutoff = now - 60 * 60 * 1000
  const before = state.ipIssuanceHistory.length
  state.ipIssuanceHistory = state.ipIssuanceHistory.filter(r => r.issuedAt >= cutoff)
  if (state.ipIssuanceHistory.length !== before) markDirty()
}

// Rolling per-IP ledger of CF-CONFIRMED actual relayed bytes, folded from
// credentials as they expire. In-memory only (a restart resets it, which only
// briefly loosens this SECONDARY per-IP cap; the persisted global monthly kill
// switch is the primary money defence). We fold `cfActualBytes` — NOT the
// pessimistic estimate — so a P2P session that relayed ~0 bytes contributes 0
// and can never false-positive a legitimate user who reconnects frequently.
interface IpByteLedgerEntry { ip: string; bytes: number; at: number }
let ipByteLedger: IpByteLedgerEntry[] = []

// Test-only: reset / inspect the in-memory ledger between scenarios.
export function _resetIpByteLedger() { ipByteLedger = [] }
export function _ipLedgerBytesForTest(ip: string): number {
  return ipByteLedger.filter(e => e.ip === ip).reduce((s, e) => s + e.bytes, 0)
}

function pruneIpByteLedger(now: number) {
  const cutoff = now - 60 * 60 * 1000
  ipByteLedger = ipByteLedger.filter(e => e.at >= cutoff)
}

/**
 * SECURITY-010: fold a credential's CF-confirmed usage into the per-IP rolling
 * ledger and mark it settled. This ALWAYS happens before an entry can be
 * deleted — a revoke used to take the only record of those bytes with it, so an
 * abuser could be revoked and immediately re-sign with their hourly cap
 * untouched. `usageSettled` makes it idempotent, so a later prune of the same
 * entry cannot double-count.
 */
function settleCredentialUsage(cred: ActiveCredential, observedBytes?: number) {
  if (cred.usageSettled) return
  const bytes = Math.max(observedBytes ?? 0, cred.cfActualBytes ?? 0)
  if (bytes > 0) {
    ipByteLedger.push({ ip: cred.ip, bytes, at: Date.now() })
    cred.cfActualBytes = bytes
  }
  cred.usageSettled = true
  markDirty()
}

function pruneActiveCredentials(now: number) {
  const state = getTurnState()
  let changed = false
  for (const [k, v] of Object.entries(state.activeCredentials)) {
    if (v.expiresAt < now) {
      settleCredentialUsage(v)
      delete state.activeCredentials[k]
      dropCachedCredential(k)
      changed = true
    }
  }
  if (changed) markDirty()
}

// Effective per-IP bytes over the last hour = still-active credentials'
// pessimistic in-flight estimate (fast guard against a burst) + CF-confirmed
// actual bytes of already-expired credentials from the rolling ledger. This is
// what the previous active-only sum could never do: accumulate a full hour.
function sumHourlyBytesForIp(ip: string, now: number): number {
  const state = getTurnState()
  const cutoff = now - 60 * 60 * 1000
  let total = 0
  for (const c of Object.values(state.activeCredentials)) {
    if (c.ip === ip && c.issuedAt >= cutoff) total += c.pessimisticBytes
  }
  for (const e of ipByteLedger) {
    if (e.ip === ip && e.at >= cutoff) total += e.bytes
  }
  return total
}

function evaluateGlobalKillSwitch() {
  const state = getTurnState()
  const limit = TURN_GLOBAL_MONTHLY_BYTES_LIMIT * (TURN_GLOBAL_THRESHOLD_PCT / 100)
  if (!state.monthlyUsage.killSwitchActive && state.monthlyUsage.bytesObserved >= limit) {
    state.monthlyUsage.killSwitchActive = true
    state.monthlyUsage.killSwitchTriggeredAt = Date.now()
    markDirty()
    console.warn(`[turn] GLOBAL KILL SWITCH engaged at ${state.monthlyUsage.bytesObserved} bytes (limit ${limit}, month ${state.monthlyUsage.monthKey})`)
    if (TURN_REVOKE_ALL_ON_KILL) {
      revokeAllActive().catch(err => console.error('[turn] revokeAllActive error:', err.message))
    }
  }
}

/**
 * SECURITY-010: the kill-switch sweep used to ignore the revoke result
 * entirely, so a failed revoke fell out of the world — no retry, no record of
 * an outstanding credential still burning quota. Failures now land in the same
 * `revokePending` queue the retry loop drains.
 */
async function revokeAllActive() {
  const state = getTurnState()
  const ids = Object.keys(state.activeCredentials)
  console.warn(`[turn] revoking ${ids.length} active credentials (kill switch)`)
  for (const cid of ids) {
    const active = state.activeCredentials[cid]
    if (!active) continue
    const ok = await revokeCustomIdentifier(cid)
    if (ok) {
      settleCredentialUsage(active)
      delete state.activeCredentials[cid]
      dropCachedCredential(cid)
    } else {
      active.revokePending = true
      active.revokeAttempts = (active.revokeAttempts ?? 0) + 1
      active.lastRevokeAttemptAt = Date.now()
    }
  }
  markDirty()
}

// ── CF GraphQL Analytics ─────────────────────────────────────────────

interface GraphQLResp<T> {
  data?: T
  errors?: Array<{ message: string }>
}

async function cfGraphQL<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  return withDeadline(async (signal) => {
    const res = await fetch(CF_GRAPHQL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TURN_CF_ANALYTICS_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
      signal,
    })
    if (!res.ok) throw new CfError('CF_HTTP', `graphql: HTTP ${res.status}`)
    let json: GraphQLResp<T>
    try {
      json = await res.json() as GraphQLResp<T>
    } catch {
      throw new CfError('CF_SCHEMA', 'graphql: response body is not JSON')
    }
    if (json.errors && json.errors.length) {
      throw new CfError('CF_GRAPHQL', 'graphql: ' + json.errors.map(e => e.message).join('; '))
    }
    if (!json.data) throw new CfError('CF_SCHEMA', 'graphql: empty data')
    return json.data
  }, 'graphql')
}

interface AnalyticsAggregateRow {
  sum?: { egressBytes?: number; ingressBytes?: number }
  dimensions?: { customIdentifier?: string }
}

interface AnalyticsViewerResp {
  viewer?: {
    accounts?: Array<{
      callsTurnUsageAdaptiveGroups?: AnalyticsAggregateRow[]
    }>
  }
}

function rowsOf(data: AnalyticsViewerResp): AnalyticsAggregateRow[] {
  return data.viewer?.accounts?.[0]?.callsTurnUsageAdaptiveGroups ?? []
}

function bytesOf(row: AnalyticsAggregateRow): number {
  return (row.sum?.egressBytes ?? 0) + (row.sum?.ingressBytes ?? 0)
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/**
 * BUG-024: cursor-paginated per-customIdentifier query. The old single
 * `limit: 1000` / `limit: 10000` request silently dropped everything past the
 * ceiling, so a high-cardinality window under-reported and abusive sessions
 * escaped the per-session cap. `truncated` is returned rather than swallowed:
 * hitting TURN_ANALYTICS_MAX_PAGES is a degraded state, not a result.
 */
async function fetchIdentifierPages(
  scalar: 'Time' | 'Date',
  since: string,
  until: string,
): Promise<{ rows: AnalyticsAggregateRow[]; truncated: boolean }> {
  const timeFilter = scalar === 'Time'
    ? 'datetime_geq: $since, datetime_leq: $until'
    : 'date_geq: $since, date_leq: $until'
  const rows: AnalyticsAggregateRow[] = []
  let cursor: string | null = null

  for (let page = 0; page < TURN_ANALYTICS_MAX_PAGES; page++) {
    // The cursor is inlined (JSON-escaped) rather than passed as a variable so
    // we don't have to guess the name of Cloudflare's scalar for it.
    const cursorClause = cursor === null ? '' : `, customIdentifier_gt: ${JSON.stringify(cursor)}`
    const query = `
      query($accountTag: String!, $since: ${scalar}!, $until: ${scalar}!) {
        viewer {
          accounts(filter: { accountTag: $accountTag }) {
            callsTurnUsageAdaptiveGroups(
              limit: ${TURN_ANALYTICS_PAGE_LIMIT}
              orderBy: [customIdentifier_ASC]
              filter: { ${timeFilter}${cursorClause} }
            ) {
              sum { egressBytes ingressBytes }
              dimensions { customIdentifier }
            }
          }
        }
      }
    `
    const data = await cfGraphQL<AnalyticsViewerResp>(query, {
      accountTag: TURN_CF_ACCOUNT_TAG,
      since,
      until,
    })
    const batch = rowsOf(data)
    rows.push(...batch)
    if (batch.length < TURN_ANALYTICS_PAGE_LIMIT) return { rows, truncated: false }
    const last = batch[batch.length - 1]?.dimensions?.customIdentifier
    // No usable cursor (or no forward progress) — stop rather than loop.
    if (!last || last === cursor) return { rows, truncated: false }
    cursor = last
  }
  return { rows, truncated: true }
}

function setAnalyticsTruncated(truncated: boolean) {
  const u = getTurnState().monthlyUsage
  if (truncated) {
    u.analyticsTruncated = true
    u.lastCfSyncErrorCode = 'ANALYTICS_TRUNCATED'
  } else if (u.analyticsTruncated) {
    u.analyticsTruncated = false
    if (u.lastCfSyncErrorCode === 'ANALYTICS_TRUNCATED') delete u.lastCfSyncErrorCode
  }
  markDirty()
}

/** Per-customIdentifier byte usage over the last hour. */
async function pollPerIdentifierUsage() {
  const state = getTurnState()
  if (Object.keys(state.activeCredentials).length === 0) return

  const now = new Date()
  const since = new Date(now.getTime() - 60 * 60 * 1000)   // 1 h window

  let paged: { rows: AnalyticsAggregateRow[]; truncated: boolean }
  try {
    paged = await fetchIdentifierPages('Time', since.toISOString(), now.toISOString())
  } catch (err) {
    state.monthlyUsage.lastCfSyncErrorCode = errorCodeOf(err)
    markDirty()
    console.error('[turn] analytics query failed:', errorCodeOf(err), (err as Error).message)
    return
  }
  if (paged.truncated) {
    console.warn(`[turn] analytics truncated after ${TURN_ANALYTICS_MAX_PAGES} pages — per-session enforcement is incomplete (degraded)`)
  }
  setAnalyticsTruncated(paged.truncated)

  const byCid = new Map<string, number>()
  for (const r of paged.rows) {
    const cid = r.dimensions?.customIdentifier
    if (!cid) continue
    byCid.set(cid, (byCid.get(cid) ?? 0) + bytesOf(r))
  }

  for (const [cid, actualBytes] of byCid.entries()) {
    const active = state.activeCredentials[cid]
    if (!active) continue
    // Record CF-confirmed actual usage so it can be folded into the per-IP
    // rolling-hour ledger when this credential expires (see pruneActiveCredentials).
    active.cfActualBytes = actualBytes
    // Correct the pessimistic estimate with actual data — only if higher than
    // already-counted pessimistic (analytics is the source of truth from now on).
    if (actualBytes > active.pessimisticBytes) {
      const delta = actualBytes - active.pessimisticBytes
      state.monthlyUsage.pessimisticBytesObserved += delta
      state.monthlyUsage.bytesObserved = Math.max(
        state.monthlyUsage.cfBytesObserved,
        state.monthlyUsage.pessimisticBytesObserved,
      )
      active.pessimisticBytes = actualBytes
      markDirty()
    }
    if (actualBytes >= TURN_MAX_BYTES_PER_SESSION) {
      await handleAbusiveCredential(cid, active, actualBytes)
    }
  }
  evaluateGlobalKillSwitch()
}

/**
 * SECURITY-010: the durable revoke / account / deny state machine, in strict
 * order. Each step is persisted locally before the next one runs, so no
 * external-provider outcome can lose the accounting or the ban — the audit does
 * NOT require a single atomic transaction across Cloudflare, it requires that a
 * failure at any step leaves a retryable local record.
 *
 *   1. SETTLE  — fold the confirmed bytes into the per-IP hourly ledger, so a
 *                successful revoke can no longer erase the usage that justified
 *                it (which is what let an abuser revoke-and-re-sign for free).
 *   2. DENY    — persist the session (and, on repeat strikes, the IP) denial.
 *   3. REVOKE  — delete on success; on failure keep the entry with
 *                `revokePending` so the retry loop drains it.
 */
async function handleAbusiveCredential(cid: string, active: ActiveCredential, actualBytes: number) {
  console.warn(`[turn] abuse: ${redactCustomIdentifier(cid)} used ${actualBytes} bytes (cap ${TURN_MAX_BYTES_PER_SESSION}), settling + denying + revoking`)
  settleCredentialUsage(active, actualBytes)
  applyDeny(cid, active.ip, 'SESSION_BYTES_EXCEEDED')

  const ok = await revokeCustomIdentifier(cid)
  if (ok) {
    delete getTurnState().activeCredentials[cid]
    dropCachedCredential(cid)
  } else {
    // P1-6: do NOT drop the entry on revoke failure. We need to retry until
    // either CF accepts the revoke or the credential's TTL elapses, otherwise
    // we lose visibility into an outstanding credential that still counts
    // against our quota.
    active.revokePending = true
    active.revokeAttempts = (active.revokeAttempts ?? 0) + 1
    active.lastRevokeAttemptAt = Date.now()
  }
  markDirty()
}

/**
 * BUG-024: the AUTHORITATIVE monthly total. Selecting no `dimensions` makes
 * Cloudflare collapse the window into a single summed row, so the figure the
 * kill switch depends on is independent of how many distinct identifiers the
 * month happened to produce. Summing a capped row list (the old approach) could
 * under-report indefinitely and therefore never trip the switch at all.
 */
async function fetchMonthlyAggregate(since: string, until: string): Promise<number> {
  const query = `
    query($accountTag: String!, $since: Date!, $until: Date!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          callsTurnUsageAdaptiveGroups(
            limit: 1
            filter: { date_geq: $since, date_leq: $until }
          ) {
            sum { egressBytes ingressBytes }
          }
        }
      }
    }
  `
  const data = await cfGraphQL<AnalyticsViewerResp>(query, {
    accountTag: TURN_CF_ACCOUNT_TAG,
    since,
    until,
  })
  let total = 0
  for (const row of rowsOf(data)) total += bytesOf(row)
  if (!Number.isFinite(total) || total < 0) {
    throw new CfError('CF_SCHEMA', 'aggregate total is not a usable number')
  }
  return total
}

/** Account-wide monthly bytes — feeds the 1 TB kill switch. */
async function pollGlobalUsage() {
  rollMonthIfNeeded()
  const state = getTurnState()
  const now = new Date()
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const since = isoDate(monthStart)
  const until = isoDate(now)

  let total: number
  let truncated = false
  try {
    total = await fetchMonthlyAggregate(since, until)
  } catch (aggErr) {
    console.error('[turn] global aggregate query failed, falling back to paginated sum:',
      errorCodeOf(aggErr), (aggErr as Error).message)
    try {
      const paged = await fetchIdentifierPages('Date', since, until)
      total = paged.rows.reduce((s, r) => s + bytesOf(r), 0)
      truncated = paged.truncated
    } catch (pagedErr) {
      state.monthlyUsage.lastCfSyncErrorCode = errorCodeOf(pagedErr)
      markDirty()
      console.error('[turn] global analytics query failed:', errorCodeOf(pagedErr), (pagedErr as Error).message)
      return
    }
  }

  // Reconcile the pessimistic estimate DOWN to only currently-active
  // credentials. `pessimisticBytesObserved` is bumped +pessimisticBytes on
  // every issuance and never decremented mid-month; since most WebRTC sessions
  // go P2P and relay ~0 bytes, it otherwise grows as (issuances × 375MB) and,
  // via max(cf, pessimistic), trips the kill switch after only a few thousand
  // credential fetches regardless of real traffic. CF's `total` already covers
  // bytes relayed by now-expired credentials, so only still-active credentials
  // should contribute a short-term lag buffer on top of it.
  pruneActiveCredentials(Date.now())
  const activePessimistic = Object.values(state.activeCredentials)
    .reduce((s, c) => s + c.pessimisticBytes, 0)

  if (truncated) {
    // FAIL-SAFE (BUG-024): the fallback sum is a LOWER BOUND, so we may only
    // move the counters UPWARD with it. We do not reconcile the pessimistic
    // estimate down and we do not clear the kill switch on incomplete data —
    // re-opening the money tap requires an authoritative figure.
    console.warn('[turn] monthly total is a truncated lower bound — holding fail-safe state')
    setAnalyticsTruncated(true)
    state.monthlyUsage.cfBytesObserved = Math.max(state.monthlyUsage.cfBytesObserved, total)
    state.monthlyUsage.bytesObserved = Math.max(
      state.monthlyUsage.cfBytesObserved,
      state.monthlyUsage.pessimisticBytesObserved,
    )
    markDirty()
    evaluateGlobalKillSwitch()   // may still TRIP; never clears
    return
  }

  setAnalyticsTruncated(false)
  state.monthlyUsage.cfBytesObserved = total
  state.monthlyUsage.pessimisticBytesObserved = activePessimistic
  state.monthlyUsage.bytesObserved = Math.max(total, activePessimistic)
  state.monthlyUsage.usageSource = 'cloudflare'
  state.monthlyUsage.lastCfSyncAt = Date.now()
  delete state.monthlyUsage.lastCfSyncErrorCode

  // A fresh authoritative sync can also CLEAR a kill switch that tripped on a
  // stale pessimistic over-count: if real effective bytes are back below the
  // threshold, re-enable issuance instead of staying dead until month roll.
  const limit = TURN_GLOBAL_MONTHLY_BYTES_LIMIT * (TURN_GLOBAL_THRESHOLD_PCT / 100)
  if (state.monthlyUsage.killSwitchActive && state.monthlyUsage.bytesObserved < limit) {
    state.monthlyUsage.killSwitchActive = false
    state.monthlyUsage.killSwitchTriggeredAt = 0
    console.warn(`[turn] global kill switch CLEARED after CF sync (${state.monthlyUsage.bytesObserved} < ${limit} bytes, month ${state.monthlyUsage.monthKey})`)
  }
  markDirty()
  // SECURITY-009: an authoritative sync tells us everything the unreadable
  // snapshot would have, so we can safely leave the fail-closed state.
  markTurnStateRecovered()
  evaluateGlobalKillSwitch()
}

export async function syncTurnUsageNow() {
  await pollGlobalUsage()
  return getOperatorTurnStatus()
}
