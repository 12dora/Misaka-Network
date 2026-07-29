/**
 * transfer/send-engine.ts — send task, repair queue, delivery state, receiver-ready barrier.
 *
 * Module-global state cleanup owners:
 *   sendTasks              → forgetTransfer / resetTransferModuleState (registry)
 *   neutralizedSends       → awaitSendEngineSettlement / forgetTransfer / reset
 *   irrevocableSendGates   → OPEN: survives forgetTransfer + reset; cleared only by
 *                            awaitSendEngineSettlement when engine actually settles
 *                            (no detach). Documented open ownership item.
 *   receiverReadyWaiters   → clearReceiverReady / markReceiverRejected / reset
 *   receiverReadyFlags     → clearReceiverReady / reset
 *   laneDrainTimeoutMs     → test helper only (process lifetime)
 */
import {
  saveTransfer, updateTransfer, getSavedChunkIndexes,
  type TransferRecord,
} from '../db'
import {
  encryptChunk, makeChunkIv, randomIvPrefix,
  deriveTransferIvPrefix, chunkAad,
} from '../crypto'
import {
  TRANSFER_PROGRESS_INTERVAL_MS, TRANSFER_LANE_COUNT,
} from '@/constants'
import {
  newBitmap, bitmapSet, bitmapHas, bitmapPopcount,
  bitmapFromIndexes, validateAndNormalizeRanges,
} from '../chunk-bitmap'
import {
  PROTOCOL_VERSION, AAD_PROTOCOL_VERSION, CHUNK_SIZE,
  expectedChunkCount, isValidChunkIndex, encodeChunkFrame,
  nextShortId, negotiatedProtocolVersion, MAX_FILE_SIZE,
  type MetaMessage,
} from './protocol'
import {
  assertTransferOwner, registerTransferOwner, TransferOwnershipError,
  type TransferOwner,
} from './ownership'
import {
  waitForBuffer, waitWhilePaused, getSignal, transferSignals,
  abortBufferWaits, cancelTransfer, resumeTransfer, pauseTransfer,
  TransferCancelledError, BufferWaitTimeoutError, WAIT_FOR_BUFFER_TIMEOUT_MS,
} from './flow-control'

function bitmapFromRecord(record: TransferRecord): Uint8Array<ArrayBuffer> {
  if (record.receivedBitmap && record.receivedBitmap.byteLength > 0) {
    const copy = record.receivedBitmap.slice(0) as ArrayBuffer
    return new Uint8Array(copy)
  }
  if (record.receivedChunks && record.receivedChunks.length > 0) {
    return bitmapFromIndexes(record.receivedChunks, record.totalChunks)
  }
  return newBitmap(record.totalChunks)
}

// ── Send file ────────────────────────────────────────────────────────

/**
 * How far a send has actually got. BUG-016: "completed" used to mean "the
 * last `dc.send()` returned", which is only "the bytes are in our own SCTP
 * queue". A drop between that call and the receiver's durable write left the
 * sender showing ✓ and dropping the retry source while the peer had a
 * truncated file.
 *
 *   queued    every chunk handed to the DataChannel
 *   delivered every lane's send buffer has drained — the bytes left this host
 *   saved     the receiver ACKed that the file is durably written (v2 only)
 */
export type DeliveryState = 'queued' | 'delivered' | 'saved'

export interface SendOutcome {
  state: DeliveryState
  /** True when a receiver finalization ACK was actually observed. */
  acked: boolean
  /** True when the peer speaks v1 and therefore can never ACK. */
  legacyPeer: boolean
}

export interface SendCallbacks {
  onProgress?: (sent: number, total: number) => void
  onError?: (error: string) => void
  /** Fires on each delivery-state transition (BUG-016). */
  onDeliveryState?: (state: DeliveryState) => void
}

function shouldFlushProgress(lastAt: number, done: number, total: number) {
  return done === total || performance.now() - lastAt >= TRANSFER_PROGRESS_INTERVAL_MS
}

// ── Live send tasks (BUG-014) ────────────────────────────────────────
// Exactly ONE engine per transferId may be live at a time. Resume used to
// call `resumeTransfer()` (waking the parked lane loop of the original task)
// AND then call `sendFileParallel()` again with the same id — two engines
// racing over one `sentBitmap`, doubling traffic and interleaving progress
// callbacks. The registry makes the duplicate start impossible: a second call
// for a live id wakes the existing task and returns its promise.

interface SendTask {
  transferId: string
  peerSessionId: string
  epoch: number
  shortId: number
  fileSize: number
  totalChunks: number
  settled: boolean
  promise: Promise<SendOutcome>
  /** Re-queue normalized missing ranges into the LIVE send task (BUG-013). */
  requeueRanges: (ranges: ReadonlyArray<readonly [number, number]>) => number
  /** Merge a fresh peer bitmap into the skip set (resume). */
  applyPeerBitmap: (bitmap: Uint8Array) => void
  /** Receiver finalization ACK plumbing (BUG-016). */
  acked: boolean
  notifyAck?: () => void
  /** Wakes an ACK wait when a repair request arrives instead (BUG-013). */
  notifyRepair?: () => void
  /**
   * Late-repair ranges stashed after the engine settled (ACK timeout) but
   * before `transfer-done`. Re-entry of the same task consumes these so a
   * second engine is never created.
   */
  pendingRepairRanges?: Array<[number, number]>
}

// Cleanup owner: registry.forgetTransfer / resetTransferModuleState
export const sendTasks = new Map<string, SendTask>()

export function getSendTaskInfo(transferId: string):
  {
    peerSessionId: string
    epoch: number
    settled: boolean
    acked: boolean
    shortId: number
    fileSize: number
    totalChunks: number
  } | undefined {
  const t = sendTasks.get(transferId)
  if (!t) return undefined
  return {
    peerSessionId: t.peerSessionId,
    epoch: t.epoch,
    settled: t.settled,
    acked: t.acked,
    shortId: t.shortId,
    fileSize: t.fileSize,
    totalChunks: t.totalChunks,
  }
}

