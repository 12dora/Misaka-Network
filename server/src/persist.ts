// ── TURN-state persistence ───────────────────────────────────────────
// Minimal JSON snapshot. Atomic write (tmp + rename). No external deps.
// Holds only data that MUST survive restart: monthly byte tally, deny lists,
// in-flight credentials, recent issuance history. Everything else stays in
// memory by design (节点 / 会话 / 上报 ephemeral per spec).

import fs from 'fs/promises'
import path from 'path'
import { TURN_PERSIST_DIR, TURN_PERSIST_INTERVAL_SEC } from './config.js'

export interface DenyEntry {
  reason: string
  bannedAt: number
  expiresAt: number       // 0 = permanent
}

export interface ActiveCredential {
  sessionId: string
  customIdentifier: string
  ip: string
  issuedAt: number
  expiresAt: number
  pessimisticBytes: number   // local upper-bound estimate; CF analytics corrects this
}

export interface IssuanceRecord {
  ip: string
  issuedAt: number
}

export interface MonthlyUsage {
  monthKey: string                  // "YYYY-MM" in UTC
  bytesObserved: number             // last known total from CF analytics (+ local pessimistic delta)
  lastCfSyncAt: number
  killSwitchActive: boolean
  killSwitchTriggeredAt: number
}

export interface TurnState {
  version: 1
  monthlyUsage: MonthlyUsage
  denyList: {
    sessions: Record<string, DenyEntry>
    ips: Record<string, DenyEntry>
  }
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
      lastCfSyncAt: 0,
      killSwitchActive: false,
      killSwitchTriggeredAt: 0,
    },
    denyList: { sessions: {}, ips: {} },
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
      console.log(`[persist] loaded turn-state.json (month=${state.monthlyUsage.monthKey}, denyList sessions=${Object.keys(state.denyList.sessions).length} ips=${Object.keys(state.denyList.ips).length})`)
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
    lastCfSyncAt: 0,
    killSwitchActive: false,
    killSwitchTriggeredAt: 0,
  }
  markDirty()
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
