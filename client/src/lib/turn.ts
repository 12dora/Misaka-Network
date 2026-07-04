import { apiUrl } from '@/config'
import { authedFetch, AuthRequiredError } from '@/lib/api'

const STORAGE_KEY = 'misaka.turnServers'

// P1-3: Cloudflare's STUN is dual-stack (A + AAAA), so on IPv6-only links
// (T-Mobile US, residential CGNAT-v6, some carrier-grade China-mobile) it
// still yields an srflx candidate where the v4-only Google/Tencent entries
// in DEFAULT_STUN return nothing. Without this, classifyNat() saw zero
// srflx candidates and falsely reported `blocked`. We expose it as a
// separate export so we don't have to touch the constants.ts contract.
export const SUPPLEMENTAL_STUN: RTCIceServer[] = [
  { urls: 'stun:stun.cloudflare.com:3478' },
]

export interface TurnServer {
  id: string
  url: string
  username: string
  credential: string
  enabled: boolean
  lastTested?: number
  reachable?: boolean
}

export interface TurnSettings {
  servers: TurnServer[]
  enabled: boolean
  forceRelay: boolean
}

// ── Auto TURN (server-issued via /api/turn-credentials) ──────────────
// Credentials are kept in memory only — never persisted.

interface AutoTurnState {
  iceServers: RTCIceServer[]
  expiresAt: number
}

interface AutoTurnResponse {
  enabled: boolean
  iceServers?: RTCIceServer[]
  expiresAt?: number
  reason?: string
}

interface TurnStatusResponse {
  enabled: boolean
  configured: boolean
  provider: string
  credentialTtlSec: number
  monthKey: string
  monthlyBytesUsed: number
  monthlyBytesEffective: number
  monthlyUsageSource: 'cloudflare' | 'pessimistic'
  lastCfSyncError?: string
  monthlyBytesLimit: number
  percentUsed: number
  thresholdPct: number
  killSwitchActive: boolean
  killSwitchTriggeredAt: number
  lastCfSyncAt: number
  activeCredentials: number
}

let autoTurn: AutoTurnState | null = null
let inFlight: Promise<AutoTurnState | null> | null = null
let refreshTimer: ReturnType<typeof setTimeout> | null = null
let lastFailReason: string | null = null
const REFRESH_LEAD_MS = 60_000   // refetch 60s before expiry

// P1-2: when fetchAutoTurnOnce() fails (503, network blip, parse error),
// schedule the next retry with exponential backoff capped at 60 s. Without
// this scheduleNextRefresh() bails (autoTurn === null) and we silently give
// up until the next manual trigger.
let failureAttempts = 0
const FAILURE_BACKOFF_BASE_MS = 5_000
const FAILURE_BACKOFF_MAX_MS = 60_000

// ── Config-change observers ──────────────────────────────────────────
// Any consumer that builds an RTCConfiguration from the live TURN state
// (network.ts owns the live RTCPeerConnections) subscribes here so it can
// re-apply via `pc.setConfiguration(...)`. Without this, a refreshed cred
// or a force-relay toggle never reaches existing connections — a peer
// connection older than the cred TTL silently runs on dead TURN.

type TurnConfigChangeListener = () => void
const turnConfigListeners = new Set<TurnConfigChangeListener>()

export function onTurnConfigChange(fn: TurnConfigChangeListener): () => void {
  turnConfigListeners.add(fn)
  return () => turnConfigListeners.delete(fn)
}

function emitTurnConfigChange() {
  for (const fn of turnConfigListeners) {
    try { fn() } catch (err) { tlog('listener failed', err) }
  }
}

// P2-9: scoped + timestamped warn. Kept local (instead of importing from
// webrtc.ts) so we don't create a cycle — webrtc.ts depends on turn.ts.
function tlog(...args: unknown[]) {
  const ts = new Date().toISOString().slice(11, 23)
  console.warn(`[turn ${ts}]`, ...args)
}

// ── TURN settings ────────────────────────────────────────────────────

export function loadTurnSettings(): TurnSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw) as TurnSettings
  } catch { /* ignore */ }
  return { servers: [], enabled: false, forceRelay: false }
}

export function saveTurnSettings(settings: TurnSettings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  // The `enabled` flag, manual server list, and `forceRelay` flag all feed
  // into RTCConfiguration. Notify so live PCs can rebuild their config.
  emitTurnConfigChange()
}

export function getTurnIceServers(): RTCIceServer[] {
  const t = loadTurnSettings()
  if (!t.enabled) return []
  return t.servers
    .filter(s => s.enabled)
    .map(s => ({
      urls: s.url,
      username: s.username || undefined,
      credential: s.credential || undefined,
    }))
}

// ── Auto TURN — server-issued, short-lived ──────────────────────────

export function getAutoTurnIceServers(): RTCIceServer[] {
  if (!autoTurn) return []
  if (Date.now() >= autoTurn.expiresAt) {
    autoTurn = null
    // Kick a background refresh so the *next* PC build has fresh creds even
    // if this caller has to fall back to STUN-only. Without this, an expiry
    // that happens between PC construction events leaves us with no auto
    // TURN until the scheduled refresh timer fires (could be minutes).
    void refreshAutoTurn().catch(() => {})
    return []
  }
  return autoTurn.iceServers
}

