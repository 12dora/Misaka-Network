import { create } from 'zustand'
import type { Peer, Transfer, NodeStatus, ChannelMessage, MessageStatus, PendingFileItem } from '@/types'
import {
  connect as wsConnect, disconnect as wsDisconnect, send as wsSend,
  onMessage, onConnect, onDisconnect, reconnectNow,
} from '@/lib/signaling'
import {
  createPeerConnection, createDataChannel, createOffer, createAnswer,
  applyAnswer, addIceCandidate, getSelectedChannelType, getSelectedIcePath,
} from '@/lib/webrtc'
import {
  generateECDHKeyPair, getMyPublicKey, setPeerPublicKey,
  resetCrypto, hasAESKey,
} from '@/lib/crypto'
import {
  sendFileParallel as engineSendFileParallel, handleMetaMessage, receiveChunk,
  completeReceive, cancelReceive, createTransferId, buildResumeRequest,
  pauseTransfer, resumeTransfer, cancelTransfer as engineCancelTransfer,
  supportsFileSystemAccess, streamChunkToDisk,
  finalizeStreamedFile, cancelStreamWrite, getWriteHandle,
  supportsOPFS, createOPFSReceiveFile, writeChunkToOPFS, getOPFSFile, getOPFSHandle, cleanupOPFS,
  type MetaMessage, type ChunkHeader, type SendCallbacks, type ResumeRequest,
} from '@/lib/transfer'
import { getTransfer, getActiveTransfers } from '@/lib/db'
import { playSound } from '@/lib/sound'
import { notifyIncomingFile } from '@/lib/notify'
import { refreshAutoTurn, clearAutoTurn } from '@/lib/turn'
import {
  MAX_ICE_RESTART_ATTEMPTS, ICE_RESTART_BACKOFF_MS, ICE_DISCONNECTED_RESTART_DELAY_MS,
  DC_OPEN_TIMEOUT_MS, ENCRYPTION_TIMEOUT_MS,
  TRANSFER_LANE_COUNT,
} from '@/constants'

// ── Non-reactive WebRTC state ────────────────────────────────────────
// All routing is per-session (one device = one sessionId). Multiple devices
// may share a nodeId; sessionId is the unique key.
const peerConnections = new Map<string, RTCPeerConnection>()
const dataChannels = new Map<string, RTCDataChannel>()
const transferLanes = new Map<string, RTCDataChannel[]>()
const configuredDataChannels = new WeakSet<RTCDataChannel>()
const pendingIceCandidates = new Map<string, RTCIceCandidateInit[]>()
const ecdhResolvers: Map<string, () => void> = new Map()
const iceRestarting = new Set<string>()
const iceRestartAttempts = new Map<string, number>()
// Schedule an ICE restart when state is 'disconnected' for too long. The
// browser fires 'failed' very lazily (~30s), so we stop waiting and try
// to recover proactively.
const disconnectedTimers = new Map<string, ReturnType<typeof setTimeout>>()
const sendingFiles = new Map<string, File>()  // transferId → File
let initialized = false   // see init() — prevents StrictMode double-registration
const deliveredTransfers = new Set<string>()  // one file card per transferId
const transferSpeedSamples = new Map<string, { bytes: number; at: number }>()
let currentToken = ''

// Messages typed before the DC fully opened, flushed in dc.onopen.
const outgoingQueue = new Map<string, string[]>()
// Track msgIds in outgoingQueue so we can update their status on flush or failure.
const queuedMessageIds = new Map<string, Set<string>>()

function queueOutgoing(peerSessionId: string, payload: string, msgId?: string) {
  const q = outgoingQueue.get(peerSessionId) ?? []
  q.push(payload)
  outgoingQueue.set(peerSessionId, q)
  if (msgId) {
    const ids = queuedMessageIds.get(peerSessionId) ?? new Set<string>()
    ids.add(msgId)
    queuedMessageIds.set(peerSessionId, ids)
  }
}
function flushOutgoing(peerSessionId: string, dc: RTCDataChannel) {
  const q = outgoingQueue.get(peerSessionId)
  if (!q?.length) return
  for (const p of q) {
    try { dc.send(p) } catch { /* ignore */ }
  }
  outgoingQueue.delete(peerSessionId)
  // All queued messages are now in-flight → mark as 'sent'.
  const ids = queuedMessageIds.get(peerSessionId)
  if (ids) {
    for (const id of ids) updateMessageStatus(peerSessionId, id, 'sent')
    queuedMessageIds.delete(peerSessionId)
  }
}

function updateMessageStatus(peerSessionId: string, msgId: string, status: MessageStatus) {
  useNetworkStore.setState(s => ({
    chatMessages: {
      ...s.chatMessages,
      [peerSessionId]: (s.chatMessages[peerSessionId] ?? []).map(m =>
        m.id === msgId ? { ...m, status } : m,
      ),
    },
  }))
}

// Mark queued messages as failed (e.g. peer went offline before DC opened).
function failPendingMessages(peerSessionId: string) {
  const ids = queuedMessageIds.get(peerSessionId)
  if (!ids?.size) return
  for (const id of ids) updateMessageStatus(peerSessionId, id, 'failed')
  queuedMessageIds.delete(peerSessionId)
  outgoingQueue.delete(peerSessionId)
}

let recoveryInstalled = false
let lastRecoverAt = 0

function installForegroundRecovery() {
  if (recoveryInstalled || typeof window === 'undefined') return
  recoveryInstalled = true
  const recover = () => {
    if (document.visibilityState && document.visibilityState !== 'visible') return
    recoverConnections()
  }
  window.addEventListener('online', recover)
  window.addEventListener('focus', recover)
  window.addEventListener('pageshow', recover)
  document.addEventListener('visibilitychange', recover)
}

