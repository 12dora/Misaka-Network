/**
 * transfer/receive-engine.ts — session, per-index in-flight, fixed persistence order, unified finalize.
 *
 * Module-global state cleanup owners:
 *   receiveSessions          → finalizeReceive / abortInboundTransfer / forgetTransfer / reset
 *   backendPreparations      → prepareReceiveBackend finally / forgetTransfer / reset
 *   terminalCleanupJobs      → clearTerminalCleanupJob / forceResidual / reset (timers cancelled)
 *   pendingCompletedResults  → OPEN: takePendingCompletedResult / clearPendingCompleted;
 *                              intentionally survives resetTransferModuleState
 *   terminalCleanup intents  → OPEN: localStorage key misaka.terminalCleanupIntents;
 *                              survives forgetTransfer (by design); cleared on successful cleanup
 *
 * Fixed receive order: decrypt → durable write → set bitmap → persist bitmap → progress.
 * finalizeReceive = single successful terminal API across FSA/OPFS/IDB.
 * abortInboundTransfer = single abnormal terminal API.
 */
import {
  saveTransfer, updateTransfer, getTransfer, getActiveTransfers,
  saveChunk, getChunk, deleteChunks, getSavedChunkIndexes,
  pruneTerminalTransfers,
  type TransferRecord,
} from '../db'
import {
  decryptChunk, decryptChunkFrame, chunkAad,
} from '../crypto'
import {
  TRANSFER_PROGRESS_INTERVAL_MS, TRANSFER_RECORD_INTERVAL_MS,
  MAX_INMEMORY_RECEIVE_BYTES,
} from '@/constants'
import {
  newBitmap, bitmapSet, bitmapHas, bitmapPopcount,
  bitmapFromIndexes, bitmapToRanges, rangesToBitmap,
  preferRangesOverIndexes,
} from '../chunk-bitmap'
import {
  AAD_PROTOCOL_VERSION, CHUNK_FRAME_IV_LENGTH,
  LEGACY_PROTOCOL_VERSION, expectedChunkLength, isValidChunkIndex,
  setPeerProtocolVersion, negotiatedProtocolVersion,
  type MetaMessage, type RepairRequest, type ResumeRequest,
} from './protocol'
import {
  assertTransferOwner, registerTransferOwner, clearTransferOwner,
  transferOwners, TransferOwnershipError,
  type TransferOwner,
} from './ownership'
import {
  transferSignals, cancelTransfer,
} from './flow-control'
import {
  clearReceiverReady, sendTasks, hasLiveSendTask,
} from './send-engine'
import {
  supportsOPFS, getOPFSHandle, writeChunkToOPFS, getOPFSFile,
  removeOPFSEntry, cleanupOPFS, opfsHandles,
} from './storage/opfs'
import {
  supportsFileSystemAccess, streamChunkToDisk, finalizeStreamedFile,
  cancelStreamWrite, writeHandles,
} from './storage/fsa'
import { selectWritableBackend } from './storage/backend'
import { isQuotaExceeded, StorageQuotaExceededError } from './storage/shared'

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

// ── Receive file ─────────────────────────────────────────────────────

export interface ReceiveCallbacks {
  onMeta?: (meta: MetaMessage) => void
  onProgress?: (received: number, total: number) => void
  onError?: (error: string) => void
}

type ReceiveSession = {
  transferId: string
  /** SECURITY-015: the ONE peer session allowed to drive this transfer. */
  peerSessionId: string
  epoch: number
  peerNodeId: number
  fileName: string
  fileSize: number
  fileHash: string
  totalChunks: number
  mime: string
  shortId: number
  /** Negotiated protocol version frozen at meta time for AAD decisions. */
  protocolVersion: number
  // Bit-array (length = ceil(totalChunks/8)) of chunk indexes already
  // accepted. Replaces a Set<number> which was ~50 B per chunk — a 1 TB
  // transfer used to need ~800 MB just for tracking. Now it's ~2 MB.
  // Backed by a plain ArrayBuffer (never SharedArrayBuffer) so it
  // round-trips through IDB structured clone without TS variance issues.
  received: Uint8Array<ArrayBuffer>
  receivedCount: number
  lastRecordAt: number
  lastProgressAt: number   // throttle React store updates — 4000 setState/GB otherwise
  storageMode: 'pending' | 'stream' | 'indexeddb'
  /** The backend `prepareReceiveBackend` actually COMMITTED (BUG-011/012).
   *  Until this is non-null no chunk may be written anywhere. */
  backend: 'fsa' | 'opfs' | 'idb' | null
  /** Cached committed-backend result so late duplicate meta is idempotent. */
  preparedResult: { ok: true; mode: 'fsa' | 'opfs' | 'idb' } | { ok: false; rejection: MetaRejection } | null
  direction: 'recv'
  // P0-2: track every saveChunk promise we kick off so `cancelReceive`
  // can drain them BEFORE deleteChunks runs.
  inflightSaves: Set<Promise<unknown>>
  /** Per-index in-flight save promises — concurrent duplicate frames share one. */
  inflightByIndex: Map<number, Promise<{ decrypted: ArrayBuffer; storageMode: 'stream' | 'indexeddb'; done: boolean } | undefined>>
  /** BUG-011: chunks that arrived before the backend was committed. Bounded
   *  by frame count AND byte budget (never by trusting totalChunks). */
  buffered: Array<{ index: number; iv: Uint8Array<ArrayBuffer>; encrypted: ArrayBuffer }>
  /** O(1) membership for pre-commit frames (avoids linear buffered.some). */
  bufferedIndexes: Set<number>
  /** Running ciphertext+iv byte total of the pre-commit buffer. */
  bufferedBytes: number
  /** BUG-013: indexes dropped because the receiver was paused. These become
   *  the `transfer-repair` request on resume. */
  droppedWhilePaused: Uint8Array<ArrayBuffer>
  droppedCount: number
  /** BUG-018: set by `finalizeReceive` so a second completion is a no-op. */
  finalized: boolean
  /** Generation token for stale preparation detection. */
  attemptToken: number
}

// Cleanup owner: finalizeReceive / abortInboundTransfer / forgetTransfer / reset
export const receiveSessions = new Map<string, ReceiveSession>()

// BUG-011: pre-commit buffer is bounded by BOTH frame count and total bytes.
// 32 × ~252 KB ≈ 8 MB — enough for a legacy (v1) sender that starts blasting
// the moment it has sent `meta`, without giving a hostile peer an unbounded
// (or totalChunks-proportional) memory sink. v2+ overflow is recovered via
// repair; v1 overflow rejects the transfer rather than OOM or silent drop.
const MAX_BUFFERED_PRECOMMIT_FRAMES = 32
/** Hard byte cap for pre-commit ciphertext (~8 MiB). */
export const MAX_BUFFERED_PRECOMMIT_BYTES = 8 * 1024 * 1024

