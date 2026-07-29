/**
 * transfer-controller.ts — staging, send/resume/cancel, v2/v3 controls, demux,
 * delivery state, deliverCompletedFile.
 *
 * Ports: deps.ensureTransferLanes / deps.ownerFor / deps.getNetworkEpoch / deps.dataChannels.
 * Store: store-access only.
 */

import type { Transfer } from '@/types'
import {
  sendFileParallel as engineSendFileParallel, handleMetaMessage,
  createTransferId, buildResumeRequest,
  decodeResumeRequest,
  clearTransferSignal,
  TransferCancelledError,
  setPeerProtocolVersion,
  validateMetaMessage, prepareReceiveBackend, finalizeReceive, abortInboundTransfer,
  hasLiveSendTask, getSendTaskInfo,
  forgetTransfer,
  TransferOwnershipError,
  type SendCallbacks, type ResumeRequest,
  type TransferOwner, type DeliveryState,
} from '@/lib/transfer'
import { notifyActiveWorkChanged } from '@/hooks/activeWork'
import { getTransfer, getActiveTransfers } from '@/lib/db'
import { playSound } from '@/lib/sound'
import { notifyIncomingFile } from '@/lib/notify'
import { storeGet, storeSet } from './store-access'
import { deps } from './deps'
import { appendSystemChat, appendFileChat } from './chat-controller'
import { selectPrunedTerminalTransfers } from './selectors'
import { registerDownloadArtifact } from './download-artifacts'
import type { ResumeFailureCode } from './contracts'

export const EMPTY_CIPHERTEXT = new ArrayBuffer(0)

/** Cleanup owner: transfer-controller terminal paths + session-scope.endNetworkEpoch */
export const sendingFiles = new Map<string, File>()  // transferId → File

// Per-peer mapping from the compact shortId embedded in binary chunk frames
// to the full transferId. Registered when a `meta` message arrives and
// consulted on every incoming chunk so the receiver can demux multiple
// concurrent transfers without a JSON header per frame.
/** Cleanup owner: transfer-controller / peer cleanup / epoch teardown */
export const shortIdToTransferId = new Map<string, Map<number, string>>()

export const deliveredTransfers = new Set<string>()  // one file card per transferId

export const transferSpeedSamples = new Map<string, { bytes: number; at: number }>()

// BUG-016: how far each transfer really got. `Transfer.status` stays the
// coarse UI state; this map carries the durable-delivery truth
// (queued → delivered → saved) that the ✓ badge must not overstate.
export const transferDelivery = new Map<string, DeliveryState>()

/** Cleanup owner: session-scope.endNetworkEpoch (OPEN: not cleared on every path — see report) */
export const pendingDurableAcks = new Map<string, PendingDurableAck>()

interface PendingDurableAck {
  peerSessionId: string
  transferId: string
  bytes: number
  epoch: number
}

/** @internal test-only: install a source File so resume/ownership paths are reachable. */
export function setSendingFileForTests(transferId: string, file: File | null): void {
  if (file) sendingFiles.set(transferId, file)
  else sendingFiles.delete(transferId)
}


/** Receiver-side chat msgId dedupe (per peer session). */
/** Cleanup owner: session-scope.endNetworkEpoch / PEER_LEFT (OPEN: incomplete paths — see report) */

export function getTransferDeliveryState(transferId: string): DeliveryState | undefined {
  return transferDelivery.get(transferId)
}



// ── Bounded terminal retention (QUALITY-001) ─────────────────────────
// Nothing in the app reads a completed transfer card, a delivered chat
// message or a finished receive session after the user has moved on, yet all
// three grew without limit for the lifetime of a tab. The store keeps a short
// tail so the UI still shows recent history; `pruneTerminalTransfers()` does
// the same for the IndexedDB rows.
/**
 * Compatibility wrappers: pure selection in selectors.ts; side effects stay
 * with the maps owned by this composition root / transfer-controller.
 */
export function pruneTerminalTransferCards(transfers: Transfer[]): Transfer[] {
  const { kept, retiredIds } = selectPrunedTerminalTransfers(transfers)
  for (const id of retiredIds) {
    transferSpeedSamples.delete(id)
    transferDelivery.delete(id)
    deliveredTransfers.delete(id)
  }
  return kept
}



