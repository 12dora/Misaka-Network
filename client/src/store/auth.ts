import { create } from 'zustand'
import type { Identity, LegacyStoredSession, Session } from '@/types'
import { apiUrl } from '@/config'
import { NODE_ID_MIN, NODE_ID_MAX } from '@/constants'
import { onAuthInvalid, endSession } from '@/lib/signaling'
import { secureRandomInt, generatePassCode } from '@/lib/passcode'

// Session as stored client-side. reRegisterProof is a required Session key
// with a nullable value: every construction site decides deliberately, but a
// missing proof degrades silent recovery rather than blocking the session.
export type AuthSession = Session

/** Non-empty recovery proof, or null when auto-recovery is unavailable. */
function normalizeProof(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

// Web Locks API mutex: hold this lock for the lifetime of the tab. If another
// tab in the same origin tries to register the same nodeId, its `request()`
// with `ifAvailable: true` returns null and we surface a clear conflict
// message. Browsers without Web Locks (older Safari) silently no-op — degraded
// behavior matches the pre-existing "last writer wins" anyway.
let nodeIdLockRelease: (() => void) | null = null
let lockedNodeId: number | null = null
/** Auth-op generation that currently owns the Web Lock lease. */
let lockOwnerGen: number | null = null

async function acquireNodeIdLock(nodeId: number, gen: number): Promise<boolean> {
  if (typeof navigator === 'undefined' || !('locks' in navigator)) {
    lockOwnerGen = gen
    lockedNodeId = nodeId
    return true
  }
  // Re-entrant: if THIS tab already holds the lock for this same nodeId, don't
  // issue a second competing `ifAvailable` request (which the browser would
  // deny with lock===null, falsely reporting a same-tab conflict). Transfer
  // ownership to the newer generation so a superseded op's finally cannot
  // release a lock the newer op still needs.
  if (nodeIdLockRelease && lockedNodeId === nodeId) {
    lockOwnerGen = gen
    return true
  }
  // Release any previously held lock (user changed nodeId).
  if (nodeIdLockRelease) {
    nodeIdLockRelease()
    nodeIdLockRelease = null
    lockedNodeId = null
    lockOwnerGen = null
  }
  return new Promise<boolean>((resolve) => {
    // ifAvailable: true → never block, returns null on contention.
    navigator.locks.request(
      `misaka-node-${nodeId}`,
      { ifAvailable: true },
      (lock) => {
        if (!lock) { resolve(false); return undefined }
        lockedNodeId = nodeId
        lockOwnerGen = gen
        resolve(true)
        // Hold for the tab's lifetime via a never-resolving promise; the
        // browser releases the lock automatically on tab close / refresh.
        return new Promise<void>((release) => {
          nodeIdLockRelease = release
        })
      },
    ).catch(() => {
      lockOwnerGen = gen
      lockedNodeId = nodeId
      resolve(true)
    })
  })
}

// ── Auth operation generation / connect dedupe ───────────────────────
// Monotonic generation + AbortController so a late /register cannot reverse
// a disconnect or an identity switch. Dedupe key includes identity + grant so
// a plain re-auth never swallows a QR admission commit.
let authOpGen = 0
let connectAbort: AbortController | null = null
// In-flight connect promises resolve to whether THIS operation committed a
// session (callers must not read a stale global isConnected).
let connectInFlight: { key: string; promise: Promise<boolean> } | null = null

// BUG-001: the same idempotency for logout. A double-click on Disconnect (or
// a 4001 close racing the button) must not fire two /api/release calls, two
// network teardowns, or interleave a re-register into the middle of a logout.
let disconnectInFlight: Promise<void> | null = null

// Contract 2 — seamless session renewal.
let renewTimer: ReturnType<typeof setTimeout> | null = null
let renewBackoffAttempts = 0
const RENEW_LEAD_MS = 5 * 60_000
const RENEW_MIN_DELAY_MS = 5_000
const REGISTER_TIMEOUT_MS = 15_000

// Drop-in hook for network epoch teardown (network.ts does not own this file).
// network.ts should: onSessionInvalid(() => destroy/end epoch) at module init.
type SessionInvalidListener = () => void
const sessionInvalidListeners = new Set<SessionInvalidListener>()

export function onSessionInvalid(fn: SessionInvalidListener): () => void {
  sessionInvalidListeners.add(fn)
  return () => sessionInvalidListeners.delete(fn)
}

function emitSessionInvalid() {
  for (const fn of sessionInvalidListeners) {
    try { fn() } catch (err) { console.warn('[auth] session-invalid listener failed', err) }
  }
}

function releaseNodeIdLock() {
  if (nodeIdLockRelease) { nodeIdLockRelease(); nodeIdLockRelease = null; lockedNodeId = null }
  lockOwnerGen = null
}

/** Release the Web Lock only if `gen` still owns the lease. */
function releaseNodeIdLockForGen(gen: number) {
  if (lockOwnerGen === gen) releaseNodeIdLock()
}

/** Bump generation + abort any in-flight connect (identity change / logout). */
function supersedeInFlightAuthOp() {
  authOpGen++
  if (connectAbort) {
    try { connectAbort.abort() } catch { /* ignore */ }
    connectAbort = null
  }
  connectInFlight = null
}

type AuthGet = () => AuthState
type AuthSet = (partial: Partial<AuthState>) => void

interface ConnectOptions {
  /** Short-lived proof returned by /qr-redeem; committed by /register. */
  admissionGrant?: string
  /** Explicit re-registration proof (Contract 1 recovery path). */
  reRegisterProof?: string
}

function connectKey(identity: Identity, options: ConnectOptions): string {
  return `${identity.nodeId}\0${identity.passCode}\0${options.admissionGrant ?? ''}\0${options.reRegisterProof ?? ''}`
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

/** Shared error decoder for /register and QR redeem. */
export interface AuthErrorView {
  code: string
  message: string
  /** When false, UI should not auto-retry. */
  retryable: boolean
  ipFull?: boolean
  unlockAt?: number
}

export function decodeAuthError(
  status: number,
  body: { error?: string; message?: string; reason?: string; remaining?: number; unlockAt?: number } | null,
): AuthErrorView {
  const code = body?.error ?? `HTTP_${status}`
  if (status === 409) {
    const msg = body?.remaining != null
      ? `通行码错误（剩余 ${body.remaining} 次尝试机会）`
      : (body?.message ?? '该节点编号已被他人使用，请换一个')
    return { code, message: msg, retryable: false }
  }
  if (status === 423) {
    const unlockAt = body?.unlockAt ?? 0
    const mins = Math.max(1, Math.ceil((unlockAt - Date.now()) / 60000))
    const msg = body?.reason === 'WRONG_PASSCODE'
      ? `通行码错误次数过多，节点已临时锁定（${mins} 分钟后解除）`
      : body?.reason === 'NODE_FROZEN'
        ? `该节点被多 IP 频繁试探，已全局冻结（${mins} 分钟后解除）。请稍后再试，或更换节点编号。`
        : body?.message ?? `检测到异常接入尝试，节点已临时锁定（${mins} 分钟后解除）`
    return { code: code || 'NODE_LOCKED', message: msg, retryable: false, unlockAt }
  }
  if (status === 403) {
    const msg = code === 'BAD_ORIGIN'
      ? '请求来源不被允许。请确认在官方部署域名下访问，而非直接打开 HTML。'
      : (body?.message ?? '请求被拒绝')
    return { code, message: msg, retryable: false }
  }
  if (status === 429) {
    if (code === 'IP_LIMITED') {
      return { code, message: body?.message ?? '本机 IP 节点已满', retryable: false, ipFull: true }
    }
    if (code === 'RATE_LIMITED') {
      return { code, message: body?.message ?? '请求过于频繁，请稍后再试', retryable: true }
    }
    return { code, message: body?.message ?? '请求过于频繁，请稍后再试', retryable: true }
  }
  if (status === 503 || code === 'NETWORK_FULL' || code === 'SERVER_BUSY') {
    if (code === 'NETWORK_FULL') {
      return {
        code,
        message: body?.message ?? '御坂网络已达容量上限，请稍后再试（请勿频繁重试）',
        retryable: false,
      }
    }
    if (code === 'SERVER_BUSY') {
      return {
        code,
        message: body?.message ?? '服务繁忙，请稍后短暂等待后重试',
        retryable: true,
      }
    }
    return { code, message: body?.message ?? '服务暂时不可用，请稍后重试', retryable: true }
  }
  if (code === 'INVALID_QR_TOKEN') {
    return { code, message: 'QR 码已过期或已被使用', retryable: false }
  }
  if (code === 'QR_REQUIRES_PASSCODE') {
    return { code, message: body?.message ?? '请输入通行码', retryable: false }
  }
  if (code === 'WRONG_PASSCODE') {
    return { code, message: '通行码不正确，请重新输入', retryable: false }
  }
  if (code === 'INVALID_PROOF') {
    return { code, message: '会话已失效，请重新输入通行码接入', retryable: false }
  }
  if (code === 'INVALID_INPUT' || status === 400) {
    return {
      code: code === 'HTTP_400' ? 'INVALID_INPUT' : code,
      message: body?.message ?? '请求参数无效，请检查节点编号与通行码',
      retryable: false,
    }
  }
  if (status >= 500) {
    return { code, message: body?.message ?? '服务暂时不可用，请稍后重试', retryable: true }
  }
  return { code, message: body?.message ?? '接入失败，请稍后重试', retryable: status >= 500 || status === 0 }
}

/** Jittered backoff for SERVER_BUSY (ms). Exported for tests. */
export function serverBusyBackoffMs(random = Math.random): number {
  // 1.5s–4.5s: long enough to stop hammering, short enough to feel responsive.
  return 1_500 + Math.floor(random() * 3_000)
}

function clearRenewTimer() {
  if (renewTimer) { clearTimeout(renewTimer); renewTimer = null }
}

function scheduleSessionRenewal(session: AuthSession) {
  clearRenewTimer()
  const delay = Math.max(session.expiresAt - Date.now() - RENEW_LEAD_MS, RENEW_MIN_DELAY_MS)
  renewTimer = setTimeout(() => {
    renewTimer = null
    void renewSession()
  }, delay)
}

async function renewSession(): Promise<void> {
  const state = useAuthStore.getState()
  const session = state.session
  if (!state.isConnected || !session?.token) return

  try {
    const res = await fetch(apiUrl('/api/session-renew'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.token}`,
        'Content-Type': 'application/json',
      },
    })
    if (!res.ok) throw new Error(`renew HTTP ${res.status}`)
    const data = await res.json() as {
      sessionId: string
      token: string
      expiresAt: number
      reRegisterProof?: string
    }
    // Same sessionId is required — network epoch must survive.
    if (data.sessionId !== session.sessionId) {
      console.warn('[auth] session-renew returned a different sessionId; ignoring')
      throw new Error('sessionId changed')
    }
    // Prefer a renewed non-empty proof; otherwise keep the live value
    // (including null when recovery was already unavailable).
    const renewed = normalizeProof(data.reRegisterProof)
    const next: AuthSession = {
      token: data.token,
      sessionId: data.sessionId,
      expiresAt: data.expiresAt,
      reRegisterProof: renewed ?? session.reRegisterProof,
    }
    // Compare-and-swap: only commit if we still own the same session.
    if (useAuthStore.getState().session?.sessionId !== session.sessionId) return
    sessionStorage.setItem('misaka.session', JSON.stringify(next))
    useAuthStore.setState({ session: next, isConnected: true })
    renewBackoffAttempts = 0
    scheduleSessionRenewal(next)
  } catch {
    // Retry with backoff until expiresAt, then the normal 4002 path takes over.
    const still = useAuthStore.getState().session
    if (!still || still.sessionId !== session.sessionId) return
    const remaining = still.expiresAt - Date.now()
    if (remaining <= 0) return
    const backoff = Math.min(30_000, 2_000 * Math.pow(2, renewBackoffAttempts++))
    const delay = Math.min(backoff, Math.max(RENEW_MIN_DELAY_MS, remaining - 1_000))
    renewTimer = setTimeout(() => {
      renewTimer = null
      void renewSession()
    }, delay)
  }
}

/**
 * Release a server session so it does not consume MAX_NODES_PER_IP.
 * Checks HTTP status and retries once on transport failure or non-OK
 * (except 404 — already gone). Still best-effort: a second failure is swallowed.
 */
async function bestEffortRelease(token: string): Promise<void> {
  const once = async (): Promise<'ok' | 'retry' | 'gone'> => {
    try {
      const res = await fetch(apiUrl('/api/release'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      if (res.ok || res.status === 404) return 'ok'
      // 4xx other than 404 is unlikely to succeed on retry; 5xx / network-ish
      // status codes warrant one more attempt.
      if (res.status >= 500 || res.status === 429) return 'retry'
      return 'gone'
    } catch {
      return 'retry'
    }
  }
  const first = await once()
  if (first === 'ok' || first === 'gone') return
  await once()
}

async function commitSession(
  get: AuthGet,
  set: AuthSet,
  gen: number,
  data: { token: string; sessionId: string; expiresAt: number; reRegisterProof?: string | null },
  registeredIdentity: { nodeId: number; passCode: string },
): Promise<boolean> {
  if (gen !== authOpGen) {
    // Superseded — release the token we just obtained so it does not leak.
    await bestEffortRelease(data.token)
    return false
  }
  // Identity compare-and-swap: a late 200 for identity A must not install
  // while the UI now shows B (user edited node id / passcode mid-flight).
  const live = get().identity
  if (live.nodeId !== registeredIdentity.nodeId || live.passCode !== registeredIdentity.passCode) {
    await bestEffortRelease(data.token)
    return false
  }
  // Absence of a proof degrades silent 4001/4002 recovery — it never blocks
  // a valid 200. Older servers / proof-stripping proxies still connect.
  const proof = normalizeProof(data.reRegisterProof)
  const session: AuthSession = {
    token: data.token,
    sessionId: data.sessionId,
    expiresAt: data.expiresAt,
    reRegisterProof: proof,
  }
  sessionStorage.setItem('misaka.session', JSON.stringify(session))
  // A committed session owns recovery from here; drop any prior pending proof
  // so a later proofless null cannot fall back to a stale value.
  pendingReRegisterProof = null
  set({
    session,
    isConnected: true,
    isLoading: false,
    error: null,
    credentialsRequired: false,
    connectBlockedUntil: null,
    lastAuthErrorCode: null,
    // Notice when auto-recovery is unavailable; clear when a proof arrives.
    recoveryUnavailableNotice: proof === null,
  })
  renewBackoffAttempts = 0
  scheduleSessionRenewal(session)
  return true
}

/**
 * Apply a failed connect result atomically for the owning generation.
 * Clears isConnected/session so a prior live session cannot make callers
 * (Join) treat this failure as success. Superseded gens must not clobber.
 *
 * When a prior committed session is being abandoned, perform terminal
 * teardown + best-effort /api/release so the old server token and network
 * epoch do not survive behind a store that reports disconnected.
 */
async function applyConnectFailure(
  get: AuthGet,
  set: AuthSet,
  gen: number,
  partial: Partial<AuthState>,
): Promise<void> {
  if (gen !== authOpGen) return
  const prior = get().session
  if (prior) {
    // Tear down the network epoch before dropping credentials so peers and
    // local WebRTC state do not keep living on a token we are about to free.
    try { endSession() } catch (err) { console.warn('[auth] session teardown failed', err) }
    emitSessionInvalid()
  }
  // A failed connect must never leave a stale recovery proof hanging around
  // for a later proofless session to inherit.
  pendingReRegisterProof = null
  sessionStorage.removeItem('misaka.session')
  // Atomic failure: always disconnect this op; partial may set error/codes.
  set({
    ...partial,
    isLoading: false,
    isConnected: false,
    session: null,
  })
  if (prior) {
    await bestEffortRelease(prior.token)
  }
}

async function doConnect(
  get: AuthGet,
  set: AuthSet,
  options: ConnectOptions,
  gen: number,
  signal: AbortSignal,
): Promise<boolean> {
  const current = get().identity
  // Capture identity at request start for CAS at commit.
  const registeredIdentity = { nodeId: current.nodeId, passCode: current.passCode }
  set({ isLoading: true, error: null, ipFullPrompt: false, credentialsRequired: false })

  const ownsLock = await acquireNodeIdLock(current.nodeId, gen)
  // Re-check after every await — including lock acquisition.
  if (gen !== authOpGen || signal.aborted) {
    // Superseded while acquire was pending: release the lease we may have
    // just obtained so another tab is not falsely told the node is taken.
    releaseNodeIdLockForGen(gen)
    return false
  }
  if (!ownsLock) {
    if (gen !== authOpGen || signal.aborted) return false
    await applyConnectFailure(get, set, gen, {
      error: '该节点编号已在本浏览器的另一个标签页接入。请关闭其他标签页或更换节点编号。',
    })
    return false
  }

  let sessionCommitted = false
  const timeout = abortableTimeout(REGISTER_TIMEOUT_MS, signal)
  try {
    // Prefer re-register when:
    //   - caller passed an explicit non-empty proof (WS 4001/4002 recovery), or
    //   - passcode is empty and the live session still has a proof (HTTP 401).
    // Never re-register with a null/empty proof — that was the original P1.
    // QR commits and typed-passcode logins always use full /register.
    const existingProof = normalizeProof(options.reRegisterProof)
      ?? normalizeProof(get().session?.reRegisterProof)
    const useReRegister = !options.admissionGrant
      && existingProof != null
      && (!!options.reRegisterProof || !/^\d{6}$/.test(current.passCode))

    // Explicit credentials / admission login discards any stale pending proof
    // so a later null live session cannot fall back to it.
    if (!useReRegister) {
      pendingReRegisterProof = null
    }

    // Hard ban: never POST /api/register with an empty passcode. Without a
    // proof the only legal recovery is credentials-required.
    if (!useReRegister && !options.admissionGrant && !/^\d{6}$/.test(registeredIdentity.passCode)) {
      await applyConnectFailure(get, set, gen, {
        credentialsRequired: true,
        error: '会话已失效，请重新输入通行码接入',
        lastAuthErrorCode: 'CREDENTIALS_REQUIRED',
      })
      return false
    }

    // Race against the deadline signal: many test mocks ignore RequestInit.signal.
    // A late success after abort/supersede is best-effort released so the
    // server session does not leak (fire-and-forget on the original promise).
    const fetchOnce = async (url: string, init: RequestInit): Promise<Response> => {
      if (timeout.signal.aborted) {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      }
      const abortErr = () => Object.assign(new Error('aborted'), { name: 'AbortError' })
      const pending = fetch(url, { ...init, signal: timeout.signal })
      // If we lose the race (aborted/superseded), still drain a late OK body
      // and release its token so the server slot is not leaked.
      void pending.then(async (r) => {
        if (gen === authOpGen && !signal.aborted && !timeout.signal.aborted) return
        if (!r.ok) return
        try {
          const data = await r.clone().json() as { token?: string }
          if (data.token) await bestEffortRelease(data.token)
        } catch { /* ignore */ }
      }).catch(() => {})

      return await new Promise<Response>((resolve, reject) => {
        const onAbort = () => reject(abortErr())
        timeout.signal.addEventListener('abort', onAbort, { once: true })
        pending.then(
          (r) => {
            timeout.signal.removeEventListener('abort', onAbort)
            if (gen !== authOpGen || signal.aborted || timeout.signal.aborted) {
              reject(abortErr())
              return
            }
            resolve(r)
          },
          (e) => {
            timeout.signal.removeEventListener('abort', onAbort)
            reject(e)
          },
        )
      })
    }

    let res: Response
    if (useReRegister) {
      res = await fetchOnce(apiUrl('/api/re-register'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proof: existingProof }),
      })
    } else {
      res = await fetchOnce(apiUrl('/api/register'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nodeId: registeredIdentity.nodeId,
          passCode: registeredIdentity.passCode,
          ...(options.admissionGrant ? { admissionGrant: options.admissionGrant } : {}),
        }),
      })
    }

    // Re-check after the fetch await before touching UI or parsing.
    if (gen !== authOpGen || signal.aborted) return false

    if (!res.ok) {
      const body = await res.json().catch(() => null) as {
        error?: string; message?: string; reason?: string; remaining?: number; unlockAt?: number
      } | null
      // Re-check after body parse — a superseded slow error must not clobber
      // the newer operation's loading/error state.
      if (gen !== authOpGen || signal.aborted) return false
      const view = decodeAuthError(res.status, body)
      if (view.ipFull) {
        await applyConnectFailure(get, set, gen, {
          ipFullPrompt: true,
          error: null,
          lastAuthErrorCode: view.code,
        })
        return false
      }
      if (useReRegister && (res.status === 401 || view.code === 'INVALID_PROOF')) {
        // Failed proof recovery: drop pending so a later proofless login's
        // explicit null is not overridden by this stale proof.
        pendingReRegisterProof = null
        await applyConnectFailure(get, set, gen, {
          credentialsRequired: true,
          error: view.message,
          lastAuthErrorCode: view.code,
          connectBlockedUntil: null,
        })
        return false
      }
      // Retry policy: NETWORK_FULL never invites immediate hammering;
      // SERVER_BUSY gets a jittered cooldown before the button re-arms.
      let connectBlockedUntil: number | null = null
      if (view.code === 'NETWORK_FULL') {
        connectBlockedUntil = Number.MAX_SAFE_INTEGER
      } else if (view.code === 'SERVER_BUSY') {
        connectBlockedUntil = Date.now() + serverBusyBackoffMs()
      }
      await applyConnectFailure(get, set, gen, {
        error: view.message,
        lastAuthErrorCode: view.code,
        connectBlockedUntil,
      })
      return false
    }

    const data = await res.json() as {
      token: string
      sessionId: string
      expiresAt: number
      resumed?: boolean
      reRegisterProof?: string | null
    }
    // Re-check after success body parse before commit.
    if (gen !== authOpGen || signal.aborted) {
      if (data.token) await bestEffortRelease(data.token)
      return false
    }
    // Always route through commitSession so a superseded success is
    // best-effort released instead of silently dropped.
    sessionCommitted = await commitSession(get, set, gen, data, registeredIdentity)
    return sessionCommitted
  } catch (err) {
    if (gen !== authOpGen || signal.aborted) return false
    const aborted = (err instanceof DOMException && err.name === 'AbortError')
      || (err instanceof Error && err.name === 'AbortError')
      || signal.aborted
      || timeout.signal.aborted
    await applyConnectFailure(get, set, gen, {
      error: aborted ? '接入超时，请检查网络后重试' : '网络连接失败，请检查网络',
      lastAuthErrorCode: aborted ? 'TIMEOUT' : 'NETWORK',
    })
    return false
  } finally {
    timeout.dispose()
    // Lease: release the Web Lock on any uncommitted path so another tab is
    // not told the node is taken when this tab never registered. Generation-
    // scoped so a newer op that re-acquired is not disturbed. After atomic
    // failure, isConnected is false so the lock must not outlive this op.
    if (!sessionCommitted) releaseNodeIdLockForGen(gen)
  }
}

// SECURITY-019: identity material (node id + pass code) is drawn from the
// CSPRNG with rejection sampling — see lib/passcode.ts. `Math.random()` is
// predictable from a couple of observed outputs, which matters a lot for a
// 6-digit code.
function randomInt(min: number, max: number) {
  return secureRandomInt(min, max)
}

function generateIdentity(): Identity {
  const cached = sessionStorage.getItem('misaka.identity')
  if (cached) {
    // P1: passCode is NEVER restored from storage — it is private credential
    // material and only the nodeId/createdAt are safe to persist. If a session
    // token is also cached and still valid, no re-entry is needed; otherwise
    // the user must re-type the passcode (the trade-off for strong privacy).
    const data = JSON.parse(cached) as { nodeId: number; createdAt: number }
    return { nodeId: data.nodeId, passCode: '', createdAt: data.createdAt }
  }
  const identity: Identity = {
    nodeId: randomInt(NODE_ID_MIN, NODE_ID_MAX),
    passCode: '',
    createdAt: Date.now(),
  }
  persistIdentity(identity)
  return identity
}

function persistIdentity(identity: Identity) {
  // Only nodeId + createdAt — passCode stays in memory.
  sessionStorage.setItem('misaka.identity', JSON.stringify({ nodeId: identity.nodeId, createdAt: identity.createdAt }))
}

/**
 * Restore a saved session from sessionStorage (survives page refresh).
 *
 * A still-valid row without a recovery proof is kept with
 * `reRegisterProof: null` — absence degrades auto-recovery, it never
 * silently logs the user out of a valid session.
 */
function tryRestoreSession(): { session: AuthSession; recoveryUnavailable: boolean } | null {
  try {
    const raw = sessionStorage.getItem('misaka.session')
    if (!raw) return null
    const parsed = JSON.parse(raw) as LegacyStoredSession
    if (!(parsed.expiresAt > Date.now() && typeof parsed.token === 'string' && parsed.token
      && typeof parsed.sessionId === 'string' && parsed.sessionId)) {
      sessionStorage.removeItem('misaka.session')
      return null
    }
    const proof = normalizeProof(parsed.reRegisterProof)
    const session: AuthSession = {
      token: parsed.token,
      sessionId: parsed.sessionId,
      expiresAt: parsed.expiresAt,
      reRegisterProof: proof,
    }
    // Rewrite storage so the live shape always has the required key.
    if (parsed.reRegisterProof !== proof) {
      sessionStorage.setItem('misaka.session', JSON.stringify(session))
    }
    return { session, recoveryUnavailable: proof === null }
  } catch { /* ignore */ }
  return null
}

interface AuthState {
  identity: Identity
  session: AuthSession | null
  isConnected: boolean
  isLoading: boolean
  error: string | null
  ipFullPrompt: boolean
  /** True when re-register failed and the user must re-enter credentials. */
  credentialsRequired: boolean
  /**
   * One-time dismissible notice: this session cannot silently auto-recover
   * from 4001/4002 (proofless server response or legacy cache).
   */
  recoveryUnavailableNotice: boolean
  /**
   * Wall-clock ms until connect() may be retried. `null` = no cooldown.
   * NETWORK_FULL sets MAX_SAFE_INTEGER (cleared only by identity change).
   * SERVER_BUSY sets a jittered short backoff.
   */
  connectBlockedUntil: number | null
  lastAuthErrorCode: string | null

  setNodeId: (nodeId: number) => void
  setPassCode: (passCode: string) => void
  regenerateNodeId: () => void
  regeneratePassCode: () => void
  /**
   * Attempt registration. Resolves to true only if THIS operation committed
   * a session — callers must not read a stale global `isConnected`.
   */
  connect: (options?: ConnectOptions) => Promise<boolean>
  disconnect: () => Promise<void>
  clearSession: () => void
  /** Local-only invalidation: drop session, release node lock, emit listeners. No /api/release. */
  invalidateSession: () => void
  releaseAllFromIp: () => Promise<number>
  dismissIpFullPrompt: () => void
  dismissRecoveryUnavailableNotice: () => void
  /** True when the connect button should refuse another immediate attempt. */
  isConnectBlocked: () => boolean
}

const restored = tryRestoreSession()
const savedSession = restored?.session ?? null

export const useAuthStore = create<AuthState>((set, get) => ({
  identity: generateIdentity(),
  session: savedSession,
  isConnected: savedSession !== null,
  isLoading: false,
  error: null,
  ipFullPrompt: false,
  credentialsRequired: false,
  recoveryUnavailableNotice: restored?.recoveryUnavailable ?? false,
  connectBlockedUntil: null,
  lastAuthErrorCode: null,

  setNodeId(nodeId) {
    // Identity mutation must supersede any in-flight /register so a late 200
    // for the old identity cannot commit under the new UI identity.
    supersedeInFlightAuthOp()
    const identity = { ...get().identity, nodeId }
    persistIdentity(identity)
    set({
      identity,
      error: null,
      isLoading: false,
      connectBlockedUntil: null,
      lastAuthErrorCode: null,
    })
  },

  setPassCode(passCode) {
    supersedeInFlightAuthOp()
    const identity = { ...get().identity, passCode }
    persistIdentity(identity)
    set({
      identity,
      error: null,
      isLoading: false,
      connectBlockedUntil: null,
      lastAuthErrorCode: null,
    })
  },

  regenerateNodeId() {
    supersedeInFlightAuthOp()
    const nodeId = randomInt(1, 20001)
    const identity = { ...get().identity, nodeId }
    persistIdentity(identity)
    set({
      identity,
      error: null,
      isLoading: false,
      connectBlockedUntil: null,
      lastAuthErrorCode: null,
    })
  },

  regeneratePassCode() {
    supersedeInFlightAuthOp()
    const passCode = generatePassCode()
    const identity = { ...get().identity, passCode }
    persistIdentity(identity)
    set({
      identity,
      error: null,
      isLoading: false,
      connectBlockedUntil: null,
      lastAuthErrorCode: null,
    })
  },

  isConnectBlocked() {
    const until = get().connectBlockedUntil
    return until != null && Date.now() < until
  },

  async connect(options = {}) {
    // Enforce retry policy at the store boundary (LoginCard also disables UI).
    if (get().isConnectBlocked() && !options.admissionGrant && !options.reRegisterProof) {
      return false
    }

    const key = connectKey(get().identity, options)
    // Coalesce only identical identity+grant operations.
    if (connectInFlight && connectInFlight.key === key) return connectInFlight.promise

    // Supersede any in-flight op with a different key (QR vs plain re-auth,
    // identity switch, etc.).
    authOpGen++
    const gen = authOpGen
    if (connectAbort) {
      try { connectAbort.abort() } catch { /* ignore */ }
    }
    const ac = new AbortController()
    connectAbort = ac

    // Assign after declaration so the finally closure can compare identity
    // without a self-referential const initialiser (TS2454).
    let promise!: Promise<boolean>
    promise = (async () => {
      try {
        return await doConnect(get, set, options, gen, ac.signal)
      } finally {
        if (connectInFlight?.promise === promise) connectInFlight = null
        if (connectAbort === ac) connectAbort = null
      }
    })()
    connectInFlight = { key, promise }
    return promise
  },

  async releaseAllFromIp() {
    // Scope proof is ALWAYS the current identity (what the UI claims to
    // release). Prefer nodeId+passCode over Bearer so a logged-in session A
    // joining as B cannot knock A's other devices offline (09 P1).
    const { identity } = get()
    const headers: Record<string, string> = {}
    let body: string | undefined

    if (/^\d{6}$/.test(identity.passCode)) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify({ nodeId: identity.nodeId, passCode: identity.passCode })
    } else if (get().session?.token) {
      headers.Authorization = `Bearer ${get().session!.token}`
    } else {
      set({ error: '请先输入完整通行码再释放' })
      return 0
    }

    try {
      const res = await fetch(apiUrl('/api/release-by-ip'), { method: 'POST', headers, body })
      if (res.status === 401) {
        set({ error: '通行码错误，无法释放该节点编号占用' })
        return 0
      }
      if (res.status === 423) {
        const data = await res.json().catch(() => ({ unlockAt: 0 })) as { unlockAt: number }
        const mins = Math.max(1, Math.ceil((data.unlockAt - Date.now()) / 60000))
        set({ error: `尝试次数过多，请 ${mins} 分钟后再试` })
        return 0
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as { released: number; releasedNodeId?: number }
      // Server dependency: when `releasedNodeId` is present, verify scope.
      if (
        typeof data.releasedNodeId === 'number'
        && data.releasedNodeId !== identity.nodeId
        && data.released > 0
      ) {
        set({
          error: `服务端释放了节点 ${data.releasedNodeId}，与当前身份 ${identity.nodeId} 不一致`,
          ipFullPrompt: false,
        })
        return 0
      }
      set({ ipFullPrompt: false, error: null })
      return data.released
    } catch {
      set({ error: '释放失败，请重试' })
      return 0
    }
  },

  dismissIpFullPrompt() {
    set({ ipFullPrompt: false })
  },

  dismissRecoveryUnavailableNotice() {
    set({ recoveryUnavailableNotice: false })
  },

  clearSession() {
    clearRenewTimer()
    pendingReRegisterProof = null
    sessionStorage.removeItem('misaka.session')
    releaseNodeIdLock()
    set({ session: null, isConnected: false, recoveryUnavailableNotice: false })
  },

  invalidateSession() {
    // Terminal local cleanup used by authedFetch double-401 and similar.
    // Does NOT call /api/release (token already dead). Emits so network.ts
    // can tear down the epoch when it subscribes to onSessionInvalid.
    clearRenewTimer()
    authOpGen++
    if (connectAbort) {
      try { connectAbort.abort() } catch { /* ignore */ }
      connectAbort = null
    }
    connectInFlight = null
    // Drop pending proof on invalidation. Recovery callers (onAuthInvalid)
    // re-arm pending from the live session *before* calling us, then restore
    // only a non-null proof after we return.
    pendingReRegisterProof = null
    emitSessionInvalid()
    sessionStorage.removeItem('misaka.session')
    releaseNodeIdLock()
    set({ session: null, isConnected: false, recoveryUnavailableNotice: false })
  },

  async disconnect() {
    // BUG-001: an explicit Disconnect must end the whole network epoch, not
    // just forget the token. Order matters:
    //   1. stop signaling reconnects + destroy every session-scoped WebRTC
    //      artefact (PC / DC / ECDH keys / in-flight transfers) so nothing
    //      keeps living on a token we are about to release;
    //   2. drop the local credentials so no background 401-retry can
    //      re-register behind our back;
    //   3. release the server-side session last — that is what makes the
    //      server drop us from the cluster channel and tell peers PEER_LEFT.
    if (disconnectInFlight) return disconnectInFlight
    disconnectInFlight = (async () => {
      try {
        // Cancel any in-flight connect so a late success cannot re-login.
        authOpGen++
        if (connectAbort) {
          try { connectAbort.abort() } catch { /* ignore */ }
          connectAbort = null
        }
        connectInFlight = null
        clearRenewTimer()
        pendingReRegisterProof = null

        const { session } = get()
        try { endSession() } catch (err) { console.warn('[auth] session teardown failed', err) }
        emitSessionInvalid()
        sessionStorage.removeItem('misaka.session')
        releaseNodeIdLock()
        set({
          session: null,
          isConnected: false,
          error: null,
          credentialsRequired: false,
          recoveryUnavailableNotice: false,
        })
        if (session) {
          await bestEffortRelease(session.token)
        }
      } finally {
        disconnectInFlight = null
      }
    })()
    return disconnectInFlight
  },
}))

// Arm renewal for a restored session (page refresh while still valid).
if (savedSession) {
  scheduleSessionRenewal(savedSession)
}

// Held across a double 4001/4002 so a second close that races the first
// recovery still has the proof after session was cleared.
let pendingReRegisterProof: string | null = null

// WS reports our cached token is unknown/expired (4001/4002):
// drop the dead session and re-register via the opaque proof (Contract 1).
// NEVER fire /register with an empty passcode — including when the live
// session had reRegisterProof: null (degraded recovery).
//
// Live session wins: if a session is present, its reRegisterProof (including
// explicit null) is the only source of truth. Stale pendingReRegisterProof
// must not override a deliberate proofless commit.
onAuthInvalid(() => {
  const store = useAuthStore.getState()
  const live = store.session
  const proof = live
    ? normalizeProof(live.reRegisterProof)
    : normalizeProof(pendingReRegisterProof)
  // Capture before invalidateSession clears pending.
  store.invalidateSession()
  if (proof) {
    pendingReRegisterProof = proof
    void store.connect({ reRegisterProof: proof }).then((committed) => {
      // Success: commitSession already cleared pending. Failure: must clear so
      // a later manual proofless login cannot inherit this stale proof.
      if (!committed && pendingReRegisterProof === proof) {
        pendingReRegisterProof = null
      }
    })
  } else {
    pendingReRegisterProof = null
    useAuthStore.setState({
      credentialsRequired: true,
      error: '会话已失效，请重新输入通行码接入',
      isLoading: false,
    })
  }
})