export function getReceiveSession(transferId: string): ReceiveSession | undefined {
  return receiveSessions.get(transferId)
}

/**
 * Reason why a transfer's meta should be rejected before any chunks land.
 */
export interface MetaRejection {
  reason: 'too-large-for-fallback' | 'invalid-metadata' | 'owner-mismatch' | 'no-writable-backend'
  message: string
  limitBytes?: number
}

/**
 * BUG-012: the in-memory ceiling applies to the backend we actually COMMITTED,
 * not to whether an API exists. `supportsFileSystemAccess()` is true on every
 * Chromium tab, including ones where the save picker will be refused for want
 * of user activation; `supportsOPFS()` is true on iOS Safari <17 where
 * `createWritable()` throws. Both cases silently fell back to the IndexedDB
 * whole-file assemble — the exact path the cap exists to protect — while the
 * guard had already waved the transfer through.
 *
 * Call this with the committed mode from `prepareReceiveBackend`.
 */
export function checkBackendOOMGuard(
  fileSize: number,
  committedMode: 'fsa' | 'opfs' | 'idb',
): MetaRejection | null {
  // A committed streaming backend never materialises the whole file in memory.
  if (committedMode !== 'idb') return null
  if (fileSize <= MAX_INMEMORY_RECEIVE_BYTES) return null
  const mb = Math.round(fileSize / (1024 * 1024))
  const limitMb = Math.round(MAX_INMEMORY_RECEIVE_BYTES / (1024 * 1024))
  return {
    reason: 'too-large-for-fallback',
    message: `文件大小 ${mb} MB 超出当前浏览器的内存接收上限（${limitMb} MB）。请使用 Chrome / Edge 或升级 Firefox 到 111+ 以支持大文件流式落盘。`,
    limitBytes: MAX_INMEMORY_RECEIVE_BYTES,
  }
}

/**
 * Legacy pre-flight guard, kept for callers that want a cheap "is this
 * hopeless?" answer BEFORE running the (async, possibly user-prompting)
 * backend preparation. It is intentionally optimistic — the authoritative
 * decision is `checkBackendOOMGuard` against the committed backend.
 */
export function checkMetaOOMGuard(meta: Pick<MetaMessage, 'fileSize'>): MetaRejection | null {
  if (meta.fileSize <= MAX_INMEMORY_RECEIVE_BYTES) return null
  if (supportsFileSystemAccess()) return null
  if (supportsOPFS()) return null
  return checkBackendOOMGuard(meta.fileSize, 'idb')
}

/**
 * Register (or re-attach to) a receive session.
 *
 * SECURITY-007: `msg` MUST already have passed `validateMetaMessage`. Callers
 * that take a raw wire value should use `acceptIncomingMeta`, which does both.
 *
 * SECURITY-015: `owner` is the `(peerSessionId, epoch)` pair the message
 * arrived on. A second `meta` for the same id from a different session, or
 * one that changes immutable geometry, throws `TransferOwnershipError`.
 */
export async function handleMetaMessage(
  msg: MetaMessage,
  peerNodeId: number,
  owner: TransferOwner = { peerSessionId: '', epoch: 0 },
): Promise<ReceiveSession> {
  const existing = receiveSessions.get(msg.transferId)
  if (existing) {
    if (existing.peerSessionId !== owner.peerSessionId || existing.epoch !== owner.epoch) {
      throw new TransferOwnershipError(
        'owner-mismatch',
        '该传输 ID 属于另一个会话，已拒绝',
      )
    }
    if (
      existing.fileName !== msg.fileName
      || existing.fileSize !== msg.fileSize
      || existing.totalChunks !== msg.totalChunks
    ) {
      throw new TransferOwnershipError(
        'metadata-mismatch',
        '该传输 ID 的元数据与首次声明不一致，已拒绝',
      )
    }
    // Same geometry, possibly a new attempt shortId (v3 AAD identity).
    // Always adopt the latest shortId so resumed frames authenticate.
    // Caller (network demux) must retire the old shortId mapping — we only
    // update the session field here.
    if (typeof msg.shortId === 'number' && msg.shortId !== existing.shortId) {
      existing.shortId = msg.shortId >>> 0
    }
    if (msg.v !== undefined && owner.peerSessionId) {
      setPeerProtocolVersion(owner.peerSessionId, msg.v)
      existing.protocolVersion = negotiatedProtocolVersion(owner.peerSessionId)
    }
    return existing
  }

  // A persisted record from an earlier session pins the owner too: whoever
  // reconnects with this transferId must be the session that created it.
  const priorOwner = transferOwners.get(msg.transferId)
  if (priorOwner && priorOwner.peerSessionId !== owner.peerSessionId) {
    throw new TransferOwnershipError('owner-mismatch', '该传输 ID 属于另一个会话，已拒绝')
  }

  // CRITICAL: register the session SYNCHRONOUSLY before any await. The
  // DataChannel's onmessage queues meta + chunks back-to-back; if we await
  // any I/O before set()ing receiveSessions, the very next message (a
  // chunk for the same transfer on the same lane) reaches receiveChunk
  // BEFORE the session exists and gets silently dropped.
  if (msg.v !== undefined && owner.peerSessionId) {
    setPeerProtocolVersion(owner.peerSessionId, msg.v)
  }
  const session: ReceiveSession = {
    transferId: msg.transferId,
    peerSessionId: owner.peerSessionId,
    epoch: owner.epoch,
    peerNodeId,
    fileName: msg.fileName,
    fileSize: msg.fileSize,
    fileHash: msg.fileHash,
    totalChunks: msg.totalChunks,
    mime: msg.mime,
    shortId: msg.shortId,
    protocolVersion: owner.peerSessionId
      ? negotiatedProtocolVersion(owner.peerSessionId)
      : LEGACY_PROTOCOL_VERSION,
    received: newBitmap(msg.totalChunks),
    receivedCount: 0,
    lastRecordAt: performance.now(),
    lastProgressAt: 0,
    storageMode: 'pending',
    backend: null,
    preparedResult: null,
    direction: 'recv',
    inflightSaves: new Set(),
    inflightByIndex: new Map(),
    buffered: [],
    bufferedIndexes: new Set(),
    bufferedBytes: 0,
    droppedWhilePaused: newBitmap(msg.totalChunks),
    droppedCount: 0,
    finalized: false,
    attemptToken: 1,
  }
  receiveSessions.set(msg.transferId, session)
  registerTransferOwner(msg.transferId, {
    peerSessionId: owner.peerSessionId,
    epoch: owner.epoch,
    direction: 'recv',
    fileName: msg.fileName,
    fileSize: msg.fileSize,
    totalChunks: msg.totalChunks,
  })
  // Resume-aware: if a TransferRecord already exists from a prior session
  // (page reload mid-transfer), restore the bitmap so subsequent chunk
  // arrivals can still hit the `received === total` completion gate.
  try {
    const prior = await getTransfer(msg.transferId)
    if (prior && prior.direction === 'recv') {
      // SECURITY-015: a persisted record whose owner disagrees is not ours to
      // resume. Ignore its bitmap rather than leaking what another session
      // already received.
      const sameOwner = !prior.peerSessionId || prior.peerSessionId === owner.peerSessionId
      const sameShape = prior.totalChunks === msg.totalChunks && prior.fileSize === msg.fileSize
      if (sameOwner && sameShape) {
        const fromRecord = bitmapFromRecord(prior)
        for (let i = 0; i < fromRecord.length && i < session.received.length; i++) {
          session.received[i] |= fromRecord[i]
        }
        const saved = await getSavedChunkIndexes(msg.transferId)
        for (const idx of saved) bitmapSet(session.received, idx)
        session.receivedCount = bitmapPopcount(session.received)
      }
    }
  } catch { /* fresh transfer */ }

  await saveTransfer({
    transferId: msg.transferId,
    direction: 'recv',
    peerNodeId,
    peerSessionId: owner.peerSessionId,
    epoch: owner.epoch,
    fileName: msg.fileName,
    fileSize: msg.fileSize,
    fileHash: msg.fileHash,
    totalChunks: msg.totalChunks,
    receivedChunks: [],
    receivedBitmap: session.received.buffer.slice(0),
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })

  return session
}

