import { apiUrl } from '@/config'
import { authedFetch, AuthRequiredError } from '@/lib/api'
import { isE2eHostIceOnly } from './e2e-ice'

const STORAGE_KEY = 'misaka.turnServers'
const TURN_SETTINGS_VERSION = 1

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

/** Explicit three-state preference for the master relay switch. */
export type TurnRelayPreference = 'unset' | 'enabled' | 'disabled'

const DEFAULT_SETTINGS: TurnSettings = { servers: [], enabled: false, forceRelay: false }

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
  retryable?: boolean
  retryAt?: number
}

export interface TurnStatusResponse {
  enabled: boolean
  configured: boolean
  provider: string
  credentialTtlSec: number
  available: boolean
  reason?: string
  detailed: false
}

/** Permanent server rejections — do not back off forever. */
const PERMANENT_FAIL_REASONS = new Set([
  'DISABLED',
  'NOT_CONFIGURED',
  'GLOBAL_QUOTA_EXCEEDED',
  'IP_BANNED',
  'SESSION_BANNED',
])

const CREDENTIAL_FETCH_TIMEOUT_MS = 12_000
const STATUS_FETCH_TIMEOUT_MS = 8_000

let autoTurn: AutoTurnState | null = null
let inFlight: Promise<AutoTurnState | null> | null = null
let refreshTimer: ReturnType<typeof setTimeout> | null = null
let lastFailReason: string | null = null
const REFRESH_LEAD_MS = 60_000   // refetch 60s before expiry

// Generation so clearAutoTurn() / logout can supersede in-flight fetches.
let autoTurnEpoch = 0
let inFlightAbort: AbortController | null = null

// P1-2: when fetchAutoTurnOnce() fails (503, network blip, parse error),
// schedule the next retry with exponential backoff capped at 60 s. Without
// this scheduleNextRefresh() bails (autoTurn === null) and we silently give
// up until the next manual trigger.
let failureAttempts = 0
const FAILURE_BACKOFF_BASE_MS = 5_000
const FAILURE_BACKOFF_MAX_MS = 60_000

// In-memory settings when localStorage is unavailable or a write fails.
let memorySettings: TurnSettings | null = null
let lastPersistOk = true

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

function isTurnServer(raw: unknown): raw is TurnServer {
  if (!raw || typeof raw !== 'object') return false
  const s = raw as Record<string, unknown>
  return typeof s.id === 'string'
    && typeof s.url === 'string'
    && typeof s.username === 'string'
    && typeof s.credential === 'string'
    && typeof s.enabled === 'boolean'
}

function normalizeTurnSettings(raw: unknown): TurnSettings | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>

  // Optional version field for future migrations; unknown versions still
  // try field-level validation rather than hard-failing.
  if ('v' in obj && obj.v !== undefined && obj.v !== TURN_SETTINGS_VERSION) {
    // Accept v-less legacy records; only reject non-numeric future junk.
    if (typeof obj.v !== 'number') return null
  }

  const enabled = obj.enabled
  const forceRelay = obj.forceRelay
  if (typeof enabled !== 'boolean') return null
  if (typeof forceRelay !== 'boolean') return null

  let servers: TurnServer[] = []
  if (obj.servers === undefined) {
    servers = []
  } else if (!Array.isArray(obj.servers)) {
    return null
  } else {
    servers = obj.servers.filter(isTurnServer).map(s => ({
      id: s.id,
      url: s.url,
      username: s.username,
      credential: s.credential,
      enabled: s.enabled,
      lastTested: typeof s.lastTested === 'number' ? s.lastTested : undefined,
      reachable: typeof s.reachable === 'boolean' ? s.reachable : undefined,
    }))
  }

  return { servers, enabled, forceRelay }
}

/** True when localStorage has an explicit user preference for TURN. */
export function hasStoredTurnPreference(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== null
  } catch {
    // If storage is unreadable but we have a successful persist in memory,
    // treat it as stored.
    return lastPersistOk && memorySettings !== null
  }
}