export async function sendFileToPeer(file: File, peerSessionId: string, displayName = file.name): Promise<boolean> {
  const peer = storeGet().peers.find(p => p.sessionId === peerSessionId)
  const peerNodeId = peer?.nodeId ?? 0

  let dcs: RTCDataChannel[]
  try {
    dcs = await deps.ensureTransferLanes(peerSessionId)
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
  storeSet(s => ({ transfers: pruneTerminalTransferCards([...s.transfers, transfer]) }))
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
      storeSet(s => ({
        transfers: s.transfers.map(t =>
          t.id === transferId ? { ...t, progress: sent / total, speedBps, status: 'transferring' as const } : t,
        ),
      }))
    },
    onError(error) {
      storeSet(s => ({
        transfers: s.transfers.map(t =>
          t.id === transferId ? { ...t, status: 'failed' as const, error } : t,
        ),
      }))
    },
    onDeliveryState(state) {
      transferDelivery.set(transferId, state)
    },
  }

  try {
    sendingFiles.set(transferId, file)
    const outcome = await engineSendFileParallel(
      dcs, file, transferId, peerNodeId, peerSessionId, undefined, callbacks,
      undefined, deps.getNetworkEpoch(), displayName,
    )
    transferDelivery.set(transferId, outcome.state)
    // BUG-016: hold the source File until the receiver confirms a DURABLE
    // write. A v1 peer can never confirm, so legacy semantics still release it
    // — but for a v2 peer, "the last dc.send() returned" is not a reason to
    // throw away the only thing a retry could use.
    if (outcome.state === 'saved' || outcome.legacyPeer) sendingFiles.delete(transferId)
    clearTransferSignal(transferId)
    storeSet(s => ({
      transfers: s.transfers.map(t =>
        t.id === transferId ? { ...t, progress: 1, status: 'completed' as const } : t,
      ),
    }))
    appendSystemChat(
      peerSessionId,
      outcome.state === 'saved'
        ? `已发送文件 ${displayName}`
        : `已送出文件 ${displayName}（等待对方确认落盘）`,
      'sent',
    )
    playSound('complete')
    transferSpeedSamples.delete(transferId)
    return true
  } catch (e) {
    sendingFiles.delete(transferId)
    transferDelivery.delete(transferId)
    clearTransferSignal(transferId)
    transferSpeedSamples.delete(transferId)
    // A cancel (local or peer-driven) is not a failure: the transfer card is
    // already 'failed' via checkSignals; show a neutral notice, no error tone.
    if (e instanceof TransferCancelledError) {
      appendSystemChat(peerSessionId, `已取消发送 ${displayName}`, 'sent')
      return false
    }
    storeSet(s => ({
      transfers: s.transfers.map(t =>
        t.id === transferId ? { ...t, status: 'failed' as const, error: String(e) } : t,
      ),
    }))
    appendSystemChat(peerSessionId, `发送失败：${displayName} · ${String((e as Error).message ?? e)}`, 'sent')
    playSound('error')
    return false
  }
}



// ── Resume / retry preconditions (BUG-019) ───────────────────────────
// Retry on a failed send used to be optimistic: it flipped the card to
// "transferring", then hit one of several silent early returns (no live
// DataChannel, no persisted record, source File already released) and left a
// permanently fake in-progress card with no bytes moving and no way back.

type PreconditionResult =
  | { ok: true }
  | { ok: false; code: ResumeFailureCode; message: string }

export async function checkResumePreconditions(
  transferId: string,
  peerSessionId: string,
  transfer: Transfer | undefined,
): Promise<PreconditionResult> {
  if (!transfer) {
    return { ok: false, code: 'unknown-transfer', message: '该传输记录已不存在' }
  }
  if (transfer.status === 'completed') {
    return { ok: false, code: 'not-resumable', message: '该传输已完成' }
  }
  const dc = deps.dataChannels.get(peerSessionId)
  if (!dc || dc.readyState !== 'open') {
    return { ok: false, code: 'channel-unavailable', message: '与该节点的数据信道尚未就绪' }
  }
  // Receiver side needs nothing else — the sender owns the send loop.
  if (transfer.direction === 'recv') return { ok: true }

  if (!sendingFiles.has(transferId)) {
    return {
      ok: false,
      code: 'source-missing',
      message: '源文件已释放，请重新选择该文件后再发送',
    }
  }
  const record = await getTransfer(transferId)
  if (!record) {
    return { ok: false, code: 'record-missing', message: '传输记录已丢失，请重新发送该文件' }
  }
  return { ok: true }
}



