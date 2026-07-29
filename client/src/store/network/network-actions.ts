/**
 * network-actions.ts — Zustand action surface for composition in runtime.
 * Pure restructuring: methods moved out of create() for a slim composition root.
 */

import type { ChannelMessage } from '@/types'
import { send as wsSend } from '@/lib/signaling'
import {
  buildResumeRequest,
  pauseTransfer, resumeTransfer, cancelTransfer as engineCancelTransfer,
  decodeResumeRequest,
  TransferCancelledError,
  abortInboundTransfer,
  buildRepairRequest,
  forgetTransfer,
  awaitSendEngineSettlement,
  getReceiveSession,
} from '@/lib/transfer'
import { notifyActiveWorkChanged } from '@/hooks/activeWork'
import { getTransfer } from '@/lib/db'
import type { NetworkState } from './contracts'
import {
  PartialFanoutError,
  TransferResumeError,
} from './contracts'
import {
  ORPHANED_DOWNLOADS_CHAT_KEY,
  retireDownloadArtifact,
  isDownloadArtifactStarted,
} from './download-artifacts'
import { storeSet } from './store-access'
import {
  seenInboundChatIds,
  appendSystemChat,
  sendChatMessage as chatSendMessage,
  retryChatMessage as chatRetryMessage,
} from './chat-controller'
import {
  sendingFiles,
  transferSpeedSamples,
  transferDelivery,
  sendFileToPeer,
  checkResumePreconditions,
  runSendEngine,
  failTransferRecord,
} from './transfer-controller'
import {
  recoverConnections as recoverConnectionsImpl,
} from './connectivity-controller'
import {
  initialEncryptedSessionRebuilds,
} from './ice-recovery'
import {
  dataChannels,
  peerGeneration,
  isPeerGenerationAttemptCurrent,
  ensureTransferLanes,
  initiateWebRTC,
  cleanupPeerConnection,
  type PeerGenerationAttempt,
} from './peer-runtime'
import {
  networkEpoch,
  ownerFor,
} from './session-scope'
import { pruneChatMessages } from './runtime-helpers'

