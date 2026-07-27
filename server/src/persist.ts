// ── TURN-state persistence ───────────────────────────────────────────
// Minimal JSON snapshot. Atomic write (unique tmp + rename). No external deps.
// Holds only data that MUST survive restart: monthly byte tally,
// in-flight credentials, recent issuance history, TURN deny list. Everything
// else stays in memory by design (节点 / 会话 / 上报 ephemeral per spec).
//
// Brute-force lock persistence (P1-7) is a *separate* file so the two
// concerns can roll independently and so corrupting one doesn't take out
// the other. We don't persist session tokens or sessionIds — those reset
// on restart by design.
//
// SECURITY-009: both snapshots are now VALIDATED on load and the result is
// exposed as a readiness state. A file we cannot trust must not be silently
// downgraded to "fresh install" — for the TURN snapshot that would mean a
// zero-byte month and a disengaged kill switch, i.e. failing OPEN on the one
// piece of state that costs real money. `index.ts` awaits both loads before it
// binds, and `turn.ts` refuses to issue while `isTurnStateReady()` is false.
//
// BUG-025: every writer used the same `<file>.tmp` path with no in-flight
// guard, so two concurrent flushes (periodic tick + shutdown) wrote the same
// temp file and both renamed it — the second rename hit ENOENT and whichever
// writer won left an arbitrary, possibly stale, snapshot behind. Writes are now
// serialised per file and each one uses a unique temp path.

import fs from 'fs/promises'
import path from 'path'
import { TURN_PERSIST_DIR, TURN_PERSIST_INTERVAL_SEC } from './config.js'
import { attemptLocks, nodeFreezes, type AttemptLock, type NodeFreeze } from './store.js'

export interface ActiveCredential {
  sessionId: string
  customIdentifier: string
  ip: string
  issuedAt: number
  expiresAt: number
  pessimisticBytes: number   // local upper-bound estimate; CF analytics corrects this
  cfActualBytes?: number     // CF-confirmed actual relayed bytes (once analytics reports); folded into the per-IP hourly ledger at expiry
  // SECURITY-008: unique per issuance. A rollback compares it before deleting
  // so a failed call can only ever remove ITS OWN reservation, never a sibling
  // that succeeded under the same (deterministic) customIdentifier.
  reservationId?: string
  // SECURITY-010: set once the credential's confirmed usage has been folded
  // into the per-IP rolling ledger, so revoke → delete cannot lose it and a
  // later prune cannot double-count it.
  usageSettled?: boolean
  revokePending?: boolean    // P1-6: set when a CF revoke call failed; background retry will try again until success or expiry
  revokeAttempts?: number    // how many retry attempts we've made (for log triage)
  lastRevokeAttemptAt?: number
}

export interface IssuanceRecord {
  ip: string
  issuedAt: number
}

// SECURITY-010: durable denial. Keys are `ip:<ip>` and `cid:<customIdentifier>`
// so both axes survive a restart (sessionIds do not, customIdentifiers do —
// they are derived from sessionId + SERVER_SECRET).
export interface DenyEntry {
  until: number
  reason: string
  at: number
  ip?: string
}

export interface MonthlyUsage {
  monthKey: string                  // "YYYY-MM" in UTC
  bytesObserved: number             // effective guardrail bytes: max(CF monthly, local pessimistic)
  cfBytesObserved: number           // Cloudflare Analytics source-of-truth monthly bytes
  pessimisticBytesObserved: number  // local no-delay estimate before Analytics catches up
  usageSource: 'cloudflare' | 'pessimistic'
  lastCfSyncAt: number
  /** Stable code (CF_TIMEOUT / CF_HTTP / ...) — never the raw provider text. */
  lastCfSyncErrorCode?: string
  /** BUG-024: last analytics sweep hit the page ceiling → counts are a lower bound. */
  analyticsTruncated?: boolean
  killSwitchActive: boolean
  killSwitchTriggeredAt: number
}

export interface TurnState {
  version: 1
  monthlyUsage: MonthlyUsage
  activeCredentials: Record<string, ActiveCredential>   // keyed by customIdentifier
  ipIssuanceHistory: IssuanceRecord[]                   // ring buffer, oldest first
  denyList: Record<string, DenyEntry>
}