/**
 * Inbound `meta`, end to end:
 *
 *   validate (SECURITY-007) → ownership (SECURITY-015) → register demux →
 *   register session → prepare + PROVE a writable backend, deduplicated per
 *   (peer, transfer) (BUG-011) → apply the size cap to the COMMITTED backend
 *   (BUG-012) → ACK `transfer-ready` so the sender may ship payload.
 *
 * Nothing may write a byte before the ACK; chunks that a legacy (v1) sender
 * pushes early are buffered inside the receive session and replayed in index
 * order once the backend commits.
 */
export async function handleIncomingMeta(
  raw: unknown,
  peerSessionId: string,
  dc: RTCDataChannel,
  owner: TransferOwner,
  stillThisAttempt: () => boolean = () => true,
) {
  const validated = validateMetaMessage(raw)
  if (!validated.ok) {
    console.warn('[net] rejecting malformed meta', validated.code, validated.message)
    const badId = (raw as { transferId?: unknown })?.transferId
    if (typeof badId === 'string' && badId.length > 0 && badId.length <= 256) {
      try {
        dc.send(JSON.stringify({
          type: 'transfer-reject', transferId: badId,
          reason: validated.code, message: validated.message,
        }))
      } catch { /* peer DC might already be dying */ }
    }
    if (stillThisAttempt()) {
      appendSystemChat(peerSessionId, `已拒绝一个非法的传输请求：${validated.message}`)
    }
    return
  }
  const meta = validated.meta
  setPeerProtocolVersion(peerSessionId, meta.v)
  const peerNodeId = storeGet().peers.find(p => p.sessionId === peerSessionId)?.nodeId ?? 0

  // Compare-and-set demux: if (peerSessionId, shortId) already points at a
  // different live transfer, REJECT the new meta and keep the old mapping.
  let peerMap = shortIdToTransferId.get(peerSessionId)
  if (!peerMap) {
    peerMap = new Map()
    shortIdToTransferId.set(peerSessionId, peerMap)
  }
  const existingTid = peerMap.get(meta.shortId)
  if (existingTid && existingTid !== meta.transferId) {
    console.warn('[net] shortId collision — rejecting meta', meta.shortId, existingTid, meta.transferId)
    try {
      dc.send(JSON.stringify({
        type: 'transfer-reject', transferId: meta.transferId,
        reason: 'shortid-collision',
        message: 'shortId 与进行中的传输冲突',
      }))
    } catch { /* ignore */ }
    if (stillThisAttempt()) {
      appendSystemChat(peerSessionId, `已拒绝接收 ${meta.fileName}：shortId 冲突`)
    }
    return
  }
  // Retire any prior shortId demux entry for the same transferId so a v3
  // rebind cannot leave the old shortId routing into the new attempt.
  for (const [sid, tid] of peerMap) {
    if (tid === meta.transferId && sid !== meta.shortId) peerMap.delete(sid)
  }
  peerMap.set(meta.shortId, meta.transferId)

  try {
    await handleMetaMessage(meta, peerNodeId, owner)
  } catch (err) {
    if (peerMap.get(meta.shortId) === meta.transferId) peerMap.delete(meta.shortId)
    const message = err instanceof TransferOwnershipError ? err.message : String(err)
    console.warn('[net] rejecting meta', message)
    try {
      dc.send(JSON.stringify({
        type: 'transfer-reject', transferId: meta.transferId,
        reason: 'owner-mismatch', message,
      }))
    } catch { /* ignore */ }
    if (stillThisAttempt()) {
      appendSystemChat(peerSessionId, `已拒绝接收 ${meta.fileName}：${message}`)
    }
    return
  }

  if (!stillThisAttempt()) {
    // Stale: only clean up what this owner created; never publish UI.
    await abortInboundTransfer(meta.transferId, 'stale-epoch').catch(() => {})
    if (peerMap.get(meta.shortId) === meta.transferId) peerMap.delete(meta.shortId)
    return
  }

  const prepared = await prepareReceiveBackend({
    transferId: meta.transferId,
    fileName: meta.fileName,
    totalChunks: meta.totalChunks,
    size: meta.fileSize,
  }, owner).catch((err): { ok: false; rejection: { reason: string; message: string } } => ({
    ok: false,
    rejection: { reason: 'no-writable-backend', message: String(err) },
  }))

  if (!stillThisAttempt()) {
    await abortInboundTransfer(meta.transferId, 'stale-epoch').catch(() => {})
    if (peerMap.get(meta.shortId) === meta.transferId) peerMap.delete(meta.shortId)
    return
  }

  if (!prepared.ok) {
    try {
      dc.send(JSON.stringify({ type: 'transfer-reject', transferId: meta.transferId, reason: prepared.rejection.reason, message: prepared.rejection.message }))
      dc.send(JSON.stringify({ type: 'transfer-cancel', transferId: meta.transferId }))
    } catch { /* peer DC might already be dying — ignore */ }
    if (peerMap.get(meta.shortId) === meta.transferId) peerMap.delete(meta.shortId)
    await abortInboundTransfer(meta.transferId, prepared.rejection.message).catch(() => {})
    storeSet(s => {
      if (s.transfers.some(t => t.id === meta.transferId)) return s
      return {
        transfers: pruneTerminalTransferCards([...s.transfers, {
          id: meta.transferId, direction: 'recv' as const,
          peerSessionId, peerNodeId,
          fileName: meta.fileName, fileSize: meta.fileSize,
          progress: 0, speedBps: 0,
          status: 'failed:unsupported' as const,
          error: prepared.rejection.message,
          startedAt: Date.now(),
        }]),
      }
    })
    appendSystemChat(peerSessionId, `已拒绝接收 ${meta.fileName}：${prepared.rejection.message}`)
    playSound('error')
    return
  }

  storeSet(s => {
    if (s.transfers.some(t => t.id === meta.transferId)) return s
    return {
      transfers: pruneTerminalTransferCards([...s.transfers, {
        id: meta.transferId, direction: 'recv' as const,
        peerSessionId, peerNodeId,
        fileName: meta.fileName, fileSize: meta.fileSize,
        progress: 0, speedBps: 0, status: 'transferring' as const,
        startedAt: Date.now(),
        storageMode: prepared.mode,
      }]),
    }
  })
  notifyActiveWorkChanged()

  try {
    dc.send(JSON.stringify({ type: 'transfer-ready', transferId: meta.transferId, shortId: meta.shortId }))
  } catch { /* the sender's own timeout covers this */ }

  const alreadyAnnounced = storeGet().chatMessages[peerSessionId]
    ?.some(m => m.type === 'system' && m.content === `正在接收文件 ${meta.fileName}`)
  if (!alreadyAnnounced) appendSystemChat(peerSessionId, `正在接收文件 ${meta.fileName}`)
  notifyIncomingFile({ peerNodeId, fileName: meta.fileName, fileSize: meta.fileSize })

  // Zero-byte and fully-buffered v1 files: route through finalizeReceive via
  // deliverCompletedFile — never hand-write a terminal state.
  const fullyReady = (meta.totalChunks === 0 && meta.fileSize === 0)
    || (prepared.ok && prepared.completed === true)
  if (fullyReady) {
    if (!stillThisAttempt()) return
    await deliverCompletedFile(meta.transferId, peerSessionId)
  }
}