function recoverConnections() {
  const now = Date.now()
  if (now - lastRecoverAt < 1_500) return
  lastRecoverAt = now
  if (currentToken) {
    reconnectNow()
    void refreshAutoTurn(currentToken)
  }
  for (const peer of useNetworkStore.getState().peers) {
    const pc = peerConnections.get(peer.sessionId)
    const dc = dataChannels.get(peer.sessionId)
    const needsReconnect =
      peer.status === 'offline' ||
      peer.status === 'reconnecting' ||
      !pc ||
      pc.connectionState === 'closed' ||
      pc.connectionState === 'failed' ||
      pc.iceConnectionState === 'failed' ||
      !dc ||
      dc.readyState === 'closed'

    if (needsReconnect) {
      cleanupPeerConnection(peer.sessionId)
      initiateWebRTC(peer.sessionId).catch(() => {})
    } else if (pc.iceConnectionState === 'disconnected') {
      attemptIceRestart(peer.sessionId).catch(() => {})
    }
  }
}

function genMsgId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

interface NetworkState {
  wsConnected: boolean
  mySessionId: string | null
  channelId: string | null
  peers: Peer[]
  selectedSessionId: string | null
  transfers: Transfer[]
  chatMessages: Record<string, ChannelMessage[]>   // keyed by peer sessionId
  pendingFiles: Record<string, PendingFileItem[]>  // peer sessionId -> files awaiting send
  connectedPeers: Set<string>                      // sessionIds with open DC
  unreadByPeer: Record<string, { message: number; file: number }>

  init: (token: string) => void
  destroy: () => void
  selectPeer: (sessionId: string | null) => void
  addPendingFiles: (sessionId: string, files: File[]) => void
  removePendingFile: (sessionId: string, itemId: string) => void
  clearPendingFiles: (sessionId: string) => void
  sendPendingFile: (sessionId: string) => Promise<void>
  sendFile: (file: File) => Promise<void>
  sendFilesToAll: (files: File[]) => Promise<void>
  pauseTransfer: (transferId: string) => void
  resumeTransfer: (transferId: string, peerSessionId: string) => Promise<void>
  cancelTransferAction: (transferId: string) => void
  sendChatMessage: (peerSessionId: string, text: string) => void
  retryChatMessage: (peerSessionId: string, msgId: string) => void
  blockPeer: (sessionId: string) => void
  recoverConnections: () => void
}

