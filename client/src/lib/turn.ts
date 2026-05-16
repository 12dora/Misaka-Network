import { apiUrl } from '@/config'
import { authedFetch, AuthRequiredError } from '@/lib/api'

const STORAGE_KEY = 'misaka.turnServers'

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
    return []
  }
  return autoTurn.iceServers
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
    autoTurn = result
    scheduleNextRefresh()
    return result?.iceServers ?? []
  } finally {
    inFlight = null
  }
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

export function clearAutoTurn() {
  autoTurn = null
  lastFailReason = null
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null }
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
    const timeout = setTimeout(() => { pc.close(); resolve(false) }, 5000)
    pc.onicecandidate = e => {
      if (e.candidate?.candidate.includes(' typ relay ')) {
        clearTimeout(timeout)
        pc.close()
        resolve(true)
      }
    }
  })
}