/**
 * Three-state master switch:
 *   unset    — never saved; auto TURN allowed (server is the gate)
 *   enabled  — user opted in
 *   disabled — user opted out; no auto or manual TURN in the PC
 *
 * Live in-memory settings (including a failed-persist write) are the single
 * source of truth for the current tab; storage is a cache that never
 * overrides them.
 */
export function getTurnRelayPreference(): TurnRelayPreference {
  // Session-live memory always wins — including when setItem threw and an
  // older enabled record is still on disk.
  if (memorySettings !== null) {
    return memorySettings.enabled ? 'enabled' : 'disabled'
  }
  if (!hasStoredTurnPreference()) return 'unset'
  return loadTurnSettings().enabled ? 'enabled' : 'disabled'
}

/** True only when the user has explicitly turned the master switch off. */
export function isTurnExplicitlyDisabled(): boolean {
  return getTurnRelayPreference() === 'disabled'
}

/** Drop the in-memory cache so the next load re-reads storage (tests / logout). */
export function resetTurnSettingsMemory(): void {
  memorySettings = null
  lastPersistOk = true
}

function cloneTurnSettings(s: TurnSettings): TurnSettings {
  return { ...s, servers: s.servers.map(x => ({ ...x })) }
}

export function loadTurnSettings(): TurnSettings {
  // Live in-memory preference is authoritative for this tab. Storage is only
  // consulted when the user has not applied a setting yet this session.
  if (memorySettings !== null) {
    return cloneTurnSettings(memorySettings)
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) {
      // Do NOT cache the struct default into memory — that would collapse
      // "unset" into an explicit disabled preference for isRelayAllowed.
      return { ...DEFAULT_SETTINGS, servers: [] }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      tlog('ignoring unparseable TURN settings')
      return { ...DEFAULT_SETTINGS, servers: [] }
    }
    const normalized = normalizeTurnSettings(parsed)
    if (!normalized) {
      tlog('ignoring invalid TURN settings shape', parsed)
      return { ...DEFAULT_SETTINGS, servers: [] }
    }
    // Cache a successful storage read so subsequent loads are stable, but
    // only after an explicit stored preference exists.
    memorySettings = normalized
    lastPersistOk = true
    return cloneTurnSettings(normalized)
  } catch {
    return { ...DEFAULT_SETTINGS, servers: [] }
  }
}

export interface SaveTurnSettingsResult {
  persisted: boolean
}

/**
 * Apply TURN settings. Always updates the live in-memory config and notifies
 * listeners. Persistence may fail (quota / sandbox); callers can surface
 * "本次有效但无法保存" when `persisted` is false.
 */
export function saveTurnSettings(settings: TurnSettings): SaveTurnSettingsResult {
  const next: TurnSettings = {
    enabled: !!settings.enabled,
    forceRelay: !!settings.forceRelay,
    servers: Array.isArray(settings.servers)
      ? settings.servers.filter(isTurnServer).map(s => ({ ...s }))
      : [],
  }
  memorySettings = next
  let persisted = false
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      v: TURN_SETTINGS_VERSION,
      enabled: next.enabled,
      forceRelay: next.forceRelay,
      servers: next.servers,
    }))
    lastPersistOk = true
    persisted = true
  } catch (err) {
    lastPersistOk = false
    tlog('localStorage write failed; settings live for this session only', err)
  }
  // The `enabled` flag, manual server list, and `forceRelay` flag all feed
  // into RTCConfiguration. Notify so live PCs can rebuild their config.
  emitTurnConfigChange()
  return { persisted }
}