// ── Single in-flight backend preparation (BUG-011) ───────────────────
// `meta` is sent down EVERY lane, so up to TRANSFER_LANE_COUNT copies of it
// arrive nearly simultaneously. Each one used to kick off its own
// `prepareReceiveStorage()`; the last one to finish won the `opfsHandles`
// entry while chunks that had already landed went to IndexedDB, and delivery
// then preferred the (empty) OPFS file. Keyed by `(peerSessionId, transferId)`
// so one preparation is shared and its RESULT is what commits.

// Cleanup owner: prepareReceiveBackend finally / forgetTransfer / reset
export const backendPreparations = new Map<string, Promise<PrepareBackendResult>>()

export type PrepareBackendResult =
  | { ok: true; mode: 'fsa' | 'opfs' | 'idb'; completed?: boolean }
  | { ok: false; rejection: MetaRejection }

function preparationKey(owner: TransferOwner, transferId: string): string {
  return `${owner.peerSessionId}\u0000${transferId}`
}

/**
 * Select, PROVE-WRITABLE and commit a receive backend, then apply the
 * in-memory cap to the committed result (BUG-012). Concurrent calls for the
 * same `(peerSessionId, transferId)` share one preparation (BUG-011). Already-
 * committed results are returned idempotently (late duplicate meta).
 */
export function prepareReceiveBackend(
  meta: { transferId: string; fileName: string; totalChunks: number; size: number },
  owner: TransferOwner = { peerSessionId: '', epoch: 0 },
): Promise<PrepareBackendResult> {
  const session = receiveSessions.get(meta.transferId)
  if (session?.preparedResult) return Promise.resolve(session.preparedResult)
  if (session?.backend) {
    const result: PrepareBackendResult = { ok: true, mode: session.backend }
    session.preparedResult = result
    return Promise.resolve(result)
  }

  const key = preparationKey(owner, meta.transferId)
  const inFlight = backendPreparations.get(key)
  if (inFlight) return inFlight

  const attemptToken = session?.attemptToken ?? 0

  const task = (async (): Promise<PrepareBackendResult> => {
    const selected = await selectWritableBackend(meta)
    // Re-check session identity after the (possibly user-prompting) await.
    const live = receiveSessions.get(meta.transferId)
    if (
      !live
      || live.peerSessionId !== owner.peerSessionId
      || live.epoch !== owner.epoch
      || live.attemptToken !== attemptToken
    ) {
      // Cancelled / epoch-changed / superseded while the picker was open —
      // tear down any handle we just opened and refuse.
      if (selected === 'opfs') await cleanupOPFS(meta.transferId).catch(() => {})
      if (selected === 'fsa') await cancelStreamWrite(meta.transferId)
      return {
        ok: false,
        rejection: {
          reason: 'no-writable-backend',
          message: '接收已取消或会话已切换',
        },
      }
    }
    const rejection = checkBackendOOMGuard(meta.size, selected)
    if (rejection) {
      if (selected === 'opfs') await cleanupOPFS(meta.transferId).catch(() => {})
      if (selected === 'fsa') await cancelStreamWrite(meta.transferId)
      const fail: PrepareBackendResult = { ok: false, rejection }
      live.preparedResult = fail
      return fail
    }
    live.backend = selected
    live.storageMode = selected === 'idb' ? 'indexeddb' : 'stream'
    const flush = await flushBufferedChunks(live)
    if (flush.error) {
      const fail: PrepareBackendResult = {
        ok: false,
        rejection: {
          reason: 'no-writable-backend',
          message: flush.error,
        },
      }
      live.preparedResult = fail
      return fail
    }
    const ok: PrepareBackendResult = { ok: true, mode: selected }
    live.preparedResult = ok
    // Attach completion flag so the network layer can finalize a v1 file that
    // landed entirely in the pre-commit buffer.
    ;(ok as PrepareBackendResult & { completed?: boolean }).completed = flush.completed
    return ok
  })()

  backendPreparations.set(key, task)
  task.catch(() => {}).finally(() => {
    if (backendPreparations.get(key) === task) backendPreparations.delete(key)
  })
  return task
}

/** True once a writable backend has been committed for this transfer. */
export function isReceiveBackendReady(transferId: string): boolean {
  return receiveSessions.get(transferId)?.backend != null
}

export interface FlushBufferedResult {
  completed: boolean
  error?: string
}

