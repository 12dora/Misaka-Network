// ── Cloudflare Realtime TURN — auto provisioning + abuse policy ──────
// Issues short-lived TURN credentials per WS session, monitors usage via
// CF GraphQL Analytics, and applies per-session / per-IP / global limits.
//
// Security model:
//   - API token (TURN_CF_API_TOKEN) is read from env, never logged, never
//     returned to clients.
//   - All enforcement runs server-side. Clients are pure consumers: a hooked
//     client cannot grant itself credentials, raise its byte cap, or evade
//     the deny list — every issuance round-trips through this module.
//   - Credentials are short (default 5 min) so a failed CF revoke still
//     bounds the abuse window. CF revoke is best-effort on top.

import {
  TURN_AUTO_ENABLED, TURN_PROVIDER, TURN_CF_KEY_ID, TURN_CF_API_TOKEN, TURN_CF_ACCOUNT_TAG, TURN_CF_ANALYTICS_API_TOKEN,
  TURN_CREDENTIAL_TTL_SEC,
  TURN_MAX_BYTES_PER_SESSION, TURN_MAX_BYTES_PER_HOUR_PER_IP, TURN_MAX_ISSUE_PER_HOUR_PER_IP,
  TURN_GLOBAL_MONTHLY_BYTES_LIMIT, TURN_GLOBAL_THRESHOLD_PCT, TURN_REVOKE_ALL_ON_KILL,
  TURN_PESSIMISTIC_RATE_BPS,
  TURN_ABUSE_POLL_SEC, TURN_GLOBAL_POLL_SEC,
  TURN_BAN_DURATION_SEC,
} from './config.js'
import {
  getTurnState, markDirty, rollMonthIfNeeded,
  type ActiveCredential, type DenyEntry,
} from './persist.js'

const CF_API_BASE = 'https://rtc.live.cloudflare.com/v1'
const CF_GRAPHQL = 'https://api.cloudflare.com/client/v4/graphql'

export type IssueResult =
  | { ok: true; iceServers: RTCIceServerLike[]; expiresAt: number; customIdentifier: string }
  | { ok: false; reason: IssueReject }

export type IssueReject =
  | 'DISABLED'
  | 'NOT_CONFIGURED'
  | 'GLOBAL_QUOTA_EXCEEDED'
  | 'SESSION_BANNED'
  | 'IP_BANNED'
  | 'IP_RATE_LIMITED'
  | 'IP_BYTES_LIMITED'
  | 'CF_ERROR'

export interface RTCIceServerLike {
  urls: string | string[]
  username?: string
  credential?: string
}

interface CfCredentialsResponse {
  iceServers?: { urls: string | string[]; username?: string; credential?: string } | { urls: string | string[]; username?: string; credential?: string }[]
  username?: string
  credential?: string
  // older shape returned `iceServers` array; newer returns single object
}

let pollers: NodeJS.Timeout[] = []

// ── Public API ───────────────────────────────────────────────────────

export function turnConfigured(): boolean {
  return TURN_AUTO_ENABLED
    && TURN_PROVIDER === 'cloudflare'
    && !!TURN_CF_KEY_ID
    && !!TURN_CF_API_TOKEN
    && !!TURN_CF_ACCOUNT_TAG
}

/**
 * Issue short-lived TURN credentials for a session. All gates run here so
 * that a malicious client cannot bypass enforcement by hooking its own code.
 */