const FILE_NAME = 'turn-state.json'
const TMP_SUFFIX = '.tmp'

function emptyState(): TurnState {
  return {
    version: 1,
    monthlyUsage: {
      monthKey: currentMonthKey(),
      bytesObserved: 0,
      cfBytesObserved: 0,
      pessimisticBytesObserved: 0,
      usageSource: 'pessimistic',
      lastCfSyncAt: 0,
      killSwitchActive: false,
      killSwitchTriggeredAt: 0,
    },
    activeCredentials: {},
    ipIssuanceHistory: [],
    denyList: {},
  }
}

export function currentMonthKey(now = Date.now()): string {
  const d = new Date(now)
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  return `${d.getUTCFullYear()}-${m}`
}

/**
 * Readiness of a persisted snapshot.
 *   ok       — loaded (or legitimately absent, i.e. a fresh install)
 *   failed   — present but unreadable/invalid; callers must fail closed
 *   pending  — load has not run yet (only observable before `index.ts` binds)
 */
export type PersistLoadState = 'pending' | 'ok' | 'failed'

let state: TurnState = emptyState()
let dirty = false
let flushTimer: NodeJS.Timeout | null = null
let loaded = false
let turnLoadState: PersistLoadState = 'pending'
let locksLoadState: PersistLoadState = 'pending'

function statePath(): string {
  return path.join(TURN_PERSIST_DIR, FILE_NAME)
}

// ── Atomic write helpers (BUG-025) ───────────────────────────────────

let tmpSeq = 0

function uniqueTmpPath(target: string): string {
  tmpSeq += 1
  return `${target}.${process.pid}.${Date.now().toString(36)}.${tmpSeq}${TMP_SUFFIX}`
}

async function writeFileAtomic(target: string, payload: string): Promise<void> {
  const tmp = uniqueTmpPath(target)
  try {
    await fs.writeFile(tmp, payload, 'utf8')
    await fs.rename(tmp, target)
  } catch (err) {
    // Never leave a partial temp file behind — a crash mid-write would
    // otherwise litter the persist dir with orphans.
    await fs.rm(tmp, { force: true }).catch(() => { /* best effort */ })
    throw err
  }
}

// One serialised write chain per file. Each queued task snapshots the state
// AFTER the previous write finished, so the last caller's data is what lands on
// disk and no two writers ever share a temp path.
let turnChain: Promise<void> = Promise.resolve()
let locksChain: Promise<void> = Promise.resolve()

// ── TURN state load + validation (SECURITY-009) ──────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function finiteNum(v: unknown, fallback: number): number | null {
  if (v === undefined) return fallback
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * Structural validation of a parsed turn-state.json. Returns null when the
 * snapshot cannot be trusted; individual malformed *entries* inside otherwise
 * sound containers are dropped rather than failing the whole file.
 */
