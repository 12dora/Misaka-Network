import { create } from 'zustand'
import type { Identity, Session } from '@/types'
import { apiUrl } from '@/config'

function randomInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function generateIdentity(): Identity {
  const cached = sessionStorage.getItem('misaka.identity')
  if (cached) {
    const data = JSON.parse(cached) as { nodeId: number; passCode?: string; createdAt: number }
    return { nodeId: data.nodeId, passCode: data.passCode ?? '', createdAt: data.createdAt }
  }
  const identity: Identity = {
    nodeId: randomInt(1, 20001),
    passCode: '',
    createdAt: Date.now(),
  }
  persistIdentity(identity)
  return identity
}

function persistIdentity(identity: Identity) {
  sessionStorage.setItem('misaka.identity', JSON.stringify({ nodeId: identity.nodeId, passCode: identity.passCode, createdAt: identity.createdAt }))
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
  connect: () => Promise<void>
  disconnect: () => Promise<void>
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
    const passCode = String(randomInt(0, 999999)).padStart(6, '0')
    const identity = { ...get().identity, passCode }
    persistIdentity(identity)
    set({ identity, error: null })
  },

  async connect() {
    const current = get().identity
    set({ isLoading: true, error: null, ipFullPrompt: false })

    try {
      const res = await fetch(apiUrl('/api/register'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeId: current.nodeId, passCode: current.passCode }),
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
          : `检测到异常接入尝试，节点已临时锁定（${mins} 分钟后解除）`
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
  },

  async releaseAllFromIp() {
    try {
      const res = await fetch(apiUrl('/api/release-by-ip'), { method: 'POST' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as { released: number }
      set({ ipFullPrompt: false })
      return data.released
    } catch {
      set({ error: '释放失败，请重试' })
      return 0
    }
  },

  dismissIpFullPrompt() {
    set({ ipFullPrompt: false })
  },

  async disconnect() {
    const { session } = get()
    if (session) {
      await fetch(apiUrl('/api/release'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: session.token }),
      }).catch(() => {})
    }
    sessionStorage.removeItem('misaka.session')
    set({ session: null, isConnected: false, error: null })
  },
}))