/**
 * A peer asks us to resume sending. SECURITY-015: only the session that owns
 * the transfer may ask, and BUG-014: a live task is woken, never duplicated.
 */
export async function handleResumeRequest(
  req: ResumeRequest,
  peerSessionId: string,
  owner: TransferOwner,
) {
  if (typeof req.transferId !== 'string') return
  const file = sendingFiles.get(req.transferId)
  const record = await getTransfer(req.transferId)
  if (!file || !record) return
  // Owner is (peerSessionId, epoch) — never adopt an ownerless legacy row
  // for a sibling session that shares nodeId (SECURITY-015).
  if (!record.peerSessionId || record.peerSessionId !== peerSessionId) {
    console.warn('[net] refusing resume for ownerless or foreign send record', req.transferId)
    return
  }
  if (record.epoch !== undefined && record.epoch !== owner.epoch) {
    console.warn('[net] refusing resume across epoch boundary', req.transferId)
    return
  }
  const peerNodeId = storeGet().peers.find(p => p.sessionId === peerSessionId)?.nodeId ?? 0
  const lanes = await deps.ensureTransferLanes(peerSessionId)
  // decodeResumeRequest handles both legacy (`receivedChunks`) and new
  // (`receivedRanges`) wire formats, capped at totalChunks so a malformed
  // peer can't trigger an oversize bitmap alloc.
  const peerBitmap = decodeResumeRequest(req, record.totalChunks)
  // engineSendFileParallel itself dedupes against the live task (BUG-014).
  void runSendEngine(lanes, file, req.transferId, peerNodeId, peerSessionId, record, peerBitmap, owner)
}