function validateTurnState(parsed: unknown): TurnState | null {
  if (!isPlainObject(parsed)) return null
  if (parsed.version !== 1) return null

  const usageRaw = parsed.monthlyUsage
  if (!isPlainObject(usageRaw)) return null
  if (typeof usageRaw.monthKey !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(usageRaw.monthKey)) return null

  const bytesObserved = finiteNum(usageRaw.bytesObserved, 0)
  const cfBytes = finiteNum(usageRaw.cfBytesObserved, undefined as unknown as number)
  const pessBytes = finiteNum(usageRaw.pessimisticBytesObserved, undefined as unknown as number)
  const lastSync = finiteNum(usageRaw.lastCfSyncAt, 0)
  const killAt = finiteNum(usageRaw.killSwitchTriggeredAt, 0)
  if (bytesObserved === null || lastSync === null || killAt === null) return null
  if (usageRaw.cfBytesObserved !== undefined && cfBytes === null) return null
  if (usageRaw.pessimisticBytesObserved !== undefined && pessBytes === null) return null
  if (usageRaw.killSwitchActive !== undefined && typeof usageRaw.killSwitchActive !== 'boolean') return null

  if (!isPlainObject(parsed.activeCredentials)) return null
  if (!Array.isArray(parsed.ipIssuanceHistory)) return null
  if (parsed.denyList !== undefined && !isPlainObject(parsed.denyList)) return null

  const monthlyUsage: MonthlyUsage = {
    monthKey: usageRaw.monthKey,
    bytesObserved,
    cfBytesObserved: cfBytes ?? (lastSync > 0 ? bytesObserved : 0),
    pessimisticBytesObserved: pessBytes ?? (lastSync > 0 ? 0 : bytesObserved),
    usageSource: usageRaw.usageSource === 'cloudflare' ? 'cloudflare' : 'pessimistic',
    lastCfSyncAt: lastSync,
    killSwitchActive: usageRaw.killSwitchActive === true,
    killSwitchTriggeredAt: killAt,
  }
  if (typeof usageRaw.lastCfSyncErrorCode === 'string') monthlyUsage.lastCfSyncErrorCode = usageRaw.lastCfSyncErrorCode
  if (usageRaw.analyticsTruncated === true) monthlyUsage.analyticsTruncated = true

  const activeCredentials: Record<string, ActiveCredential> = {}
  for (const [cid, raw] of Object.entries(parsed.activeCredentials)) {
    if (!isPlainObject(raw)) continue
    if (typeof raw.sessionId !== 'string' || typeof raw.ip !== 'string') continue
    const issuedAt = finiteNum(raw.issuedAt, 0)
    const expiresAt = finiteNum(raw.expiresAt, 0)
    const pessimisticBytes = finiteNum(raw.pessimisticBytes, 0)
    if (issuedAt === null || expiresAt === null || pessimisticBytes === null) continue
    const cred: ActiveCredential = {
      sessionId: raw.sessionId,
      customIdentifier: typeof raw.customIdentifier === 'string' ? raw.customIdentifier : cid,
      ip: raw.ip,
      issuedAt,
      expiresAt,
      pessimisticBytes,
    }
    const cfActual = finiteNum(raw.cfActualBytes, undefined as unknown as number)
    if (raw.cfActualBytes !== undefined && cfActual !== null) cred.cfActualBytes = cfActual
    if (typeof raw.reservationId === 'string') cred.reservationId = raw.reservationId
    if (raw.usageSettled === true) cred.usageSettled = true
    if (raw.revokePending === true) cred.revokePending = true
    const attempts = finiteNum(raw.revokeAttempts, undefined as unknown as number)
    if (raw.revokeAttempts !== undefined && attempts !== null) cred.revokeAttempts = attempts
    const lastAttempt = finiteNum(raw.lastRevokeAttemptAt, undefined as unknown as number)
    if (raw.lastRevokeAttemptAt !== undefined && lastAttempt !== null) cred.lastRevokeAttemptAt = lastAttempt
    activeCredentials[cid] = cred
  }

  const ipIssuanceHistory: IssuanceRecord[] = []
  for (const raw of parsed.ipIssuanceHistory) {
    if (!isPlainObject(raw)) continue
    if (typeof raw.ip !== 'string') continue
    const issuedAt = finiteNum(raw.issuedAt, 0)
    if (issuedAt === null) continue
    ipIssuanceHistory.push({ ip: raw.ip, issuedAt })
  }

  const denyList: Record<string, DenyEntry> = {}
  for (const [key, raw] of Object.entries(parsed.denyList ?? {})) {
    if (!isPlainObject(raw)) continue
    const until = finiteNum(raw.until, 0)
    const at = finiteNum(raw.at, 0)
    if (until === null || at === null) continue
    denyList[key] = {
      until,
      at,
      reason: typeof raw.reason === 'string' ? raw.reason : 'UNKNOWN',
      ...(typeof raw.ip === 'string' ? { ip: raw.ip } : {}),
    }
  }

  return { version: 1, monthlyUsage, activeCredentials, ipIssuanceHistory, denyList }
}