export const useNetworkStore = create<NetworkState>((set, get) => ({
  wsConnected: false,
  mySessionId: null,
  channelId: null,
  peers: [],
  selectedSessionId: null,
  transfers: [],
  chatMessages: {},
  pendingFiles: {},
  connectedPeers: new Set(),
  unreadByPeer: {},

  init(token: string) {
    // React 18 StrictMode double-mounts effects in dev, which would register
    // a second onMessage handler (every signal would be processed twice,
    // tripping `setLocalDescription: wrong state: stable` on the second
    // application) and spawn a second WebSocket. Guard with a module flag.
    if (initialized) return
    initialized = true
    currentToken = token
    onMessage(async (msg) => {
      switch (msg.t) {
        case 'WELCOME': {
          set({ wsConnected: true, mySessionId: msg.sessionId })
          // Auto-join the identity-scoped cluster channel.
          wsSend({ t: 'JOIN_CLUSTER' })
          break
        }

        case 'PEER_JOINED': {
          const { sessionId, nodeId, joinedAt } = msg.peer
          set(s => {
            const exists = s.peers.find(p => p.sessionId === sessionId)
            if (exists) return s
            const newPeer: Peer = { sessionId, nodeId, status: 'online', channelType: 'direct', joinedAt }
            return { peers: [...s.peers, newPeer] }
          })
          // We're the newcomer — kick off the WebRTC offer to each existing peer.
          // The existing peers receive shouldInitiate=false and just wait.
          if (msg.shouldInitiate) {
            initiateWebRTC(sessionId).catch(err => console.warn('[net] auto-initiate failed', err))
          }
          break
        }

        case 'PEER_LEFT': {
          const sid = msg.sessionId
          set(s => {
            const { [sid]: _omit, ...restChat } = s.chatMessages
            const { [sid]: _f, ...restFiles } = s.pendingFiles
            const { [sid]: _u, ...restUnread } = s.unreadByPeer
            const nextConnected = new Set(s.connectedPeers); nextConnected.delete(sid)
            return {
              peers: s.peers.map(p => p.sessionId === sid ? { ...p, status: 'offline' as const } : p),
              chatMessages: restChat,
              pendingFiles: restFiles,
              connectedPeers: nextConnected,
              unreadByPeer: restUnread,
              selectedSessionId: s.selectedSessionId === sid ? null : s.selectedSessionId,
            }
          })
          cleanupPeerConnection(sid)
          break
        }

        case 'SIGNAL_SDP':
          await handleRemoteSDP(msg.fromSessionId, msg.fromNodeId, msg.sdp)
          break

        case 'SIGNAL_ICE':
          await handleRemoteICE(msg.fromSessionId, msg.candidate)
          break

        case 'SIGNAL_ICE_END':
          await handleRemoteICEEnd(msg.fromSessionId)
          break

        case 'SERVER_SHUTDOWN':
          console.warn(`[Signaling] 服务器关闭: ${msg.reason}`)
          set({ wsConnected: false })
          break

        case 'ERROR':
          console.warn(`[Signaling] ${msg.code}: ${msg.message}`)
          break

        default:
          break
      }
    })

    onConnect(() => {
      set({ wsConnected: true })
      // Prefetch auto TURN once authed. Server may reply 503 if disabled —
      // that's fine, we just fall back to STUN + manual TURN. Re-fetch on
      // every reconnect because credentials are short-lived.
      void refreshAutoTurn(token)
    })
    onDisconnect(() => set({ wsConnected: false }))

    wsConnect(token)
    installForegroundRecovery()
  },

  destroy() {
    wsDisconnect()
    for (const sid of peerConnections.keys()) cleanupPeerConnection(sid)
    resetCrypto()
    clearAutoTurn()
    initialized = false
    currentToken = ''
    set({
      wsConnected: false, mySessionId: null, channelId: null,
      peers: [], selectedSessionId: null, transfers: [],
      chatMessages: {}, pendingFiles: {}, connectedPeers: new Set(), unreadByPeer: {},
    })
  },

  selectPeer(sessionId) {
    if (!sessionId) {
      set({ selectedSessionId: null })
      return
    }
    set(s => {
      const { [sessionId]: _seen, ...rest } = s.unreadByPeer
      return { selectedSessionId: sessionId, unreadByPeer: rest }
    })
  },

  addPendingFiles(sessionId, files) {
    set(s => {
      const current = s.pendingFiles[sessionId] ?? []
      const incoming = files.map(file => ({
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        file,
        displayName: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
      }))
      return { pendingFiles: { ...s.pendingFiles, [sessionId]: [...current, ...incoming] } }
    })
  },

  removePendingFile(sessionId, itemId) {
    set(s => {
      const next = (s.pendingFiles[sessionId] ?? []).filter(item => item.id !== itemId)
      if (next.length === 0) {
        const { [sessionId]: _drop, ...rest } = s.pendingFiles
        return { pendingFiles: rest }
      }
      return { pendingFiles: { ...s.pendingFiles, [sessionId]: next } }
    })
  },

  clearPendingFiles(sessionId) {
    set(s => {
      const { [sessionId]: _drop, ...rest } = s.pendingFiles
      return { pendingFiles: rest }
    })
  },

  async sendPendingFile(sessionId) {
    const items = get().pendingFiles[sessionId] ?? []
    if (items.length === 0) return
    let allOk = true
    for (const item of items) {
      const ok = await sendFileToPeer(item.file, sessionId, item.displayName)
      if (!ok) allOk = false
    }
    if (allOk) {
      set(s => {
        const { [sessionId]: _drop, ...rest } = s.pendingFiles
        return { pendingFiles: rest }
      })
    }
    // On failure leave the staged queue in place so the user can retry / prune.
  },

  async sendFile(file) {
    const sid = get().selectedSessionId
    if (!sid) throw new Error('未选择目标节点')
    await sendFileToPeer(file, sid)
  },

  async sendFilesToAll(files) {
    const targets = get().peers.filter(p => p.status !== 'offline').map(p => p.sessionId)
    if (targets.length === 0) throw new Error('没有可用的目标节点')
    await Promise.allSettled(targets.flatMap(sid => files.map(file => sendFileToPeer(file, sid))))
  },

  sendChatMessage(peerSessionId, text) {
    const msg: ChannelMessage = {
      id: genMsgId(), type: 'text', content: text, timestamp: Date.now(),
      direction: 'sent', status: 'sending',
    }
    set(s => ({
      chatMessages: { ...s.chatMessages, [peerSessionId]: [...(s.chatMessages[peerSessionId] ?? []), msg] },
    }))

    const payload = JSON.stringify({ type: 'chat', id: msg.id, content: msg.content, timestamp: msg.timestamp })
    const dc = dataChannels.get(peerSessionId)
    if (dc?.readyState === 'open') {
      try {
        dc.send(payload)
        updateMessageStatus(peerSessionId, msg.id, 'sent')
      } catch {
        updateMessageStatus(peerSessionId, msg.id, 'failed')
      }
    } else {
      // Queued — will be flushed and marked 'sent' when the DC opens.
      queueOutgoing(peerSessionId, payload, msg.id)
    }
  },

  retryChatMessage(peerSessionId, msgId) {
    const msg = get().chatMessages[peerSessionId]?.find(m => m.id === msgId)
    if (!msg || msg.type !== 'text') return
    updateMessageStatus(peerSessionId, msgId, 'sending')
    const payload = JSON.stringify({ type: 'chat', id: msg.id, content: msg.content, timestamp: msg.timestamp })
    const dc = dataChannels.get(peerSessionId)
    if (dc?.readyState === 'open') {
      try {
        dc.send(payload)
        updateMessageStatus(peerSessionId, msgId, 'sent')
      } catch {
        updateMessageStatus(peerSessionId, msgId, 'failed')
      }
    } else {
      queueOutgoing(peerSessionId, payload, msgId)
    }
  },

  blockPeer(sessionId) {
    wsSend({ t: 'BLOCK', sessionId })
    set(s => {
      const { [sessionId]: _omit, ...rest } = s.chatMessages
      return {
        peers: s.peers.filter(p => p.sessionId !== sessionId),
        chatMessages: rest,
        selectedSessionId: s.selectedSessionId === sessionId ? null : s.selectedSessionId,
      }
    })
    cleanupPeerConnection(sessionId)
  },

  recoverConnections() {
    recoverConnections()
  },

  pauseTransfer(transferId) {
    pauseTransfer(transferId)
    set(s => ({
      transfers: s.transfers.map(t => t.id === transferId ? { ...t, status: 'paused' as const } : t),
    }))
  },

  async resumeTransfer(transferId, peerSessionId) {
    resumeTransfer(transferId)
    set(s => ({
      transfers: s.transfers.map(t => t.id === transferId ? { ...t, status: 'transferring' as const } : t),
    }))
    const dc = dataChannels.get(peerSessionId)
    const file = sendingFiles.get(transferId)
    if (dc && file && dc.readyState === 'open') {
      const record = await getTransfer(transferId)
      if (record) {
        const request = await buildResumeRequest(transferId)
        const peerNodeId = get().peers.find(p => p.sessionId === peerSessionId)?.nodeId ?? 0
        const lanes = await ensureTransferLanes(peerSessionId)
        engineSendFileParallel(lanes, file, transferId, peerNodeId, record, undefined, request?.receivedChunks)
          .then(() => sendingFiles.delete(transferId))
          .catch(() => {})
      }
    }
  },

  cancelTransferAction(transferId) {
    engineCancelTransfer(transferId)
    cancelReceive(transferId)
    cancelStreamWrite(transferId)
    cleanupOPFS(transferId).catch(() => {})
    sendingFiles.delete(transferId)
    transferSpeedSamples.delete(transferId)
    set(s => ({ transfers: s.transfers.filter(t => t.id !== transferId) }))
  },
}))

