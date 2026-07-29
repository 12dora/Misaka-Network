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
  /** Restart-stable deny principal (HMAC over identity). Optional for legacy snapshots. */
  turnPrincipal?: string
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

/** Rolling per-IP CF-confirmed bytes. Survives restart so the 10 GiB/h cap cannot be reset by a crash. */
export interface IpByteLedgerEntry {
  ip: string
  bytes: number
  at: number
}

export interface IssuanceRecord {
  ip: string
  issuedAt: number
}

// SECURITY-010: durable denial. Keys are `ip:<ip>` and `principal:<id>`
// (restart-stable identity HMAC). Legacy snapshots may still carry
// `cid:<customIdentifier>` entries; those are honoured until they expire but
// new denials always write the principal form.
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
  /** Per-IP hourly CF-confirmed byte ledger. Absent on pre-persistence snapshots → []. */
  ipByteLedger: IpByteLedgerEntry[]
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
    ipByteLedger: [],
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

/** Test-only: inject a parent-directory fsync failure for durable writes. */
let _durableDirSyncHookForTest: (() => Promise<void>) | null = null
export function _setDurableDirSyncHookForTest(fn: (() => Promise<void>) | null): void {
  _durableDirSyncHookForTest = fn
}

function uniqueTmpPath(target: string): string {
  tmpSeq += 1
  return `${target}.${process.pid}.${Date.now().toString(36)}.${tmpSeq}${TMP_SUFFIX}`
}

/**
 * Crash-durable atomic write: open → write → fsync file → close → rename →
 * fsync parent directory. Without the fsyncs a process crash after rename can
 * still leave an empty or partial file on some filesystems (ext4 data=ordered
 * is better but not a guarantee we want to depend on for money/security state).
 *
 * `durable=true` is used by the strict security flush path. Periodic flushes
 * keep the cheaper write+rename path for throughput.
 */
