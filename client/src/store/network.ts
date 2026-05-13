import { create } from 'zustand'
import type { Peer, Transfer, NodeStatus, ChannelMessage } from '@/types'
import { apiUrl } from '@/config'
import {
  connect as wsConnect, disconnect as wsDisconnect, send as wsSend,
  onMessage, onConnect, onDisconnect,
} from '@/lib/signaling'
import {
  createPeerConnection, createDataChannel, createOffer, createAnswer,
  applyAnswer, addIceCandidate, getSelectedChannelType,
} from '@/lib/webrtc'
import {
  generateECDHKeyPair, getMyPublicKey, setPeerPublicKey,
  resetCrypto, hasAESKey,
} from '@/lib/crypto'
import {
  sendFile as engineSendFile, handleMetaMessage, receiveChunk,
  completeReceive, cancelReceive, createTransferId,
  type MetaMessage, type ChunkHeader, type SendCallbacks,
} from '@/lib/transfer'
import { useAuthStore } from './auth'

// Non-reactive WebRTC state (module-level)
const peerConnections = new Map<number, RTCPeerConnection>()
const dataChannels = new Map<number, RTCDataChannel>()
const pendingIceCandidates = new Map<number, RTCIceCandidateInit[]>()
const ecdhResolvers: Map<number, () => void> = new Map()

interface PendingRequest {
  fromNodeId: number
  requestId: string
}

async function hashPasscode(passCode: string): Promise<string> {
  const data = new TextEncoder().encode(passCode)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .substring(0, 16)
}

function genMsgId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

interface NetworkState {
  wsConnected: boolean
  channelId: string | null
  peers: Peer[]
  selectedPeerId: number | null
  transfers: Transfer[]
  chatMessages: Record<number, ChannelMessage[]>
  incomingRequest: PendingRequest | null
  incomingMeta: (MetaMessage & { fromNodeId: number }) | null
  connectedPeers: Set<number>

  init: (token: string) => void
  destroy: () => void
  joinChannel: (channelId: string) => void
  selectPeer: (id: number | null) => void
  requestConnection: (targetNodeId: number) => Promise<void>
  verifyAndConnect: (passCode: string) => Promise<void>
  rejectIncoming: () => void
  sendFile: (file: File) => Promise<void>
  sendChatMessage: (peerId: number, text: string) => void
  acceptTransfer: () => Promise<void>
  rejectTransfer: () => void
  blockPeer: (nodeId: number) => void
}