export function hasLiveSendTask(transferId: string): boolean {
  const t = sendTasks.get(transferId)
  return !!t && !t.settled
}

/** True while a send task still exists (including dormant-awaiting-ACK). */
export function hasSendTask(transferId: string): boolean {
  return sendTasks.has(transferId)
}

/**
 * Receiver's `transfer-done` ACK landed (BUG-016). Ownership-checked: only
 * the peer that owns the transfer may confirm it. `bytes` MUST be a safe
 * integer exactly equal to the send task's file size.
 */
export function markTransferAcked(
  transferId: string,
  bytes: number,
  owner: TransferOwner | undefined,
): boolean {
  if (!assertTransferOwner(transferId, owner)) return false
  const task = sendTasks.get(transferId)
  if (!task) return false
  if (owner && task.peerSessionId !== owner.peerSessionId) return false
  if (!Number.isSafeInteger(bytes) || bytes !== task.fileSize) return false
  task.acked = true
  const notify = task.notifyAck
  task.notifyAck = undefined
  notify?.()
  return true
}

/**
 * Apply a receiver repair request (BUG-013): re-queue exactly the indexes the
 * receiver says it is still missing into the LIVE send task. Returns the
 * number of indexes re-queued, or -1 when there is no live task to repair
 * (the caller then has to restart the engine from the persisted record).
 *
 * Never builds a per-index array from untrusted ranges — ranges are
 * validated/normalized against `task.totalChunks` first.
 */
export function applyRepairRequest(
  req: { transferId: string; missingRanges?: Array<[number, number]>; missing?: number[] },
  owner: TransferOwner | undefined,
): number {
  if (!assertTransferOwner(req.transferId, owner)) return -1
  const task = sendTasks.get(req.transferId)
  if (!task) return -1
  if (owner && task.peerSessionId !== owner.peerSessionId) return -1
  // Settled but not acked: still inside the late-ACK window. Stash ranges on
  // the task and return -2 so the caller re-enters the SAME task (same shortId)
  // rather than spawning a second engine.
  if (task.settled && task.acked) return -1

  const ranges: Array<[number, number]> = []
  if (Array.isArray(req.missingRanges)) {
    ranges.push(...validateAndNormalizeRanges(req.missingRanges, task.totalChunks))
  }
  if (Array.isArray(req.missing)) {
    // Legacy flat indexes → single-chunk ranges, still clamped.
    for (const i of req.missing) {
      if (!Number.isSafeInteger(i) || i < 0 || i >= task.totalChunks) continue
      ranges.push([i, 1])
    }
  }
  const normalized = validateAndNormalizeRanges(ranges, task.totalChunks)
  if (normalized.length === 0) return 0
  if (task.settled) {
    task.pendingRepairRanges = normalized
    return -2
  }
  return task.requeueRanges(normalized)
}

// How long the sender waits for the receiver's durable-write ACK before
// giving up and reporting `delivered` (not `saved`). Generous: the receiver
// may still be draining a multi-GB OPFS write queue when the last chunk
// lands.
export const RECEIVER_ACK_TIMEOUT_MS = 60_000
// Upper bound on how long we wait for the lanes' SCTP buffers to drain
// before declaring `delivered`. Exceeding this is a delivery failure, not
// a silent success. Mutable only via test helper below.
let laneDrainTimeoutMs = 30_000
/** @internal test-only: shorten drain budget so unit tests can assert failure. */
export function setLaneDrainTimeoutMsForTests(ms: number | null): void {
  laneDrainTimeoutMs = ms == null ? 30_000 : ms
}

/** Thrown when SCTP buffers never drain — must not be reported as delivered. */
export class LaneDrainTimeoutError extends Error {
  constructor(message = '数据通道排空超时，无法确认送达') {
    super(message)
    this.name = 'LaneDrainTimeoutError'
  }
}

/**
 * Send-path neutralisation: after local/peer cancel, a wedged engine that is
 * still parked in slice/encrypt/backpressure must not be allowed to transmit
 * when it finally resumes. We keep the cancel signal + task alive (so the
 * engine can observe cancellation) and only block the wire.
 *
 * `irrevocableSendGates` survives `forgetTransfer` / `resetTransferModuleState`
 * so epoch teardown cannot clear the wire gate while an engine is still live.
 * Soft `neutralizedSends` is for ordinary cancel paths and is cleared on
 * settlement; the irrevocable gate is the epoch-safe backstop.
 */
// Cleanup owner: awaitSendEngineSettlement / forgetTransfer / reset
export const neutralizedSends = new Set<string>()
// OPEN OWNERSHIP: survives forgetTransfer + resetTransferModuleState so epoch
// teardown cannot clear the wire gate while an engine is still live.
// Cleared only by awaitSendEngineSettlement when !didDetach.
// Cleanup owner: UNCLEAR / incomplete — open item for next task.
export const irrevocableSendGates = new Set<string>()

export function neutralizeSendTask(transferId: string): void {
  cancelTransfer(transferId)
  neutralizedSends.add(transferId)
  irrevocableSendGates.add(transferId)
  abortBufferWaits(transferId)
}

export function isSendNeutralized(transferId: string): boolean {
  return neutralizedSends.has(transferId) || irrevocableSendGates.has(transferId)
}

/**
 * Drop live-task bookkeeping without clearing the irrevocable wire gate.
 * Used when a never-resolving slice/worker would otherwise pin settlement
 * forever after the gate is already installed.
 */
function detachLiveSendTask(transferId: string): void {
  sendTasks.delete(transferId)
  // Keep transferSignals.cancelled + irrevocable gate if present so a late
  // resume still cannot transmit. Source File is held by the store layer.
}

