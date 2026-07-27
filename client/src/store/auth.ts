import { create } from 'zustand'
import type { Identity, Session } from '@/types'
import { apiUrl } from '@/config'
import { NODE_ID_MIN, NODE_ID_MAX } from '@/constants'
import { onAuthInvalid, endSession } from '@/lib/signaling'
import { secureRandomInt, generatePassCode } from '@/lib/passcode'

// Web Locks API mutex: hold this lock for the lifetime of the tab. If another
// tab in the same origin tries to register the same nodeId, its `request()`
// with `ifAvailable: true` returns null and we surface a clear conflict
// message. Browsers without Web Locks (older Safari) silently no-op — degraded
// behavior matches the pre-existing "last writer wins" anyway.
let nodeIdLockRelease: (() => void) | null = null
let lockedNodeId: number | null = null

async function acquireNodeIdLock(nodeId: number): Promise<boolean> {
  if (typeof navigator === 'undefined' || !('locks' in navigator)) return true
  // Re-entrant: if THIS tab already holds the lock for this same nodeId, don't
  // issue a second competing `ifAvailable` request (which the browser would
  // deny with lock===null, falsely reporting a same-tab conflict).
  if (nodeIdLockRelease && lockedNodeId === nodeId) return true
  // Release any previously held lock (user changed nodeId).
  if (nodeIdLockRelease) { nodeIdLockRelease(); nodeIdLockRelease = null; lockedNodeId = null }
  return new Promise<boolean>((resolve) => {
    // ifAvailable: true → never block, returns null on contention.
    navigator.locks.request(
      `misaka-node-${nodeId}`,
      { ifAvailable: true },
      (lock) => {
        if (!lock) { resolve(false); return undefined }
        lockedNodeId = nodeId
        resolve(true)
        // Hold for the tab's lifetime via a never-resolving promise; the
        // browser releases the lock automatically on tab close / refresh.
        return new Promise<void>((release) => {
          nodeIdLockRelease = release
        })
      },
    ).catch(() => resolve(true))   // unexpected → don't block the user
  })
}

// Dedupe concurrent connect() calls. After a server restart, multiple in-flight
// authedFetch calls each 401 and each fires reAuth()->connect(); onAuthInvalid
// (WS 4001/4002) also calls connect(). Without dedup they race the same Web
// Lock (only one wins → the losers flash a bogus "another tab" error) and
// double-register. A shared in-flight promise makes all callers await one run.
let connectInFlight: Promise<void> | null = null

// BUG-001: the same idempotency for logout. A double-click on Disconnect (or
// a 4001 close racing the button) must not fire two /api/release calls, two
// network teardowns, or interleave a re-register into the middle of a logout.
let disconnectInFlight: Promise<void> | null = null

function releaseNodeIdLock() {
  if (nodeIdLockRelease) { nodeIdLockRelease(); nodeIdLockRelease = null; lockedNodeId = null }
}

type AuthGet = () => AuthState
type AuthSet = (partial: Partial<AuthState>) => void

interface ConnectOptions {
  /** Short-lived proof returned by /qr-redeem; committed by /register. */
  admissionGrant?: string
}