export async function loadTurnState(): Promise<TurnState> {
  if (loaded) return state
  try {
    await fs.mkdir(TURN_PERSIST_DIR, { recursive: true })
  } catch (err) {
    console.error('[persist] mkdir failed:', (err as Error).message)
  }

  let raw: string
  try {
    raw = await fs.readFile(statePath(), 'utf8')
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') {
      // Fresh install — an absent file is a legitimate empty month.
      state = emptyState()
      loaded = true
      turnLoadState = 'ok'
      return state
    }
    // Present but unreadable. We must NOT pretend the month started at zero.
    console.error('[persist] turn-state.json unreadable — TURN issuance will FAIL CLOSED:', e.message)
    state = emptyState()
    turnLoadState = 'failed'
    return state
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    console.error('[persist] turn-state.json is not valid JSON — TURN issuance will FAIL CLOSED:', (err as Error).message)
    state = emptyState()
    turnLoadState = 'failed'
    return state
  }

  const validated = validateTurnState(parsed)
  if (!validated) {
    console.error('[persist] turn-state.json failed validation — TURN issuance will FAIL CLOSED')
    state = emptyState()
    turnLoadState = 'failed'
    return state
  }

  state = validated
  const nowKey = currentMonthKey()
  if (state.monthlyUsage.monthKey !== nowKey) rollMonth(nowKey)
  normalizeMonthlyUsage()
  loaded = true
  turnLoadState = 'ok'
  console.log(`[persist] loaded turn-state.json (month=${state.monthlyUsage.monthKey}, deny=${Object.keys(state.denyList).length})`)
  return state
}

export function getTurnState(): TurnState {
  return state
}

/** SECURITY-009: false → callers that spend money must fail closed. */
export function isTurnStateReady(): boolean {
  return turnLoadState === 'ok'
}

export function getPersistReadiness(): { turn: PersistLoadState; locks: PersistLoadState } {
  return { turn: turnLoadState, locks: locksLoadState }
}

/**
 * An authoritative Cloudflare sync gives us everything the unreadable snapshot
 * would have: the month's real spend. Once that lands we can safely leave the
 * fail-closed state instead of staying dark until an operator intervenes.
 */
export function markTurnStateRecovered(): void {
  if (turnLoadState === 'ok') return
  turnLoadState = 'ok'
  loaded = true
  markDirty()
  console.warn('[persist] TURN state recovered from an authoritative Cloudflare sync; issuance re-enabled')
}

export function markDirty() {
  dirty = true
}

function rollMonth(newKey: string) {
  state.monthlyUsage = {
    monthKey: newKey,
    bytesObserved: 0,
    cfBytesObserved: 0,
    pessimisticBytesObserved: 0,
    usageSource: 'pessimistic',
    lastCfSyncAt: 0,
    killSwitchActive: false,
    killSwitchTriggeredAt: 0,
  }
  markDirty()
}

function normalizeMonthlyUsage() {
  const u = state.monthlyUsage
  u.bytesObserved = Math.max(u.cfBytesObserved, u.pessimisticBytesObserved)
}

export function rollMonthIfNeeded(): boolean {
  const nowKey = currentMonthKey()
  if (state.monthlyUsage.monthKey !== nowKey) {
    rollMonth(nowKey)
    return true
  }
  return false
}

export function flushTurnState(force = false): Promise<void> {
  if (!loaded) return Promise.resolve()
  if (!force && !dirty) return turnChain
  dirty = false
  const run = turnChain.then(async () => {
    try {
      await writeFileAtomic(statePath(), JSON.stringify(state))
    } catch (err) {
      dirty = true   // mark dirty again so we retry next tick
      console.error('[persist] write failed:', (err as Error).message)
    }
  })
  turnChain = run
  return run
}

export function startPersistFlusher() {
  if (flushTimer) return
  flushTimer = setInterval(() => {
    flushTurnState().catch(() => { /* logged inside */ })
    flushPersistedLocks().catch(() => { /* logged inside */ })
  }, TURN_PERSIST_INTERVAL_SEC * 1000)
  // don't keep process alive solely for the flusher
  flushTimer.unref?.()
}

export function stopPersistFlusher() {
  if (flushTimer) {
    clearInterval(flushTimer)
    flushTimer = null
  }
}

/**
 * BUG-025: shutdown (and tests) must be able to wait for whatever is already
 * queued. Both chains swallow their own errors, so this never rejects.
 */
export function awaitPendingFlushes(): Promise<void> {
  return Promise.allSettled([turnChain, locksChain]).then(() => { /* nothing to report */ })
}

