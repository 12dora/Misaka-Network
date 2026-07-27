import {
  getTurnIceServers, getAutoTurnIceServers, loadTurnSettings, refreshAutoTurn, isAutoTurnStaleWithin,
  SUPPLEMENTAL_STUN,
} from './turn'
import { getDetectedNatType } from './nat'
import { isE2eHostIceOnly } from './e2e-ice'
import { DEFAULT_STUN, ICE_CANDIDATE_POOL_SIZE } from '@/constants'

// ── Logging helper ───────────────────────────────────────────────────
// Unified console.warn prefix so log lines from the network layer carry a
// scope tag + timestamp. Cheap to call — formatting only happens when
// console.warn actually runs. P2-9.
export function wlog(scope: string, ...args: unknown[]) {
  const ts = new Date().toISOString().slice(11, 23)   // HH:MM:SS.mmm
  console.warn(`[${scope} ${ts}]`, ...args)
}

// How close to expiry we consider the auto-TURN credential "stale enough"
// that the next PC should wait for a refresh rather than starting with creds
// that will die in seconds. 10s gives the new fetch room to complete before
// ICE actually needs the relay candidate.
const AUTO_TURN_STALE_WINDOW_MS = 10_000

// One-shot pre-warm so connections kicked off immediately after WS open
// can still get TURN ICE servers from the first RTCPeerConnection.
// refreshAutoTurn is idempotent / coalesces in-flight calls.
export async function ensureAutoTurnReady(timeoutMs = 1500): Promise<void> {
  if (isE2eHostIceOnly()) return
  // P1: previously this only re-fetched when there were *zero* servers. A
  // credential that was about to expire (or had just expired) would still
  // satisfy the early-return, so the next PC built with it failed ICE the
  // moment the relay candidate timed out. Check staleness, not emptiness.
  if (!isAutoTurnStaleWithin(AUTO_TURN_STALE_WINDOW_MS) && getAutoTurnIceServers().length > 0) return
  try {
    await Promise.race([
      refreshAutoTurn(),
      new Promise(resolve => setTimeout(resolve, timeoutMs)),
    ])
  } catch { /* ignore — fall through with whatever we have */ }
}

// ICE candidate pair → channel type
export type ChannelType = 'direct' | 'stun' | 'relay'
export interface SelectedIcePath {
  channelType: ChannelType | null
  pathText: string
}

export function candidateType(candidate: RTCIceCandidate): ChannelType | null {
  if (!candidate.candidate) return null
  const s = candidate.candidate.toLowerCase()
  if (s.includes(' typ host ')) return 'direct'
  if (s.includes(' typ srflx ')) return 'stun'
  if (s.includes(' typ relay ')) return 'relay'
  return null
}

export async function getSelectedChannelType(pc: RTCPeerConnection): Promise<ChannelType | null> {
  return (await getSelectedIcePath(pc))?.channelType ?? null
}

type CandidateKind = 'host' | 'srflx' | 'relay' | 'unknown'

function normalizeCandidateType(t?: string): CandidateKind {
  if (t === 'host' || t === 'srflx' || t === 'relay') return t
  // A peer-reflexive candidate is a NAT-mapped address discovered during
  // connectivity checks — for reporting purposes it behaves like srflx, not
  // like a directly reachable host address.
  if (t === 'prflx') return 'srflx'
  return 'unknown'
}

// BUG-010: classify the candidate PAIR, not just our own side. A host/srflx
// local candidate paired with a remote `relay` candidate is still a relayed
// path: the bytes cross the TURN server, we still pay for them, and the
// privacy statement ("your traffic is relayed") still applies. Reporting it
// as "直接信道" misled users, cost attribution and support diagnosis alike.
export function classifyCandidatePair(local: CandidateKind, remote: CandidateKind): ChannelType | null {
  if (local === 'relay' || remote === 'relay') return 'relay'
  if (local === 'srflx' || remote === 'srflx') return 'stun'
  if (local === 'host' || remote === 'host') return 'direct'
  return null
}