export async function issueCredentials(sessionId: string, ip: string): Promise<IssueResult> {
  if (!TURN_AUTO_ENABLED) return { ok: false, reason: 'DISABLED' }
  if (!turnConfigured()) return { ok: false, reason: 'NOT_CONFIGURED' }

  const state = getTurnState()
  const now = Date.now()

  rollMonthIfNeeded()
  pruneDenyList(now)
  pruneIssuanceHistory(now)
  pruneActiveCredentials(now)

  // Global kill-switch
  if (state.monthlyUsage.killSwitchActive) {
    return { ok: false, reason: 'GLOBAL_QUOTA_EXCEEDED' }
  }

  // Deny list checks
  if (state.denyList.sessions[sessionId]) return { ok: false, reason: 'SESSION_BANNED' }
  if (state.denyList.ips[ip]) return { ok: false, reason: 'IP_BANNED' }

  // Per-IP issuance rate (anti-spam: small file with the request count itself)
  const issueWindowMs = 60 * 60 * 1000
  const issueWindowStart = now - issueWindowMs
  const recentIssuesForIp = state.ipIssuanceHistory.filter(r => r.ip === ip && r.issuedAt >= issueWindowStart).length
  if (recentIssuesForIp >= TURN_MAX_ISSUE_PER_HOUR_PER_IP) {
    return { ok: false, reason: 'IP_RATE_LIMITED' }
  }

  // Per-IP pessimistic byte cap (fast path; corrected later by CF analytics)
  const pessimisticIpBytes = sumActivePessimisticBytesForIp(ip, now)
  if (pessimisticIpBytes >= TURN_MAX_BYTES_PER_HOUR_PER_IP) {
    return { ok: false, reason: 'IP_BYTES_LIMITED' }
  }

  // Call CF
  const customIdentifier = `misaka-${sessionId}`
  let cfResp: CfCredentialsResponse
  try {
    cfResp = await cfGenerateCredentials(customIdentifier, TURN_CREDENTIAL_TTL_SEC)
  } catch (err) {
    console.error('[turn] cf issue failed for', customIdentifier, '-', (err as Error).message)
    return { ok: false, reason: 'CF_ERROR' }
  }

  const expiresAt = now + TURN_CREDENTIAL_TTL_SEC * 1000
  const pessimisticBytes = Math.floor((TURN_PESSIMISTIC_RATE_BPS / 8) * TURN_CREDENTIAL_TTL_SEC)

  const active: ActiveCredential = {
    sessionId,
    customIdentifier,
    ip,
    issuedAt: now,
    expiresAt,
    pessimisticBytes,
  }
  state.activeCredentials[customIdentifier] = active
  state.ipIssuanceHistory.push({ ip, issuedAt: now })
  // Pre-add the pessimistic delta to the guardrail counter; CF Analytics
  // supplies the displayed monthly source-of-truth when it syncs.
  state.monthlyUsage.pessimisticBytesObserved += pessimisticBytes
  state.monthlyUsage.bytesObserved = Math.max(
    state.monthlyUsage.cfBytesObserved,
    state.monthlyUsage.pessimisticBytesObserved,
  )
  markDirty()

  // Check global kill threshold after pessimistic add
  evaluateGlobalKillSwitch()

  const iceServers = normalizeIceServers(cfResp)
  return { ok: true, iceServers, expiresAt, customIdentifier }
}

/**
 * Best-effort revoke. Used both on abuse and on global kill (if configured).
 * Logs failures but never throws to caller.
 */
export async function revokeCustomIdentifier(customIdentifier: string): Promise<boolean> {
  try {
    const res = await fetch(`${CF_API_BASE}/turn/keys/${encodeURIComponent(TURN_CF_KEY_ID)}/credentials/${encodeURIComponent(customIdentifier)}/revoke`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TURN_CF_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
    })
    if (!res.ok) {
      console.error(`[turn] revoke ${customIdentifier} failed: HTTP ${res.status}`)
      return false
    }
    return true
  } catch (err) {
    console.error(`[turn] revoke ${customIdentifier} error:`, (err as Error).message)
    return false
  }
}

export function banSession(sessionId: string, reason: string) {
  const state = getTurnState()
  const now = Date.now()
  const entry: DenyEntry = {
    reason,
    bannedAt: now,
    expiresAt: TURN_BAN_DURATION_SEC > 0 ? now + TURN_BAN_DURATION_SEC * 1000 : 0,
  }
  state.denyList.sessions[sessionId] = entry
  markDirty()
}

export function banIp(ip: string, reason: string) {
  const state = getTurnState()
  const now = Date.now()
  const entry: DenyEntry = {
    reason,
    bannedAt: now,
    expiresAt: TURN_BAN_DURATION_SEC > 0 ? now + TURN_BAN_DURATION_SEC * 1000 : 0,
  }
  state.denyList.ips[ip] = entry
  markDirty()
}

// ── Status (safe to expose; no secrets) ──────────────────────────────