// ── WebRTC helpers ────────────────────────────────────────────────────

async function ensureConnected(peerSessionId: string): Promise<RTCDataChannel> {
  let dc = dataChannels.get(peerSessionId)
  if (!dc) {
    await initiateWebRTC(peerSessionId)
    dc = dataChannels.get(peerSessionId)
    if (!dc) throw new Error('无法建立连接')
  }
  if (dc.readyState !== 'open') {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('DataChannel 打开超时')), DC_OPEN_TIMEOUT_MS)
      const onOpen = () => { clearTimeout(timeout); resolve() }
      dc!.addEventListener('open', onOpen, { once: true })
    })
  }
  if (!hasAESKey()) {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('加密协商超时')), ENCRYPTION_TIMEOUT_MS)
      ecdhResolvers.set(peerSessionId, () => { clearTimeout(timeout); resolve() })
    })
  }
  return dc
}

async function ensureTransferLanes(peerSessionId: string): Promise<RTCDataChannel[]> {
  const primary = await ensureConnected(peerSessionId)
  let lanes = transferLanes.get(peerSessionId) ?? []
  lanes = lanes.filter(dc => dc.readyState !== 'closed')
  transferLanes.set(peerSessionId, lanes)

  const openLanes = lanes.filter(dc => dc.readyState === 'open')
  if (openLanes.length > 0) return openLanes
  return [primary]
}

async function sendFileToPeer(file: File, peerSessionId: string, displayName = file.name): Promise<boolean> {
  const peer = useNetworkStore.getState().peers.find(p => p.sessionId === peerSessionId)
  const peerNodeId = peer?.nodeId ?? 0

  let dcs: RTCDataChannel[]
  try {
    dcs = await ensureTransferLanes(peerSessionId)
  } catch (e) {
    appendSystemChat(peerSessionId, `发送失败：${String((e as Error).message ?? e)}`)
    return false
  }

  const transferId = createTransferId()
  const transfer: Transfer = {
    id: transferId, direction: 'send',
    peerSessionId, peerNodeId,
    fileName: displayName, fileSize: file.size,
    progress: 0, speedBps: 0, status: 'pending', startedAt: Date.now(),
  }
  useNetworkStore.setState(s => ({ transfers: [...s.transfers, transfer] }))
  // Surface the send intent in the chat history immediately.
  appendSystemChat(peerSessionId, `开始发送文件 ${displayName}`, 'sent')

  const callbacks: SendCallbacks = {
    onProgress(sent, total) {
      const now = performance.now()
      const bytes = Math.min(file.size, Math.round((sent / total) * file.size))
      const prev = transferSpeedSamples.get(transferId) ?? { bytes: 0, at: now }
      const elapsed = Math.max(1, now - prev.at)
      const speedBps = now === prev.at ? 0 : ((bytes - prev.bytes) * 1000) / elapsed
      transferSpeedSamples.set(transferId, { bytes, at: now })
      useNetworkStore.setState(s => ({
        transfers: s.transfers.map(t =>
          t.id === transferId ? { ...t, progress: sent / total, speedBps, status: 'transferring' as const } : t,
        ),
      }))
    },
    onError(error) {
      useNetworkStore.setState(s => ({
        transfers: s.transfers.map(t =>
          t.id === transferId ? { ...t, status: 'failed' as const, error } : t,
        ),
      }))
    },
  }

  try {
    sendingFiles.set(transferId, file)
    await engineSendFileParallel(dcs, file, transferId, peerNodeId, undefined, callbacks)
    sendingFiles.delete(transferId)
    useNetworkStore.setState(s => ({
      transfers: s.transfers.map(t =>
        t.id === transferId ? { ...t, progress: 1, status: 'completed' as const } : t,
      ),
    }))
    appendSystemChat(peerSessionId, `已发送文件 ${displayName}`, 'sent')
    playSound('complete')
    transferSpeedSamples.delete(transferId)
    return true
  } catch (e) {
    transferSpeedSamples.delete(transferId)
    useNetworkStore.setState(s => ({
      transfers: s.transfers.map(t =>
        t.id === transferId ? { ...t, status: 'failed' as const, error: String(e) } : t,
      ),
    }))
    appendSystemChat(peerSessionId, `发送失败：${displayName} · ${String((e as Error).message ?? e)}`, 'sent')
    playSound('error')
    return false
  }
}