export async function getSelectedIcePath(pc: RTCPeerConnection): Promise<SelectedIcePath | null> {
  try {
    const stats = await pc.getStats()
    for (const report of stats.values()) {
      if (report.type !== 'candidate-pair' || report.state !== 'succeeded' || !report.nominated) continue
      const local = stats.get(report.localCandidateId)
      const remote = stats.get(report.remoteCandidateId)
      const localType = normalizeCandidateType(local?.candidateType)
      const remoteType = normalizeCandidateType(remote?.candidateType)
      const channelType = classifyCandidatePair(localType, remoteType)
      const localProto = local?.protocol || '?'
      const remoteProto = remote?.protocol || '?'
      return {
        channelType,
        pathText: `${localType}/${localProto} → ${remoteType}/${remoteProto}`,
      }
    }
  } catch { /* stats may fail */ }
  return null
}

// ── TURN master switch ───────────────────────────────────────────────
// BUG-008: "启用 TURN 中继" is presented as a master switch, but only the
// MANUAL server list honoured it — server-issued auto credentials were
// injected unconditionally, so a user who turned relaying off kept relaying
// (with whatever creds were already cached) until the tab was closed.
//
// The one nuance: `loadTurnSettings()` has no "unset" state and returns
// `enabled: false` for a user who has simply never opened Settings. Treating
// that struct default as an opt-out would disable server-issued TURN for
// everybody out of the box. So: an explicitly persisted record is honoured
// verbatim; the absence of a record leaves auto TURN on (the server remains
// the canonical gate via its budget / kill-switch) and manual TURN off
// (there are no manual servers before the record exists anyway).
//
// Mirrors turn.ts's STORAGE_KEY — duplicated rather than exported because
// turn.ts owns the persistence format and we only need "has the user ever
// expressed a preference".
const TURN_SETTINGS_STORAGE_KEY = 'misaka.turnServers'

function hasStoredTurnPreference(): boolean {
  try { return localStorage.getItem(TURN_SETTINGS_STORAGE_KEY) !== null } catch { return false }
}

/** Whether ANY relay (auto or manual) may be attached to a peer connection. */
export function isRelayAllowed(): boolean {
  if (loadTurnSettings().enabled) return true
  return !hasStoredTurnPreference()
}

function isTurnUrl(u: unknown): boolean {
  return typeof u === 'string' && (u.startsWith('turn:') || u.startsWith('turns:'))
}

function containsTurn(servers: RTCIceServer[]): boolean {
  return servers.some(s => (Array.isArray(s.urls) ? s.urls : [s.urls]).some(isTurnUrl))
}

/** True when the current settings would actually yield a relay candidate. */
export function hasUsableTurnServer(): boolean {
  return containsTurn(currentTurnServers())
}

function currentTurnServers(): RTCIceServer[] {
  if (!isRelayAllowed()) return []
  // getTurnIceServers() already returns [] unless the master switch is on.
  return [...getAutoTurnIceServers(), ...getTurnIceServers()]
}

// Single source of truth for the RTCConfiguration derived from current TURN
// state — used both for new PCs and to re-apply via `pc.setConfiguration()`
// on existing PCs when creds rotate or the user flips force-relay.
export function buildIceConfig(): RTCConfiguration {
  if (isE2eHostIceOnly()) {
    return {
      iceServers: [],
      iceTransportPolicy: 'all',
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
      iceCandidatePoolSize: ICE_CANDIDATE_POOL_SIZE,
    }
  }
  const turnSettings = loadTurnSettings()
  // Order: STUN → server-issued auto TURN → manual user TURN. Both TURN
  // tiers sit behind the master switch (see isRelayAllowed above).
  const turnServers = currentTurnServers()
  const iceServers: RTCIceServer[] = [
    ...DEFAULT_STUN,
    ...SUPPLEMENTAL_STUN,
    ...turnServers,
  ]
  // P1: when local NAT is symmetric, host candidates can't be reached and
  // srflx candidates won't match the peer's expectations either — only relay
  // works reliably. Previously this required the user to manually flip
  // "强制使用 TURN" in Settings; now we do it automatically once
  // `detectNatType()` has marked us symmetric. The Settings toggle still
  // wins if it's already set.
  //
  // BUG-008 (second half): a 'relay' policy with no TURN entry can never
  // produce a candidate — it guarantees connection failure. Refuse it,
  // whichever side asked for it. `hasUsableTurnServer()` is exported so the
  // Settings UI can refuse/clear the toggle instead of silently disagreeing
  // with what we actually apply.
  const natIsSymmetric = getDetectedNatType() === 'symmetric'
  const forceRelay = containsTurn(turnServers) && (turnSettings.forceRelay || natIsSymmetric)
  return {
    iceServers,
    iceTransportPolicy: forceRelay ? 'relay' : 'all',
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
    iceCandidatePoolSize: ICE_CANDIDATE_POOL_SIZE,
  }
}