export function getTurnStatus() {
  const state = getTurnState()
  const u = state.monthlyUsage
  const limit = TURN_GLOBAL_MONTHLY_BYTES_LIMIT
  return {
    enabled: TURN_AUTO_ENABLED,
    configured: turnConfigured(),
    provider: TURN_PROVIDER,
    credentialTtlSec: TURN_CREDENTIAL_TTL_SEC,
    monthKey: u.monthKey,
    monthlyBytesUsed: u.lastCfSyncAt > 0 ? u.cfBytesObserved : u.bytesObserved,
    monthlyBytesEffective: u.bytesObserved,
    monthlyUsageSource: u.lastCfSyncAt > 0 ? 'cloudflare' : 'pessimistic',
    lastCfSyncError: u.lastCfSyncError,
    monthlyBytesLimit: limit,
    percentUsed: limit > 0 ? ((u.lastCfSyncAt > 0 ? u.cfBytesObserved : u.bytesObserved) / limit) * 100 : 0,
    thresholdPct: TURN_GLOBAL_THRESHOLD_PCT,
    killSwitchActive: u.killSwitchActive,
    killSwitchTriggeredAt: u.killSwitchTriggeredAt,
    lastCfSyncAt: u.lastCfSyncAt,
    activeCredentials: Object.keys(state.activeCredentials).length,
    denyListSize: {
      sessions: Object.keys(state.denyList.sessions).length,
      ips: Object.keys(state.denyList.ips).length,
    },
  }
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
  setTimeout(() => {
    pollGlobalUsage().catch(err => console.error('[turn] initial global poll error:', err.message))
  }, 2000)
}

export function stopTurnPollers() {
  for (const p of pollers) clearInterval(p)
  pollers = []
}

// ── Internals ────────────────────────────────────────────────────────

function normalizeIceServers(resp: CfCredentialsResponse): RTCIceServerLike[] {
  // CF returns either a single iceServers object (new generate-ica) or a flat
  // username/credential pair. Normalize to RTCIceServer[].
  if (resp.iceServers) {
    const list = Array.isArray(resp.iceServers) ? resp.iceServers : [resp.iceServers]
    return list.map(ice => ({
      urls: ice.urls,
      username: ice.username,
      credential: ice.credential,
    }))
  }
  if (resp.username && resp.credential) {
    return [{
      urls: ['stun:stun.cloudflare.com:3478', 'turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:3478?transport=tcp', 'turns:turn.cloudflare.com:5349?transport=tcp'],
      username: resp.username,
      credential: resp.credential,
    }]
  }
  return []
}

async function cfGenerateCredentials(customIdentifier: string, ttlSec: number): Promise<CfCredentialsResponse> {
  const url = `${CF_API_BASE}/turn/keys/${encodeURIComponent(TURN_CF_KEY_ID)}/credentials/generate`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TURN_CF_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ttl: ttlSec, customIdentifier }),
  })
  if (!res.ok) {
    // do not log res body — CF echoes the API token request id only; still play safe
    throw new Error(`HTTP ${res.status}`)
  }
  const data = await res.json() as CfCredentialsResponse
  return data
}

function pruneDenyList(now: number) {
  const state = getTurnState()
  let changed = false
  for (const [k, v] of Object.entries(state.denyList.sessions)) {
    if (v.expiresAt > 0 && v.expiresAt < now) { delete state.denyList.sessions[k]; changed = true }
  }
  for (const [k, v] of Object.entries(state.denyList.ips)) {
    if (v.expiresAt > 0 && v.expiresAt < now) { delete state.denyList.ips[k]; changed = true }
  }
  if (changed) markDirty()
}

function pruneIssuanceHistory(now: number) {
  const state = getTurnState()
  const cutoff = now - 60 * 60 * 1000
  const before = state.ipIssuanceHistory.length
  state.ipIssuanceHistory = state.ipIssuanceHistory.filter(r => r.issuedAt >= cutoff)
  if (state.ipIssuanceHistory.length !== before) markDirty()
}

function pruneActiveCredentials(now: number) {
  const state = getTurnState()
  let changed = false
  for (const [k, v] of Object.entries(state.activeCredentials)) {
    if (v.expiresAt < now) { delete state.activeCredentials[k]; changed = true }
  }
  if (changed) markDirty()
}

function sumActivePessimisticBytesForIp(ip: string, now: number): number {
  const state = getTurnState()
  const cutoff = now - 60 * 60 * 1000
  let total = 0
  for (const c of Object.values(state.activeCredentials)) {
    if (c.ip === ip && c.issuedAt >= cutoff) total += c.pessimisticBytes
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

async function revokeAllActive() {
  const state = getTurnState()
  const ids = Object.keys(state.activeCredentials)
  console.warn(`[turn] revoking ${ids.length} active credentials (kill switch)`)
  for (const cid of ids) {
    await revokeCustomIdentifier(cid)
  }
}

// ── CF GraphQL Analytics ─────────────────────────────────────────────

interface GraphQLResp<T> {
  data?: T
  errors?: Array<{ message: string }>
}

async function cfGraphQL<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(CF_GRAPHQL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TURN_CF_ANALYTICS_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  })
  if (!res.ok) throw new Error(`graphql HTTP ${res.status}`)
  const json = await res.json() as GraphQLResp<T>
  if (json.errors && json.errors.length) {
    throw new Error('graphql: ' + json.errors.map(e => e.message).join('; '))
  }
  if (!json.data) throw new Error('graphql: empty data')
  return json.data
}