/**
 * Late repair after the original engine settled (ACK timeout window).
 * Re-enters the SAME send task (same shortId) via sendFileParallel's
 * settled-reentry path — never allocates a second engine identity.
 */
export async function reenterSendTaskForRepair(
  transferId: string,
  peerSessionId: string,
  owner: TransferOwner,
) {
  const file = sendingFiles.get(transferId)
  const record = await getTransfer(transferId)
  if (!file || !record) return
  if (!record.peerSessionId || record.peerSessionId !== peerSessionId) return
  if (record.epoch !== undefined && record.epoch !== owner.epoch) return
  const info = getSendTaskInfo(transferId)
  if (!info || info.peerSessionId !== owner.peerSessionId || info.epoch !== owner.epoch) return
  const peerNodeId = storeGet().peers.find(p => p.sessionId === peerSessionId)?.nodeId ?? 0
  const lanes = await deps.ensureTransferLanes(peerSessionId)
  void runSendEngine(lanes, file, transferId, peerNodeId, peerSessionId, record, undefined, owner)
}



/** Shared tail for every resume/repair-driven send restart. */
export async function runSendEngine(
  lanes: RTCDataChannel[],
  file: File,
  transferId: string,
  peerNodeId: number,
  peerSessionId: string,
  record: Awaited<ReturnType<typeof getTransfer>>,
  peerBitmap: Uint8Array | undefined,
  owner: TransferOwner,
) {
  try {
    const outcome = await engineSendFileParallel(
      lanes, file, transferId, peerNodeId, peerSessionId, record ?? undefined,
      undefined, peerBitmap, owner.epoch, record?.fileName ?? file.name,
    )
    transferDelivery.set(transferId, outcome.state)
    // BUG-016: only release the retry source once the receiver confirmed a
    // durable write (or the peer is v1 and can never confirm).
    // v1 tops at delivered and never ACKs — forget the task so it does not
    // accumulate for the life of the epoch.
    if (outcome.state === 'saved' || outcome.legacyPeer) {
      sendingFiles.delete(transferId)
      forgetTransfer(transferId)
    }
    notifyActiveWorkChanged()
    return outcome
  } catch (err) {
    if (err instanceof TransferCancelledError) {
      sendingFiles.delete(transferId)
      forgetTransfer(transferId)
      notifyActiveWorkChanged()
      throw err
    }
    console.warn('[net] resume send failed', transferId, err)
    notifyActiveWorkChanged()
    throw err
  }
}



export function hasLiveSendTaskAny(): boolean {
  // Probe helper — walk known transfer cards + sendingFiles.
  for (const id of sendingFiles.keys()) {
    if (hasLiveSendTask(id)) return true
  }
  for (const t of storeGet().transfers) {
    if (hasLiveSendTask(t.id)) return true
  }
  return false
}



/** Tell the sender their file is durably written (BUG-016). Queued until
 *  primary is open; only cleared on successful send; re-sent on primary reopen. */
export function sendDurableAck(peerSessionId: string, transferId: string, bytes: number) {
  const key = `${peerSessionId}\u0000${transferId}`
  pendingDurableAcks.set(key, {
    peerSessionId, transferId, bytes, epoch: deps.getNetworkEpoch(),
  })
  flushPendingDurableAcks(peerSessionId)
}



export function flushPendingDurableAcks(peerSessionId: string) {
  const dc = deps.dataChannels.get(peerSessionId)
  if (dc?.readyState !== 'open') return
  for (const [key, ack] of [...pendingDurableAcks]) {
    if (ack.peerSessionId !== peerSessionId) continue
    if (ack.epoch !== deps.getNetworkEpoch()) {
      pendingDurableAcks.delete(key)
      continue
    }
    try {
      dc.send(JSON.stringify({ type: 'transfer-done', transferId: ack.transferId, bytes: ack.bytes }))
      pendingDurableAcks.delete(key)
    } catch {
      // Keep queued for next open.
    }
  }
}