async function flushBufferedChunks(session: ReceiveSession): Promise<FlushBufferedResult> {
  if (session.buffered.length === 0) {
    return { completed: session.receivedCount === session.totalChunks && session.totalChunks >= 0 }
  }
  const queued = session.buffered.slice().sort((a, b) => a.index - b.index)
  session.buffered.length = 0
  session.bufferedIndexes.clear()
  session.bufferedBytes = 0
  for (const frame of queued) {
    try {
      const result = await persistChunk(session, frame.index, frame.iv, frame.encrypted, session.peerSessionId)
      if (result?.done) return { completed: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn('[transfer] buffered chunk replay failed', frame.index, err)
      return { completed: false, error: message }
    }
  }
  return { completed: session.receivedCount === session.totalChunks && session.totalChunks > 0 }
}

/** Optional zero-copy frame view: decrypt from the original ArrayBuffer. */
export interface ReceiveFrameView {
  rawFrame: ArrayBuffer
  ivOffset: number
  cipherOffset: number
  cipherLength: number
}

export async function receiveChunk(
  transferId: string,
  index: number,
  iv: Uint8Array<ArrayBuffer>,
  encrypted: ArrayBuffer,
  peerSessionId: string,
  callbacks?: ReceiveCallbacks,
  frameView?: ReceiveFrameView,
): Promise<{ decrypted: ArrayBuffer; storageMode: 'stream' | 'indexeddb'; done: boolean } | undefined> {
  const session = receiveSessions.get(transferId)
  if (!session) return

  // SECURITY-015: only the owning peer session may push bytes into this
  // transfer. Without it, any peer that learns a transferId can inject
  // (undecryptable, but state-mutating) frames.
  if (session.peerSessionId && session.peerSessionId !== peerSessionId) return

  // SECURITY-007: bound the index BEFORE it can size an allocation or an
  // `index * CHUNK_SIZE` file offset.
  if (!isValidChunkIndex(index, session.totalChunks)) return

  const signal = transferSignals.get(transferId)
  if (signal?.cancelled) return
  if (signal?.paused) {
    // BUG-013: a receiver pause used to DROP in-flight chunks with no record
    // that they ever existed. The sender had already marked them sent, so the
    // transfer could never reach 100% again. Remember exactly what we dropped;
    // `buildRepairRequest` turns this into the re-send list on resume.
    if (!bitmapHas(session.received, index) && bitmapSet(session.droppedWhilePaused, index)) {
      session.droppedCount++
    }
    return
  }

  // P1-4: duplicate-chunk fast path (already durable).
  if (bitmapHas(session.received, index)) return

  // Per-index in-flight dedupe: concurrent lanes delivering the same index
  // share one persist promise so a slow duplicate cannot recreate orphan
  // chunks after finalizeReceive's deleteChunks.
  const inflight = session.inflightByIndex.get(index)
  if (inflight) return inflight

  // BUG-011: no backend committed yet → buffer, never guess. Writing to
  // IndexedDB "for now" is what produced half-IDB / half-OPFS files.
  // Bound by BYTES (not totalChunks) so a multi-GB legacy announcement cannot
  // fill page memory while the storage picker is pending.
  if (session.backend === null) {
    if (session.bufferedIndexes.has(index)) return
    // Prefer cipherLength from the frame view so we don't force a ciphertext copy.
    const cipherBytes = frameView?.cipherLength ?? encrypted.byteLength
    const frameBytes = cipherBytes + iv.byteLength
    const nextBytes = session.bufferedBytes + frameBytes
    if (
      session.buffered.length < MAX_BUFFERED_PRECOMMIT_FRAMES
      && nextBytes <= MAX_BUFFERED_PRECOMMIT_BYTES
    ) {
      // Buffer may need a detached ciphertext for later replay after the
      // DataChannel buffer is recycled; only slice when we actually park it.
      const stored = frameView
        ? frameView.rawFrame.slice(frameView.cipherOffset, frameView.cipherOffset + frameView.cipherLength)
        : encrypted
      session.buffered.push({ index, iv, encrypted: stored })
      session.bufferedIndexes.add(index)
      session.bufferedBytes = nextBytes
    } else if (session.protocolVersion < 2) {
      // v1 has no repair: over-cap is a hard reject so we never OOM or hang.
      throw new Error(
        `v1 预提交缓冲已满（>${MAX_BUFFERED_PRECOMMIT_BYTES} 字节 / ${MAX_BUFFERED_PRECOMMIT_FRAMES} 帧），请升级对端或选择磁盘后端后重试`,
      )
    }
    // v2+ overflow: dropped; transfer-repair recovers.
    return
  }

  const op = persistChunk(session, index, iv, encrypted, peerSessionId, callbacks, frameView)
  // Track the derived promise from finally so its rejection is handled; an
  // ignored finally() result is an unhandled rejection under Vitest.
  const tracked = op.finally(() => {
    if (session.inflightByIndex.get(index) === tracked) session.inflightByIndex.delete(index)
  })
  session.inflightByIndex.set(index, tracked)
  void tracked.catch(() => {})
  return tracked
}

/**
 * BUG-017: the durable write now happens BEFORE the bitmap is set and
 * persisted. The old order was decrypt → bitmap → persist bitmap → (return to
 * network.ts) → disk write, so a crash or a disk failure in that window left a
 * resume bitmap claiming bytes that were never on disk. Resume then skipped
 * them and the receiver "successfully" delivered a sparse file.
 *
 * Order is now: decrypt → validate length → durable write → set bitmap →
 * persist bitmap → progress.
 */
async function persistChunk(
  session: ReceiveSession,
  index: number,
  iv: Uint8Array<ArrayBuffer>,
  encrypted: ArrayBuffer,
  peerSessionId: string,
  callbacks?: ReceiveCallbacks,
  frameView?: ReceiveFrameView,
): Promise<{ decrypted: ArrayBuffer; storageMode: 'stream' | 'indexeddb'; done: boolean } | undefined> {
  const transferId = session.transferId
  // P0-2: track the WHOLE receive-and-persist operation so cancelReceive
  // can drain in-flight work before deleteChunks.
  let opResolve!: () => void
  const opPromise = new Promise<void>(resolve => { opResolve = resolve })
  session.inflightSaves.add(opPromise)

  try {
    // AES-GCM authenticates the encrypted payload — no separate per-chunk
    // checksum is needed (and the sender no longer ships one). v3+ also
    // binds transferId/shortId/index/length as AAD so a frame cannot be
    // re-routed across indexes without the tag failing.
    const expected = expectedChunkLength(session.fileSize, index)
    const aad = session.protocolVersion >= AAD_PROTOCOL_VERSION
      ? chunkAad(
          session.protocolVersion, session.transferId, session.shortId,
          index, expected,
        )
      : undefined
    // Prefer zero-copy frame decrypt: worker slices ciphertext from the
    // original DataChannel buffer (no main-thread cipher copy).
    const decrypted = frameView
      ? await decryptChunkFrame(
          peerSessionId,
          frameView.rawFrame,
          frameView.ivOffset,
          CHUNK_FRAME_IV_LENGTH,
          frameView.cipherOffset,
          frameView.cipherLength,
          aad,
        )
      : await decryptChunk(iv, encrypted, peerSessionId, aad)

    // SECURITY-007: the plaintext length is fully determined by the declared
    // geometry. A chunk that disagrees would make the assembled file longer or
    // shorter than `fileSize` — silent corruption we must refuse.
    if (decrypted.byteLength !== expected) {
      throw new Error(`分片 ${index} 长度非法（${decrypted.byteLength}，应为 ${expected}）`)
    }

    const storageMode: 'stream' | 'indexeddb' = session.backend === 'idb' ? 'indexeddb' : 'stream'
    session.storageMode = storageMode

    // ── durable write FIRST ──
    if (storageMode === 'indexeddb') {
      try {
        await saveChunk(transferId, index, decrypted)
      } catch (err) {
        // P1-6: normalize QuotaExceededError into a uniform error string.
        // Route through the single abnormal terminal API (persist-first).
        if (isQuotaExceeded(err)) {
          void abortInboundTransfer(transferId, 'quota-exceeded')
          throw new StorageQuotaExceededError(err)
        }
        throw err
      }
    } else if (session.backend === 'fsa') {
      await streamChunkToDisk(transferId, index, decrypted)
    } else if (session.backend === 'opfs') {
      await writeChunkToOPFS(transferId, index, decrypted)
    }

    // ── only now is the chunk allowed to exist in the resume bitmap ──
    if (bitmapSet(session.received, index)) session.receivedCount++
    // A repaired chunk is no longer "dropped".
    if (bitmapHas(session.droppedWhilePaused, index)) {
      session.droppedWhilePaused[index >>> 3] &= ~(1 << (index & 7))
      session.droppedCount = Math.max(0, session.droppedCount - 1)
    }

    const done = session.receivedCount === session.totalChunks
    if (
      performance.now() - session.lastRecordAt >= TRANSFER_RECORD_INTERVAL_MS
      || done
    ) {
      await updateTransfer(transferId, {
        receivedChunks: [],
        receivedBitmap: session.received.buffer.slice(0),
        updatedAt: Date.now(),
      })
      session.lastRecordAt = performance.now()
    }

    // Throttle progress callbacks the same way the sender does. Always emit
    // the final tick so the completion hook in network.ts still runs.
    if (done || performance.now() - session.lastProgressAt >= TRANSFER_PROGRESS_INTERVAL_MS) {
      callbacks?.onProgress?.(session.receivedCount, session.totalChunks)
      session.lastProgressAt = performance.now()
    }

    return { decrypted, storageMode, done }
  } finally {
    session.inflightSaves.delete(opPromise)
    opResolve()
  }
}

/**
 * BUG-013: build the receiver's repair request. Includes both the chunks we
 * knowingly dropped while paused AND anything else still missing, so a single
 * message repairs a pause, a lane death and a reconnect identically.
 */
export function buildRepairRequest(transferId: string): RepairRequest | null {
  const session = receiveSessions.get(transferId)
  if (!session) return null
  const missing: Array<[number, number]> = []
  let runStart = -1
  for (let i = 0; i < session.totalChunks; i++) {
    const have = bitmapHas(session.received, i)
    if (!have && runStart < 0) runStart = i
    else if (have && runStart >= 0) { missing.push([runStart, i - runStart]); runStart = -1 }
  }
  if (runStart >= 0) missing.push([runStart, session.totalChunks - runStart])
  if (missing.length === 0) return null
  // Clear the drop ledger — the request we are about to send supersedes it.
  session.droppedWhilePaused = newBitmap(session.totalChunks)
  session.droppedCount = 0
  return { type: 'transfer-repair', transferId, missingRanges: missing }
}

/** How many chunks were dropped by a receiver-side pause and still need repair. */
export function droppedWhilePausedCount(transferId: string): number {
  return receiveSessions.get(transferId)?.droppedCount ?? 0
}

export async function assembleFile(transferId: string): Promise<File> {
  const session = receiveSessions.get(transferId)
  if (!session) throw new Error('No receive session')

  const chunks: BlobPart[] = []
  for (let i = 0; i < session.totalChunks; i++) {
    const data = await getChunk(transferId, i)
    if (!data) throw new Error(`Missing chunk ${i}`)
    chunks.push(new Uint8Array(data as ArrayBuffer))
  }

  const blob = new Blob(chunks, { type: session.mime })
  // AES-GCM auth tags on each chunk are the integrity check — any tampered
  // or truncated chunk would have failed decrypt above.
  return new File([blob], session.fileName, { type: session.mime })
}

// ── The one terminal completion API (BUG-018) ────────────────────────
// Every successful receive — IDB, FSA or OPFS — funnels through here. It is
// the single place that closes the backend, verifies the artefact, deletes the
// on-disk remnants, retires the DB row and drops the in-memory session. The
// old code had three ad-hoc variants; the OPFS one lost the file-name handle
// before it could `removeEntry`, so the origin-private copy, the `active` DB
// row, the receive session and the bitmap all accumulated forever.

export interface FinalizeResult {
  file: File
  bytes: number
  backend: 'fsa' | 'opfs' | 'idb'
  /** Release backend storage after the user-facing artefact is no longer needed. */
  cleanup?: () => Promise<void>
}

export class TransferIntegrityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TransferIntegrityError'
  }
}