function appendSystemChat(peerSessionId: string, content: string, direction: 'sent' | 'recv' | 'system' = 'system') {
  const m: ChannelMessage = { id: genMsgId(), type: 'system', content, timestamp: Date.now(), direction }
  useNetworkStore.setState(s => {
    const msgs = [...(s.chatMessages[peerSessionId] ?? []), m]
    return { chatMessages: { ...s.chatMessages, [peerSessionId]: msgs } }
  })
}

async function initiateWebRTC(peerSessionId: string) {
  if (peerConnections.has(peerSessionId)) return
  const pc = createPeerConnection()
  peerConnections.set(peerSessionId, pc)

  const dc = createDataChannel(pc)
  dataChannels.set(peerSessionId, dc)
  setupDataChannel(dc, peerSessionId)
  for (let i = 0; i < TRANSFER_LANE_COUNT; i++) {
    const lane = createDataChannel(pc, `misaka-transfer-${i}`)
    const lanes = transferLanes.get(peerSessionId) ?? []
    lanes.push(lane)
    transferLanes.set(peerSessionId, lanes)
    setupDataChannel(lane, peerSessionId)
  }

  await generateECDHKeyPair()

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      wsSend({ t: 'SIGNAL_ICE', targetSessionId: peerSessionId, candidate: e.candidate.toJSON() })
    } else {
      // null marks end-of-candidates — tell peer so its ICE agent can stop
      // waiting for stragglers and finalize connectivity checks faster.
      wsSend({ t: 'SIGNAL_ICE_END', targetSessionId: peerSessionId })
    }
  }

  pc.oniceconnectionstatechange = () => handleIceStateChange(pc, peerSessionId)

  const offer = await createOffer(pc)
  wsSend({ t: 'SIGNAL_SDP', targetSessionId: peerSessionId, sdp: offer })

  const pending = pendingIceCandidates.get(peerSessionId)
  if (pending) {
    pendingIceCandidates.delete(peerSessionId)
    for (const c of pending) await addIceCandidate(pc, c)
  }
}

async function handleRemoteSDP(fromSessionId: string, fromNodeId: number, sdp: RTCSessionDescriptionInit) {
  let pc = peerConnections.get(fromSessionId)

  if (!pc) {
    // Inbound offer from a peer who joined before us — accept it.
    pc = createPeerConnection()
    peerConnections.set(fromSessionId, pc)

    pc.ondatachannel = (e) => {
      if (e.channel.label.startsWith('misaka-transfer-')) {
        const lanes = transferLanes.get(fromSessionId) ?? []
        lanes.push(e.channel)
        transferLanes.set(fromSessionId, lanes)
      } else {
        dataChannels.set(fromSessionId, e.channel)
      }
      setupDataChannel(e.channel, fromSessionId)
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        wsSend({ t: 'SIGNAL_ICE', targetSessionId: fromSessionId, candidate: e.candidate.toJSON() })
      } else {
        wsSend({ t: 'SIGNAL_ICE_END', targetSessionId: fromSessionId })
      }
    }

    pc.oniceconnectionstatechange = () => handleIceStateChange(pc!, fromSessionId)

    await generateECDHKeyPair()

    // Make sure the peer is in our radar (PEER_JOINED may have arrived before
    // the SDP, but on race we surface them here too).
    useNetworkStore.setState(s => {
      if (s.peers.some(p => p.sessionId === fromSessionId)) return s
      const peer: Peer = {
        sessionId: fromSessionId, nodeId: fromNodeId,
        status: 'connecting', channelType: 'direct', joinedAt: Date.now(),
      }
      return { peers: [...s.peers, peer] }
    })
  }

  if (sdp.type === 'offer') {
    const answer = await createAnswer(pc, sdp)
    wsSend({ t: 'SIGNAL_SDP', targetSessionId: fromSessionId, sdp: answer })
  } else {
    await applyAnswer(pc, sdp)
  }

  const pending = pendingIceCandidates.get(fromSessionId)
  if (pending) {
    pendingIceCandidates.delete(fromSessionId)
    for (const c of pending) await addIceCandidate(pc, c)
  }
}

async function handleRemoteICE(fromSessionId: string, candidate: RTCIceCandidateInit) {
  const pc = peerConnections.get(fromSessionId)
  if (pc?.remoteDescription) {
    await addIceCandidate(pc, candidate)
  } else {
    const pending = pendingIceCandidates.get(fromSessionId) ?? []
    pending.push(candidate)
    pendingIceCandidates.set(fromSessionId, pending)
  }
}

async function handleRemoteICEEnd(fromSessionId: string) {
  const pc = peerConnections.get(fromSessionId)
  if (!pc) return
  // Empty-candidate marker per RFC 8445 §8.1.2 — signals the peer has
  // finished gathering. Browsers accept this to short-circuit waits.
  try { await pc.addIceCandidate({ candidate: '', sdpMid: '', sdpMLineIndex: 0 }) }
  catch { /* some browsers reject the marker; harmless */ }
}