export function createPeerConnection(): RTCPeerConnection {
  return new RTCPeerConnection(buildIceConfig())
}

// BUG-009: `setConfiguration()` re-arms the ICE agent for the NEXT gathering
// round; it does not move an already-selected candidate pair. Flipping
// force-relay on a live call therefore left the media path exactly where it
// was while the UI claimed otherwise. We record the effective config per PC
// and report the ones that materially changed so the caller (network.ts,
// which owns signaling) can schedule an ICE restart at a safe moment.
const appliedIceSignature = new WeakMap<RTCPeerConnection, string>()

function iceConfigSignature(cfg: RTCConfiguration): string {
  const urls = (cfg.iceServers ?? []).flatMap(s => {
    const list = Array.isArray(s.urls) ? s.urls : [s.urls]
    // Credentials matter too — a rotated username/password is a different
    // relay session even when the URL is unchanged.
    return list.map(u => `${u}|${s.username ?? ''}|${s.credential ?? ''}`)
  })
  return `${cfg.iceTransportPolicy ?? 'all'}::${urls.join(',')}`
}

// Re-apply the current TURN config to every live PC. Called when auto-TURN
// creds refresh, when the user toggles force-relay, when manual servers are
// added/removed, etc. Without this an existing connection keeps the original
// (now stale) creds until it's torn down and re-created.
//
// Returns the PCs whose effective config changed since the last call (empty
// on the first call for a given PC — that only establishes the baseline).
export function applyIceConfigToAll(pcs: Iterable<RTCPeerConnection>): RTCPeerConnection[] {
  const cfg = buildIceConfig()
  const signature = iceConfigSignature(cfg)
  const changed: RTCPeerConnection[] = []
  for (const pc of pcs) {
    if (pc.connectionState === 'closed') continue
    const previous = appliedIceSignature.get(pc)
    appliedIceSignature.set(pc, signature)
    if (previous !== undefined && previous !== signature) changed.push(pc)
    // P0: setConfiguration() throws InvalidModificationError on Chrome the
    // moment iceCandidatePoolSize differs from the pool size used at
    // construction time AND gathering has begun (iceGatheringState !=
    // 'new'). Carry the pool size that was actually used at construction
    // so creds + policy still propagate without retripping the spec check.
    let live: RTCConfiguration = cfg
    if (pc.iceGatheringState !== 'new') {
      let currentPool = 0
      try {
        currentPool = pc.getConfiguration?.().iceCandidatePoolSize ?? 0
      } catch { /* getConfiguration may not exist on older shims */ }
      live = { ...cfg, iceCandidatePoolSize: currentPool }
    }
    try {
      // setConfiguration accepts a partial; we always pass the full one so
      // toggling forceRelay OFF actually clears the prior 'relay' policy.
      pc.setConfiguration(live)
    } catch (err) {
      wlog('webrtc', 'setConfiguration failed', err)
    }
  }
  return changed
}

export function createDataChannel(pc: RTCPeerConnection, label = 'misaka'): RTCDataChannel {
  return pc.createDataChannel(label, {
    ordered: true,
  })
}

