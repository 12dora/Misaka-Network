/**
 * data-channel-router.ts — label whitelist, binary/string parse, typed dispatch.
 */
import {
  receiveChunk, decodeChunkFrame,
  makeHelloMessage, setPeerProtocolVersion,
  abortInboundTransfer,
  applyRepairRequest, markReceiverReady, markReceiverRejected,
  markTransferAcked, getSendTaskInfo,
  applyPeerPause, applyPeerResume, applyPeerCancel,
  forgetTransfer, getReceiveSession, awaitSendEngineSettlement,
  type ResumeRequest,
} from '@/lib/transfer'
import { getMyPublicKey, setPeerPublicKey, hasAESKey } from '@/lib/crypto'
import { playSound } from '@/lib/sound'
import { storeGet, storeSet } from './store-access'
import { deps } from './deps'

// Extra maps bound at composition time (not all on NetworkDeps type yet).
const x = deps as typeof deps & {
  configuredDataChannels: WeakSet<RTCDataChannel>
  ecdhResolvers: Map<string, { generation: number; timer: ReturnType<typeof setTimeout>; resolve: () => void; reject: (e: Error) => void }>
  initialEncryptedSessionRebuilds: Set<string>
}
import { handleChat, handleMsgAck, flushOutgoing, appendSystemChat } from './chat-controller'
import {
  EMPTY_CIPHERTEXT, shortIdToTransferId, transferSpeedSamples, transferDelivery,
  sendingFiles, handleIncomingMeta, handleResumeRequest, reenterSendTaskForRepair,
  deliverCompletedFile, failTransferRecord, flushPendingDurableAcks, sendResumeRequests,
} from './transfer-controller'

interface PeerConnectionAttempt {
  peerSessionId: string
  epoch: number
  gen: number
  pc: RTCPeerConnection
}