// ── Brute-force lock persistence (P1-7) ─────────────────────────────
//
// Why this is a separate file from the TURN snapshot:
//   - Different write cadence: locks change on every failed register, TURN
//     state changes on credential issue / poll. Coalescing into one file
//     would make every lock event also fsync TURN state.
//   - Different blast radius: TURN state is large and corrupting it costs
//     real money; lock state is small and corrupting it costs at most an
//     hour of brute-force defence.
//   - Restart attacks: without this file, an attacker who could trigger a
//     server restart would also instantly clear all active locks. Now the
//     locks survive restart and the attacker has to wait for the natural
//     LOCK_DURATION_MS / NODE_FREEZE_DURATION_MS to elapse.

const LOCKS_FILE_NAME = 'auth-locks.json'

interface PersistedLocksV1 {
  version: 1
  savedAt: number
  attemptLocks: Array<{ key: string; lock: AttemptLock }>
  nodeFreezes: Array<{ nodeId: number; freeze: NodeFreeze }>
}

function locksPath(): string {
  return path.join(TURN_PERSIST_DIR, LOCKS_FILE_NAME)
}

export async function loadPersistedLocks(): Promise<void> {
  try {
    await fs.mkdir(TURN_PERSIST_DIR, { recursive: true })
  } catch { /* ignored — same as turn-state */ }

  let raw: string
  try {
    raw = await fs.readFile(locksPath(), 'utf8')
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') { locksLoadState = 'ok'; return }
    console.error('[persist] load locks failed:', e.message)
    locksLoadState = 'failed'
    return
  }

  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch (err) {
    console.error('[persist] auth-locks.json is not valid JSON:', (err as Error).message)
    locksLoadState = 'failed'
    return
  }

  if (!isPlainObject(data) || data.version !== 1
      || !Array.isArray(data.attemptLocks) || !Array.isArray(data.nodeFreezes)) {
    console.warn('[persist] auth-locks.json shape unrecognised, starting fresh')
    locksLoadState = 'failed'
    return
  }

  const now = Date.now()
  for (const entry of data.attemptLocks) {
    if (!isPlainObject(entry) || typeof entry.key !== 'string' || !isPlainObject(entry.lock)) continue
    const lock = entry.lock as unknown as AttemptLock
    if (!Number.isFinite(lock.lockedUntil) || !Number.isFinite(lock.lastAttemptAt) || !Number.isFinite(lock.attempts)) continue
    // Drop entries whose lock + idle window has already elapsed — they'd
    // be pruned on the first cleanup tick anyway.
    if (lock.lockedUntil === 0 && now - lock.lastAttemptAt > 60 * 60_000) continue
    attemptLocks.set(entry.key, lock)
  }
  for (const entry of data.nodeFreezes) {
    if (!isPlainObject(entry) || typeof entry.nodeId !== 'number' || !isPlainObject(entry.freeze)) continue
    const freeze = entry.freeze as unknown as NodeFreeze
    if (!Number.isFinite(freeze.frozenUntil) || !Array.isArray(freeze.recentFailures)) continue
    if (freeze.frozenUntil === 0 && freeze.recentFailures.length === 0) continue
    nodeFreezes.set(entry.nodeId, freeze)
  }
  locksLoadState = 'ok'
  console.log(`[persist] loaded auth-locks.json (locks=${attemptLocks.size}, freezes=${nodeFreezes.size})`)
}

export function flushPersistedLocks(): Promise<void> {
  // Queue behind whatever is already writing. Snapshotting INSIDE the queued
  // task (rather than at call time) is what makes the newest lock the one that
  // survives: the last caller serialises the freshest maps.
  const run = locksChain.then(async () => {
    const payload: PersistedLocksV1 = {
      version: 1,
      savedAt: Date.now(),
      attemptLocks: Array.from(attemptLocks.entries()).map(([key, lock]) => ({ key, lock })),
      nodeFreezes: Array.from(nodeFreezes.entries()).map(([nodeId, freeze]) => ({ nodeId, freeze })),
    }
    try {
      await writeFileAtomic(locksPath(), JSON.stringify(payload))
    } catch (err) {
      console.error('[persist] flush locks failed:', (err as Error).message)
    }
  })
  locksChain = run
  return run
}