// Trickle ICE: return the SDP as soon as the local description is set, then
// stream candidates over the signaling channel via `onicecandidate`.
// Previously we waited for `iceGatheringState === 'complete'` but the
// listener was registered with `{ once: true }` — the first transition is
// usually `new → gathering`, the handler fires, doesn't resolve, gets
// removed, and the `complete` event later has no handler. The whole
// handshake hung, the DC never opened, and the user saw "DataChannel 打开超时".
function assertNegotiationCurrent(isCurrent?: () => boolean) {
  if (isCurrent && !isCurrent()) throw new DOMException('Stale WebRTC negotiation attempt', 'AbortError')
}

export async function createOffer(
  pc: RTCPeerConnection,
  isCurrent?: () => boolean,
): Promise<RTCSessionDescriptionInit> {
  const offer = await pc.createOffer()
  assertNegotiationCurrent(isCurrent)
  await pc.setLocalDescription(offer)
  assertNegotiationCurrent(isCurrent)
  return pc.localDescription!.toJSON()
}

export async function createAnswer(
  pc: RTCPeerConnection,
  offer: RTCSessionDescriptionInit,
  isCurrent?: () => boolean,
): Promise<RTCSessionDescriptionInit> {
  await pc.setRemoteDescription(new RTCSessionDescription(offer))
  assertNegotiationCurrent(isCurrent)
  const answer = await pc.createAnswer()
  assertNegotiationCurrent(isCurrent)
  await pc.setLocalDescription(answer)
  assertNegotiationCurrent(isCurrent)
  return pc.localDescription!.toJSON()
}

export async function applyAnswer(
  pc: RTCPeerConnection,
  answer: RTCSessionDescriptionInit,
  isCurrent?: () => boolean,
) {
  await pc.setRemoteDescription(new RTCSessionDescription(answer))
  assertNegotiationCurrent(isCurrent)
}

export async function addIceCandidate(pc: RTCPeerConnection, candidate: RTCIceCandidateInit) {
  await pc.addIceCandidate(new RTCIceCandidate(candidate))
}

// ── ICE restart re-queue helper ──────────────────────────────────────
// P1-4: ICE restart used to no-op silently when the PC was mid-roundtrip
// (signalingState !== 'stable'). Callers in network.ts now await this
// helper before retrying, instead of dropping the restart on the floor.
export interface WhenSignalingStableOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

export function whenSignalingStable(
  pc: RTCPeerConnection,
  opts: WhenSignalingStableOptions = {},
): Promise<void> {
  if (pc.signalingState === 'stable') return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const onChange = () => {
      if (pc.signalingState === 'stable') {
        cleanup()
        resolve()
      }
    }
    const onAbort = () => {
      cleanup()
      reject(new DOMException('Aborted while waiting for signalingState=stable', 'AbortError'))
    }
    const onTimeout = () => {
      cleanup()
      reject(new Error('Timeout waiting for signalingState=stable'))
    }
    const cleanup = () => {
      pc.removeEventListener('signalingstatechange', onChange)
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort)
      if (timer) { clearTimeout(timer); timer = null }
    }
    pc.addEventListener('signalingstatechange', onChange)
    if (opts.signal) {
      if (opts.signal.aborted) { onAbort(); return }
      opts.signal.addEventListener('abort', onAbort, { once: true })
    }
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(onTimeout, opts.timeoutMs)
    }
  })
}