export const useNetworkStore = create<NetworkState>((set, get) => ({
  wsConnected: false,
  channelId: null,
  peers: [],
  selectedPeerId: null,
  transfers: [],
  chatMessages: {},
  incomingRequest: null,
  incomingMeta: null,
  connectedPeers: new Set(),

  init(token: string) {
    onMessage(async (msg) => {
      switch (msg.t) {
        case 'WELCOME': {
          // Priority: 1) QR join (scanner), 2) QR owner channel, 3) passcode-derived
          const joinRaw = sessionStorage.getItem('misaka.join')
          const qrChId = sessionStorage.getItem('misaka.qrChannel')
          let chId: string | undefined
          if (joinRaw) {
            try {
              const ctx = JSON.parse(joinRaw) as { channelId?: string }
              chId = ctx.channelId
            } catch { /* ignore */ }
          }
          if (!chId && qrChId) {
            chId = qrChId
            sessionStorage.removeItem('misaka.qrChannel')
          }
          if (!chId) {
            const passCode = useAuthStore.getState().identity.passCode
            const h = await hashPasscode(passCode || '000000')
            chId = `cluster-${h}`
          }
          wsSend({ t: 'JOIN_CHANNEL', channelId: chId })
          set({ wsConnected: true, channelId: chId })
          break
        }

        case 'PEER_JOINED': {
          const newPeer: Peer = {
            nodeId: msg.node.nodeId,
            status: 'online',
            channelType: 'direct',
            joinedAt: msg.node.joinedAt,
          }
          set(s => {
            const existing = s.peers.find(p => p.nodeId === newPeer.nodeId)
            if (existing) {
              return { peers: s.peers.map(p => p.nodeId === newPeer.nodeId ? { ...p, status: 'online' as const, joinedAt: newPeer.joinedAt } : p) }
            }
            return { peers: [...s.peers, newPeer] }
          })
          break
        }

        case 'PEER_LEFT': {
          set(s => {
            const { [msg.nodeId]: _, ...rest } = s.chatMessages
            return {
              peers: s.peers.map(p => p.nodeId === msg.nodeId ? { ...p, status: 'offline' as const } : p),
              chatMessages: rest,
              connectedPeers: (() => {
                const next = new Set(s.connectedPeers)
                next.delete(msg.nodeId)
                return next
              })(),
            }
          })
          cleanupPeerConnection(msg.nodeId)
          break
        }

        case 'CONNECT_REQ_IN': {
          set({ incomingRequest: { fromNodeId: msg.fromNodeId, requestId: msg.requestId } })
          break
        }

        case 'SIGNAL_SDP': {
          await handleRemoteSDP(msg.fromNodeId, msg.sdp)
          break
        }

        case 'SIGNAL_ICE': {
          await handleRemoteICE(msg.fromNodeId, msg.candidate)
          break
        }

        case 'ERROR': {
          console.warn(`[Signaling] ${msg.code}: ${msg.message}`)
          break
        }

        default:
          break
      }
    })

    onConnect(() => set({ wsConnected: true }))
    onDisconnect(() => set({ wsConnected: false }))

    wsConnect(token)
  },

  destroy() {
    wsDisconnect()
    for (const [id] of peerConnections) {
      cleanupPeerConnection(id)
    }
    resetCrypto()
    set({ wsConnected: false, channelId: null, peers: [], selectedPeerId: null, transfers: [], chatMessages: {}, incomingRequest: null, incomingMeta: null, connectedPeers: new Set() })
  },

  joinChannel(channelId: string) {
    wsSend({ t: 'JOIN_CHANNEL', channelId })
    set({ channelId })
  },

  selectPeer(id) {
    set({ selectedPeerId: id })
  },

  async requestConnection(targetNodeId) {
    set(s => ({
      peers: s.peers.map(p =>
        p.nodeId === targetNodeId ? { ...p, status: 'connecting' as NodeStatus } : p,
      ),
    }))
    wsSend({ t: 'CONNECT_REQ', targetNodeId })
  },

  async verifyAndConnect(passCode) {
    const state = get()
    const auth = useAuthStore.getState()
    const req = state.incomingRequest
    if (!req || !auth.session) return

    const res = await fetch(apiUrl('/api/verify-passcode'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetNodeId: req.fromNodeId,
        passCode,
        sourceToken: auth.session.token,
      }),
    })

    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: 'UNKNOWN' }))
      throw new Error(data.error === 'WRONG_PASSCODE'
        ? `通行码错误，剩余 ${data.attemptsLeft} 次`
        : '验证失败')
    }

    const fromNodeId = req.fromNodeId
    const pc = createPeerConnection()
    peerConnections.set(fromNodeId, pc)

    const dcPromise = new Promise<RTCDataChannel>(resolve => {
      pc.ondatachannel = (e) => resolve(e.channel)
    })

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        wsSend({ t: 'SIGNAL_ICE', targetNodeId: fromNodeId, candidate: e.candidate.toJSON() })
      }
    }

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
        set(s => ({
          peers: s.peers.map(p =>
            p.nodeId === fromNodeId ? { ...p, status: 'offline' as NodeStatus } : p,
          ),
        }))
      }
    }

    await generateECDHKeyPair()

    const dc = await dcPromise
    dataChannels.set(fromNodeId, dc)
    setupDataChannel(dc, fromNodeId)

    set(s => ({
      incomingRequest: null,
      connectedPeers: new Set([...s.connectedPeers, fromNodeId]),
    }))
  },

  rejectIncoming() {
    set({ incomingRequest: null })
  },

  async sendFile(file) {
    const state = get()
    const peerId = state.selectedPeerId
    if (!peerId) throw new Error('未选择目标节点')

    let dc = dataChannels.get(peerId)
    if (!dc) {
      await initiateWebRTC(peerId)
      dc = dataChannels.get(peerId)
      if (!dc) throw new Error('无法建立连接')
    }

    if (!hasAESKey()) {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('加密协商超时')), 30_000)
        ecdhResolvers.set(peerId, () => {
          clearTimeout(timeout)
          resolve()
        })
      })
    }

    const transferId = createTransferId()
    const transfer: Transfer = {
      id: transferId,
      direction: 'send',
      peerNodeId: peerId,
      fileName: file.name,
      fileSize: file.size,
      progress: 0,
      speedBps: 0,
      status: 'pending',
      startedAt: Date.now(),
    }

    set(s => ({ transfers: [...s.transfers, transfer] }))

    const callbacks: SendCallbacks = {
      onProgress(sent, total) {
        set(s => ({
          transfers: s.transfers.map(t =>
            t.id === transferId ? { ...t, progress: sent / total, status: 'transferring' as const } : t,
          ),
        }))
      },
      onError(error) {
        set(s => ({
          transfers: s.transfers.map(t =>
            t.id === transferId ? { ...t, status: 'failed' as const, error } : t,
          ),
        }))
      },
    }

    try {
      await engineSendFile(dc, file, transferId, peerId, undefined, callbacks)
      set(s => ({
        transfers: s.transfers.map(t =>
          t.id === transferId ? { ...t, progress: 1, status: 'completed' as const } : t,
        ),
      }))
    } catch (e) {
      set(s => ({
        transfers: s.transfers.map(t =>
          t.id === transferId ? { ...t, status: 'failed' as const, error: String(e) } : t,
        ),
      }))
    }
  },

  async acceptTransfer() {
    // Transfer acceptance is implicit — chunks are already being received
    // The incomingMeta is cleared so the modal dismisses
    set({ incomingMeta: null })
  },

  rejectTransfer() {
    const meta = get().incomingMeta
    if (meta) {
      cancelReceive(meta.transferId)
      set({ incomingMeta: null })
    }
  },

  sendChatMessage(peerId, text) {
    const dc = dataChannels.get(peerId)
    if (!dc || dc.readyState !== 'open') return

    const msg: ChannelMessage = {
      id: genMsgId(),
      type: 'text',
      content: text,
      timestamp: Date.now(),
    }
    dc.send(JSON.stringify({ type: 'chat', id: msg.id, content: msg.content, timestamp: msg.timestamp }))

    set(s => {
      const msgs = [...(s.chatMessages[peerId] ?? []), msg]
      return { chatMessages: { ...s.chatMessages, [peerId]: msgs } }
    })
  },

  blockPeer(nodeId) {
    wsSend({ t: 'BLOCK', nodeId })
    set(s => ({
      peers: s.peers.filter(p => p.nodeId !== nodeId),
      incomingMeta: null,
      incomingRequest: null,
    }))
    cleanupPeerConnection(nodeId)
  },
}))

