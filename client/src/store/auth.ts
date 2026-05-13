import { create } from 'zustand'
import type { Identity, Session } from '@/types'
import { apiUrl } from '@/config'

function randomInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function generateIdentity(): Identity {
  const cached = sessionStorage.getItem('misaka.identity')
  if (cached) return JSON.parse(cached) as Identity
  const identity: Identity = {
    nodeId: randomInt(1, 20001),
    passCode: '', // blank initially — user must generate or type one
    createdAt: Date.now(),
  }
  sessionStorage.setItem('misaka.identity', JSON.stringify(identity))
  return identity
}

interface AuthState {
  identity: Identity
  session: Session | null
  isConnected: boolean
  isLoading: boolean
  error: string | null

  setNodeId: (nodeId: number) => void
  setPassCode: (passCode: string) => void
  regenerateNodeId: () => void
  regeneratePassCode: () => void
  connect: () => Promise<void>
  disconnect: () => Promise<void>
}

export const useAuthStore = create<AuthState>((set, get) => ({
  identity: generateIdentity(),
  session: null,
  isConnected: false,
  isLoading: false,
  error: null,

  setNodeId(nodeId) {
    const identity = { ...get().identity, nodeId }
    sessionStorage.setItem('misaka.identity', JSON.stringify(identity))
    set({ identity, error: null })
  },

  setPassCode(passCode) {
    const identity = { ...get().identity, passCode }
    sessionStorage.setItem('misaka.identity', JSON.stringify(identity))
    set({ identity, error: null })
  },

  regenerateNodeId() {
    const nodeId = randomInt(1, 20001)
    const identity = { ...get().identity, nodeId }
    sessionStorage.setItem('misaka.identity', JSON.stringify(identity))
    set({ identity, error: null })
  },

  regeneratePassCode() {
    const passCode = String(randomInt(0, 999999)).padStart(6, '0')
    const identity = { ...get().identity, passCode }
    sessionStorage.setItem('misaka.identity', JSON.stringify(identity))
    set({ identity, error: null })
  },

  async connect() {
    const { identity } = get()
    set({ isLoading: true, error: null })

    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const res = await fetch(apiUrl('/api/register'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nodeId: identity.nodeId, passCode: identity.passCode }),
        })

        if (res.status === 409) {
          const newNodeId = identity.nodeId + 1 > 20001 ? randomInt(1, 20001) : identity.nodeId + 1
          const newIdentity = { ...identity, nodeId: newNodeId }
          sessionStorage.setItem('misaka.identity', JSON.stringify(newIdentity))
          set({ identity: newIdentity })
          continue
        }

        if (res.status === 423) {
          const data = await res.json() as { error: string; unlockAt: number }
          const mins = Math.ceil((data.unlockAt - Date.now()) / 60000)
          set({ isLoading: false, error: `检测到异常接入尝试，节点已临时锁定（${mins} 分钟后解除）` })
          return
        }

        if (!res.ok) {
          set({ isLoading: false, error: '接入失败，请稍后重试' })
          return
        }

        const data = await res.json() as { token: string; expiresAt: number; resumed: boolean }
        const session: Session = { token: data.token, expiresAt: data.expiresAt }
        sessionStorage.setItem('misaka.session', JSON.stringify(session))
        set({ session, isConnected: true, isLoading: false })
        return
      } catch {
        set({ isLoading: false, error: '网络连接失败，请检查网络' })
        return
      }
    }

    set({ isLoading: false, error: '节点编号冲突，请手动选择编号' })
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