function handleIceStateChange(pc: RTCPeerConnection, peerSessionId: string) {
  const state = pc.iceConnectionState
  if (state === 'connected' || state === 'completed') {
    clearDisconnectedTimer(peerSessionId)
    iceRestartAttempts.set(peerSessionId, 0)
    void onIceConnected(pc, peerSessionId)
  } else if (state === 'disconnected') {
    const prevStatus = useNetworkStore.getState().peers.find(p => p.sessionId === peerSessionId)?.status
    useNetworkStore.setState(s => ({
      peers: s.peers.map(p =>
        p.sessionId === peerSessionId ? { ...p, status: 'reconnecting' as NodeStatus } : p,
      ),
    }))
    if (prevStatus === 'transferring') {
      appendSystemChat(peerSessionId, '⚠ 连接中断，尝试恢复中…')
    }
    // Schedule a proactive restart instead of waiting ~30s for 'failed'.
    if (!disconnectedTimers.has(peerSessionId)) {
      const t = setTimeout(() => {
        disconnectedTimers.delete(peerSessionId)
        const cur = peerConnections.get(peerSessionId)
        if (!cur) return
        if (cur.iceConnectionState === 'disconnected' || cur.iceConnectionState === 'failed') {
          attemptIceRestart(peerSessionId)
        }
      }, ICE_DISCONNECTED_RESTART_DELAY_MS)
      disconnectedTimers.set(peerSessionId, t)
    }
  } else if (state === 'failed') {
    clearDisconnectedTimer(peerSessionId)
    attemptIceRestart(peerSessionId)
  }
}

function clearDisconnectedTimer(peerSessionId: string) {
  const t = disconnectedTimers.get(peerSessionId)
  if (t) {
    clearTimeout(t)
    disconnectedTimers.delete(peerSessionId)
  }
}

async function onIceConnected(pc: RTCPeerConnection, peerSessionId: string) {
  const selectedPath = await getSelectedIcePath(pc)
  const ct = selectedPath?.channelType ?? await getSelectedChannelType(pc)
  useNetworkStore.setState(s => ({
    peers: s.peers.map(p =>
      p.sessionId === peerSessionId
        ? {
            ...p,
            status: 'transferring' as NodeStatus,
            channelType: ct ?? 'stun',
            icePath: selectedPath?.pathText,
            icePathMeasuredAt: selectedPath?.pathText ? Date.now() : p.icePathMeasuredAt,
          }
        : p,
    ),
    connectedPeers: new Set([...s.connectedPeers, peerSessionId]),
  }))
}