/**
 * Wait until the live send engine has settled. Never releases cancel state
 * on a wall-clock deadline. After `neutralizeAfterMs`, the send path is
 * neutralised so a wedged encrypt/backpressure wait cannot transmit cancelled
 * data when it eventually resumes. After `detachAfterMs`, task bookkeeping is
 * detached so settlement can complete even if `File.arrayBuffer()` / a worker
 * never resolves — the irrevocable gate still blocks the wire.
 */
export async function awaitSendEngineSettlement(
  transferId: string,
  options?: { neutralizeAfterMs?: number; detachAfterMs?: number; pollMs?: number },
): Promise<void> {
  const neutralizeAfterMs = options?.neutralizeAfterMs ?? 30_000
  const detachAfterMs = options?.detachAfterMs ?? neutralizeAfterMs + 30_000
  const pollMs = options?.pollMs ?? 20
  const started = Date.now()
  let didNeutralize = false
  let didDetach = false
  while (hasLiveSendTask(transferId)) {
    const elapsed = Date.now() - started
    if (!didNeutralize && elapsed >= neutralizeAfterMs) {
      neutralizeSendTask(transferId)
      didNeutralize = true
    }
    if (!didDetach && elapsed >= detachAfterMs) {
      // Gate is installed; drop task so callers are not wedged forever on a
      // never-resolving engine boundary.
      if (!didNeutralize) neutralizeSendTask(transferId)
      detachLiveSendTask(transferId)
      didDetach = true
      break
    }
    await new Promise<void>(r => setTimeout(r, pollMs))
  }
  neutralizedSends.delete(transferId)
  // Clear the irrevocable gate only when the engine actually settled (task
  // gone or settled). After detach the engine may still be live in the
  // background — keep the gate so a late resume cannot transmit.
  if (!didDetach) irrevocableSendGates.delete(transferId)
}

export async function sendFileParallel(
  dcs: RTCDataChannel[],
  file: File,
  transferId: string,
  peerNodeId: number,
  peerSessionId: string,
  existingRecord?: TransferRecord,
  callbacks?: SendCallbacks,
  peerReceivedBitmap?: Uint8Array,
  epoch = 0,
  wireFileName = file.name,
): Promise<SendOutcome> {
  // BUG-014: never run two engines for one transfer id. A resume path that
  // reaches here while the original task is merely PARKED (waitWhilePaused)
  // must wake that task, hand it the fresh peer bitmap, and await it.
  // A settled-but-not-acked task may re-enter for late repair with the SAME
  // shortId / owner — never allocate a second engine identity.
  const live = sendTasks.get(transferId)
  if (live && !live.settled) {
    if (live.peerSessionId !== peerSessionId) {
      throw new TransferOwnershipError(
        'owner-mismatch',
        '该传输属于其他会话，拒绝续传',
      )
    }
    if (peerReceivedBitmap) live.applyPeerBitmap(peerReceivedBitmap)
    resumeTransfer(transferId)
    return live.promise
  }
  if (live && live.settled && !live.acked) {
    if (live.peerSessionId !== peerSessionId) {
      throw new TransferOwnershipError(
        'owner-mismatch',
        '该传输属于其他会话，拒绝续传',
      )
    }
    live.settled = false
    const pending = live.pendingRepairRanges
    live.pendingRepairRanges = undefined
    let repairBitmap = peerReceivedBitmap
    if (pending && pending.length > 0) {
      // peer-have = all chunks EXCEPT the pending missing ranges
      const bm = newBitmap(live.totalChunks)
      for (let i = 0; i < live.totalChunks; i++) bitmapSet(bm, i)
      for (const [start, length] of pending) {
        for (let i = start; i < start + length && i < live.totalChunks; i++) {
          const byte = i >>> 3
          const mask = 1 << (i & 7)
          if (byte < bm.length) bm[byte] &= ~mask
        }
      }
      repairBitmap = bm
    }
    const promise = runSendEngine(
      live, dcs, file, transferId, peerNodeId, peerSessionId,
      existingRecord, callbacks, repairBitmap, wireFileName,
      /* reuseShortId */ live.shortId,
    )
    live.promise = promise
    promise.then(
      () => { live.settled = true },
      () => { live.settled = true },
    )
    return promise
  }

  const totalChunks = expectedChunkCount(file.size)
  const task: SendTask = {
    transferId,
    peerSessionId,
    epoch,
    shortId: 0,
    fileSize: file.size,
    totalChunks,
    settled: false,
    acked: false,
    promise: undefined as unknown as Promise<SendOutcome>,
    requeueRanges: () => -1,
    applyPeerBitmap: () => {},
  }
  // Registered SYNCHRONOUSLY (runSendEngine runs up to its first await inside
  // this same tick), so a second entry point can never slip past the guard.
  sendTasks.set(transferId, task)
  registerTransferOwner(transferId, {
    peerSessionId, epoch, direction: 'send',
    fileName: wireFileName, fileSize: file.size,
    totalChunks,
  })

  const promise = runSendEngine(
    task, dcs, file, transferId, peerNodeId, peerSessionId,
    existingRecord, callbacks, peerReceivedBitmap, wireFileName,
  )
  task.promise = promise
  // Keep the task registered after settle so a late `transfer-done` or
  // repair can still hit the same owner/fileSize/shortId. Cleanup is via
  // forgetTransfer / epoch reset / successful saved release.
  promise.then(
    () => { task.settled = true },
    () => { task.settled = true },
  )
  return promise
}