async function doConnect(get: AuthGet, set: AuthSet, options: ConnectOptions = {}): Promise<void> {
  const current = get().identity
  set({ isLoading: true, error: null, ipFullPrompt: false })

  const ownsLock = await acquireNodeIdLock(current.nodeId)
  if (!ownsLock) {
    set({
      isLoading: false,
      error: '该节点编号已在本浏览器的另一个标签页接入。请关闭其他标签页或更换节点编号。',
    })
    return
  }

  try {
    const res = await fetch(apiUrl('/api/register'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nodeId: current.nodeId,
        passCode: current.passCode,
        ...(options.admissionGrant ? { admissionGrant: options.admissionGrant } : {}),
      }),
    })

    if (res.status === 409) {
      const data = await res.json() as { error: string; message?: string; remaining?: number }
      const msg = data.remaining != null
        ? `通行码错误（剩余 ${data.remaining} 次尝试机会）`
        : (data.message ?? '该节点编号已被他人使用，请换一个')
      set({ isLoading: false, error: msg })
      return
    }

    if (res.status === 423) {
      const data = await res.json() as { error: string; reason?: string; unlockAt: number }
      const mins = Math.ceil((data.unlockAt - Date.now()) / 60000)
      const msg = data.reason === 'WRONG_PASSCODE'
        ? `通行码错误次数过多，节点已临时锁定（${mins} 分钟后解除）`
        : data.reason === 'NODE_FROZEN'
          ? `该节点被多 IP 频繁试探，已全局冻结（${mins} 分钟后解除）。请稍后再试，或更换节点编号。`
          : `检测到异常接入尝试，节点已临时锁定（${mins} 分钟后解除）`
      set({ isLoading: false, error: msg })
      return
    }

    if (res.status === 403) {
      const data = await res.json().catch(() => ({ error: 'BAD_ORIGIN' })) as { error: string; message?: string }
      const msg = data.error === 'BAD_ORIGIN'
        ? '请求来源不被允许。请确认在官方部署域名下访问，而非直接打开 HTML。'
        : (data.message ?? '请求被拒绝')
      set({ isLoading: false, error: msg })
      return
    }

    if (res.status === 429) {
      const data = await res.json().catch(() => ({ error: 'RATE_LIMITED' })) as { error: string; message?: string }
      if (data.error === 'IP_LIMITED') {
        set({ isLoading: false, ipFullPrompt: true, error: null })
        return
      }
      set({ isLoading: false, error: data.message ?? '请求过于频繁，请稍后再试' })
      return
    }

    if (!res.ok) {
      set({ isLoading: false, error: '接入失败，请稍后重试' })
      return
    }

    const data = await res.json() as { token: string; sessionId: string; expiresAt: number; resumed: boolean }
    const session: Session = { token: data.token, sessionId: data.sessionId, expiresAt: data.expiresAt }
    sessionStorage.setItem('misaka.session', JSON.stringify(session))
    set({ session, isConnected: true, isLoading: false })
  } catch {
    set({ isLoading: false, error: '网络连接失败，请检查网络' })
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

/** Try to restore a saved session from sessionStorage (survives page refresh). */
function tryRestoreSession(): Session | null {
  try {
    const raw = sessionStorage.getItem('misaka.session')
    if (!raw) return null
    const session = JSON.parse(raw) as Session
    if (session.expiresAt > Date.now() && session.token) {
      return session
    }
    sessionStorage.removeItem('misaka.session')
  } catch { /* ignore */ }
  return null
}

interface AuthState {
  identity: Identity
  session: Session | null
  isConnected: boolean
  isLoading: boolean
  error: string | null
  ipFullPrompt: boolean

  setNodeId: (nodeId: number) => void
  setPassCode: (passCode: string) => void
  regenerateNodeId: () => void
  regeneratePassCode: () => void
  connect: (options?: ConnectOptions) => Promise<void>
  disconnect: () => Promise<void>
  clearSession: () => void
  releaseAllFromIp: () => Promise<number>
  dismissIpFullPrompt: () => void
}

const savedSession = tryRestoreSession()

export const useAuthStore = create<AuthState>((set, get) => ({
  identity: generateIdentity(),
  session: savedSession,
  isConnected: savedSession !== null,
  isLoading: false,
  error: null,
  ipFullPrompt: false,

  setNodeId(nodeId) {
    const identity = { ...get().identity, nodeId }
    persistIdentity(identity)
    set({ identity, error: null })
  },

  setPassCode(passCode) {
    const identity = { ...get().identity, passCode }
    persistIdentity(identity)
    set({ identity, error: null })
  },

  regenerateNodeId() {
    const nodeId = randomInt(1, 20001)
    const identity = { ...get().identity, nodeId }
    persistIdentity(identity)
    set({ identity, error: null })
  },

  regeneratePassCode() {
    const passCode = generatePassCode()
    const identity = { ...get().identity, passCode }
    persistIdentity(identity)
    set({ identity, error: null })
  },

  async connect(options = {}) {
    // Coalesce concurrent callers (parallel 401 re-auths + onAuthInvalid) onto
    // one registration so they don't race the node lock or double-register.
    if (connectInFlight) return connectInFlight
    connectInFlight = (async () => {
      try {
        await doConnect(get, set, options)
      } finally {
        connectInFlight = null
      }
    })()
    return connectInFlight
  },

  async releaseAllFromIp() {
    // Two proof paths, see server/src/http.ts /api/release-by-ip:
    //   1. Already logged in → Bearer token.
    //   2. Hit IP_LIMITED on /register so no token yet → re-supply the
    //      identity (nodeId + passcode) the user just typed. Server hashes
    //      the passcode and only releases sessions matching it on this IP.
    const { session, identity } = get()
    const headers: Record<string, string> = {}
    let body: string | undefined
    if (session?.token) {
      headers.Authorization = `Bearer ${session.token}`
    } else {
      if (!/^\d{6}$/.test(identity.passCode)) {
        set({ error: '请先输入完整通行码再释放' })
        return 0
      }
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify({ nodeId: identity.nodeId, passCode: identity.passCode })
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
      const data = await res.json() as { released: number }
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

  clearSession() {
    sessionStorage.removeItem('misaka.session')
    releaseNodeIdLock()
    set({ session: null, isConnected: false })
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
        const { session } = get()
        try { endSession() } catch (err) { console.warn('[auth] session teardown failed', err) }
        sessionStorage.removeItem('misaka.session')
        releaseNodeIdLock()
        set({ session: null, isConnected: false, error: null })
        if (session) {
          await fetch(apiUrl('/api/release'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: session.token }),
          }).catch(() => {})
        }
      } finally {
        disconnectInFlight = null
      }
    })()
    return disconnectInFlight
  },
}))

// WS reports our cached token is unknown (server restarted, session GC'd):
// drop the dead session and re-register from the cached identity so all
// downstream API/QR calls get a fresh Bearer instead of looping on 401.
onAuthInvalid(() => {
  const store = useAuthStore.getState()
  store.clearSession()
  void store.connect()
})