function setupDataChannel(dc: RTCDataChannel, peerSessionId: string) {
  // Idempotency guard: in reconnect races the same channel instance may flow
  // through setup twice; avoid duplicate listeners / duplicate side effects.
  if (configuredDataChannels.has(dc)) return
  configuredDataChannels.add(dc)

  let lastChunkHeader: ChunkHeader | null = null

  // Without this, incoming chunk bodies arrive as Blob and the
  // `instanceof ArrayBuffer` check below skips them silently.
  dc.binaryType = 'arraybuffer'

  dc.onclose = () => {
    if (dc.readyState === 'closed') {
      const pc = peerConnections.get(peerSessionId)
      if (pc && pc.connectionState !== 'closed') {
        attemptIceRestart(peerSessionId)
      }
    }
  }

  const handleOpen = async () => {
    // Show reconnection notice if there was prior chat activity.
    const prevMsgs = useNetworkStore.getState().chatMessages[peerSessionId] ?? []
    const isReconnect = prevMsgs.some(m => m.type !== 'system')
    useNetworkStore.setState(s => ({
      peers: s.peers.map(p =>
        p.sessionId === peerSessionId ? { ...p, status: 'transferring' as const } : p,
      ),
      connectedPeers: new Set([...s.connectedPeers, peerSessionId]),
    }))
    if (isReconnect) {
      appendSystemChat(peerSessionId, '✓ 连接已恢复')
    }
    try {
      const pub = await getMyPublicKey()
      dc.send(JSON.stringify({ type: 'ecdh-pub', pub }))
    } catch (err) {
      console.warn('[net] ecdh-pub send failed', err)
    }
    flushOutgoing(peerSessionId, dc)
  }

  // Race: on the answerer side, the channel may already be open by the time
  // we attach the listener. addEventListener (vs `.onopen=`) doesn't help if
  // the event has already fired — guard explicitly.
  if (dc.readyState === 'open') {
    handleOpen()
  } else {
    dc.addEventListener('open', handleOpen, { once: true })
  }

  dc.onmessage = async (e) => {
    if (e.data instanceof ArrayBuffer) {
      if (!lastChunkHeader) return
      const header = lastChunkHeader
      lastChunkHeader = null

      const packet = new Uint8Array(e.data as ArrayBuffer)
      const iv = packet.slice(0, 12)
      const encrypted = packet.slice(12).buffer as ArrayBuffer

      const result = await receiveChunk(
        header.transferId, header, iv, encrypted,
        {
          onProgress(received, total) {
            const now = performance.now()
            const transfer = useNetworkStore.getState().transfers.find(t => t.id === header.transferId)
            const fileSize = transfer?.fileSize ?? 0
            const bytes = fileSize > 0 ? Math.min(fileSize, Math.round((received / total) * fileSize)) : 0
            const prev = transferSpeedSamples.get(header.transferId) ?? { bytes: 0, at: now }
            const elapsed = Math.max(1, now - prev.at)
            const speedBps = now === prev.at ? 0 : ((bytes - prev.bytes) * 1000) / elapsed
            transferSpeedSamples.set(header.transferId, { bytes, at: now })
            useNetworkStore.setState(s => ({
              transfers: s.transfers.map(t =>
                t.id === header.transferId
                  ? { ...t, progress: received / total, speedBps, status: 'transferring' as const }
                  : t,
              ),
            }))
            if (received === total) deliverCompletedFile(header.transferId, peerSessionId)
          },
          onError(error) {
            useNetworkStore.setState(s => ({
              transfers: s.transfers.map(t =>
                t.id === header.transferId ? { ...t, status: 'failed' as const, error } : t,
              ),
            }))
          },
        },
      )

      if (result) {
        const { ack, decrypted: decryptedData, storageMode } = result
        if (storageMode === 'stream') {
          await Promise.all([
            streamChunkToDisk(header.transferId, header.index, decryptedData),
            writeChunkToOPFS(header.transferId, header.index, decryptedData),
          ])
        }
        dc.send(JSON.stringify(ack))
      }
      return
    }

    if (typeof e.data === 'string') {
      try {
        const msg = JSON.parse(e.data)

        if (msg.type === 'ecdh-pub') {
          await setPeerPublicKey(msg.pub)
          ecdhResolvers.get(peerSessionId)?.()
          ecdhResolvers.delete(peerSessionId)
          sendResumeRequests(peerSessionId, dc)
          return
        }

        if (msg.type === 'meta') {
          const meta = msg as MetaMessage
          const peerNodeId = useNetworkStore.getState().peers.find(p => p.sessionId === peerSessionId)?.nodeId ?? 0
          await handleMetaMessage(meta, peerNodeId)
          if (supportsOPFS() && !supportsFileSystemAccess()) {
            createOPFSReceiveFile(meta.transferId, meta.fileName, meta.totalChunks).catch(() => {})
          }
          useNetworkStore.setState(s => ({
            transfers: [...s.transfers, {
              id: meta.transferId, direction: 'recv' as const,
              peerSessionId, peerNodeId,
              fileName: meta.fileName, fileSize: meta.fileSize,
              progress: 0, speedBps: 0, status: 'transferring' as const,
              startedAt: Date.now(),
            }],
          }))
          appendSystemChat(peerSessionId, `正在接收文件 ${meta.fileName}`)
          return
        }

        if (msg.type === 'chunk') {
          lastChunkHeader = msg as ChunkHeader
          return
        }

        if (msg.type === 'resume') {
          const resumeRequest = msg as ResumeRequest
          const file = sendingFiles.get(resumeRequest.transferId)
          const record = await getTransfer(resumeRequest.transferId)
          if (file && record) {
            const peerNodeId = useNetworkStore.getState().peers.find(p => p.sessionId === peerSessionId)?.nodeId ?? 0
            const lanes = await ensureTransferLanes(peerSessionId)
            engineSendFileParallel(lanes, file, resumeRequest.transferId, peerNodeId, record, undefined, resumeRequest.receivedChunks)
              .then(() => sendingFiles.delete(resumeRequest.transferId))
              .catch(() => {})
          }
          return
        }

        if (msg.type === 'chat') {
          const chatMsg: ChannelMessage = {
            id: msg.id || genMsgId(),
            type: 'text',
            content: msg.content || msg.text || '',
            timestamp: msg.timestamp || Date.now(),
            direction: 'recv',
          }
          useNetworkStore.setState(s => {
            const msgs = [...(s.chatMessages[peerSessionId] ?? []), chatMsg]
            const shouldMarkUnread = s.selectedSessionId !== peerSessionId
            const prevUnread = s.unreadByPeer[peerSessionId] ?? { message: 0, file: 0 }
            return {
              chatMessages: { ...s.chatMessages, [peerSessionId]: msgs },
              unreadByPeer: shouldMarkUnread
                ? { ...s.unreadByPeer, [peerSessionId]: { ...prevUnread, message: prevUnread.message + 1 } }
                : s.unreadByPeer,
            }
          })
          // Acknowledge receipt so the sender's UI can show "delivered".
          try { dc.send(JSON.stringify({ type: 'msg-ack', id: msg.id })) } catch { /* ignore */ }
          return
        }

        if (msg.type === 'msg-ack') {
          updateMessageStatus(peerSessionId, msg.id, 'delivered')
          return
        }
      } catch { /* not JSON */ }
    }
  }
}

async function attemptIceRestart(peerSessionId: string) {
  if (iceRestarting.has(peerSessionId)) return
  const attempts = iceRestartAttempts.get(peerSessionId) ?? 0
  if (attempts >= MAX_ICE_RESTART_ATTEMPTS) {
    useNetworkStore.setState(s => ({
      peers: s.peers.map(p =>
        p.sessionId === peerSessionId ? { ...p, status: 'offline' as NodeStatus } : p,
      ),
    }))
    failPendingMessages(peerSessionId)
    appendSystemChat(peerSessionId, '连接已断开，未送达的消息可点击 ↺ 重试')
    return
  }

  iceRestarting.add(peerSessionId)
  iceRestartAttempts.set(peerSessionId, attempts + 1)

  // Exponential backoff: spread out retries so we don't hammer the signaling
  // server when the network is genuinely down.
  const delay = ICE_RESTART_BACKOFF_MS[Math.min(attempts, ICE_RESTART_BACKOFF_MS.length - 1)]
  if (delay > 0) await new Promise(r => setTimeout(r, delay))

  useNetworkStore.setState(s => ({
    peers: s.peers.map(p =>
      p.sessionId === peerSessionId ? { ...p, status: 'reconnecting' as NodeStatus } : p,
    ),
  }))

  try {
    const pc = peerConnections.get(peerSessionId)
    if (!pc || pc.connectionState === 'closed' || pc.connectionState === 'failed') {
      cleanupPeerConnection(peerSessionId)
      await initiateWebRTC(peerSessionId)
      return
    }

    const offer = await pc.createOffer({ iceRestart: true })
    await pc.setLocalDescription(offer)
    // Trickle — candidates will stream via onicecandidate. (Same fix as
    // createOffer/createAnswer: the `{ once: true }` gathering wait could
    // miss the `complete` event and hang the restart forever.)
    wsSend({ t: 'SIGNAL_SDP', targetSessionId: peerSessionId, sdp: pc.localDescription!.toJSON() })
  } catch {
    useNetworkStore.setState(s => ({
      peers: s.peers.map(p =>
        p.sessionId === peerSessionId ? { ...p, status: 'offline' as NodeStatus } : p,
      ),
    }))
  } finally {
    iceRestarting.delete(peerSessionId)
  }
}