async function writeFileAtomic(target: string, payload: string, { durable = false } = {}): Promise<void> {
  const tmp = uniqueTmpPath(target)
  try {
    if (durable) {
      const handle = await fs.open(tmp, 'w')
      try {
        await handle.writeFile(payload, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await fs.rename(tmp, target)
      // Fsync the parent directory so the rename itself is durable. A failure
      // here means a crash can still lose the rename — fail the durable write
      // rather than report success. Platform refusals (EPERM/EACCES/ENOTSUP/
      // EINVAL/EISDIR) used to be swallowed as success, which then authorised
      // Cloudflare revoke and 409/423 responses without a proven directory
      // entry. Strict durability either holds or the call rejects; callers
      // that need the guarantee must not proceed on failure.
      if (_durableDirSyncHookForTest) {
        await _durableDirSyncHookForTest()
      } else {
        try {
          const dir = await fs.open(path.dirname(target), 'r')
          try { await dir.sync() } finally { await dir.close() }
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN'
          throw new Error(
            `durable dir sync failed for ${path.dirname(target)} (${code}): ${(err as Error).message}`,
          )
        }
      }
    } else {
      await fs.writeFile(tmp, payload, 'utf8')
      await fs.rename(tmp, target)
    }
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

/** Safe non-negative integer used for money/security counters. Rejects floats and negatives. */
function nonNegSafeInt(v: unknown, fallback: number): number | null {
  if (v === undefined) return fallback
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) return null
  return v
}

const MAX_STR_LEN = 256
const MAX_IP_LEN = 64
const MAX_CID_LEN = 64
const MAX_PRINCIPAL_LEN = 64

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
    if (typeof cid !== 'string' || cid.length === 0 || cid.length > MAX_CID_LEN) continue
    if (!isPlainObject(raw)) continue
    // Incomplete junk entries can be dropped. Credential-shaped entries with
    // invalid money counters MUST fail the whole snapshot closed — dropping
    // them would lower observed usage and bypass the hourly/monthly cap.
    if (typeof raw.sessionId !== 'string' || raw.sessionId.length === 0) continue
    if (typeof raw.ip !== 'string' || raw.ip.length === 0) continue
    if (raw.sessionId.length > MAX_STR_LEN || raw.ip.length > MAX_IP_LEN) return null
    const sessionId = raw.sessionId
    const ip = raw.ip
    const issuedAt = nonNegSafeInt(raw.issuedAt, 0)
    const expiresAt = nonNegSafeInt(raw.expiresAt, 0)
    const pessimisticBytes = nonNegSafeInt(raw.pessimisticBytes, 0)
    if (issuedAt === null || expiresAt === null || pessimisticBytes === null) return null
    if (expiresAt < issuedAt) return null
    if (raw.cfActualBytes !== undefined) {
      const cfActualCheck = nonNegSafeInt(raw.cfActualBytes, undefined as unknown as number)
      if (cfActualCheck === null) return null
    }
    const cred: ActiveCredential = {
      sessionId,
      customIdentifier: typeof raw.customIdentifier === 'string' && raw.customIdentifier.length <= MAX_CID_LEN
        ? raw.customIdentifier
        : cid,
      ip,
      issuedAt,
      expiresAt,
      pessimisticBytes,
    }
    if (typeof raw.turnPrincipal === 'string' && raw.turnPrincipal.length > 0 && raw.turnPrincipal.length <= MAX_PRINCIPAL_LEN) {
      cred.turnPrincipal = raw.turnPrincipal
    }
    const cfActual = nonNegSafeInt(raw.cfActualBytes, undefined as unknown as number)
    if (raw.cfActualBytes !== undefined && cfActual !== null) cred.cfActualBytes = cfActual
    if (typeof raw.reservationId === 'string' && raw.reservationId.length <= MAX_STR_LEN) cred.reservationId = raw.reservationId
    if (raw.usageSettled === true) cred.usageSettled = true
    if (raw.revokePending === true) cred.revokePending = true
    const attempts = nonNegSafeInt(raw.revokeAttempts, undefined as unknown as number)
    if (raw.revokeAttempts !== undefined && attempts === null) return null
    if (raw.revokeAttempts !== undefined && attempts !== null) cred.revokeAttempts = attempts
    const lastAttempt = nonNegSafeInt(raw.lastRevokeAttemptAt, undefined as unknown as number)
    if (raw.lastRevokeAttemptAt !== undefined && lastAttempt === null) return null
    if (raw.lastRevokeAttemptAt !== undefined && lastAttempt !== null) cred.lastRevokeAttemptAt = lastAttempt
    activeCredentials[cid] = cred
  }

  const ipIssuanceHistory: IssuanceRecord[] = []
  for (const raw of parsed.ipIssuanceHistory) {
    if (!isPlainObject(raw)) continue
    if (typeof raw.ip !== 'string' || raw.ip.length === 0 || raw.ip.length > MAX_IP_LEN) continue
    const issuedAt = nonNegSafeInt(raw.issuedAt, 0)
    if (issuedAt === null) continue
    ipIssuanceHistory.push({ ip: raw.ip, issuedAt })
  }

  const denyList: Record<string, DenyEntry> = {}
  for (const [key, raw] of Object.entries(parsed.denyList ?? {})) {
    if (typeof key !== 'string' || key.length === 0 || key.length > MAX_STR_LEN) continue
    if (!isPlainObject(raw)) continue
    const until = nonNegSafeInt(raw.until, 0)
    const at = nonNegSafeInt(raw.at, 0)
    if (until === null || at === null) continue
    denyList[key] = {
      until,
      at,
      reason: typeof raw.reason === 'string' ? raw.reason.slice(0, MAX_STR_LEN) : 'UNKNOWN',
      ...(typeof raw.ip === 'string' && raw.ip.length <= MAX_IP_LEN ? { ip: raw.ip } : {}),
    }
  }

  // Per-IP hourly ledger. Absent on legacy snapshots → empty (with a one-shot
  // warning so operators notice the migration). Ledger-shaped entries with
  // invalid/negative `bytes` fail the WHOLE snapshot closed — dropping them
  // would silently lower the hourly cap.
  const ipByteLedger: IpByteLedgerEntry[] = []
  if (parsed.ipByteLedger !== undefined) {
    if (!Array.isArray(parsed.ipByteLedger)) return null
    const cutoff = Date.now() - 60 * 60 * 1000
    for (const raw of parsed.ipByteLedger) {
      if (!isPlainObject(raw)) continue
      if (typeof raw.ip !== 'string' || raw.ip.length === 0) continue
      if (raw.ip.length > MAX_IP_LEN) return null
      const bytes = nonNegSafeInt(raw.bytes, null as unknown as number)
      const at = nonNegSafeInt(raw.at, null as unknown as number)
      // Entry has an IP so it is ledger-shaped: bad counters fail closed.
      if (bytes === null || at === null) return null
      if (at < cutoff) continue
      ipByteLedger.push({ ip: raw.ip, bytes, at })
    }
  } else {
    console.warn('[persist] turn-state.json has no ipByteLedger (pre-persistence snapshot); starting empty hourly ledger')
  }

  // Monthly counters that could lower a money guard: reject negatives.
  if (bytesObserved < 0) return null
  if (monthlyUsage.cfBytesObserved < 0 || monthlyUsage.pessimisticBytesObserved < 0) return null

  return { version: 1, monthlyUsage, activeCredentials, ipIssuanceHistory, denyList, ipByteLedger }
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

/**
 * Periodic / best-effort TURN flush. Errors are logged and retried next tick
 * (never rejected) so a transient disk blip cannot crash the poller.
 *
 * Pass `force=true` for shutdown / security boundaries: the write is durable
 * (fsync) and the returned promise REJECTS on failure so callers can exit
 * non-zero and name the file.
 */
export function flushTurnState(force = false): Promise<void> {
  // Never overwrite a snapshot we failed to load with an empty in-memory state.
  if (turnLoadState === 'failed') {
    if (force) return Promise.reject(new Error('turn-state.json: refusing to flush over a failed load'))
    return Promise.resolve()
  }
  if (!loaded && !force) return Promise.resolve()
  if (!force && !dirty) return turnChain
  dirty = false
  const run = turnChain.then(async () => {
    if (turnLoadState === 'failed') {
      if (force) throw new Error('turn-state.json: refusing to flush over a failed load')
      return
    }
    try {
      await writeFileAtomic(statePath(), JSON.stringify(state), { durable: force })
    } catch (err) {
      dirty = true   // mark dirty again so we retry next tick
      const msg = (err as Error).message
      console.error('[persist] write failed:', msg)
      if (force) throw new Error(`turn-state.json: ${msg}`)
    }
  })
  turnChain = run.catch(() => { /* keep chain alive after a force reject */ })
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
 * queued. Best-effort form never rejects.
 */
export function awaitPendingFlushes(): Promise<void> {
  return Promise.allSettled([turnChain, locksChain]).then(() => { /* nothing to report */ })
}

/**
 * Strict security boundary: both money/security snapshots must hit disk
 * before an external action (CF revoke) or a security response (423) goes out.
 * Rejects with the file name that failed.
 */
export async function flushSecurityState(): Promise<void> {
  const errors: string[] = []
  // TURN state: attempt when not failed. Locks: same. A failed load must not
  // be clobbered, and unit tests of the TURN module often never load locks.
  try {
    if (turnLoadState !== 'failed') {
      await flushTurnState(true)
    }
  } catch (err) {
    errors.push((err as Error).message)
  }
  try {
    if (locksLoadState !== 'failed') {
      await flushPersistedLocks(true)
    }
  } catch (err) {
    errors.push((err as Error).message)
  }
  if (errors.length > 0) {
    throw new Error(`security flush failed: ${errors.join('; ')}`)
  }
}

// Also: isLocksStateReady treats 'pending' as not ready for HTTP admission
// (boot must finish load). For unit tests that never call load, callers that
// only flush are fine.

/** SECURITY-009 (locks): false → register / release-by-ip / qr-redeem must fail closed. */
export function isLocksStateReady(): boolean {
  return locksLoadState === 'ok'
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

/**
 * Move a corrupt/unreadable auth-locks.json out of the way so a later
 * successful flush cannot destroy forensic evidence. Best-effort: if the
 * quarantine rename itself fails we still mark load failed and refuse to flush.
 */
async function quarantineLocksFile(reason: string): Promise<void> {
  const src = locksPath()
  const dest = `${src}.corrupt.${Date.now()}`
  try {
    await fs.rename(src, dest)
    console.error(`[persist] quarantined corrupt auth-locks.json → ${path.basename(dest)} (${reason})`)
  } catch (err) {
    console.error(`[persist] could not quarantine auth-locks.json (${reason}):`, (err as Error).message)
  }
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
    // Present but unreadable — quarantine so a later successful flush cannot
    // destroy forensic evidence, and refuse to flush empty state over it.
    await quarantineLocksFile(`unreadable: ${e.code ?? e.message}`)
    return
  }

  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch (err) {
    console.error('[persist] auth-locks.json is not valid JSON:', (err as Error).message)
    locksLoadState = 'failed'
    await quarantineLocksFile('invalid JSON')
    return
  }

  if (!isPlainObject(data) || data.version !== 1
      || !Array.isArray(data.attemptLocks) || !Array.isArray(data.nodeFreezes)) {
    console.warn('[persist] auth-locks.json shape unrecognised — failing CLOSED (not starting fresh)')
    locksLoadState = 'failed'
    await quarantineLocksFile('unrecognised shape')
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

/**
 * Periodic / best-effort locks flush. When `locksLoadState !== 'ok'` we REFUSE
 * to write — an empty in-memory map must never overwrite a corrupt snapshot
 * that we failed to load (and that may still hold the original freezes).
 *
 * `force=true` uses durable fsync and REJECTS on failure (shutdown path).
 */
export function flushPersistedLocks(force = false): Promise<void> {
  // Never overwrite a file we could not trust on load. 'pending' (never loaded)
  // and 'ok' are fine to write; only 'failed' is refuse-to-clobber.
  if (locksLoadState === 'failed') {
    if (force) {
      return Promise.reject(new Error('auth-locks.json: refusing to flush over a failed load'))
    }
    return Promise.resolve()
  }
  // Queue behind whatever is already writing. Snapshotting INSIDE the queued
  // task (rather than at call time) is what makes the newest lock the one that
  // survives: the last caller serialises the freshest maps.
  const run = locksChain.then(async () => {
    if (locksLoadState === 'failed') {
      if (force) throw new Error('auth-locks.json: refusing to flush over a failed load')
      return
    }
    const payload: PersistedLocksV1 = {
      version: 1,
      savedAt: Date.now(),
      attemptLocks: Array.from(attemptLocks.entries()).map(([key, lock]) => ({ key, lock })),
      nodeFreezes: Array.from(nodeFreezes.entries()).map(([nodeId, freeze]) => ({ nodeId, freeze })),
    }
    try {
      await writeFileAtomic(locksPath(), JSON.stringify(payload), { durable: force })
    } catch (err) {
      const msg = (err as Error).message
      console.error('[persist] flush locks failed:', msg)
      if (force) throw new Error(`auth-locks.json: ${msg}`)
    }
  })
  locksChain = run.catch(() => { /* keep chain alive after a force reject */ })
  return run
}
