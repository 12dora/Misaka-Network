// ── TURN-state persistence ───────────────────────────────────────────
// Minimal JSON snapshot. Atomic write (tmp + rename). No external deps.
// Holds only data that MUST survive restart: monthly byte tally,
// in-flight credentials, recent issuance history. Everything else stays in
// memory by design (节点 / 会话 / 上报 ephemeral per spec).
//
// Brute-force lock persistence (P1-7) is a *separate* file so the two
// concerns can roll independently and so corrupting one doesn't take out
// the other. We don't persist session tokens or sessionIds — those reset
// on restart by design.

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
  revokePending?: boolean    // P1-6: set when a CF revoke call failed; background retry will try again until success or expiry
  revokeAttempts?: number    // how many retry attempts we've made (for log triage)
  lastRevokeAttemptAt?: number
}

export interface IssuanceRecord {
  ip: string
  issuedAt: number
}

export interface MonthlyUsage {
  monthKey: string                  // "YYYY-MM" in UTC
  bytesObserved: number             // effective guardrail bytes: max(CF monthly, local pessimistic)
  cfBytesObserved: number           // Cloudflare Analytics source-of-truth monthly bytes
  pessimisticBytesObserved: number  // local no-delay estimate before Analytics catches up
  usageSource: 'cloudflare' | 'pessimistic'
  lastCfSyncAt: number
  lastCfSyncError?: string
  killSwitchActive: boolean
  killSwitchTriggeredAt: number
}

export interface TurnState {
  version: 1
  monthlyUsage: MonthlyUsage
  activeCredentials: Record<string, ActiveCredential>   // keyed by customIdentifier
  ipIssuanceHistory: IssuanceRecord[]                   // ring buffer, oldest first
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
  }
}

export function currentMonthKey(now = Date.now()): string {
  const d = new Date(now)
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  return `${d.getUTCFullYear()}-${m}`
}

let state: TurnState = emptyState()
let dirty = false
let inFlight: Promise<void> | null = null
let flushTimer: NodeJS.Timeout | null = null
let loaded = false

function statePath(): string {
  return path.join(TURN_PERSIST_DIR, FILE_NAME)
}

export async function loadTurnState(): Promise<TurnState> {
  if (loaded) return state
  try {
    await fs.mkdir(TURN_PERSIST_DIR, { recursive: true })
  } catch (err) {
    console.error('[persist] mkdir failed:', (err as Error).message)
  }

  try {
    const raw = await fs.readFile(statePath(), 'utf8')
    const parsed = JSON.parse(raw) as TurnState
    if (parsed && typeof parsed === 'object' && parsed.version === 1) {
      state = parsed
      // Roll month if the file is from a previous month.
      const nowKey = currentMonthKey()
      if (state.monthlyUsage.monthKey !== nowKey) {
        rollMonth(nowKey)
      }
      normalizeMonthlyUsage()
      console.log(`[persist] loaded turn-state.json (month=${state.monthlyUsage.monthKey})`)
    } else {
      console.warn('[persist] state file has unexpected shape, starting empty')
      state = emptyState()
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code !== 'ENOENT') {
      console.error('[persist] read failed, starting empty:', e.message)
    }
    state = emptyState()
  }
  loaded = true
  return state
}

export function getTurnState(): TurnState {
  return state
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
  const u = state.monthlyUsage as MonthlyUsage & {
    cfBytesObserved?: number
    pessimisticBytesObserved?: number
    usageSource?: 'cloudflare' | 'pessimistic'
    lastCfSyncError?: string
  }
  u.cfBytesObserved ??= u.lastCfSyncAt > 0 ? u.bytesObserved : 0
  u.pessimisticBytesObserved ??= u.lastCfSyncAt > 0 ? 0 : u.bytesObserved
  u.usageSource ??= u.lastCfSyncAt > 0 ? 'cloudflare' : 'pessimistic'
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

async function writeAtomic(): Promise<void> {
  const target = statePath()
  const tmp = target + TMP_SUFFIX
  const payload = JSON.stringify(state)
  await fs.writeFile(tmp, payload, 'utf8')
  await fs.rename(tmp, target)
}

export async function flushTurnState(force = false): Promise<void> {
  if (!loaded) return
  if (!force && !dirty) return
  if (inFlight) {
    // coalesce concurrent flushes — wait for the running one, then write again
    // if still dirty (caller marked it after the in-flight read snapshot).
    await inFlight
    if (!dirty && !force) return
  }
  dirty = false
  inFlight = writeAtomic().catch(err => {
    dirty = true   // mark dirty again so we retry next tick
    console.error('[persist] write failed:', (err as Error).message)
  }).finally(() => { inFlight = null })
  await inFlight
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

  let parsed: PersistedLocksV1 | null = null
  try {
    const raw = await fs.readFile(locksPath(), 'utf8')
    const data = JSON.parse(raw) as PersistedLocksV1
    if (data && typeof data === 'object' && data.version === 1) {
      parsed = data
    } else {
      console.warn('[persist] auth-locks.json shape unrecognised, starting fresh')
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code !== 'ENOENT') console.error('[persist] load locks failed:', e.message)
    return
  }
  if (!parsed) return

  const now = Date.now()
  for (const { key, lock } of parsed.attemptLocks) {
    // Drop entries whose lock + idle window has already elapsed — they'd
    // be pruned on the first cleanup tick anyway.
    if (lock.lockedUntil === 0 && now - lock.lastAttemptAt > 60 * 60_000) continue
    attemptLocks.set(key, lock)
  }
  for (const { nodeId, freeze } of parsed.nodeFreezes) {
    if (freeze.frozenUntil === 0 && freeze.recentFailures.length === 0) continue
    nodeFreezes.set(nodeId, freeze)
  }
  console.log(`[persist] loaded auth-locks.json (locks=${attemptLocks.size}, freezes=${nodeFreezes.size})`)
}

export async function flushPersistedLocks(): Promise<void> {
  const payload: PersistedLocksV1 = {
    version: 1,
    savedAt: Date.now(),
    attemptLocks: Array.from(attemptLocks.entries()).map(([key, lock]) => ({ key, lock })),
    nodeFreezes: Array.from(nodeFreezes.entries()).map(([nodeId, freeze]) => ({ nodeId, freeze })),
  }
  const target = locksPath()
  const tmp = target + TMP_SUFFIX
  try {
    await fs.writeFile(tmp, JSON.stringify(payload), 'utf8')
    await fs.rename(tmp, target)
  } catch (err) {
    console.error('[persist] flush locks failed:', (err as Error).message)
  }
}