async function deliverCompletedFile(transferId: string, peerSessionId: string) {
  if (deliveredTransfers.has(transferId)) return
  deliveredTransfers.add(transferId)

  const handle = getWriteHandle(transferId)
  const opfsHandle = getOPFSHandle(transferId)

  if (handle) {
    try {
      const streamedFile = await finalizeStreamedFile(transferId)
      const url = URL.createObjectURL(streamedFile)
      appendFileChat(peerSessionId, streamedFile.name, streamedFile.size, url)
      playSound('complete')
      cleanupTransferRecord(transferId)
    } catch (err) {
      failTransferRecord(transferId, String(err))
      deliveredTransfers.delete(transferId)
      playSound('error')
    }
  } else if (opfsHandle && opfsHandle.written.size === opfsHandle.totalChunks) {
    try {
      const file = await getOPFSFile(transferId)
      const url = URL.createObjectURL(file)
      appendFileChat(peerSessionId, file.name, file.size, url)
      playSound('complete')
      cleanupTransferRecord(transferId)
      cleanupOPFS(transferId).catch(() => {})
    } catch (err) {
      failTransferRecord(transferId, String(err))
      deliveredTransfers.delete(transferId)
      playSound('error')
      cleanupOPFS(transferId).catch(() => {})
    }
  } else {
    try {
      const assembledFile = await completeReceive(transferId)
      const url = URL.createObjectURL(assembledFile)
      appendFileChat(peerSessionId, assembledFile.name, assembledFile.size, url)
      playSound('complete')
      cleanupTransferRecord(transferId)
    } catch (err) {
      failTransferRecord(transferId, String(err))
      deliveredTransfers.delete(transferId)
      playSound('error')
    }
  }
}

function appendFileChat(peerSessionId: string, fileName: string, fileSize: number, downloadUrl: string) {
  const m: ChannelMessage = {
    id: genMsgId(), type: 'file', content: fileName,
    timestamp: Date.now(), direction: 'recv',
    fileName, fileSize, downloadUrl,
  }
  useNetworkStore.setState(s => {
    const msgs = [...(s.chatMessages[peerSessionId] ?? []), m]
    const shouldMarkUnread = s.selectedSessionId !== peerSessionId
    const prevUnread = s.unreadByPeer[peerSessionId] ?? { message: 0, file: 0 }
    return {
      chatMessages: { ...s.chatMessages, [peerSessionId]: msgs },
      unreadByPeer: shouldMarkUnread
        ? { ...s.unreadByPeer, [peerSessionId]: { ...prevUnread, file: prevUnread.file + 1 } }
        : s.unreadByPeer,
    }
  })
  const peerNodeId = useNetworkStore.getState().peers.find(p => p.sessionId === peerSessionId)?.nodeId
  notifyIncomingFile({ peerNodeId, fileName, fileSize })
}

function cleanupTransferRecord(transferId: string) {
  transferSpeedSamples.delete(transferId)
  import('@/lib/db').then(({ deleteChunks }) => deleteChunks(transferId).catch(() => {}))
  useNetworkStore.setState(s => ({
    transfers: s.transfers.map(t =>
      t.id === transferId ? { ...t, progress: 1, status: 'completed' as const } : t,
    ),
  }))
}

function failTransferRecord(transferId: string, error: string) {
  transferSpeedSamples.delete(transferId)
  useNetworkStore.setState(s => ({
    transfers: s.transfers.map(t =>
      t.id === transferId ? { ...t, status: 'failed' as const, error } : t,
    ),
  }))
}

async function sendResumeRequests(peerSessionId: string, dc: RTCDataChannel) {
  if (dc.label.startsWith('misaka-transfer-')) return
  const active = await getActiveTransfers()
  const peerNodeId = useNetworkStore.getState().peers.find(p => p.sessionId === peerSessionId)?.nodeId ?? 0
  for (const record of active) {
    if (record.direction === 'recv' && record.peerNodeId === peerNodeId) {
      const req = await buildResumeRequest(record.transferId)
      if (req && dc.readyState === 'open') dc.send(JSON.stringify(req))
    }
  }
}

function cleanupPeerConnection(sessionId: string) {
  failPendingMessages(sessionId)
  iceRestartAttempts.delete(sessionId)
  iceRestarting.delete(sessionId)
  clearDisconnectedTimer(sessionId)
  const dc = dataChannels.get(sessionId)
  if (dc) { dc.close(); dataChannels.delete(sessionId) }
  const lanes = transferLanes.get(sessionId)
  if (lanes) {
    for (const lane of lanes) lane.close()
    transferLanes.delete(sessionId)
  }
  const pc = peerConnections.get(sessionId)
  if (pc) { pc.close(); peerConnections.delete(sessionId) }
  ecdhResolvers.delete(sessionId)
  pendingIceCandidates.delete(sessionId)
}