interface AnalyticsAggregateRow {
  sum: { egressBytes?: number; ingressBytes?: number }
  dimensions: { customIdentifier?: string }
}

interface AnalyticsViewerResp {
  viewer: {
    accounts: Array<{
      callsTurnUsageAdaptiveGroups?: AnalyticsAggregateRow[]
    }>
  }
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** Per-customIdentifier byte usage over the last `windowMin` minutes. */
async function pollPerIdentifierUsage() {
  const state = getTurnState()
  if (Object.keys(state.activeCredentials).length === 0) return

  const now = new Date()
  const since = new Date(now.getTime() - 60 * 60 * 1000)   // 1 h window

  const query = `
    query($accountTag: String!, $since: Time!, $until: Time!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          callsTurnUsageAdaptiveGroups(
            limit: 1000
            filter: { datetime_geq: $since, datetime_leq: $until }
          ) {
            sum { egressBytes ingressBytes }
            dimensions { customIdentifier }
          }
        }
      }
    }
  `
  let data: AnalyticsViewerResp
  try {
    data = await cfGraphQL<AnalyticsViewerResp>(query, {
      accountTag: TURN_CF_ACCOUNT_TAG,
      since: since.toISOString(),
      until: now.toISOString(),
    })
  } catch (err) {
    console.error('[turn] analytics query failed:', (err as Error).message)
    return
  }

  const rows = data.viewer.accounts[0]?.callsTurnUsageAdaptiveGroups ?? []
  const byCid = new Map<string, number>()
  for (const r of rows) {
    const cid = r.dimensions.customIdentifier
    if (!cid) continue
    const bytes = (r.sum.egressBytes ?? 0) + (r.sum.ingressBytes ?? 0)
    byCid.set(cid, (byCid.get(cid) ?? 0) + bytes)
  }

  for (const [cid, actualBytes] of byCid.entries()) {
    const active = state.activeCredentials[cid]
    if (!active) continue
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
      console.warn(`[turn] abuse: ${cid} used ${actualBytes} bytes (cap ${TURN_MAX_BYTES_PER_SESSION}), revoking + banning`)
      banSession(active.sessionId, `BYTES_EXCEEDED:${actualBytes}`)
      banIp(active.ip, `BYTES_EXCEEDED:${actualBytes}`)
      await revokeCustomIdentifier(cid)
      delete state.activeCredentials[cid]
      markDirty()
    }
  }
  evaluateGlobalKillSwitch()
}

/** Account-wide monthly bytes — feeds the 1 TB kill switch. */
async function pollGlobalUsage() {
  rollMonthIfNeeded()
  const state = getTurnState()
  const now = new Date()
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))

  let data: AnalyticsViewerResp
  try {
    // Need aggregate sum across all rows — query with the same shape but
    // larger limit; the totals come from summing rows we receive.
    const wideQuery = `
      query($accountTag: String!, $since: Date!, $until: Date!) {
        viewer {
          accounts(filter: { accountTag: $accountTag }) {
            callsTurnUsageAdaptiveGroups(
              limit: 10000
              filter: { date_geq: $since, date_leq: $until }
            ) {
              sum { egressBytes ingressBytes }
              dimensions { customIdentifier }
            }
          }
        }
      }
    `
    data = await cfGraphQL<AnalyticsViewerResp>(wideQuery, {
      accountTag: TURN_CF_ACCOUNT_TAG,
      since: isoDate(monthStart),
      until: isoDate(now),
    })
  } catch (err) {
    state.monthlyUsage.lastCfSyncError = (err as Error).message
    markDirty()
    console.error('[turn] global analytics query failed:', (err as Error).message)
    return
  }

  const rows = data.viewer.accounts[0]?.callsTurnUsageAdaptiveGroups ?? []
  let total = 0
  for (const r of rows) {
    total += (r.sum.egressBytes ?? 0) + (r.sum.ingressBytes ?? 0)
  }

  state.monthlyUsage.cfBytesObserved = total
  state.monthlyUsage.bytesObserved = Math.max(total, state.monthlyUsage.pessimisticBytesObserved)
  state.monthlyUsage.usageSource = 'cloudflare'
  state.monthlyUsage.lastCfSyncAt = Date.now()
  delete state.monthlyUsage.lastCfSyncError
  markDirty()
  evaluateGlobalKillSwitch()
}

export async function syncTurnUsageNow() {
  await pollGlobalUsage()
  return getTurnStatus()
}
