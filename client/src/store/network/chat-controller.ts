/**
 * chat-controller.ts — outgoing queue, ack, unread, send/retry.
 *
 * Ports: deps.ensureConnected (breaks chat → peer-runtime cycle).
 * Store access: store-access only (no useNetworkStore).
 */

import type { ChannelMessage, MessageStatus } from '@/types'
import { storeGet, storeSet } from './store-access'
import { deps } from './deps'
import type { FlushResult } from './contracts'
import { selectPrunedChatMessages } from './selectors'
import { retireDownloadUrls } from './download-artifacts'

function pruneChatMessages(msgs: ChannelMessage[]): ChannelMessage[] {
  const { kept, retiredUrls } = selectPrunedChatMessages(msgs)
  retireDownloadUrls(retiredUrls)
  return kept
}

export type { FlushResult }

interface OutgoingItem { payload: string; msgId?: string }

/** Cleanup owner: failPendingMessages / cleanupPeerConnection */
export const outgoingQueue = new Map<string, OutgoingItem[]>()
export const queuedMessageIds = new Map<string, Set<string>>()
/** Cleanup owner: endNetworkEpoch / PEER_LEFT (OPEN: incomplete paths) */
export const seenInboundChatIds = new Map<string, Set<string>>()
const MAX_SEEN_CHAT_IDS = 500

export function noteInboundChatId(peerSessionId: string, msgId: string): boolean {
  let set = seenInboundChatIds.get(peerSessionId)
  if (!set) {
    set = new Set()
    seenInboundChatIds.set(peerSessionId, set)
  }
  if (set.has(msgId)) return false
  set.add(msgId)
  if (set.size > MAX_SEEN_CHAT_IDS) {
    // Drop oldest-ish by rebuilding from the tail of insertion order.
    const keep = [...set].slice(-Math.floor(MAX_SEEN_CHAT_IDS / 2))
    seenInboundChatIds.set(peerSessionId, new Set(keep))
  }
  return true
}


/** Remove a queued outbound chat copy (open-channel retry must not leave a twin). */
export function removeQueuedMessage(peerSessionId: string, msgId: string): void {
  const q = outgoingQueue.get(peerSessionId)
  if (q) {
    const next = q.filter(item => item.msgId !== msgId)
    if (next.length > 0) outgoingQueue.set(peerSessionId, next)
    else outgoingQueue.delete(peerSessionId)
  }
  const ids = queuedMessageIds.get(peerSessionId)
  if (ids) {
    ids.delete(msgId)
    if (ids.size === 0) queuedMessageIds.delete(peerSessionId)
  }
}


export function queueOutgoing(peerSessionId: string, payload: string, msgId?: string) {
  const q = outgoingQueue.get(peerSessionId) ?? []
  // Replace an existing entry with the same msgId so retry cannot deliver
  // the same chat message twice after the channel reopens.
  if (msgId) {
    const idx = q.findIndex(item => item.msgId === msgId)
    if (idx >= 0) {
      q[idx] = { payload, msgId }
      outgoingQueue.set(peerSessionId, q)
      return
    }
  }
  q.push({ payload, msgId })
  outgoingQueue.set(peerSessionId, q)
  if (msgId) {
    const ids = queuedMessageIds.get(peerSessionId) ?? new Set<string>()
    ids.add(msgId)
    queuedMessageIds.set(peerSessionId, ids)
  }
}


/**
 * BUG-020: the flush used to `try { dc.send(p) } catch { /* ignore *​/ }` every
 * queued payload, then unconditionally delete the queue and mark EVERY queued
 * id as 'sent'. A channel that closed mid-flush therefore reported success for
 * messages that never left the tab, and the payloads were gone — no retry set,
 * no failure surfaced.
 *
 * Now each payload is tracked individually: only what actually reached
 * `dc.send()` is removed and marked 'sent'; the rest stay queued and are
 * marked 'failed' so the ↺ affordance is truthful.
 */
export function flushOutgoing(peerSessionId: string, dc: RTCDataChannel): FlushResult {
  const result: FlushResult = { sent: [], failed: [] }
  const q = outgoingQueue.get(peerSessionId)
  if (!q?.length) return result

  const remaining: OutgoingItem[] = []
  for (const item of q) {
    if (dc.readyState !== 'open') {
      remaining.push(item)
      if (item.msgId) result.failed.push(item.msgId)
      continue
    }
    try {
      dc.send(item.payload)
      if (item.msgId) result.sent.push(item.msgId)
    } catch {
      remaining.push(item)
      if (item.msgId) result.failed.push(item.msgId)
    }
  }

  if (remaining.length > 0) outgoingQueue.set(peerSessionId, remaining)
  else outgoingQueue.delete(peerSessionId)

  const ids = queuedMessageIds.get(peerSessionId)
  if (ids) {
    for (const id of result.sent) { updateMessageStatus(peerSessionId, id, 'sent'); ids.delete(id) }
    for (const id of result.failed) updateMessageStatus(peerSessionId, id, 'failed')
    if (ids.size === 0) queuedMessageIds.delete(peerSessionId)
  }
  return result
}


export function updateMessageStatus(peerSessionId: string, msgId: string, status: MessageStatus) {
  storeSet(s => ({
    chatMessages: {
      ...s.chatMessages,
      [peerSessionId]: (s.chatMessages[peerSessionId] ?? []).map(m =>
        m.id === msgId ? { ...m, status } : m,
      ),
    },
  }))
}


// Mark queued messages as failed (e.g. peer went offline before DC opened).
export function failPendingMessages(peerSessionId: string) {
  const ids = queuedMessageIds.get(peerSessionId)
  if (!ids?.size) return
  for (const id of ids) updateMessageStatus(peerSessionId, id, 'failed')
  queuedMessageIds.delete(peerSessionId)
  outgoingQueue.delete(peerSessionId)
}