// ── End-of-candidates helper ─────────────────────────────────────────
// P1-5: Firefox throws when you create an RTCIceCandidate({ candidate: '' })
// without a valid sdpMid. We need to pull the mid from the first transceiver
// (or the data-channel only DataChannel-style m-line). Returns a payload
// that's safe to pass to new RTCIceCandidate() across browsers.
export function endOfCandidatesFor(
  pc: RTCPeerConnection,
  locator?: RTCIceCandidateInit,
): RTCIceCandidateInit {
  if (locator && (locator.sdpMid != null || locator.sdpMLineIndex != null)) {
    return {
      candidate: '',
      sdpMid: locator.sdpMid ?? null,
      sdpMLineIndex: locator.sdpMLineIndex ?? null,
      ...(locator.usernameFragment != null
        ? { usernameFragment: locator.usernameFragment }
        : {}),
    }
  }
  let sdpMid: string | null = null
  let sdpMLineIndex: number | null = null
  try {
    const txs = pc.getTransceivers?.() ?? []
    for (let i = 0; i < txs.length; i++) {
      const m = txs[i].mid
      if (typeof m === 'string' && m.length > 0) {
        sdpMid = m
        sdpMLineIndex = i
        break
      }
    }
  } catch { /* getTransceivers may not exist on shims */ }
  if (sdpMid === null) {
    // Fall back to scraping the local SDP for the first m=... line's mid.
    try {
      const sdp = pc.localDescription?.sdp ?? ''
      const lines = sdp.split(/\r?\n/)
      let mIndex = -1
      for (const line of lines) {
        if (line.startsWith('m=')) {
          mIndex++
          if (sdpMLineIndex === null) sdpMLineIndex = mIndex
        }
        const match = line.match(/^a=mid:(\S+)/)
        if (match) {
          sdpMid = match[1]
          break
        }
      }
    } catch { /* ignore */ }
  }
  // Last-ditch defaults — Chromium tolerates these even when empty.
  return {
    candidate: '',
    sdpMid: sdpMid ?? '0',
    sdpMLineIndex: sdpMLineIndex ?? 0,
  }
}

/** One media-scoped EOC marker per local SDP m-line. */
export function endOfCandidateMarkersFor(pc: RTCPeerConnection): RTCIceCandidateInit[] {
  const media: Array<RTCIceCandidateInit & { mediaUfrag?: string | null }> = []
  let sessionUfrag: string | null = null
  try {
    const lines = pc.localDescription?.sdp?.split(/\r?\n/) ?? []
    let current: (RTCIceCandidateInit & { mediaUfrag?: string | null }) | null = null
    for (const line of lines) {
      if (line.startsWith('m=')) {
        current = {
          candidate: '',
          sdpMid: null,
          sdpMLineIndex: media.length,
          mediaUfrag: null,
        }
        media.push(current)
      } else if (line.startsWith('a=mid:') && current) {
        current.sdpMid = line.slice('a=mid:'.length).trim() || null
      } else if (line.startsWith('a=ice-ufrag:')) {
        const ufrag = line.slice('a=ice-ufrag:'.length).trim()
        if (!ufrag) continue
        if (current) current.mediaUfrag = ufrag
        else sessionUfrag = ufrag
      }
    }
  } catch { /* malformed/missing local SDP falls back below */ }
  if (media.length === 0) return [endOfCandidatesFor(pc)]
  return media.map(({ mediaUfrag, ...marker }) => {
    const usernameFragment = mediaUfrag ?? sessionUfrag
    return {
      ...marker,
      ...(usernameFragment !== null ? { usernameFragment } : {}),
    }
  })
}

// ── ICE error introspection ──────────────────────────────────────────
// P2-8: pc.onicecandidateerror fires on STUN/TURN reachability failures
// (host unreachable, TURN auth, port blocked). We stash the most recent
// error per-PC in a WeakMap so the diagnostics UI can render it without
// every PC having to manage its own listener.
export interface IceErrorSummary {
  errorCode: number
  errorText: string
  url: string
  hostCandidate: string
  at: number   // ms epoch
}
const iceErrorLog = new WeakMap<RTCPeerConnection, IceErrorSummary>()

export function installIceErrorListener(pc: RTCPeerConnection): void {
  // Use property assignment for broadest compatibility — addEventListener
  // also fires it, but `onicecandidateerror` is the canonical hook.
  const handler = (event: any) => {
    const summary: IceErrorSummary = {
      errorCode: Number(event?.errorCode ?? 0),
      errorText: String(event?.errorText ?? ''),
      url: String(event?.url ?? ''),
      hostCandidate: String(event?.hostCandidate ?? event?.address ?? ''),
      at: Date.now(),
    }
    iceErrorLog.set(pc, summary)
    wlog('ice', 'candidate error', summary)
  }
  try {
    pc.addEventListener('icecandidateerror', handler)
  } catch { /* very old browsers */ }
}

export function getLastIceError(pc: RTCPeerConnection): IceErrorSummary | null {
  return iceErrorLog.get(pc) ?? null
}

// Re-export wlog so consumers across the network layer share one helper.
export const log = wlog