export async function finalizeReceive(transferId: string): Promise<FinalizeResult> {
  const session = receiveSessions.get(transferId)
  if (!session) throw new Error('No receive session')
  if (session.finalized) throw new Error('Transfer already finalized')

  // Drain every in-flight save BEFORE checking completeness / closing
  // backends, so a slow concurrent duplicate cannot recreate orphan chunks
  // after deleteChunks.
  if (session.inflightSaves.size > 0) {
    await Promise.allSettled(Array.from(session.inflightSaves))
  }
  if (session.inflightByIndex.size > 0) {
    await Promise.allSettled(Array.from(session.inflightByIndex.values()))
  }

  // Never finalize a transfer that is not actually complete — that is how a
  // sparse file used to reach the user.
  if (session.receivedCount !== session.totalChunks) {
    throw new TransferIntegrityError(
      `传输不完整：${session.totalChunks - session.receivedCount} 个分片缺失`,
    )
  }
  session.finalized = true

  const backend = session.backend ?? 'idb'
  // Capture the OPFS entry name BEFORE any handle release. BUG-018: cleanup
  // used to look the name up from a handle that finalize had already dropped.
  const opfsEntryName = backend === 'opfs' ? getOPFSHandle(transferId)?.fileName : undefined
  let file: File
  try {
    if (backend === 'fsa') {
      // Drain+close writable, but KEEP the handle map entry until the
      // terminal row is durable so a failed persist can retry getFile.
      file = await finalizeStreamedFile(transferId, { releaseHandle: false })
    } else if (backend === 'opfs') {
      file = await getOPFSFile(transferId, { releaseHandle: false })
    } else {
      file = await assembleFile(transferId)
    }
  } catch (err) {
    session.finalized = false
    throw err
  }

  // BUG-017 final gate: the artefact must be exactly as large as declared.
  if (file.size !== session.fileSize) {
    session.finalized = false
    throw new TransferIntegrityError(
      `文件大小校验失败：实际 ${file.size} 字节，应为 ${session.fileSize} 字节`,
    )
  }

  // Some backends hand back a handle-derived name; always deliver under the
  // sanitised name we validated at `meta` time.
  const named = file.name === session.fileName
    ? file
    : new File([file], session.fileName, { type: session.mime })

  // OPFS File objects are lazy views over the directory entry. Deleting the
  // entry here makes the just-created object URL fail with NotFoundError (and
  // browsers report the download as cancelled). Transfer ownership/session
  // state can retire now, but the entry itself is released by the UI when the
  // download URL is consumed, pruned or the network epoch ends.
  const cleanup = backend === 'opfs' && opfsEntryName
    ? async () => { await removeOPFSEntry(transferId, opfsEntryName).catch(() => {}) }
    : undefined

  // ── terminal status + cleanup ──
  // A successful assembly must NEVER be undone by a status-write failure.
  // Deliver the file to the caller regardless; retry only the durable row /
  // chunk cleanup without destroying the completed OPFS/IDB artefact.
  try {
    await updateTransfer(transferId, { status: 'completed' })
  } catch (err) {
    // Keep session + handles + finalized so a retry can re-read the artefact.
    // Persist cleanup INTENT durably so a tab close cannot erase the only job.
    stashPendingCompleted(transferId, { file: named, bytes: named.size, backend, cleanup })
    persistTerminalCleanupIntent(transferId, 'completed')
    scheduleTerminalCleanup(transferId, 'completed', 'finalize-persist-failed')
    // Return the assembled file — do not throw into abortInboundTransfer.
    return { file: named, bytes: named.size, backend, cleanup }
  }

  // Terminal row is durable — now it is safe to drop recovery handles/chunks
  // (but NOT the OPFS entry the user may still download).
  if (backend === 'fsa') writeHandles.delete(transferId)
  if (backend === 'opfs') opfsHandles.delete(transferId)

  try {
    await deleteChunks(transferId)
  } catch (err) {
    console.warn('[transfer] deleteChunks after finalize failed', transferId, err)
    persistTerminalCleanupIntent(transferId, 'completed')
    scheduleTerminalCleanup(transferId, 'completed', 'delete-chunks-failed')
  }
  receiveSessions.delete(transferId)
  transferSignals.delete(transferId)
  clearTransferOwner(transferId)
  clearReceiverReady(transferId)
  clearPendingCompleted(transferId)
  clearTerminalCleanupIntent(transferId)
  // Terminal rows have no consumer (QUALITY-001) — prune opportunistically so
  // the policy runs without a separate scheduler.
  try {
    const p = pruneTerminalTransfers()
    if (p && typeof (p as Promise<unknown>).then === 'function') {
      void (p as Promise<unknown>).catch(() => {})
    }
  } catch { /* mock / missing export */ }

  return { file: named, bytes: named.size, backend, cleanup }
}