// Returns true when auto-TURN credentials are still within `withinMs` of
// expiry (or already gone). Used by webrtc.ts to decide whether to await a
// fresh fetch before building a new RTCPeerConnection.
export function isAutoTurnStaleWithin(withinMs: number): boolean {
  if (!autoTurn) return true
  return Date.now() + withinMs >= autoTurn.expiresAt
}

export function getAutoTurnState(): { active: boolean; expiresAt: number | null; lastFailReason: string | null } {
  if (autoTurn && Date.now() < autoTurn.expiresAt) {
    return { active: true, expiresAt: autoTurn.expiresAt, lastFailReason: null }
  }
  return { active: false, expiresAt: null, lastFailReason }
}

async function fetchAutoTurnOnce(): Promise<AutoTurnState | null> {
  let resp: Response
  try {
    resp = await authedFetch('/api/turn-credentials')
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      lastFailReason = 'AUTH_REQUIRED'
    } else {
      lastFailReason = 'NETWORK'
    }
    return null
  }
  if (!resp.ok) {
    try {
      const body = await resp.json() as AutoTurnResponse
      lastFailReason = body.reason ?? `HTTP_${resp.status}`
    } catch {
      lastFailReason = `HTTP_${resp.status}`
    }
    return null
  }
  let data: AutoTurnResponse
  try { data = await resp.json() as AutoTurnResponse } catch { lastFailReason = 'PARSE'; return null }
  if (!data.enabled || !data.iceServers || !data.expiresAt) {
    lastFailReason = data.reason ?? 'DISABLED'
    return null
  }
  lastFailReason = null
  return { iceServers: data.iceServers, expiresAt: data.expiresAt }
}

export async function refreshAutoTurn(): Promise<RTCIceServer[]> {
  if (inFlight) return (await inFlight)?.iceServers ?? []

  inFlight = fetchAutoTurnOnce()
  try {
    const result = await inFlight
    if (result) {
      // Success: adopt the new creds, reset backoff, schedule the lead-time
      // refetch, and notify only if the server set actually changed.
      const changed = !sameIceServers(autoTurn?.iceServers ?? [], result.iceServers)
      autoTurn = result
      failureAttempts = 0
      scheduleNextRefresh()
      if (changed) emitTurnConfigChange()
      return result.iceServers
    }
    // Failure path. The scheduled refresh fires REFRESH_LEAD_MS BEFORE expiry,
    // so the existing creds are usually still valid. Do NOT clobber them to
    // null on a transient 503/network blip — that would strip relay servers off
    // every live PeerConnection (via emitTurnConfigChange) and break new/ICE-
    // restarted symmetric-NAT peers until the backoff retry lands. Keep the
    // creds until they actually expire; only then drop and emit.
    let changed = false
    if (autoTurn && Date.now() >= autoTurn.expiresAt) {
      autoTurn = null
      changed = true
    }
    // P1-2: schedule an exponential-backoff retry so we recover on our own.
    scheduleFailureRetry()
    if (changed) emitTurnConfigChange()
    return autoTurn?.iceServers ?? []
  } finally {
    inFlight = null
  }
}

function sameIceServers(a: RTCIceServer[], b: RTCIceServer[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) return false
  }
  return true
}

function scheduleNextRefresh() {
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null }
  if (!autoTurn) return
  const lead = Math.max(autoTurn.expiresAt - Date.now() - REFRESH_LEAD_MS, 5_000)
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    void refreshAutoTurn()
  }, lead)
}

function scheduleFailureRetry() {
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null }
  const delay = Math.min(
    FAILURE_BACKOFF_BASE_MS * Math.pow(2, failureAttempts),
    FAILURE_BACKOFF_MAX_MS,
  )
  failureAttempts++
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    void refreshAutoTurn()
  }, delay)
}

export function clearAutoTurn() {
  const had = autoTurn !== null
  autoTurn = null
  lastFailReason = null
  failureAttempts = 0
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null }
  if (had) emitTurnConfigChange()
}

export async function fetchTurnStatus(): Promise<TurnStatusResponse | null> {
  try {
    const resp = await fetch(apiUrl('/api/turn-status'))
    if (!resp.ok) return null
    return await resp.json() as TurnStatusResponse
  } catch {
    return null
  }
}

export async function testTurnServer(server: TurnServer): Promise<boolean> {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: server.url, username: server.username, credential: server.credential }],
    iceTransportPolicy: 'relay',
  })
  pc.createDataChannel('test')
  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)

  return new Promise(resolve => {
    // P2-7: detach every listener before close() so a late candidate event
    // doesn't keep the RTCPeerConnection (and its underlying ICE agent)
    // alive in the GC graph. Without this we were leaking a few hundred KB
    // per server-test click.
    const teardown = (verdict: boolean) => {
      try { pc.onicecandidate = null } catch { /* ignore */ }
      try { pc.onicecandidateerror = null } catch { /* ignore */ }
      try { pc.onicegatheringstatechange = null } catch { /* ignore */ }
      try { pc.oniceconnectionstatechange = null } catch { /* ignore */ }
      try { pc.onconnectionstatechange = null } catch { /* ignore */ }
      try { pc.onsignalingstatechange = null } catch { /* ignore */ }
      try { pc.ondatachannel = null } catch { /* ignore */ }
      try { pc.close() } catch { /* ignore */ }
      resolve(verdict)
    }
    const timeout = setTimeout(() => teardown(false), 5000)
    pc.onicecandidate = e => {
      if (e.candidate?.candidate.includes(' typ relay ')) {
        clearTimeout(timeout)
        teardown(true)
      }
    }
  })
}