// ── WebRTC helpers ───────────────────────────────────────────────────

async function initiateWebRTC(targetNodeId: number) {
  const pc = createPeerConnection()
  peerConnections.set(targetNodeId, pc)

  const dc = createDataChannel(pc)
  dataChannels.set(targetNodeId, dc)

  setupDataChannel(dc, targetNodeId)

  await generateECDHKeyPair()

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      wsSend({ t: 'SIGNAL_ICE', targetNodeId, candidate: e.candidate.toJSON() })
    }
  }

  pc.oniceconnectionstatechange = async () => {
    const state = pc.iceConnectionState
    if (state === 'connected') {
      const ct = await getSelectedChannelType(pc)
      useNetworkStore.setState(s => ({
        peers: s.peers.map(p =>
          p.nodeId === targetNodeId ? { ...p, status: 'transferring' as NodeStatus, channelType: ct ?? 'stun' } : p,
        ),
        connectedPeers: new Set([...s.connectedPeers, targetNodeId]),
      }))
    } else if (state === 'disconnected' || state === 'failed') {
      useNetworkStore.setState(s => ({
        peers: s.peers.map(p =>
          p.nodeId === targetNodeId ? { ...p, status: 'offline' as NodeStatus } : p,
        ),
      }))
    }
  }

  const offer = await createOffer(pc)
  wsSend({ t: 'SIGNAL_SDP', targetNodeId, sdp: offer })

  const pending = pendingIceCandidates.get(targetNodeId)
  if (pending) {
    pendingIceCandidates.delete(targetNodeId)
    for (const c of pending) {
      await addIceCandidate(pc, c)
    }
  }
}

async function handleRemoteSDP(fromNodeId: number, sdp: RTCSessionDescriptionInit) {
  let pc = peerConnections.get(fromNodeId)

  if (!pc) {
    pc = createPeerConnection()
    peerConnections.set(fromNodeId, pc)

    const dcPromise = new Promise<RTCDataChannel>(resolve => {
      pc!.ondatachannel = (e) => resolve(e.channel)
    })

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        wsSend({ t: 'SIGNAL_ICE', targetNodeId: fromNodeId, candidate: e.candidate.toJSON() })
      }
    }

    pc.oniceconnectionstatechange = async () => {
      if (pc!.iceConnectionState === 'connected') {
        const ct = await getSelectedChannelType(pc!)
        useNetworkStore.setState(s => ({
          peers: s.peers.map(p =>
            p.nodeId === fromNodeId ? { ...p, status: 'transferring' as NodeStatus, channelType: ct ?? 'stun' } : p,
          ),
          connectedPeers: new Set([...s.connectedPeers, fromNodeId]),
        }))
      }
    }

    await generateECDHKeyPair()

    dcPromise.then(dc => {
      dataChannels.set(fromNodeId, dc)
      setupDataChannel(dc, fromNodeId)
    })
  }

  if (sdp.type === 'offer') {
    const answer = await createAnswer(pc, sdp)
    wsSend({ t: 'SIGNAL_SDP', targetNodeId: fromNodeId, sdp: answer })
  } else {
    await applyAnswer(pc, sdp)
  }

  const pending = pendingIceCandidates.get(fromNodeId)
  if (pending) {
    pendingIceCandidates.delete(fromNodeId)
    for (const c of pending) {
      await addIceCandidate(pc, c)
    }
  }
}