// ── Retryable terminal cleanup (abnormal + failed-persist) ───────────
// Every abnormal death must go through one machine: persist terminal status
// first, then backends, then chunks, then session. A failed step schedules a
// bounded retry rather than either (a) deleting data before a durable row or
// (b) retaining storage/handles forever with no progress.
//
// COMPLETED path is special: assembly already succeeded and the user must
// receive the artefact. Cleanup may only retry the durable row + chunk store
// — never destroy OPFS/FSA/IDB assembled bytes.

const TERMINAL_CLEANUP_MAX_ATTEMPTS = 8
const TERMINAL_CLEANUP_BASE_DELAY_MS = 50
const TERMINAL_CLEANUP_INTENT_KEY = 'misaka.terminalCleanupIntents'

type TerminalCleanupKind = 'failed' | 'completed'

interface TerminalCleanupJob {
  transferId: string
  kind: TerminalCleanupKind
  reason: string
  attempts: number
  timer?: ReturnType<typeof setTimeout>
}

interface PendingCompletedResult {
  file: File
  bytes: number
  backend: 'fsa' | 'opfs' | 'idb'
  cleanup?: () => Promise<void>
}

// Cleanup owner: clearTerminalCleanupJob / forceResidual / reset (timers)
export const terminalCleanupJobs = new Map<string, TerminalCleanupJob>()
// OPEN OWNERSHIP: intentionally survives resetTransferModuleState so undelivered
// completed Files remain queryable via takePendingCompletedResult.
// Cleanup owner: takePendingCompletedResult / clearPendingCompleted / forceResidual(failed).
export const pendingCompletedResults = new Map<string, PendingCompletedResult>()

function stashPendingCompleted(transferId: string, result: PendingCompletedResult): void {
  pendingCompletedResults.set(transferId, result)
}

export function clearPendingCompleted(transferId: string): void {
  pendingCompletedResults.delete(transferId)
}

/** @internal — re-deliver after a completed-status retry (store may re-query). */
export function takePendingCompletedResult(transferId: string): PendingCompletedResult | undefined {
  const r = pendingCompletedResults.get(transferId)
  if (r) pendingCompletedResults.delete(transferId)
  return r
}

function persistTerminalCleanupIntent(transferId: string, kind: TerminalCleanupKind): void {
  try {
    const raw = localStorage.getItem(TERMINAL_CLEANUP_INTENT_KEY)
    const all: Record<string, { kind: TerminalCleanupKind; at: number }> =
      raw ? JSON.parse(raw) as Record<string, { kind: TerminalCleanupKind; at: number }> : {}
    all[transferId] = { kind, at: Date.now() }
    localStorage.setItem(TERMINAL_CLEANUP_INTENT_KEY, JSON.stringify(all))
  } catch { /* private mode / SSR */ }
}

function clearTerminalCleanupIntent(transferId: string): void {
  try {
    const raw = localStorage.getItem(TERMINAL_CLEANUP_INTENT_KEY)
    if (!raw) return
    const all = JSON.parse(raw) as Record<string, unknown>
    if (!(transferId in all)) return
    delete all[transferId]
    localStorage.setItem(TERMINAL_CLEANUP_INTENT_KEY, JSON.stringify(all))
  } catch { /* ignore */ }
}

/**
 * Re-arm in-memory cleanup jobs from durable intents after a tab close/reload
 * mid-retry. Safe to call multiple times; does not destroy completed artefacts.
 */
export function resumeTerminalCleanupIntents(): void {
  try {
    const raw = localStorage.getItem(TERMINAL_CLEANUP_INTENT_KEY)
    if (!raw) return
    const all = JSON.parse(raw) as Record<string, { kind?: TerminalCleanupKind; at?: number }>
    for (const [transferId, entry] of Object.entries(all)) {
      if (!entry || (entry.kind !== 'completed' && entry.kind !== 'failed')) continue
      // Drop intents older than 7 days to bound localStorage growth.
      if (typeof entry.at === 'number' && Date.now() - entry.at > 7 * 24 * 60 * 60 * 1000) {
        clearTerminalCleanupIntent(transferId)
        continue
      }
      if (!terminalCleanupJobs.has(transferId)) {
        scheduleTerminalCleanup(transferId, entry.kind, 'resume-after-reload', 0)
      }
    }
  } catch { /* ignore */ }
}