export function startQueuedDelivery(peerSessionId: string) {
  deps.ensureConnected(peerSessionId)
    .then(dc => flushOutgoing(peerSessionId, dc))
    .catch(() => failPendingMessages(peerSessionId))
}


export function genMsgId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}


export function appendSystemChat(peerSessionId: string, content: string, direction: 'sent' | 'recv' | 'system' = 'system') {
  const m: ChannelMessage = { id: genMsgId(), type: 'system', content, timestamp: Date.now(), direction }
  storeSet(s => {
    const msgs = pruneChatMessages([...(s.chatMessages[peerSessionId] ?? []), m])
    return { chatMessages: { ...s.chatMessages, [peerSessionId]: msgs } }
  })
}


export function appendFileChat(peerSessionId: string, fileName: string, fileSize: number, downloadUrl: string) {
  const m: ChannelMessage = {
    id: genMsgId(), type: 'file', content: fileName,
    timestamp: Date.now(), direction: 'recv',
    fileName, fileSize, downloadUrl,
  }
  storeSet(s => {
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
  // Nit fix: notifyIncomingFile already fired at transfer start (meta handler
  // line ~1258). Firing it again on completion produced two OS toasts per
  // received file. The start-of-transfer toast is the user-actionable one
  // ("decline before the big upload arrives") — the completion is signalled
  // visually by the file card itself.
}

export function sendChatMessage(peerSessionId: string, text: string) {
  const CHAT_MAX_BYTES = 16 * 1024
  const trimmedText = text.length > CHAT_MAX_BYTES ? text.slice(0, CHAT_MAX_BYTES) : text
  const msg: ChannelMessage = {
    id: genMsgId(), type: 'text', content: trimmedText, timestamp: Date.now(),
    direction: 'sent', status: 'sending',
  }
  storeSet(s => ({
    chatMessages: { ...s.chatMessages, [peerSessionId]: [...(s.chatMessages[peerSessionId] ?? []), msg] },
  }))
  const payload = JSON.stringify({ type: 'chat', id: msg.id, content: msg.content, timestamp: msg.timestamp })
  const dc = deps.dataChannels.get(peerSessionId)
  if (dc?.readyState === 'open') {
    try {
      dc.send(payload)
      updateMessageStatus(peerSessionId, msg.id, 'sent')
    } catch {
      updateMessageStatus(peerSessionId, msg.id, 'failed')
    }
  } else {
    queueOutgoing(peerSessionId, payload, msg.id)
    startQueuedDelivery(peerSessionId)
  }
}

export function retryChatMessage(peerSessionId: string, msgId: string) {
  const msg = storeGet().chatMessages[peerSessionId]?.find(m => m.id === msgId)
  if (!msg || msg.type !== 'text') return
  removeQueuedMessage(peerSessionId, msgId)
  updateMessageStatus(peerSessionId, msgId, 'sending')
  const payload = JSON.stringify({ type: 'chat', id: msg.id, content: msg.content, timestamp: msg.timestamp })
  const dc = deps.dataChannels.get(peerSessionId)
  if (dc?.readyState === 'open') {
    try {
      dc.send(payload)
      updateMessageStatus(peerSessionId, msgId, 'sent')
    } catch {
      updateMessageStatus(peerSessionId, msgId, 'failed')
      queueOutgoing(peerSessionId, payload, msgId)
      startQueuedDelivery(peerSessionId)
    }
  } else {
    queueOutgoing(peerSessionId, payload, msgId)
    startQueuedDelivery(peerSessionId)
  }
}

export function handleChat(peerSessionId: string, msg: Record<string, unknown>, dc: RTCDataChannel) {
  const rawContent = String(msg.content ?? msg.text ?? '')
  const content = rawContent.length > 16 * 1024 ? rawContent.slice(0, 16 * 1024) : rawContent
  const chatId = String(msg.id || genMsgId())
  if (msg.id && !noteInboundChatId(peerSessionId, chatId)) {
    try { dc.send(JSON.stringify({ type: 'msg-ack', id: msg.id })) } catch { /* ignore */ }
    return
  }
  const chatMsg: ChannelMessage = {
    id: chatId, type: 'text', content,
    timestamp: typeof msg.timestamp === 'number' ? msg.timestamp : Date.now(),
    direction: 'recv',
  }
  storeSet(s => {
    const msgs = pruneChatMessages([...(s.chatMessages[peerSessionId] ?? []), chatMsg])
    const shouldMarkUnread = s.selectedSessionId !== peerSessionId
    const prevUnread = s.unreadByPeer[peerSessionId] ?? { message: 0, file: 0 }
    return {
      chatMessages: { ...s.chatMessages, [peerSessionId]: msgs },
      unreadByPeer: shouldMarkUnread
        ? { ...s.unreadByPeer, [peerSessionId]: { ...prevUnread, message: prevUnread.message + 1 } }
        : s.unreadByPeer,
    }
  })
  try { dc.send(JSON.stringify({ type: 'msg-ack', id: msg.id })) } catch { /* ignore */ }
}

export function handleMsgAck(peerSessionId: string, msgId: string) {
  updateMessageStatus(peerSessionId, msgId, 'delivered')
}

export function clearPeerChatState(sessionId: string) {
  failPendingMessages(sessionId)
  seenInboundChatIds.delete(sessionId)
  outgoingQueue.delete(sessionId)
  queuedMessageIds.delete(sessionId)
}

export function clearAllChatState() {
  outgoingQueue.clear()
  queuedMessageIds.clear()
  seenInboundChatIds.clear()
}