async function handleRemoteICE(fromNodeId: number, candidate: RTCIceCandidateInit) {
  const pc = peerConnections.get(fromNodeId)
  if (pc?.remoteDescription) {
    await addIceCandidate(pc, candidate)
  } else {
    const pending = pendingIceCandidates.get(fromNodeId) ?? []
    pending.push(candidate)
    pendingIceCandidates.set(fromNodeId, pending)
  }
}

function setupDataChannel(dc: RTCDataChannel, peerNodeId: number) {
  let lastChunkHeader: ChunkHeader | null = null

  dc.onopen = async () => {
    useNetworkStore.setState(s => ({
      peers: s.peers.map(p =>
        p.nodeId === peerNodeId ? { ...p, status: 'transferring' as const } : p,
      ),
    }))
    const pub = await getMyPublicKey()
    dc.send(JSON.stringify({ type: 'ecdh-pub', pub }))
  }

  dc.onmessage = async (e) => {
    // Binary: chunk body (iv + encrypted)
    if (e.data instanceof ArrayBuffer) {
      if (!lastChunkHeader) return
      const header = lastChunkHeader
      lastChunkHeader = null

      const packet = new Uint8Array(e.data as ArrayBuffer)
      const iv = packet.slice(0, 12)
      const encrypted = packet.slice(12).buffer as ArrayBuffer

      const ack = await receiveChunk(
        header.transferId, header, iv, encrypted,
        {
          onProgress(received, total) {
            useNetworkStore.setState(s => ({
              transfers: s.transfers.map(t =>
                t.id === header.transferId
                  ? { ...t, progress: received / total, status: 'transferring' as const }
                  : t,
              ),
            }))
          },
          onComplete(file) {
            completeReceive(header.transferId).then(() => {
              useNetworkStore.setState(s => ({
                transfers: s.transfers.map(t =>
                  t.id === header.transferId
                    ? { ...t, progress: 1, status: 'completed' as const }
                    : t,
                ),
              }))
              const url = URL.createObjectURL(file)
              const a = document.createElement('a')
              a.href = url
              a.download = file.name
              a.click()
              URL.revokeObjectURL(url)
            }).catch(err => {
              useNetworkStore.setState(s => ({
                transfers: s.transfers.map(t =>
                  t.id === header.transferId
                    ? { ...t, status: 'failed' as const, error: String(err) }
                    : t,
                ),
              }))
            })
          },
          onError(error) {
            useNetworkStore.setState(s => ({
              transfers: s.transfers.map(t =>
                t.id === header.transferId
                  ? { ...t, status: 'failed' as const, error }
                  : t,
              ),
            }))
          },
        },
      )

      if (ack) {
        dc.send(JSON.stringify(ack))
      }
      return
    }

    // Text messages
    if (typeof e.data === 'string') {
      try {
        const msg = JSON.parse(e.data)

        if (msg.type === 'ecdh-pub') {
          await setPeerPublicKey(msg.pub)
          ecdhResolvers.get(peerNodeId)?.()
          ecdhResolvers.delete(peerNodeId)
          return
        }

        if (msg.type === 'meta') {
          const meta = msg as MetaMessage
          await handleMetaMessage(meta, peerNodeId)
          useNetworkStore.setState(s => ({
            incomingMeta: { ...meta, fromNodeId: peerNodeId },
            transfers: [...s.transfers, {
              id: meta.transferId,
              direction: 'recv' as const,
              peerNodeId,
              fileName: meta.fileName,
              fileSize: meta.fileSize,
              progress: 0,
              speedBps: 0,
              status: 'pending' as const,
              startedAt: Date.now(),
            }],
          }))
          return
        }

        if (msg.type === 'chunk') {
          lastChunkHeader = msg as ChunkHeader
          return
        }

        if (msg.type === 'chat') {
          const chatMsg: ChannelMessage = {
            id: msg.id || genMsgId(),
            type: 'text',
            content: msg.content || msg.text || '',
            timestamp: msg.timestamp || Date.now(),
          }
          useNetworkStore.setState(s => {
            const msgs = [...(s.chatMessages[peerNodeId] ?? []), chatMsg]
            return { chatMessages: { ...s.chatMessages, [peerNodeId]: msgs } }
          })
          return
        }

        // ACK and resume messages are handled by the engine
      } catch { /* not JSON */ }
    }
  }
}

function cleanupPeerConnection(nodeId: number) {
  const dc = dataChannels.get(nodeId)
  if (dc) {
    dc.close()
    dataChannels.delete(nodeId)
  }
  const pc = peerConnections.get(nodeId)
  if (pc) {
    pc.close()
    peerConnections.delete(nodeId)
  }
  ecdhResolvers.delete(nodeId)
}