/** Cancel a scheduled retry timer without dropping intent (direct run owns it). */
function cancelTerminalCleanupTimer(transferId: string): void {
  const job = terminalCleanupJobs.get(transferId)
  if (!job) return
  if (job.timer) {
    clearTimeout(job.timer)
    job.timer = undefined
  }
}

export function clearTerminalCleanupJob(transferId: string): void {
  cancelTerminalCleanupTimer(transferId)
  terminalCleanupJobs.delete(transferId)
}

function scheduleTerminalCleanup(
  transferId: string,
  kind: TerminalCleanupKind,
  reason: string,
  attempts = 0,
): void {
  cancelTerminalCleanupTimer(transferId)
  persistTerminalCleanupIntent(transferId, kind)
  if (attempts >= TERMINAL_CLEANUP_MAX_ATTEMPTS) {
    console.warn(
      '[transfer] terminal cleanup exhausted retries; force residual drop',
      transferId, kind, reason,
    )
    void forceResidualTerminalDrop(transferId, kind)
    return
  }
  const delay = Math.min(5_000, TERMINAL_CLEANUP_BASE_DELAY_MS * (2 ** attempts))
  const job: TerminalCleanupJob = { transferId, kind, reason, attempts }
  job.timer = setTimeout(() => {
    // Clear timer handle only — do not delete the job entry before run finishes
    // so a concurrent direct abort can cancel this timer via cancelTerminalCleanupTimer.
    const live = terminalCleanupJobs.get(transferId)
    if (live) live.timer = undefined
    void runTerminalCleanup(transferId, kind, reason, attempts)
  }, delay)
  // Unref so a pending cleanup cannot wedge the Node event loop in tests.
  const t = job.timer as unknown as { unref?: () => void }
  t.unref?.()
  terminalCleanupJobs.set(transferId, job)
}

async function forceResidualTerminalDrop(
  transferId: string,
  kind: TerminalCleanupKind,
): Promise<void> {
  // Always cancel any pending timer first so it cannot re-enter after we finish.
  clearTerminalCleanupJob(transferId)
  try {
    await updateTransfer(transferId, { status: kind === 'completed' ? 'completed' : 'failed' })
  } catch { /* last resort */ }

  if (kind === 'completed') {
    // NEVER destroy a completed artefact — only drop chunk recovery state.
    await deleteChunks(transferId).catch(() => {})
    // Drop handle maps (not OPFS entries) so we do not pin FSA/OPFS forever.
    writeHandles.delete(transferId)
    opfsHandles.delete(transferId)
    // Keep pendingCompleted so a late re-deliver can still find the File.
    receiveSessions.delete(transferId)
    if (!sendTasks.has(transferId) && !hasLiveSendTask(transferId)) {
      transferSignals.delete(transferId)
      clearTransferOwner(transferId)
    }
    clearReceiverReady(transferId)
    for (const key of [...backendPreparations.keys()]) {
      if (key.endsWith(`\u0000${transferId}`)) backendPreparations.delete(key)
    }
    // Intent stays until a later successful status write clears it — tab
    // reload can still see the durable intent.
    return
  }

  await cancelStreamWrite(transferId).catch(() => {})
  await cleanupOPFS(transferId).catch(() => {})
  await deleteChunks(transferId).catch(() => {})
  receiveSessions.delete(transferId)
  if (!sendTasks.has(transferId) && !hasLiveSendTask(transferId)) {
    transferSignals.delete(transferId)
    clearTransferOwner(transferId)
  }
  clearReceiverReady(transferId)
  writeHandles.delete(transferId)
  opfsHandles.delete(transferId)
  for (const key of [...backendPreparations.keys()]) {
    if (key.endsWith(`\u0000${transferId}`)) backendPreparations.delete(key)
  }
  clearPendingCompleted(transferId)
  clearTerminalCleanupIntent(transferId)
}

async function runTerminalCleanup(
  transferId: string,
  kind: TerminalCleanupKind,
  reason: string,
  attempts: number,
): Promise<void> {
  // Direct abort while a timer is scheduled must not leave a stale fire.
  cancelTerminalCleanupTimer(transferId)

  // 1. Durable terminal row first.
  try {
    await updateTransfer(transferId, {
      status: kind === 'completed' ? 'completed' : 'failed',
    })
  } catch (err) {
    console.warn('[transfer] terminal status persist failed; scheduling retry', transferId, err)
    scheduleTerminalCleanup(transferId, kind, reason, attempts + 1)
    return
  }

  if (kind === 'completed') {
    // Successful finalization: never destroy the assembled artefact.
    // Only chunks (recovery) may be deleted; OPFS/FSA files stay for download.
    try {
      await deleteChunks(transferId)
    } catch (err) {
      console.warn('[transfer] deleteChunks during completed cleanup; retry', transferId, err)
      scheduleTerminalCleanup(transferId, kind, reason, attempts + 1)
      return
    }
    writeHandles.delete(transferId)
    opfsHandles.delete(transferId)
    receiveSessions.delete(transferId)
    if (!sendTasks.has(transferId)) {
      transferSignals.delete(transferId)
      clearTransferOwner(transferId)
    }
    clearReceiverReady(transferId)
    for (const key of [...backendPreparations.keys()]) {
      if (key.endsWith(`\u0000${transferId}`)) backendPreparations.delete(key)
    }
    clearTerminalCleanupJob(transferId)
    clearTerminalCleanupIntent(transferId)
    // pendingCompleted is left for takePendingCompletedResult if the first
    // deliver path missed; otherwise GC'd when taken or epoch ends.
    try {
      const p = pruneTerminalTransfers()
      if (p && typeof (p as Promise<unknown>).then === 'function') {
        void (p as Promise<unknown>).catch(() => {})
      }
    } catch { /* mock / missing export */ }
    return
  }

  // 2. Failed path: backends (abort FSA / close OPFS) — only after the row is
  // durable so a failed persist never destroys the only recovery handles.
  try {
    await cancelStreamWrite(transferId)
  } catch (err) {
    console.warn('[transfer] cancelStreamWrite during terminal cleanup', transferId, err)
  }
  try {
    await cleanupOPFS(transferId)
  } catch (err) {
    console.warn('[transfer] cleanupOPFS during terminal cleanup', transferId, err)
  }

  // 3. Chunk store.
  try {
    await deleteChunks(transferId)
  } catch (err) {
    console.warn('[transfer] deleteChunks during terminal cleanup; retry', transferId, err)
    scheduleTerminalCleanup(transferId, kind, reason, attempts + 1)
    return
  }

  // 4. Session + optional signal (preserve cancel for a live send engine).
  receiveSessions.delete(transferId)
  if (!sendTasks.has(transferId)) {
    transferSignals.delete(transferId)
    clearTransferOwner(transferId)
  }
  clearReceiverReady(transferId)
  for (const key of [...backendPreparations.keys()]) {
    if (key.endsWith(`\u0000${transferId}`)) backendPreparations.delete(key)
  }
  clearTerminalCleanupJob(transferId)
  clearPendingCompleted(transferId)
  clearTerminalCleanupIntent(transferId)
  // Best-effort prune — some unit mocks omit this export; never throw.
  try {
    const p = pruneTerminalTransfers()
    if (p && typeof (p as Promise<unknown>).then === 'function') {
      void (p as Promise<unknown>).catch(() => {})
    }
  } catch { /* mock / missing export */ }
}