export function getTurnIceServers(): RTCIceServer[] {
  const t = loadTurnSettings()
  if (!t.enabled) return []
  return t.servers
    .filter(s =>
      s.enabled
      && isValidTurnUrl(s.url)
      && s.username.trim().length > 0
      && s.credential.length > 0,
    )
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

function isRetryableFailure(reason: string | null, status?: number): boolean {
  if (reason && PERMANENT_FAIL_REASONS.has(reason)) return false
  if (status === 401 || status === 403) return false
  // 5xx, network, parse, CF_ERROR, kill-switch budget etc. stay retryable.
  return true
}

function abortableTimeout(ms: number, parent?: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), ms)
  const onParent = () => ac.abort()
  if (parent) {
    if (parent.aborted) ac.abort()
    else parent.addEventListener('abort', onParent, { once: true })
  }
  return {
    signal: ac.signal,
    dispose: () => {
      clearTimeout(timer)
      if (parent) parent.removeEventListener('abort', onParent)
    },
  }
}

function abortError(): Error {
  const err = new Error('The operation was aborted')
  err.name = 'AbortError'
  return err
}

/** Race a promise against an AbortSignal (mocks often ignore `signal`). */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      v => { signal.removeEventListener('abort', onAbort); resolve(v) },
      e => { signal.removeEventListener('abort', onAbort); reject(e) },
    )
  })
}

async function fetchAutoTurnOnce(signal: AbortSignal): Promise<AutoTurnState | null> {
  let resp: Response
  try {
    resp = await raceAbort(authedFetch('/api/turn-credentials', { signal }), signal)
  } catch (err) {
    if (signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
      lastFailReason = 'ABORTED'
      return null
    }
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

export interface RefreshAutoTurnOptions {
  /** Explicit user gesture (Settings "下发中继凭证") may force a fetch even when disabled. */
  force?: boolean
}

export async function refreshAutoTurn(options: RefreshAutoTurnOptions = {}): Promise<RTCIceServer[]> {
  // Playwright's paired Chromium contexts are intentionally host-only. Do
  // not hit /turn-credentials or arm background retries in that environment.
  if (isE2eHostIceOnly()) return []

  // Explicit opt-out: never burn the Cloudflare issuance budget.
  if (!options.force && isTurnExplicitlyDisabled()) {
    if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null }
    return []
  }

  if (inFlight) return (await inFlight)?.iceServers ?? []

  const epoch = autoTurnEpoch
  const ac = new AbortController()
  inFlightAbort = ac
  const timeout = abortableTimeout(CREDENTIAL_FETCH_TIMEOUT_MS, ac.signal)

  inFlight = (async () => {
    try {
      return await fetchAutoTurnOnce(timeout.signal)
    } finally {
      timeout.dispose()
    }
  })()

  try {
    const result = await inFlight
    // Superseded by clearAutoTurn() — do not resurrect state or timers.
    if (epoch !== autoTurnEpoch) return autoTurn?.iceServers ?? []

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
    if (isRetryableFailure(lastFailReason)) {
      scheduleFailureRetry()
    } else if (refreshTimer) {
      clearTimeout(refreshTimer)
      refreshTimer = null
    }
    if (changed) emitTurnConfigChange()
    return autoTurn?.iceServers ?? []
  } finally {
    if (inFlightAbort === ac) inFlightAbort = null
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
  const epoch = autoTurnEpoch
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    if (epoch !== autoTurnEpoch) return
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
  const epoch = autoTurnEpoch
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    if (epoch !== autoTurnEpoch) return
    void refreshAutoTurn()
  }, delay)
}

export function clearAutoTurn() {
  autoTurnEpoch++
  if (inFlightAbort) {
    try { inFlightAbort.abort() } catch { /* ignore */ }
    inFlightAbort = null
  }
  const had = autoTurn !== null
  autoTurn = null
  lastFailReason = null
  failureAttempts = 0
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null }
  // inFlight promise is released by its own finally; epoch check blocks commit.
  if (had) emitTurnConfigChange()
}