async function runSendEngine(
  task: SendTask,
  dcs: RTCDataChannel[],
  file: File,
  transferId: string,
  peerNodeId: number,
  peerSessionId: string,
  existingRecord?: TransferRecord,
  callbacks?: SendCallbacks,
  peerReceivedBitmap?: Uint8Array,
  wireFileName = file.name,
  reuseShortId?: number,
): Promise<SendOutcome> {
  // P1-5: refuse to start an over-cap transfer up-front. Without this
  // guard, a multi-hundred-GB drop would either OOM the sender's
  // file.slice() loop or run into the receiver's OPFS quota many GB in,
  // both of which look like silent corruption from the user's seat. We
  // throw a precise error the caller can surface as a toast.
  if (file.size > MAX_FILE_SIZE) {
    const gb = Math.round(MAX_FILE_SIZE / (1024 * 1024 * 1024))
    throw new Error(`文件过大（>${gb}GB）`)
  }
  const lanes = dcs.filter(dc => dc.readyState === 'open').slice(0, TRANSFER_LANE_COUNT)
  const activeLanes = lanes.length > 0 ? lanes : (dcs[0] ? [dcs[0]] : [])
  if (activeLanes.length === 0) throw new Error('No open DataChannel lane available')

  const fileHash = existingRecord?.fileHash ?? ''
  // Zero-byte files: math.ceil(0/CHUNK_SIZE) = 0 → no chunks ever sent, so the
  // receiver's `received === total` completion gate (which only fires from
  // receiveChunk) never trips. The meta message is enough on its own and the
  // receiver detects the empty case to deliver immediately.
  const totalChunks = expectedChunkCount(file.size)
  // Late-repair re-entry MUST keep the same shortId so the receiver demux
  // and v3 AAD attempt identity stay bound to the original attempt.
  const shortId = reuseShortId && reuseShortId !== 0 ? reuseShortId : nextShortId()
  task.shortId = shortId
  task.fileSize = file.size
  task.totalChunks = totalChunks
  // 8-byte random prefix; combined with the 4-byte chunk index it yields a
  // unique 12-byte IV per chunk without an RNG syscall in the hot loop.
  const ivPrefix = randomIvPrefix()
  // Domain-separated prefix computed ONCE per transfer (wire IV bytes unchanged).
  const domainIvPrefix = await deriveTransferIvPrefix(ivPrefix, transferId)
  const negotiated = negotiatedProtocolVersion(peerSessionId)
  const useAad = negotiated >= AAD_PROTOCOL_VERSION
  const record: TransferRecord = existingRecord ?? {
    transferId,
    direction: 'send',
    peerNodeId,
    peerSessionId,
    epoch: task.epoch,
    fileName: wireFileName,
    fileSize: file.size,
    fileHash,
    totalChunks,
    receivedChunks: [],
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  await saveTransfer(record)

  // skipBitmap: chunks the receiver already has (from a prior session) OR
  // the sender already shipped (from its own persisted record). Either way
  // we don't re-send. Two cheap O(n bytes) bitmaps, NOT a 50 B/entry Set.
  // We always own a fresh ArrayBuffer-backed bitmap so subsequent
  // `.buffer.slice(0)` writes to IDB stay variance-clean.
  let skipBitmap: Uint8Array<ArrayBuffer>
  if (peerReceivedBitmap) {
    skipBitmap = newBitmap(totalChunks)
    const copyLen = Math.min(skipBitmap.length, peerReceivedBitmap.length)
    skipBitmap.set(peerReceivedBitmap.subarray(0, copyLen))
  } else if (existingRecord) {
    skipBitmap = bitmapFromIndexes(await getSavedChunkIndexes(transferId), totalChunks)
  } else {
    skipBitmap = newBitmap(totalChunks)
  }
  // sentBitmap mirrors what we've successfully shipped. Seeded from the
  // existing record so cross-session resume picks up where it left off.
  const sentBitmap = bitmapFromRecord(record)
  // Covered = union of sent and skip. Maintain O(1) count: Math.max(popcount
  // skip, popcount sent) under-counts when the two bitmaps are disjoint.
  const coveredBitmap = newBitmap(totalChunks)
  for (let i = 0; i < coveredBitmap.length; i++) {
    coveredBitmap[i] = sentBitmap[i] | skipBitmap[i]
  }
  let sent = bitmapPopcount(coveredBitmap)
  let nextChunk = 0
  let cancelled = false
  let lastProgressAt = performance.now()
  // Set by `task.requeueRanges` when the receiver reports missing chunks after a
  // pause; makes the outer loop run the lanes again instead of finishing a
  // transfer that is knowingly incomplete (BUG-013).
  let repairRequested = false

  function markCovered(idx: number): boolean {
    if (bitmapSet(coveredBitmap, idx)) {
      sent++
      return true
    }
    return false
  }
  function clearCovered(idx: number): boolean {
    const byte = idx >>> 3
    const mask = 1 << (idx & 7)
    if (byte >= coveredBitmap.length) return false
    if ((coveredBitmap[byte] & mask) === 0) return false
    coveredBitmap[byte] &= ~mask
    sent = Math.max(0, sent - 1)
    return true
  }

  // BUG-013: the receiver's repair request lands here. Clearing the bits is
  // what makes `acquireChunk` hand those indexes out again; rewinding
  // `nextChunk` is what makes the cursor reach them. Ranges stay ranges —
  // never expand an untrusted list into a multi-billion index array.
  task.requeueRanges = (ranges: ReadonlyArray<readonly [number, number]>) => {
    let n = 0
    for (const [start, length] of ranges) {
      const end = start + length
      for (let idx = start; idx < end; idx++) {
        if (!isValidChunkIndex(idx, totalChunks)) continue
        const byte = idx >>> 3
        const mask = 1 << (idx & 7)
        if ((sentBitmap[byte] & mask) !== 0) sentBitmap[byte] &= ~mask
        if ((skipBitmap[byte] & mask) !== 0) skipBitmap[byte] &= ~mask
        clearCovered(idx)
        nextChunk = Math.min(nextChunk, idx)
        n++
      }
    }
    if (n > 0) {
      repairRequested = true
      // If the engine has already queued every chunk and is parked waiting for
      // the receiver's ACK, this is what sends it back around the loop.
      const wake = task.notifyRepair
      task.notifyRepair = undefined
      wake?.()
    }
    return n
  }
  task.applyPeerBitmap = (bitmap: Uint8Array) => {
    const copyLen = Math.min(skipBitmap.length, bitmap.length)
    for (let i = 0; i < copyLen; i++) {
      const added = bitmap[i] & ~skipBitmap[i]
      skipBitmap[i] |= bitmap[i]
      // Newly skipped bits that weren't already covered become covered.
      const newly = added & ~coveredBitmap[i]
      if (newly !== 0) {
        coveredBitmap[i] |= newly
        // popcount of newly set bits in this byte
        let v = newly
        v = v - ((v >> 1) & 0x55)
        v = (v & 0x33) + ((v >> 2) & 0x33)
        sent += ((v + (v >> 4)) & 0x0f)
      }
    }
  }

  // Meta is always (re)sent so the receiver can register the new shortId for
  // this connection — cheap and avoids a separate "remap" message on resume.
  const meta = JSON.stringify({
    type: 'meta',
    transferId,
    shortId,
    fileName: existingRecord?.fileName ?? wireFileName,
    fileSize: file.size,
    fileHash,
    totalChunks,
    mime: file.type || 'application/octet-stream',
    v: PROTOCOL_VERSION,
  } satisfies MetaMessage)
  for (const lane of activeLanes) lane.send(meta)

  // BUG-011: with a v2+ receiver, no payload may move until the receiver has
  // COMMITTED a writable storage backend and ACKed `transfer-ready`. Under
  // v1 the receiver has no way to ACK, so we keep the legacy behaviour of
  // shipping immediately (the receiver then buffers early chunks itself).
  const legacyPeer = negotiated < 2
  // Clear ready flags from PRIOR attempts (different shortId) of the same
  // transferId, but keep a flag already set for THIS shortId — a race where
  // transfer-ready arrives before we park is legitimate.
  for (const key of [...receiverReadyFlags]) {
    if (key.startsWith(`${transferId}\u0000`) && key !== readyAttemptKey(transferId, shortId)) {
      receiverReadyFlags.delete(key)
    }
  }
  for (const [key, settle] of [...receiverReadyWaiters]) {
    if (key.startsWith(`${transferId}\u0000`) && key !== readyAttemptKey(transferId, shortId)) {
      receiverReadyWaiters.delete(key)
      settle(false)
    }
  }
  if (!legacyPeer) {
    const ready = await waitForReceiverReady(transferId, shortId)
    if (!ready) {
      const signal = transferSignals.get(transferId)
      if (signal?.cancelled) {
        throw new TransferCancelledError()
      }
      throw new Error('接收端未就绪（存储准备超时）')
    }
  }

  // Zero-byte files: no chunks follow. Synthesize the (1,1) tick so the UI
  // doesn't render NaN%. v1 tops out at `delivered`; v2/v3 wait for
  // `transfer-done(bytes: 0)` before claiming `saved` — the hard contract
  // says only transfer-done promotes to saved.
  if (file.size === 0) {
    callbacks?.onProgress?.(1, 1)
    callbacks?.onDeliveryState?.('queued')
    callbacks?.onDeliveryState?.('delivered')
    if (legacyPeer) {
      await updateTransfer(transferId, { status: 'completed' })
      return { state: 'delivered', acked: false, legacyPeer: true }
    }
    const settled = await waitForReceiverAck(task, RECEIVER_ACK_TIMEOUT_MS)
    if (settled === 'cancelled') throw new TransferCancelledError()
    if (settled === 'ack') {
      callbacks?.onDeliveryState?.('saved')
      await updateTransfer(transferId, { status: 'completed' })
      clearReceiverReady(transferId)
      return { state: 'saved', acked: true, legacyPeer: false }
    }
    // timeout / unexpected: keep source for retry
    await updateTransfer(transferId, { status: 'completed' })
    clearReceiverReady(transferId)
    return { state: 'delivered', acked: false, legacyPeer: false }
  }

  callbacks?.onProgress?.(sent, totalChunks)

  // P0-3: synchronous "take a chunk index" — the sole point at which
  // `nextChunk` is mutated. JS is single-threaded so the read+increment
  // is already atomic at the language level, but we also filter on
  // `sentBitmap` so that the error-path rollback (`nextChunk = min(...)`
  // in laneLoop) cannot hand the same index to a fresh lane after a
  // healthy lane already shipped it.
  function acquireChunk(): number | null {
    while (nextChunk < totalChunks) {
      const idx = nextChunk++
      if (bitmapHas(skipBitmap, idx)) continue
      if (bitmapHas(sentBitmap, idx)) continue
      return idx
    }
    return null
  }
  // Kept the old name as an alias so the surrounding code reads
  // unchanged; the new behaviour is the additional sentBitmap filter.
  const nextIndex = acquireChunk

  // QUALITY-002: the per-chunk `await flushRecord()` is gone. It was an async
  // no-op — the sender holds the source File in memory for the duration of the
  // send and has no resume-from-IDB path — so every chunk paid a Promise +
  // microtask boundary for nothing, and its presence implied a sender-side
  // persistence contract that does not exist.

  // Pause/cancel check shared by the prefetcher and the send loop.
  // Returns true if the caller should abort the lane (cancelled / neutralised).
  async function checkSignals(): Promise<boolean> {
    if (isSendNeutralized(transferId)) {
      cancelled = true
      await updateTransfer(transferId, { status: 'failed' }).catch(() => {})
      return true
    }
    const signal = transferSignals.get(transferId)
    if (signal?.cancelled) {
      cancelled = true
      await updateTransfer(transferId, { status: 'failed' })
      return true
    }
    if (signal?.paused) {
      await updateTransfer(transferId, { status: 'paused' })
      await waitWhilePaused(transferId)
      if (isSendNeutralized(transferId)) {
        cancelled = true
        await updateTransfer(transferId, { status: 'failed' }).catch(() => {})
        return true
      }
      const s2 = transferSignals.get(transferId)
      if (s2?.cancelled) {
        cancelled = true
        await updateTransfer(transferId, { status: 'failed' })
        return true
      }
      await updateTransfer(transferId, { status: 'active' })
    }
    return false
  }

  /** Re-read cancel/neutralise after every await that can outlive a cancel. */
  function isAbortRequested(): boolean {
    if (cancelled || isSendNeutralized(transferId)) return true
    return !!transferSignals.get(transferId)?.cancelled
  }

  // Read + encrypt the next chunk for a lane. Returns null when the queue is
  // drained (or the transfer was cancelled mid-prep). Runs on its own
  // microtask so the previous chunk's dc.send can overlap with disk I/O and
  // AES-GCM — this is the core of the lane-level pipeline.
  async function prepareNext(): Promise<{ i: number; iv: Uint8Array; encrypted: ArrayBuffer } | null> {
    if (cancelled || isAbortRequested()) {
      cancelled = true
      return null
    }
    if (await checkSignals()) return null
    const i = nextIndex()
    if (i === null) return null
    const start = i * CHUNK_SIZE
    const end = Math.min(start + CHUNK_SIZE, file.size)
    const raw = await file.slice(start, end).arrayBuffer()
    // Cancel may land during slice; do not encrypt cancelled data.
    if (isAbortRequested()) {
      cancelled = true
      return null
    }
    // Domain prefix was derived once at engine start; only the 4-byte index
    // changes per chunk. Wire IV bytes are identical to the old per-chunk
    // SHA-256 path.
    const ivForChunk = makeChunkIv(domainIvPrefix, i)
    const plaintextLength = end - start
    const aad = useAad
      ? chunkAad(negotiated, transferId, shortId, i, plaintextLength)
      : undefined
    const { iv, encrypted } = await encryptChunk(raw, peerSessionId, ivForChunk, aad)
    // Cancel may land during encrypt; never hand the frame to laneLoop.
    if (isAbortRequested()) {
      cancelled = true
      return null
    }
    return { i, iv, encrypted }
  }

  async function laneLoop(dc: RTCDataChannel) {
    // Kick off the first chunk; from then on each iteration starts the next
    // chunk's prepare before awaiting the current chunk's send.
    let prepared = await prepareNext()
    while (prepared && !cancelled && !isAbortRequested()) {
      // If this lane has closed under us (NAT/firewall reset a single SCTP
      // stream), don't take the chunk off the queue with a doomed send.
      // Put it back so a healthy lane can pick it up.
      if (dc.readyState !== 'open') {
        nextChunk = Math.min(nextChunk, prepared.i)
        return
      }
      const current = prepared
      // Start preparing the next chunk in the background; we'll await it at
      // the top of the next iteration. dc.send / waitForBuffer below now
      // runs in parallel with the next disk read + AES-GCM encrypt.
      const upcoming = prepareNext()

      const packet = encodeChunkFrame(shortId, current.i, current.iv, current.encrypted)
      try {
        // Link buffer wait to cancel/neutralise so we do not park for 30s
        // after the user already aborted.
        const sig = getSignal(transferId)
        const ac = new AbortController()
        sig.bufferAbort = ac
        try {
          await waitForBuffer(dc, {
            timeoutMs: WAIT_FOR_BUFFER_TIMEOUT_MS,
            signal: ac.signal,
          })
        } finally {
          if (sig.bufferAbort === ac) sig.bufferAbort = undefined
        }
        // Cancel / neutralise during backpressure: drop the packet. Do not
        // re-queue — the transfer is dead and must not transmit.
        if (cancelled || isAbortRequested()) {
          cancelled = true
          return
        }
        if (dc.readyState !== 'open') throw new Error('lane closed')
        // Hard wire gate: neutralised sends never leave the device.
        if (isSendNeutralized(transferId)) {
          cancelled = true
          return
        }
        dc.send(packet)
      } catch (laneErr) {
        // Cancel/neutralise aborted the buffer wait — exit without re-queue.
        if (cancelled || isAbortRequested() || isSendNeutralized(transferId)) {
          cancelled = true
          return
        }
        if (laneErr instanceof DOMException && laneErr.name === 'AbortError') {
          cancelled = true
          return
        }
        // Don't abort the whole transfer for a single bad lane — re-queue
        // this index and exit this lane. Healthy lanes pick up the slack.
        console.warn('[transfer] lane send failed, re-queueing chunk', current.i, laneErr)
        nextChunk = Math.min(nextChunk, current.i)
        // Drain the upcoming so the encrypted bytes aren't lost — also
        // re-queue it.
        const orphan = await upcoming.catch(() => null)
        if (orphan) {
          nextChunk = Math.min(nextChunk, orphan.i)
        }
        return
      }

      bitmapSet(sentBitmap, current.i)
      markCovered(current.i)
      if (shouldFlushProgress(lastProgressAt, sent, totalChunks)) {
        callbacks?.onProgress?.(sent, totalChunks)
        lastProgressAt = performance.now()
      }

      prepared = await upcoming
    }
  }

  // Outer loop. Two things can send us round again, and BOTH must be handled
  // by the SAME engine rather than by a second one (BUG-013 + BUG-014):
  //
  //   1. a repair request that lands while the lanes are still running or
  //      parked in `waitWhilePaused`;
  //   2. a repair request that lands AFTER every chunk was queued, while we
  //      are parked waiting for the receiver's finalization ACK. This is the
  //      normal shape of a receiver pause: the SCTP queue was already full, so
  //      the sender is "done" by the time the receiver notices what it lost.
  for (let round = 0; round < MAX_REPAIR_ROUNDS; round++) {
    repairRequested = false
    // Use allSettled: one lane's hard failure now triggers a re-queue + lane
    // exit (see laneLoop above), but the OTHER lanes must keep draining.
    await Promise.allSettled(activeLanes.map(lane => laneLoop(lane)))

    // Cancelled mid-flight: checkSignals already set status='failed'. Surface
    // it as a thrown error so the caller takes the abort path instead of
    // reporting a false "sent" success.
    if (cancelled) {
      clearReceiverReady(transferId)
      throw new TransferCancelledError()
    }
    if (repairRequested && activeLanes.some(dc => dc.readyState === 'open')) continue
    // If we exited with anything still un-sent (all lanes died), fail loudly.
    if (sent < totalChunks) {
      throw new Error(`传输中断：${totalChunks - sent} 个分片未送达`)
    }

    // ── BUG-016: queued → delivered → saved ───────────────────────────
    callbacks?.onDeliveryState?.('queued')
    await drainLanes(activeLanes, transferId)
    if (cancelled || isAbortRequested()) {
      clearReceiverReady(transferId)
      throw new TransferCancelledError()
    }
    if (repairRequested) continue
    callbacks?.onDeliveryState?.('delivered')

    if (legacyPeer) {
      // A v1 peer will never ACK. Legacy semantics: local drain is as good as
      // it gets — but we report it honestly as `delivered`, not `saved`.
      await updateTransfer(transferId, { status: 'completed' })
      clearReceiverReady(transferId)
      return { state: 'delivered', acked: false, legacyPeer: true }
    }

    const settled = await waitForReceiverAck(task, RECEIVER_ACK_TIMEOUT_MS)
    if (settled === 'repair') continue
    if (settled === 'cancelled') {
      clearReceiverReady(transferId)
      throw new TransferCancelledError()
    }
    if (settled === 'timeout') {
      // No ACK: the receive side may still be writing, or the link died
      // between our last send and its durable write. Do NOT claim `saved`;
      // the caller keeps the source File so the user can retry. Task stays
      // registered so a late transfer-done can still promote to saved.
      await updateTransfer(transferId, { status: 'completed' })
      clearReceiverReady(transferId)
      return { state: 'delivered', acked: false, legacyPeer: false }
    }
    callbacks?.onDeliveryState?.('saved')
    await updateTransfer(transferId, { status: 'completed' })
    clearReceiverReady(transferId)
    return { state: 'saved', acked: true, legacyPeer: false }
  }

  if (cancelled) {
    clearReceiverReady(transferId)
    throw new TransferCancelledError()
  }
  throw new Error(`传输中断：修复轮次超过上限（${MAX_REPAIR_ROUNDS}）`)
}

// A repair storm must terminate: each round can only re-queue indexes the
// receiver is still missing, so a healthy link converges in one or two.
const MAX_REPAIR_ROUNDS = 8

/**
 * Wait until every lane's SCTP buffer has drained (or the lane died).
 * A timeout is a structured delivery failure — never silently return and
 * let the caller claim `delivered`.
 */
async function drainLanes(
  lanes: RTCDataChannel[],
  transferId?: string,
): Promise<void> {
  // NO-PROGRESS budget: renewed whenever bufferedAmount decreases. A healthy
  // low-bandwidth link that keeps draining must not fail at a hard wall clock.
  for (const dc of lanes) {
    let lastAmount = dc.bufferedAmount
    let lastProgressAt = Date.now()
    while (dc.readyState === 'open' && dc.bufferedAmount > 0) {
      if (transferId && (isSendNeutralized(transferId) || transferSignals.get(transferId)?.cancelled)) {
        throw new TransferCancelledError()
      }
      if (Date.now() - lastProgressAt > laneDrainTimeoutMs) {
        throw new LaneDrainTimeoutError()
      }
      try {
        const ac = transferId ? new AbortController() : undefined
        if (transferId && ac) {
          const sig = getSignal(transferId)
          sig.bufferAbort = ac
        }
        try {
          await waitForBuffer(dc, {
            // Cap each park with the same no-progress budget; progress renews
            // both here (outer loop) and inside waitForBuffer.
            timeoutMs: laneDrainTimeoutMs,
            signal: ac?.signal,
          })
        } finally {
          if (transferId && ac) {
            const sig = transferSignals.get(transferId)
            if (sig?.bufferAbort === ac) sig.bufferAbort = undefined
          }
        }
      } catch (err) {
        if (transferId && (isSendNeutralized(transferId) || transferSignals.get(transferId)?.cancelled)) {
          throw new TransferCancelledError()
        }
        if (err instanceof DOMException && err.name === 'AbortError') {
          throw new TransferCancelledError()
        }
        if (err instanceof BufferWaitTimeoutError) {
          throw new LaneDrainTimeoutError(
            err.message || '数据通道排空超时，无法确认送达',
          )
        }
        throw err
      }
      if (dc.bufferedAmount < lastAmount) {
        lastAmount = dc.bufferedAmount
        lastProgressAt = Date.now()
      }
      if (dc.bufferedAmount === 0) break
      await new Promise(r => setTimeout(r, 20))
    }
  }
}

type AckOutcome = 'ack' | 'repair' | 'cancelled' | 'timeout'

/**
 * Park until the receiver confirms a durable write — OR asks for a repair, OR
 * the transfer is cancelled, OR we give up. Repair has to be able to interrupt
 * this wait: after a receiver pause the sender is typically already "done"
 * (every chunk handed to SCTP) by the time the receiver discovers what it lost,
 * so the repair request arrives while we are sitting here (BUG-013).
 */
function waitForReceiverAck(task: SendTask, timeoutMs: number): Promise<AckOutcome> {
  if (task.acked) return Promise.resolve('ack')
  return new Promise<AckOutcome>(resolve => {
    const finish = (outcome: AckOutcome) => {
      clearTimeout(timer)
      clearInterval(poll)
      if (task.notifyAck === onAck) task.notifyAck = undefined
      if (task.notifyRepair === onRepair) task.notifyRepair = undefined
      resolve(outcome)
    }
    const timer = setTimeout(() => finish('timeout'), timeoutMs)
    // Cancellation reaches the engine through the shared signal map, which has
    // no notifier of its own; a cheap poll keeps this wait interruptible
    // without adding another callback channel to the signal shape.
    const poll = setInterval(() => {
      if (transferSignals.get(task.transferId)?.cancelled) finish('cancelled')
    }, 50)
    const onAck = () => finish('ack')
    const onRepair = () => finish('repair')
    task.notifyAck = onAck
    task.notifyRepair = onRepair
  })
}

// ── Receiver-ready barrier (BUG-011) ─────────────────────────────────
// The sender parks here between `meta` and the first chunk until the receiver
// says its storage backend is committed. Keyed by (transferId, shortId) so a
// superseded attempt's late ready cannot unlock the next attempt.

export const RECEIVER_READY_TIMEOUT_MS = 30_000

function readyAttemptKey(transferId: string, shortId: number): string {
  return `${transferId}\u0000${shortId >>> 0}`
}

// Cleanup owner: clearReceiverReady / markReceiverRejected / registry.reset
export const receiverReadyWaiters = new Map<string, (ready: boolean) => void>()
// Cleanup owner: clearReceiverReady / registry.reset
export const receiverReadyFlags = new Set<string>()

/** Receiver ACKed `transfer-ready`. Ownership-checked; shortId REQUIRED. */
export function markReceiverReady(
  transferId: string,
  shortId: number,
  owner: TransferOwner | undefined,
): boolean {
  if (!assertTransferOwner(transferId, owner)) return false
  if (!Number.isSafeInteger(shortId)) return false
  const task = sendTasks.get(transferId)
  // Require a live (or just-started) send task whose shortId matches this
  // attempt. Unknown / wrong shortId must not unlock a different attempt.
  if (!task || task.shortId !== (shortId >>> 0)) return false
  if (owner && task.peerSessionId !== owner.peerSessionId) return false
  const key = readyAttemptKey(transferId, shortId)
  receiverReadyFlags.add(key)
  const settle = receiverReadyWaiters.get(key)
  receiverReadyWaiters.delete(key)
  settle?.(true)
  return true
}

/** Receiver refused the transfer up-front — unpark the sender immediately. */
export function markReceiverRejected(transferId: string, owner: TransferOwner | undefined): boolean {
  if (!assertTransferOwner(transferId, owner)) return false
  const task = sendTasks.get(transferId)
  // Wake every waiter for this transferId (any shortId) as a hard reject.
  for (const [key, settle] of [...receiverReadyWaiters]) {
    if (key === transferId || key.startsWith(`${transferId}\u0000`)) {
      receiverReadyWaiters.delete(key)
      settle(false)
    }
  }
  for (const key of [...receiverReadyFlags]) {
    if (key === transferId || key.startsWith(`${transferId}\u0000`)) {
      receiverReadyFlags.delete(key)
    }
  }
  // Also refuse if there is no task at all (unknown id already failed assert).
  void task
  return true
}

export function clearReceiverReady(transferId: string) {
  for (const key of [...receiverReadyFlags]) {
    if (key === transferId || key.startsWith(`${transferId}\u0000`)) {
      receiverReadyFlags.delete(key)
    }
  }
  for (const [key, settle] of [...receiverReadyWaiters]) {
    if (key === transferId || key.startsWith(`${transferId}\u0000`)) {
      receiverReadyWaiters.delete(key)
      settle(false)
    }
  }
}

function waitForReceiverReady(
  transferId: string,
  shortId: number,
  timeoutMs = RECEIVER_READY_TIMEOUT_MS,
): Promise<boolean> {
  const key = readyAttemptKey(transferId, shortId)
  if (receiverReadyFlags.has(key)) return Promise.resolve(true)
  return new Promise<boolean>(resolve => {
    const timer = setTimeout(() => {
      if (receiverReadyWaiters.get(key) === settle) receiverReadyWaiters.delete(key)
      resolve(false)
    }, timeoutMs)
    const settle = (ready: boolean) => {
      clearTimeout(timer)
      resolve(ready)
    }
    receiverReadyWaiters.set(key, settle)
  })
}

// ── Peer-driven control plane (SECURITY-015) ─────────────────────────
// The three functions above are LOCAL intent (this user clicked pause). The
// three below carry intent that arrived over the DataChannel and therefore
// must prove ownership first: `peerNodeId` is shared by every device of one
// identity, so without a `(peerSessionId, epoch)` check a third device in the
// same cluster could pause or cancel a transfer between two others simply by
// guessing (or observing) its transferId. Each returns whether it was applied
// so the caller can decide whether to mirror the state into the UI.

export function applyPeerPause(transferId: string, owner: TransferOwner | undefined): boolean {
  if (!assertTransferOwner(transferId, owner)) return false
  pauseTransfer(transferId)
  return true
}

export function applyPeerResume(transferId: string, owner: TransferOwner | undefined): boolean {
  if (!assertTransferOwner(transferId, owner)) return false
  resumeTransfer(transferId)
  return true
}

export function applyPeerCancel(transferId: string, owner: TransferOwner | undefined): boolean {
  if (!assertTransferOwner(transferId, owner)) return false
  cancelTransfer(transferId)
  clearReceiverReady(transferId)
  return true
}