/**
 * Single abnormal-path terminal API for inbound transfers (Contract 5).
 * Idempotent. Notifies the peer (best-effort), drains in-flight saves,
 * then runs the retryable terminal cleanup machine. Callers must not
 * hand-write terminal states or call cancelReceive's old delete-first path.
 */
export async function abortInboundTransfer(
  transferId: string,
  reason: string,
  notifyPeer?: (msg: object) => void,
): Promise<void> {
  const session = receiveSessions.get(transferId)
  // Always try to notify — peer may still be sending.
  try {
    notifyPeer?.({ type: 'transfer-cancel', transferId })
    notifyPeer?.({ type: 'transfer-reject', transferId, reason: 'aborted', message: reason })
  } catch { /* ignore */ }

  // Set the cancel flag but do NOT drop the signal yet — a concurrent send
  // engine may still be parked in slice/encrypt/backpressure and must observe
  // cancelled === true on its next check.
  cancelTransfer(transferId)

  if (session) {
    const pending = [
      ...Array.from(session.inflightSaves),
      ...Array.from(session.inflightByIndex.values()),
    ]
    await Promise.allSettled(pending)
  }

  // Run the machine immediately (attempt 0). On persist failure it schedules
  // bounded retries instead of returning with indefinite retention.
  await runTerminalCleanup(transferId, 'failed', reason, 0)
}

/** Legacy name kept for callers/tests that only want the assembled File. */
export async function completeReceive(transferId: string): Promise<File> {
  const result = await finalizeReceive(transferId)
  return result.file
}

/**
 * Legacy name — routes through `abortInboundTransfer` so every abnormal
 * death shares one ordering (persist → backends → chunks → session).
 */
export function cancelReceive(transferId: string): Promise<void> {
  return abortInboundTransfer(transferId, 'cancelReceive')
}

// ── Resume ───────────────────────────────────────────────────────────

/**
 * Build the receiver's resume request.
 *
 * SECURITY-015: `owner` scopes the request. A persisted record that belongs to
 * a different peer session (or a previous epoch) must not have its received
 * bitmap disclosed — that bitmap is exactly the "how much of which file did
 * these two devices exchange" fact a third device in the same identity cluster
 * should not be able to fish for. Records written before ownership existed
 * (`peerSessionId` absent) stay resumable so an upgrade doesn't strand them.
 */
export async function buildResumeRequest(
  transferId: string,
  owner?: TransferOwner,
): Promise<ResumeRequest | null> {
  const record = await getTransfer(transferId)
  if (!record || record.status !== 'active') return null
  if (owner) {
    if (record.peerSessionId && record.peerSessionId !== owner.peerSessionId) return null
    if (record.epoch !== undefined && record.epoch !== owner.epoch) return null
    if (!assertTransferOwner(transferId, owner)) return null
  }

  // Merge the persisted record's bitmap with the actual chunks on disk —
  // disk is the authoritative source if the record was flushed before
  // the last write, and vice versa. OR-merge keeps both.
  const merged = bitmapFromRecord(record)
  const savedIndexes = await getSavedChunkIndexes(transferId)
  for (const idx of savedIndexes) bitmapSet(merged, idx)

  const popcount = bitmapPopcount(merged)
  const req: ResumeRequest = { type: 'resume', transferId }
  if (preferRangesOverIndexes(popcount)) {
    // RLE: tiny on the wire (a few hundred bytes even for in-progress
    // resumes of multi-thousand-chunk transfers).
    req.receivedRanges = bitmapToRanges(merged, record.totalChunks)
  } else {
    // Small enough that a flat array is fine — and it's the legacy format
    // older clients still parse.
    const out: number[] = []
    for (let i = 0; i < record.totalChunks; i++) {
      if (bitmapHas(merged, i)) out.push(i)
    }
    req.receivedChunks = out
  }
  return req
}

/**
 * Decode a `ResumeRequest` from any peer (old or new) into a bitmap
 * suitable for `sendFileParallel`'s `peerReceivedBitmap` argument. Old
 * peers send `receivedChunks` only; new peers prefer `receivedRanges`
 * but may include both. We tolerate both, and `totalChunks` bounds the
 * decoded bitmap so a malformed peer can't trigger an over-allocation.
 */
export function decodeResumeRequest(
  req: { receivedChunks?: number[]; receivedRanges?: Array<[number, number]> },
  totalChunks: number,
): Uint8Array {
  if (req.receivedRanges && req.receivedRanges.length > 0) {
    return rangesToBitmap(req.receivedRanges, totalChunks)
  }
  if (req.receivedChunks && req.receivedChunks.length > 0) {
    return bitmapFromIndexes(req.receivedChunks, totalChunks)
  }
  return newBitmap(totalChunks)
}

export function humanizeError(error: Error | string, channelType?: string): string {
  const msg = typeof error === 'string' ? error : error.message
  if (msg.includes('超时') || msg.includes('timeout')) {
    if (channelType === 'stun') return '连接超时 — 尝试在设置中开启 TURN 中继以穿越防火墙'
    return '连接超时 — 请检查网络或稍后重试'
  }
  if (msg.includes('加密') || msg.includes('AES') || msg.includes('key')) return '加密协商失败，请重新连接后重试'
  // P2-10: the `checksum` branch was dead code — we removed the
  // pre-transfer whole-file SHA-256 some time ago (per-chunk AES-GCM
  // auth tags do the integrity work end-to-end). No code path emits a
  // 'checksum' error any more.
  if (msg.includes('DataChannel')) return '数据信道断开 — 尝试更换信道类型'
  return msg || '传输失败，请检查网络连接后重试'
}

export function createTransferId(): string {
  return crypto.randomUUID()
}

export async function checkForResumableTransfers(): Promise<TransferRecord[]> {
  return getActiveTransfers()
}