export async function fetchTurnStatus(signal?: AbortSignal): Promise<TurnStatusResponse | null> {
  const timeout = abortableTimeout(STATUS_FETCH_TIMEOUT_MS, signal)
  try {
    const resp = await fetch(apiUrl('/api/turn-status'), { signal: timeout.signal })
    if (!resp.ok) return null
    return await resp.json() as TurnStatusResponse
  } catch {
    return null
  } finally {
    timeout.dispose()
  }
}

// ── BUG-026: typed TURN diagnostics ──────────────────────────────────
// `testTurnServer` constructed an RTCPeerConnection and awaited
// createOffer/setLocalDescription *outside* any try. A malformed URL (the
// add-server form accepts free text) throws synchronously from the
// constructor, and a WebRTC-disabled/hardened browser throws from
// createOffer. Both rejections propagated to the caller's
// `await testTurnServer(...)` with no catch, so `setTestingId(null)` never
// ran and the row sat on "测试中…" forever with no explanation.

export type TurnTestCode =
  | 'RELAY_OK'          // a relay candidate was gathered — server works
  | 'NO_RELAY'          // gathering finished/timed out with no relay candidate
  | 'INVALID_URL'       // not a turn:/turns: URL we can hand to the browser
  | 'WEBRTC_UNAVAILABLE'// RTCPeerConnection missing or blocked
  | 'SETUP_FAILED'      // constructor / createOffer / setLocalDescription threw
  | 'TEST_MODE_BLOCKED' // deterministic host-only E2E refuses external relay probes

export interface TurnTestResult {
  reachable: boolean
  code: TurnTestCode
  /** Localised, actionable message — safe to render directly. */
  message: string
  /** Raw error text for the "技术诊断" area / console only. */
  detail?: string
}

const DIAGNOSTIC_DEADLINE_MS = 5_000

const TEST_MESSAGES: Record<TurnTestCode, string> = {
  RELAY_OK: '可达，已成功获取中继候选',
  NO_RELAY: '未获取到中继候选。请检查地址、端口、用户名和密码，或确认服务器允许本网络访问。',
  INVALID_URL: '地址格式无效。应形如 turn:example.com:3478?transport=udp。',
  WEBRTC_UNAVAILABLE: '当前浏览器不可用 WebRTC，无法测试。请更换浏览器或关闭相关隐私屏蔽后重试。',
  SETUP_FAILED: '测试无法启动。请检查地址格式后重试。',
  TEST_MODE_BLOCKED: '端到端测试模式已禁用外部 TURN 诊断，以保持同机连接测试确定性。',
}

export function describeTurnTest(code: TurnTestCode): string {
  return TEST_MESSAGES[code]
}

export function isValidTurnUrl(value: string): boolean {
  const input = value.trim()
  const match = /^(turn|turns):(.+)$/i.exec(input)
  if (!match) return false

  const target = match[2]
  if (
    target.startsWith('//')
    || /[\s/@#\\%]/.test(target)
    || target.split('?').length > 2
  ) return false

  const [hostPort, rawQuery] = target.split('?')
  if (!hostPort) return false
  if (rawQuery !== undefined) {
    // Accept one exact supported parameter. URLSearchParams would otherwise
    // hide empty segments (`&&` or trailing `&`) during normalization.
    if (!/^transport=(udp|tcp)$/i.test(rawQuery)) return false
  }

  let host: string
  let portText: string | undefined
  if (hostPort.startsWith('[')) {
    const ipv6 = /^\[([0-9a-f:.]+)\](?::(\d+))?$/i.exec(hostPort)
    if (!ipv6) return false
    host = `[${ipv6[1]}]`
    portText = ipv6[2]
    try {
      const parsed = new URL(`http://${host}`)
      // WHATWG canonicalizes equivalent IPv6 spellings (zero compression,
      // leading zeros, and dotted IPv4 tails). Parseability is the security
      // boundary here; textual equality would reject those legal forms.
      // The authority regex and the global `%/@#\\` rejection above already
      // exclude credentials, encoded delimiters, paths and zone identifiers.
      if (
        parsed.protocol !== 'http:'
        || !parsed.hostname.startsWith('[')
        || !parsed.hostname.endsWith(']')
        || parsed.username
        || parsed.password
        || parsed.port
        || parsed.pathname !== '/'
        || parsed.search
        || parsed.hash
      ) return false
    } catch {
      return false
    }
  } else {
    const authority = /^([^:]+)(?::(\d+))?$/.exec(hostPort)
    if (!authority) return false
    host = authority[1]
    portText = authority[2]
    if (host.length > 253 || host.startsWith('.') || host.endsWith('.')) return false
    const labels = host.split('.')
    if (labels.some(label =>
      label.length < 1
      || label.length > 63
      || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label),
    )) return false
    if (labels.every(label => /^\d+$/.test(label))) {
      if (labels.length !== 4 || labels.some(label => Number(label) > 255)) return false
    }
  }

  if (portText !== undefined) {
    const port = Number(portText)
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return false
  }
  return true
}

function deadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('DIAGNOSTIC_TIMEOUT')), ms)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

/**
 * Full diagnostic result. Never rejects — every failure path is a typed
 * result the UI can turn into a recovery hint.
 */
export async function testTurnServerDetailed(server: TurnServer): Promise<TurnTestResult> {
  if (isE2eHostIceOnly()) {
    return {
      reachable: false,
      code: 'TEST_MODE_BLOCKED',
      message: TEST_MESSAGES.TEST_MODE_BLOCKED,
    }
  }
  if (!isValidTurnUrl(server.url ?? '')) {
    return { reachable: false, code: 'INVALID_URL', message: TEST_MESSAGES.INVALID_URL }
  }
  if (typeof RTCPeerConnection === 'undefined') {
    return { reachable: false, code: 'WEBRTC_UNAVAILABLE', message: TEST_MESSAGES.WEBRTC_UNAVAILABLE }
  }

  const expiresAt = Date.now() + DIAGNOSTIC_DEADLINE_MS
  let pc: RTCPeerConnection
  try {
    pc = new RTCPeerConnection({
      iceServers: [{ urls: server.url, username: server.username, credential: server.credential }],
      iceTransportPolicy: 'relay',
    })
  } catch (err) {
    return {
      reachable: false,
      code: 'INVALID_URL',
      message: TEST_MESSAGES.INVALID_URL,
      detail: String(err),
    }
  }

  try {
    pc.createDataChannel('test')
    await deadline((async () => {
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
    })(), Math.max(0, expiresAt - Date.now()))
  } catch (err) {
    try { pc.close() } catch { /* ignore */ }
    return {
      reachable: false,
      code: 'SETUP_FAILED',
      message: TEST_MESSAGES.SETUP_FAILED,
      detail: String(err),
    }
  }

  const reachable = await waitForRelayCandidate(pc, expiresAt)
  return reachable
    ? { reachable: true, code: 'RELAY_OK', message: TEST_MESSAGES.RELAY_OK }
    : { reachable: false, code: 'NO_RELAY', message: TEST_MESSAGES.NO_RELAY }
}

/**
 * Back-compatible boolean wrapper. Kept so existing callers and tests keep
 * working; new code should prefer `testTurnServerDetailed`.
 */
export async function testTurnServer(server: TurnServer): Promise<boolean> {
  return (await testTurnServerDetailed(server)).reachable
}

function waitForRelayCandidate(pc: RTCPeerConnection, expiresAt: number): Promise<boolean> {
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
    const timeout = setTimeout(() => teardown(false), Math.max(0, expiresAt - Date.now()))
    pc.onicecandidate = e => {
      if (e.candidate?.candidate.includes(' typ relay ')) {
        clearTimeout(timeout)
        teardown(true)
      }
    }
  })
}