export function buildNetworkActions(
  set: (partial: Partial<NetworkState> | ((s: NetworkState) => Partial<NetworkState> | NetworkState)) => void,
  get: () => NetworkState,
): Omit<NetworkState, keyof import('./contracts').NetworkStateSlices | 'init' | 'destroy'> {
  return {
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
      // Chromium does not promise a traversal order for webkitdirectory.
      // Normalise folder batches by relative path so the queue, transfer
      // cards and receiver artifacts have a stable order. Preserve the
      // user's picker order for ordinary multi-file batches.
      const orderedFiles = files.some(file =>
        Boolean((file as File & { webkitRelativePath?: string }).webkitRelativePath),
      )
        ? [...files].sort((a, b) => {
            const aPath = (a as File & { webkitRelativePath?: string }).webkitRelativePath || a.name
            const bPath = (b as File & { webkitRelativePath?: string }).webkitRelativePath || b.name
            return aPath.localeCompare(bPath)
          })
        : files
      const incoming = orderedFiles.map(file => ({
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
    // Guard against double-click / spam: if a send is already in flight for
    // this peer, drop the second call. Previously the second click re-queued
    // the same items (they're only removed after `allOk`), producing
    // duplicate transfers.
    if (get().sendingPeers.has(sessionId)) return
    set(s => {
      const next = new Set(s.sendingPeers)
      next.add(sessionId)
      return { sendingPeers: next }
    })
    // BUG-021: remember exactly WHICH staged ids succeeded. The old code
    // snapshotted `items` at entry and, on `allOk`, deleted the whole
    // `pendingFiles[sessionId]` bucket — so anything the user added while the
    // snapshot was in flight was silently destroyed without ever being sent.
    const sentIds: string[] = []
    try {
      for (const item of items) {
        const ok = await sendFileToPeer(item.file, sessionId, item.displayName)
        if (ok) sentIds.push(item.id)
      }
    } finally {
      set(s => {
        const next = new Set(s.sendingPeers)
        next.delete(sessionId)
        return { sendingPeers: next }
      })
    }
    if (sentIds.length > 0) {
      const done = new Set(sentIds)
      set(s => {
        const remaining = (s.pendingFiles[sessionId] ?? []).filter(item => !done.has(item.id))
        if (remaining.length === 0) {
          const { [sessionId]: _drop, ...rest } = s.pendingFiles
          return { pendingFiles: rest }
        }
        return { pendingFiles: { ...s.pendingFiles, [sessionId]: remaining } }
      })
    }
    // Failures (and anything staged mid-flight) stay put so the user can retry.
  },

  async sendFile(file) {
    const sid = get().selectedSessionId
    if (!sid) throw new Error('未选择目标节点')
    await sendFileToPeer(file, sid)
  },

  async sendFilesToAll(files) {
    const targets = get().peers.filter(p => p.status !== 'offline').map(p => p.sessionId)
    if (targets.length === 0) throw new Error('没有可用的目标节点')
    // BUG-020: a fanout used to `allSettled` and discard every result, so a
    // broadcast where every peer failed looked identical to one where every
    // peer succeeded. Keep the per-(peer, file) outcome and surface a partial
    // success to the caller.
    const jobs = targets.flatMap(sid => files.map(file => ({ sid, file })))
    // Recipients may run in parallel, but each recipient observes the file
    // picker order. A flat Promise.all raced same-recipient files and let a
    // smaller later file arrive first (or hide a dropped/duplicated sibling).
    const failures = (await Promise.all(targets.map(async sid => {
      const peerFailures: Array<{ sid: string; file: File }> = []
      for (const file of files) {
        try {
          if (!await sendFileToPeer(file, sid)) peerFailures.push({ sid, file })
        } catch {
          peerFailures.push({ sid, file })
        }
      }
      return peerFailures
    }))).flat()
    if (failures.length === jobs.length) {
      throw new Error(`群发失败：${jobs.length} 个目标全部未送达`)
    }
    if (failures.length > 0) {
      const peers = new Set(failures.map(f => f.sid))
      throw new PartialFanoutError(
        `部分节点未送达：${failures.length}/${jobs.length} 个任务失败（${peers.size} 个节点）`,
        failures.map(f => ({ peerSessionId: f.sid, fileName: f.file.name })),
      )
    }
  },

  sendChatMessage(peerSessionId, text) {
    chatSendMessage(peerSessionId, text)
  },

  retryChatMessage(peerSessionId, msgId) {
    chatRetryMessage(peerSessionId, msgId)
  },

  blockPeer(sessionId) {
    wsSend({ t: 'BLOCK', sessionId })
    // Started downloads must keep a visible owner with a release path —
    // deleting the chat card is what orphaned OPFS/object-URL artefacts.
    const msgs = get().chatMessages[sessionId] ?? []
    const keepForDownload: ChannelMessage[] = []
    for (const m of msgs) {
      if (m.downloadUrl) {
        if (isDownloadArtifactStarted(m.downloadUrl)) {
          keepForDownload.push(m)
          continue
        }
        retireDownloadArtifact(m.downloadUrl)
      }
    }
    set(s => {
      const rest = { ...s.chatMessages }
      delete rest[sessionId]
      if (keepForDownload.length > 0) {
        const prior = rest[ORPHANED_DOWNLOADS_CHAT_KEY] ?? []
        rest[ORPHANED_DOWNLOADS_CHAT_KEY] = pruneChatMessages([...prior, ...keepForDownload])
      }
      return {
        peers: s.peers.filter(p => p.sessionId !== sessionId),
        chatMessages: rest,
        selectedSessionId: s.selectedSessionId === sessionId ? null : s.selectedSessionId,
      }
    })
    seenInboundChatIds.delete(sessionId)
    // Finding 2 (13th independent review): a local teardown must retire the
    // one-shot encrypted-session-rebuild guard along with everything else —
    // `cleanupPeerConnection` bumps the peer generation (which correctly
    // fails any in-flight rebuild's later checks) but deliberately never
    // touches this set itself, because the rebuild branch above adds to it
    // and THEN calls `cleanupPeerConnection` as part of arming its own
    // one-shot attempt; clearing it inside `cleanupPeerConnection` would
    // erase that guard the instant it was set. So every OTHER teardown path
    // (PEER_LEFT, reconnectPeer, and this one) clears it explicitly instead.
    // Without this, a stale guard survives a block and a later
    // rejoin/unblock under the same sessionId could never arm recovery
    // again.
    initialEncryptedSessionRebuilds.delete(sessionId)
    cleanupPeerConnection(sessionId)
  },

  recoverConnections() {
    recoverConnectionsImpl()
  },

  pauseTransfer(transferId) {
    pauseTransfer(transferId)
    set(s => ({
      transfers: s.transfers.map(t => t.id === transferId ? { ...t, status: 'paused' as const } : t),
    }))
    // Receiver-driven pause: tell the sender to stop. Chunks already inside
    // the SCTP queue keep arriving for a moment and are recorded (not just
    // dropped) by `receiveChunk` so `buildRepairRequest` can ask for them back
    // on resume — see BUG-013 and the resume path below.
    const t = get().transfers.find(tr => tr.id === transferId)
    if (t && t.direction === 'recv') {
      const dc = dataChannels.get(t.peerSessionId)
      if (dc?.readyState === 'open') {
        try { dc.send(JSON.stringify({ type: 'transfer-pause', transferId })) } catch { /* ignore */ }
      }
    }
  },

  async resumeTransfer(transferId, peerSessionId) {
    const t = get().transfers.find(tr => tr.id === transferId)
    // BUG-019: a failed transfer's Retry used to flip the card to
    // "transferring" and then silently return when the source file, the DB
    // record or the DataChannel was gone. Validate every precondition BEFORE
    // touching the status, and surface a structured failure otherwise.
    const precondition = await checkResumePreconditions(transferId, peerSessionId, t)
    if (!precondition.ok) {
      failTransferRecord(transferId, precondition.message)
      appendSystemChat(peerSessionId, `无法继续传输：${precondition.message}`)
      throw new TransferResumeError(precondition.code, precondition.message)
    }

    // Commit UI to transferring only after control frames / engine take-over
    // succeed. A failed send must restore paused/failed, not leave a fake card.
    if (t && t.direction === 'recv') {
      const dc = dataChannels.get(peerSessionId)
      if (!dc || dc.readyState !== 'open') {
        failTransferRecord(transferId, '与该节点的数据信道尚未就绪')
        throw new TransferResumeError('channel-unavailable', '与该节点的数据信道尚未就绪')
      }
      try {
        dc.send(JSON.stringify({ type: 'transfer-resume', transferId }))
        const repair = buildRepairRequest(transferId)
        if (repair) dc.send(JSON.stringify(repair))
      } catch (err) {
        failTransferRecord(transferId, '恢复控制帧发送失败')
        throw new TransferResumeError(
          'channel-unavailable',
          err instanceof Error ? err.message : '恢复控制帧发送失败',
        )
      }
      resumeTransfer(transferId)
      set(s => ({
        transfers: s.transfers.map(tr => tr.id === transferId ? { ...tr, status: 'transferring' as const } : tr),
      }))
      return
    }

    // Send side. `engineSendFileParallel` wakes the LIVE task when one exists
    // (BUG-014) and only starts a fresh engine when the previous one has fully
    // settled, so this can no longer produce two engines for one id.
    const owner = ownerFor(peerSessionId)
    const file = sendingFiles.get(transferId)!
    const record = await getTransfer(transferId)
    const request = await buildResumeRequest(transferId, owner)
    const peerNodeId = get().peers.find(p => p.sessionId === peerSessionId)?.nodeId ?? 0
    const lanes = await ensureTransferLanes(peerSessionId)
    const peerBitmap = request && record ? decodeResumeRequest(request, record.totalChunks) : undefined
    resumeTransfer(transferId)
    set(s => ({
      transfers: s.transfers.map(tr => tr.id === transferId ? { ...tr, status: 'transferring' as const } : tr),
    }))
    try {
      await runSendEngine(lanes, file, transferId, peerNodeId, peerSessionId, record, peerBitmap, owner)
    } catch (err) {
      if (err instanceof TransferCancelledError) throw err
      failTransferRecord(transferId, err instanceof Error ? err.message : String(err))
      throw err
    }
  },

  cancelTransferAction(transferId) {
    // Tell the other side to stop before we tear our own state down — once we
    // drop the receive session / sending file, a late notice is a no-op on
    // our side but the peer still needs to know.
    const t = get().transfers.find(tr => tr.id === transferId)
    const peerSessionId = t?.peerSessionId
    if (peerSessionId) {
      const dc = dataChannels.get(peerSessionId)
      if (dc?.readyState === 'open') {
        try { dc.send(JSON.stringify({ type: 'transfer-cancel', transferId })) } catch { /* ignore */ }
      }
    }
    // Signal only — keep task + owner + cancel flag alive until the live
    // engine settles. abortInboundTransfer is receive-side only and must not
    // delete the shared signal while a send engine is still parked in
    // slice/encrypt/backpressure.
    engineCancelTransfer(transferId)
    set(s => ({ transfers: s.transfers.filter(tr => tr.id !== transferId) }))
    transferSpeedSamples.delete(transferId)
    transferDelivery.delete(transferId)
    notifyActiveWorkChanged()

    void (async () => {
      const notify = (msg: object) => {
        if (!peerSessionId) return
        const dc = dataChannels.get(peerSessionId)
        if (dc?.readyState === 'open') {
          try { dc.send(JSON.stringify(msg)) } catch { /* ignore */ }
        }
      }
      // Inbound abort only when we actually have a receive session; pure
      // send-only cancel must leave the cancel signal until the engine exits.
      if (getReceiveSession(transferId)) {
        await abortInboundTransfer(transferId, 'local-cancel', notify)
      } else {
        notify({ type: 'transfer-cancel', transferId })
      }
      // Wait for the engine to acknowledge cancel. Never force-forget on a
      // wall-clock deadline while the engine is still live — that would clear
      // the cancel flag and let a late encrypt/backpressure wait resume and
      // transmit cancelled data. A wedged engine is neutralised instead.
      await awaitSendEngineSettlement(transferId)
      sendingFiles.delete(transferId)
      forgetTransfer(transferId)
      notifyActiveWorkChanged()
    })()
  },

  pauseReceiveTransfer(transferId) {
    get().pauseTransfer(transferId)
  },

  async resumeReceiveTransfer(transferId) {
    const t = get().transfers.find(tr => tr.id === transferId)
    // BUG-019: a missing transfer is a real failure, not a silent no-op — the
    // caller has a button that must report why nothing happened.
    if (!t) throw new TransferResumeError('unknown-transfer', '该传输记录已不存在')
    await get().resumeTransfer(transferId, t.peerSessionId)
  },

  cancelReceiveTransfer(transferId) {
    get().cancelTransferAction(transferId)
  },

  async reconnectPeer(sessionId) {
    const epoch = networkEpoch
    initialEncryptedSessionRebuilds.delete(sessionId)
    // Tear the dead PC down explicitly — recoverConnections() rate-limits to
    // 1.5s and may no-op if the user is mashing the button. This path is
    // explicit user intent, so bypass the throttle for this specific peer.
    cleanupPeerConnection(sessionId, { failQueuedMessages: false })
    storeSet(s => ({
      peers: s.peers.map(p =>
        p.sessionId === sessionId ? { ...p, status: 'connecting' as const } : p,
      ),
    }))
    const task = initiateWebRTC(sessionId)
    const attempt: PeerGenerationAttempt = {
      peerSessionId: sessionId,
      epoch,
      gen: peerGeneration(sessionId),
    }
    try {
      await task
    } catch (err) {
      if (!isPeerGenerationAttemptCurrent(attempt)) return
      console.warn('[net] reconnectPeer failed', err)
      storeSet(s => {
        if (!isPeerGenerationAttemptCurrent(attempt)) return s
        return {
          peers: s.peers.map(p =>
            p.sessionId === sessionId ? { ...p, status: 'offline' as const } : p,
          ),
        }
      })
    }
  },
  }
}