/**
 * BUG-018: ONE terminal completion path for every receive backend.
 *
 * There used to be three ad-hoc branches here (FSA handle / OPFS handle /
 * IDB assemble), each with its own partial cleanup. The OPFS one dropped the
 * file-name handle inside `getOPFSFile` before it could `removeEntry`, so the
 * origin-private copy survived, and none of them retired the `active` DB row,
 * the receive session or the resume bitmap. `finalizeReceive` in lib/transfer
 * now owns all of it — closing the backend, verifying the artefact is exactly
 * `fileSize` bytes, deleting chunks, removing the OPFS entry, marking the
 * record completed and dropping the session, signal and owner record.
 *
 * This function is the UI half: object URL, chat card, sound, transfer card,
 * demux cleanup and the receiver's durable-write ACK (BUG-016).
 */
export async function deliverCompletedFile(transferId: string, peerSessionId: string) {
  if (deliveredTransfers.has(transferId)) return
  deliveredTransfers.add(transferId)

  // Freeze attempt identity before the await so an epoch/session change
  // during finalizeReceive cannot inject the old identity's file into the
  // new session (cross-identity exposure).
  const receiptEpoch = deps.getNetworkEpoch()
  const receiptOwner = deps.ownerFor(peerSessionId)

  try {
    const { file, bytes, cleanup } = await finalizeReceive(transferId)
    if (
      deps.getNetworkEpoch() !== receiptEpoch
      || receiptOwner.epoch !== deps.getNetworkEpoch()
    ) {
      // Epoch crossed during finalization: do not publish URL/chat/ACK into
      // the new identity. Drop the artefact and stop.
      try { await cleanup?.() } catch { /* ignore */ }
      deliveredTransfers.delete(transferId)
      return
    }
    const url = URL.createObjectURL(file)
    registerDownloadArtifact(url, { cleanup })
    appendFileChat(peerSessionId, file.name, file.size, url)
    playSound('complete')
    cleanupTransferRecord(transferId)
    // BUG-016: tell the sender the bytes are durably written. Only now may it
    // report "saved" and release the retry source.
    sendDurableAck(peerSessionId, transferId, bytes)
  } catch (err) {
    failTransferRecord(transferId, String(err))
    deliveredTransfers.delete(transferId)
    playSound('error')
    // Single abnormal terminal API — never hand-delete chunks while leaving
    // session/bitmap inconsistent (ghost resume).
    await abortInboundTransfer(transferId, String(err)).catch(() => {})
  }
  // Common cleanup: demux entry for any peer's map that pointed at this
  // transferId. Signal is cleared by finalizeReceive / abortInboundTransfer
  // (or preserved while a send task is still live).
  if (!hasLiveSendTask(transferId)) clearTransferSignal(transferId)
  for (const peerMap of shortIdToTransferId.values()) {
    for (const [shortId, tid] of peerMap) {
      if (tid === transferId) peerMap.delete(shortId)
    }
  }
}



export function cleanupTransferRecord(transferId: string) {
  transferSpeedSamples.delete(transferId)
  import('@/lib/db').then(({ deleteChunks }) => deleteChunks(transferId).catch(() => {}))
  storeSet(s => ({
    transfers: s.transfers.map(t =>
      t.id === transferId ? { ...t, progress: 1, status: 'completed' as const } : t,
    ),
  }))
}



export function failTransferRecord(transferId: string, error: string) {
  transferSpeedSamples.delete(transferId)
  storeSet(s => ({
    transfers: s.transfers.map(t =>
      t.id === transferId ? { ...t, status: 'failed' as const, error } : t,
    ),
  }))
}



export async function sendResumeRequests(peerSessionId: string, dc: RTCDataChannel) {
  if (dc.label.startsWith('misaka-transfer-')) return
  const active = await getActiveTransfers()
  const owner = deps.ownerFor(peerSessionId)
  for (const record of active) {
    if (record.direction !== 'recv') continue
    // Owner is NEVER peerNodeId. Legacy rows without peerSessionId must not
    // auto-bind to a same-nodeId sibling session — mark migration-required.
    if (!record.peerSessionId) {
      try {
        const { updateTransfer } = await import('@/lib/db')
        await updateTransfer(record.transferId, {
          status: 'failed:unsupported',
        })
      } catch { /* best effort */ }
      continue
    }
    if (record.peerSessionId !== peerSessionId) continue
    const req = await buildResumeRequest(record.transferId, owner)
    if (req && dc.readyState === 'open') dc.send(JSON.stringify(req))
  }
}