export function setupDataChannel(dc: RTCDataChannel, attempt: PeerConnectionAttempt) {
  const { pc, peerSessionId } = attempt
  // Idempotency guard: in reconnect races the same channel instance may flow
  // through setup twice; avoid duplicate listeners / duplicate side effects.
  if (x.configuredDataChannels.has(dc)) return
  x.configuredDataChannels.add(dc)
  const isTransferLane = dc.label.startsWith('misaka-transfer-')
  const stillCurrent = () => {
    if (!deps.isPeerConnectionAttemptCurrent(attempt)) return false
    return isTransferLane
      ? (deps.transferLanes.get(peerSessionId)?.includes(dc) ?? false)
      : deps.dataChannels.get(peerSessionId) === dc
  }
  let recoveryNoticePending = false

  const publishEncryptedReady = () => {
    if (!stillCurrent() || !hasAESKey(peerSessionId)) return false
    x.initialEncryptedSessionRebuilds.delete(peerSessionId)
    deps.clearInitialIceRecovery(peerSessionId)
    storeSet(s => {
      if (!stillCurrent() || !hasAESKey(peerSessionId)) return s
      return {
        peers: s.peers.map(p =>
          p.sessionId === peerSessionId ? { ...p, status: 'online' as const } : p,
        ),
        connectedPeers: new Set([...s.connectedPeers, peerSessionId]),
      }
    })
    if (recoveryNoticePending) {
      recoveryNoticePending = false
      appendSystemChat(peerSessionId, '✓ 连接已恢复')
    }
    return true
  }

  // Without this, incoming chunk bodies arrive as Blob and the
  // `instanceof ArrayBuffer` check below skips them silently.
  dc.binaryType = 'arraybuffer'

  dc.onclose = () => {
    if (!stillCurrent()) return
    if (dc.readyState === 'closed') {
      if (pc.connectionState !== 'closed') {
        deps.attemptIceRestart(peerSessionId)
      }
    }
  }

  const handleOpen = async () => {
    if (!stillCurrent()) return
    // Show reconnection notice if there was prior chat activity.
    const prevMsgs = storeGet().chatMessages[peerSessionId] ?? []
    const isReconnect = prevMsgs.some(m => m.type !== 'system')
    if (!isTransferLane) {
      recoveryNoticePending = isReconnect
      storeSet(s => {
        if (!stillCurrent()) return s
        const connectedPeers = new Set(s.connectedPeers)
        if (!hasAESKey(peerSessionId)) connectedPeers.delete(peerSessionId)
        return {
          peers: s.peers.map(p =>
            p.sessionId === peerSessionId
              ? { ...p, status: hasAESKey(peerSessionId) ? 'online' as const : 'connecting' as const }
              : p,
          ),
          connectedPeers,
        }
      })
      publishEncryptedReady()
      try {
        // Protocol handshake first: `hello` tells the peer which delivery
        // semantics we implement. A v1 peer ignores the unknown message and
        // both sides fall back to v1 (see negotiatedProtocolVersion).
        dc.send(makeHelloMessage())
      } catch { /* channel may already be dying */ }
      try {
        const pub = await getMyPublicKey(peerSessionId)
        if (!stillCurrent()) return
        dc.send(JSON.stringify({ type: 'ecdh-pub', pub }))
      } catch (err) {
        console.warn('[net] ecdh-pub send failed', err)
      }
      if (hasAESKey(peerSessionId)) flushOutgoing(peerSessionId, dc)
    }
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
    // Freeze attempt identity at receipt. Continuations after await must not
    // publish UI into a newer epoch/session (cross-identity data exposure).
    const receiptEpoch = deps.getNetworkEpoch()
    const receiptGen = deps.peerGeneration(peerSessionId)
    const receiptPc = deps.peerConnections.get(peerSessionId)
    const receiptDc = dc
    const stillThisAttempt = () => {
      if (
        !stillCurrent()
        || deps.getNetworkEpoch() !== receiptEpoch
        || deps.peerGeneration(peerSessionId) !== receiptGen
        || deps.peerConnections.get(peerSessionId) !== receiptPc
      ) return false
      // Primary lives in deps.dataChannels; transfer lanes live in deps.transferLanes.
      // Identity check must accept either — otherwise every lane meta/chunk
      // is silently dropped (showstopper for multi-lane transfer).
      if (deps.dataChannels.get(peerSessionId) === receiptDc) return true
      const lanes = deps.transferLanes.get(peerSessionId)
      return !!lanes && lanes.includes(receiptDc)
    }
    if (!stillThisAttempt()) return
    const owner = deps.ownerFor(peerSessionId)
    if (e.data instanceof ArrayBuffer) {
      const frame = decodeChunkFrame(e.data)
      if (!frame) return
      const transferId = shortIdToTransferId.get(peerSessionId)?.get(frame.shortId)
      if (!transferId) return  // meta hasn't arrived yet, or transfer was cleaned up

      try {
        // Zero-copy path: never evaluate frame.ciphertext (lazy getter runs
        // ArrayBuffer.slice on the main thread). Pass a zero-length stand-in;
        // receiveChunk uses rawFrame + offsets when frameView is supplied.
        const result = await receiveChunk(
          transferId, frame.index, frame.iv, EMPTY_CIPHERTEXT, peerSessionId,
          {
            onProgress(received, total) {
              if (!stillThisAttempt()) return
              const now = performance.now()
              const transfer = storeGet().transfers.find(t => t.id === transferId)
              const fileSize = transfer?.fileSize ?? 0
              const bytes = fileSize > 0 ? Math.min(fileSize, Math.round((received / total) * fileSize)) : 0
              const prev = transferSpeedSamples.get(transferId) ?? { bytes: 0, at: now }
              const elapsed = Math.max(1, now - prev.at)
              const speedBps = now === prev.at ? 0 : ((bytes - prev.bytes) * 1000) / elapsed
              transferSpeedSamples.set(transferId, { bytes, at: now })
              storeSet(s => ({
                transfers: s.transfers.map(t =>
                  t.id === transferId
                    ? {
                        ...t,
                        progress: received / total,
                        speedBps,
                        status: t.status === 'paused' ? 'paused' as const : 'transferring' as const,
                      }
                    : t,
                ),
              }))
            },
            onError(error) {
              if (!stillThisAttempt()) return
              storeSet(s => ({
                transfers: s.transfers.map(t =>
                  t.id === transferId ? { ...t, status: 'failed' as const, error } : t,
                ),
              }))
            },
          },
          {
            rawFrame: frame.rawFrame,
            ivOffset: frame.ivOffset,
            cipherOffset: frame.cipherOffset,
            cipherLength: frame.cipherLength,
          },
        )

        if (!stillThisAttempt()) {
          // Stale continuation: only clean up what this exact owner created.
          return
        }
        if (result?.done) await deliverCompletedFile(transferId, peerSessionId)
      } catch (err) {
        if (!stillThisAttempt()) return
        const errStr = err instanceof Error ? err.message : String(err)
        console.warn('[net] receiveChunk failed', errStr)
        playSound('error')
        appendSystemChat(peerSessionId, `接收失败：${errStr}`)
        await abortInboundTransfer(transferId, errStr, (msg) => {
          if (receiptDc.readyState === 'open') {
            try { receiptDc.send(JSON.stringify(msg)) } catch { /* ignore */ }
          }
        })
        shortIdToTransferId.get(peerSessionId)?.delete(frame.shortId)
        failTransferRecord(transferId, errStr)
      }
      return
    }

    if (typeof e.data === 'string') {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(e.data) as Record<string, unknown>
      } catch {
        return // not JSON
      }

      try {
        // Protocol handshake (v2/v3). Must be processed before anything that
        // depends on the negotiated version.
        if (msg.type === 'hello') {
          setPeerProtocolVersion(peerSessionId, msg.v)
          return
        }

        if (msg.type === 'ecdh-pub') {
          await setPeerPublicKey(peerSessionId, String(msg.pub ?? ''))
          if (!stillThisAttempt() || !hasAESKey(peerSessionId)) return
          publishEncryptedReady()
          const entry = x.ecdhResolvers.get(peerSessionId)
          if (entry) {
            clearTimeout(entry.timer)
            x.ecdhResolvers.delete(peerSessionId)
            entry.resolve()
          }
          flushOutgoing(peerSessionId, dc)
          flushPendingDurableAcks(peerSessionId)
          sendResumeRequests(peerSessionId, dc)
          return
        }

        if (msg.type === 'meta') {
          await handleIncomingMeta(msg, peerSessionId, dc, owner, stillThisAttempt)
          return
        }

        if (msg.type === 'resume') {
          if (!stillThisAttempt()) return
          await handleResumeRequest(msg as unknown as ResumeRequest, peerSessionId, owner)
          return
        }

        if (msg.type === 'transfer-ready' && typeof msg.transferId === 'string') {
          const shortId = typeof msg.shortId === 'number' ? msg.shortId : NaN
          markReceiverReady(msg.transferId, shortId, owner)
          return
        }
        if (msg.type === 'transfer-reject' && typeof msg.transferId === 'string') {
          if (markReceiverRejected(msg.transferId, owner)) {
            sendingFiles.delete(msg.transferId)
            failTransferRecord(msg.transferId, String(msg.message ?? '接收端拒绝了该传输'))
          }
          return
        }
        if (msg.type === 'transfer-repair' && typeof msg.transferId === 'string') {
          const requeued = applyRepairRequest(msg as { transferId: string; missingRanges?: Array<[number, number]> }, owner)
          // -2: settled task accepted late repair into the same task identity;
          // re-enter that task (same shortId) — never spawn a second engine.
          // -1: no task at all (should not restart a foreign transfer).
          if (requeued === -2) {
            await reenterSendTaskForRepair(msg.transferId, peerSessionId, owner)
          }
          return
        }
        if (msg.type === 'transfer-done' && typeof msg.transferId === 'string') {
          const bytes = typeof msg.bytes === 'number' ? msg.bytes : NaN
          if (markTransferAcked(msg.transferId, bytes, owner)) {
            transferDelivery.set(msg.transferId, 'saved')
            sendingFiles.delete(msg.transferId)
            forgetTransfer(msg.transferId)
          } else {
            // Late done after the engine settled: only promote when ownership
            // still matches (peerSessionId, epoch) AND bytes match. Never
            // open a side door for a wrong-owner transfer-done.
            const info = getSendTaskInfo(msg.transferId)
            if (
              !info
              || info.peerSessionId !== owner.peerSessionId
              || info.epoch !== owner.epoch
            ) {
              return
            }
            const expected = info.fileSize
            if (
              Number.isSafeInteger(bytes)
              && bytes === expected
              && transferDelivery.get(msg.transferId) === 'delivered'
            ) {
              transferDelivery.set(msg.transferId, 'saved')
              sendingFiles.delete(msg.transferId)
              forgetTransfer(msg.transferId)
            }
          }
          return
        }

        if (msg.type === 'chat') {
          if (!stillThisAttempt()) return
          handleChat(peerSessionId, msg, dc)
          return
        }

        if (msg.type === 'msg-ack') {
          handleMsgAck(peerSessionId, String(msg.id ?? ''))
          return
        }

        if (msg.type === 'transfer-pause' && typeof msg.transferId === 'string') {
          if (!applyPeerPause(msg.transferId, owner)) return
          if (!stillThisAttempt()) return
          storeSet(s => ({
            transfers: s.transfers.map(t =>
              t.id === msg.transferId ? { ...t, status: 'paused' as const } : t,
            ),
          }))
          return
        }
        if (msg.type === 'transfer-resume' && typeof msg.transferId === 'string') {
          if (!applyPeerResume(msg.transferId, owner)) return
          if (!stillThisAttempt()) return
          storeSet(s => ({
            transfers: s.transfers.map(t =>
              t.id === msg.transferId ? { ...t, status: 'transferring' as const } : t,
            ),
          }))
          return
        }
        if (msg.type === 'transfer-cancel' && typeof msg.transferId === 'string') {
          if (!applyPeerCancel(msg.transferId, owner)) return
          // Signal only — do not forgetTransfer until the engine settles.
          // applyPeerCancel already set cancelled=true; do not wipe the
          // signal via abortInboundTransfer while a send engine is live.
          storeSet(s => ({
            transfers: s.transfers.filter(t => t.id !== msg.transferId),
          }))
          transferSpeedSamples.delete(msg.transferId)
          transferDelivery.delete(msg.transferId)
          void (async () => {
            const tid = msg.transferId as string
            if (getReceiveSession(tid)) {
              await abortInboundTransfer(tid, 'peer-cancel')
            }
            // Engine must acknowledge cancel before we release cancel state.
            // Neutralise (not forget) is the backstop for a wedged engine.
            await awaitSendEngineSettlement(tid)
            sendingFiles.delete(tid)
            forgetTransfer(tid)
          })()
          return
        }
      } catch (err) {
        console.warn('[net] control-plane handler error', err)
      }
    }
  }
}
