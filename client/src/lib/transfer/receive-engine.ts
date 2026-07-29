/**
 * transfer/receive-engine.ts — session, per-index in-flight, fixed persistence order, unified finalize.
 *
 * Module-global state cleanup owners:
 *   receiveSessions          → finalizeReceive / abortInboundTransfer / forgetTransfer / reset
 *   backendPreparations      → prepareReceiveBackend finally / forgetTransfer / reset
 *   terminalCleanupJobs      → clearTerminalCleanupJob / forceResidual / reset (timers cancelled)
 *   terminalCleanup intents  → localStorage key misaka.terminalCleanupIntents;
 *                              owner: persist/clear/resumeTerminalCleanupIntents in THIS module.
 *                              Survives forgetTransfer (by design). Bound to owner/epoch/metadata;
 *                              validated before any row/chunk mutation. Cleared on successful cleanup.
 *
 * Delivery model: the File returned by finalizeReceive is the sole delivery.
 * An in-memory File cannot survive tab close; durable intents only retry
 * status/chunk cleanup — they never re-deliver a File.
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
  registerTransferOwner, clearTransferOwner,
  transferOwners, TransferOwnershipError,
  matchesDurableReceiveOwner,
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
  /**
   * Globally unique attempt identity (UUID / random hex). Never a module-local
   * counter — those restart at 1 after reload and collide with durable intents.
   */
  attemptToken: string
}

// Cleanup owner: finalizeReceive / abortInboundTransfer / forgetTransfer / reset
export const receiveSessions = new Map<string, ReceiveSession>()

/**
 * Mint a receive attempt token that cannot collide across page/module reloads.
 * `crypto.randomUUID()` when available; otherwise 128 bits of getRandomValues hex.
 */
export function mintReceiveAttemptToken(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch { /* fall through */ }
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  let hex = ''
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, '0')
  }
  return hex
}

/** Normalize durable/intent attempt tokens for exact comparison. */
function normalizeAttemptToken(token: unknown): string | undefined {
  if (typeof token === 'string') {
    const t = token.trim()
    return t.length > 0 ? t : undefined
  }
  if (typeof token === 'number' && Number.isSafeInteger(token) && token > 0) {
    return String(token)
  }
  return undefined
}

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
    // Globally unique per attempt — UUID/hex, never a reload-resetting counter.
    // Cleanup intents and durable rows bind to this so same-scope id reuse
    // cannot destroy a later transfer after a page reload.
    attemptToken: mintReceiveAttemptToken(),
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
        // Carry the durable attempt identity when resuming the same row so
        // intents still bind after reload. Fresh geometry keeps the mint above.
        const priorToken = normalizeAttemptToken(prior.attemptToken)
        if (priorToken !== undefined) {
          session.attemptToken = priorToken
        }
      }
    }
  } catch { /* fresh transfer */ }

  await saveTransfer({
    transferId: msg.transferId,
    direction: 'recv',
    peerNodeId,
    peerSessionId: owner.peerSessionId,
    epoch: owner.epoch,
    attemptToken: session.attemptToken,
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

  const attemptToken = session?.attemptToken ?? ''

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
  // The File returned here is the sole delivery path (no in-memory re-delivery
  // stash — Files cannot survive tab close). Retry only the durable row /
  // chunk cleanup without destroying the completed OPFS/IDB artefact.
  const intentScope = intentScopeFromSession(session)
  try {
    await updateTransfer(transferId, { status: 'completed' })
  } catch (err) {
    // Keep session + handles + finalized so a retry can re-read the artefact.
    // Persist cleanup INTENT durably so a tab close cannot erase the only job.
    scheduleTerminalCleanup(transferId, 'completed', 'finalize-persist-failed', 0, intentScope)
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
    // Schedule retry and RETURN without clearing the intent we just persisted.
    // Session can still be retired from the live map; the durable intent +
    // scoped metadata drive the retry.
    scheduleTerminalCleanup(transferId, 'completed', 'delete-chunks-failed', 0, intentScope)
    receiveSessions.delete(transferId)
    if (!sendTasks.has(transferId) && !hasLiveSendTask(transferId)) {
      transferSignals.delete(transferId)
      clearTransferOwner(transferId)
    }
    clearReceiverReady(transferId)
    return { file: named, bytes: named.size, backend, cleanup }
  }

  receiveSessions.delete(transferId)
  transferSignals.delete(transferId)
  clearTransferOwner(transferId)
  clearReceiverReady(transferId)
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
//
// Intents are SCOPED to the exact attempt (owner session, epoch, metadata).
// An old identity's completed intent must never terminalize a live receive
// that reuses the same caller-controlled transferId.

const TERMINAL_CLEANUP_MAX_ATTEMPTS = 8
const TERMINAL_CLEANUP_BASE_DELAY_MS = 50
/** Slow re-arm when fail-closed row reads stay unreadable after ordinary retries. */
const TERMINAL_CLEANUP_DEFER_BACKOFF_MS = 5_000
/**
 * Bound for pre-token (`keep`) re-arms against a live later attempt. After this
 * many keep cycles the intent is dropped with a warning so it cannot live
 * forever when a live receive never yields. Age TTL is the primary long-lived
 * bound; this is a shorter session-local safety net (~5 min at 5s backoff).
 */
const TERMINAL_CLEANUP_KEEP_MAX = 64
const TERMINAL_CLEANUP_INTENT_KEY = 'misaka.terminalCleanupIntents'
const TERMINAL_CLEANUP_INTENT_MAX = 64
const TERMINAL_CLEANUP_INTENT_TTL_MS = 7 * 24 * 60 * 60 * 1000

type TerminalCleanupKind = 'failed' | 'completed'

/** Attempt-scoped durable intent — never keyed by transferId alone. */
interface TerminalCleanupIntent {
  kind: TerminalCleanupKind
  at: number
  peerSessionId: string
  epoch: number
  fileName: string
  fileSize: number
  totalChunks: number
  /**
   * Globally unique attempt identity. Optional only for pre-token intents from
   * older builds — those match a durable row solely when owner/epoch/metadata
   * agree and no live receive with a different proven token is present.
   */
  attemptToken?: string | number
}

interface TerminalCleanupJob {
  transferId: string
  kind: TerminalCleanupKind
  reason: string
  attempts: number
  scope: TerminalCleanupIntent
  timer?: ReturnType<typeof setTimeout>
}

// Cleanup owner: clearTerminalCleanupJob / forceResidual / reset (timers)
export const terminalCleanupJobs = new Map<string, TerminalCleanupJob>()

function intentScopeFromSession(session: ReceiveSession): TerminalCleanupIntent {
  return {
    kind: 'completed', // kind filled by caller when persisting
    at: Date.now(),
    peerSessionId: session.peerSessionId,
    epoch: session.epoch,
    fileName: session.fileName,
    fileSize: session.fileSize,
    totalChunks: session.totalChunks,
    attemptToken: session.attemptToken,
  }
}

function isValidIntentShape(entry: unknown): entry is TerminalCleanupIntent {
  if (!entry || typeof entry !== 'object') return false
  const e = entry as Record<string, unknown>
  if (e.kind !== 'completed' && e.kind !== 'failed') return false
  if (typeof e.at !== 'number' || !Number.isFinite(e.at)) return false
  if (typeof e.peerSessionId !== 'string' || e.peerSessionId.length === 0) return false
  if (typeof e.epoch !== 'number' || !Number.isSafeInteger(e.epoch)) return false
  if (typeof e.fileName !== 'string') return false
  if (typeof e.fileSize !== 'number' || !Number.isSafeInteger(e.fileSize) || e.fileSize < 0) return false
  if (typeof e.totalChunks !== 'number' || !Number.isSafeInteger(e.totalChunks) || e.totalChunks < 0) return false
  // attemptToken optional for pre-token builds. When present: non-empty string
  // (UUID/hex) or a positive safe integer from intermediate counter builds.
  if (e.attemptToken !== undefined && e.attemptToken !== null) {
    if (normalizeAttemptToken(e.attemptToken) === undefined) return false
  }
  return true
}

/**
 * Exact attempt match when both sides have tokens. A missing token on the
 * durable row (or a pre-token intent) is a soft match only when every other
 * scoping field already agrees — never against a live receive that has a
 * different proven token (see resolveIntentTarget live path).
 */
function attemptTokensCompatible(
  intentToken: unknown,
  targetToken: unknown,
): boolean {
  const intent = normalizeAttemptToken(intentToken)
  const target = normalizeAttemptToken(targetToken)
  if (intent === undefined || target === undefined) return true
  return intent === target
}

/** Load intents; recover from corrupt JSON by wiping the key. Cap + expire. */
function loadCleanupIntents(): Record<string, TerminalCleanupIntent> {
  try {
    const raw = localStorage.getItem(TERMINAL_CLEANUP_INTENT_KEY)
    if (!raw) return {}
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      localStorage.removeItem(TERMINAL_CLEANUP_INTENT_KEY)
      return {}
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      localStorage.removeItem(TERMINAL_CLEANUP_INTENT_KEY)
      return {}
    }
    const out: Record<string, TerminalCleanupIntent> = {}
    const now = Date.now()
    for (const [id, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof id !== 'string' || id.length === 0 || id.length > 128) continue
      if (!isValidIntentShape(entry)) continue
      if (now - entry.at > TERMINAL_CLEANUP_INTENT_TTL_MS) continue
      out[id] = entry
    }
    // Cap: keep newest by `at`.
    const ids = Object.keys(out)
    if (ids.length > TERMINAL_CLEANUP_INTENT_MAX) {
      ids.sort((a, b) => out[a].at - out[b].at)
      for (const drop of ids.slice(0, ids.length - TERMINAL_CLEANUP_INTENT_MAX)) {
        delete out[drop]
      }
    }
    return out
  } catch {
    return {}
  }
}

function saveCleanupIntents(all: Record<string, TerminalCleanupIntent>): void {
  try {
    localStorage.setItem(TERMINAL_CLEANUP_INTENT_KEY, JSON.stringify(all))
  } catch { /* private mode / SSR / quota */ }
}

function persistTerminalCleanupIntent(
  transferId: string,
  kind: TerminalCleanupKind,
  scope: Omit<TerminalCleanupIntent, 'kind' | 'at'> & { kind?: TerminalCleanupKind; at?: number },
): void {
  const all = loadCleanupIntents()
  // Preserve the original arm time across keep/defer re-arms so the 7-day TTL
  // still expires intents that can never match (e.g. pre-token vs live forever).
  const prior = all[transferId]
  const at =
    typeof scope.at === 'number' && Number.isFinite(scope.at)
      ? scope.at
      : (prior && typeof prior.at === 'number' && Number.isFinite(prior.at)
        ? prior.at
        : Date.now())
  const entry: TerminalCleanupIntent = {
    kind,
    at,
    peerSessionId: scope.peerSessionId,
    epoch: scope.epoch,
    fileName: scope.fileName,
    fileSize: scope.fileSize,
    totalChunks: scope.totalChunks,
  }
  const token = normalizeAttemptToken(scope.attemptToken)
  if (token !== undefined) entry.attemptToken = token
  all[transferId] = entry
  // Cap after insert.
  const ids = Object.keys(all)
  if (ids.length > TERMINAL_CLEANUP_INTENT_MAX) {
    ids.sort((a, b) => all[a].at - all[b].at)
    for (const drop of ids.slice(0, ids.length - TERMINAL_CLEANUP_INTENT_MAX)) {
      delete all[drop]
    }
  }
  saveCleanupIntents(all)
}

/** True when the intent has aged past the durable TTL (must not live forever). */
function isIntentAgedOut(intent: TerminalCleanupIntent): boolean {
  return Date.now() - intent.at > TERMINAL_CLEANUP_INTENT_TTL_MS
}

function clearTerminalCleanupIntent(transferId: string): void {
  try {
    const all = loadCleanupIntents()
    if (!(transferId in all)) return
    delete all[transferId]
    saveCleanupIntents(all)
  } catch { /* ignore */ }
}

/**
 * Live receive vs intent: require exact attempt tokens when the intent has one.
 * Soft-matching a missing intent token against a live UUID would terminalize a
 * distinct later attempt that reused transferId after reload — never do that.
 */
function liveMatchesIntent(
  live: ReceiveSession,
  intent: TerminalCleanupIntent,
): boolean {
  if (
    live.peerSessionId !== intent.peerSessionId
    || live.epoch !== intent.epoch
    || live.fileName !== intent.fileName
    || live.fileSize !== intent.fileSize
    || live.totalChunks !== intent.totalChunks
  ) {
    return false
  }
  const intentToken = normalizeAttemptToken(intent.attemptToken)
  if (intentToken === undefined) {
    // Pre-token intent cannot prove identity against a live attempt.
    return false
  }
  return live.attemptToken === intentToken
}

/**
 * Pre-token (legacy) intent blocked by a live receive: stay armed only while
 * the intent is still within age/retry bounds. Aged-out intents are rejected
 * so they cannot remain permanently inert.
 */
function keepOrDropLegacyAgainstLive(intent: TerminalCleanupIntent): 'keep' | 'reject' {
  if (normalizeAttemptToken(intent.attemptToken) !== undefined) return 'reject'
  if (isIntentAgedOut(intent)) return 'reject'
  return 'keep'
}

/**
 * Validate that a durable intent still targets the same attempt before any
 * destructive cleanup. Rejects (and clears) stale/mismatched entries.
 * Returns `defer` when the durable row cannot be read — fail closed (retry
 * later) rather than applying against an unvalidated target.
 * Returns `keep` only when a live receive exists and a pre-token intent cannot
 * prove match — never when there is nothing live to protect.
 *
 * Legacy soft-match (no live session): if owner, epoch and metadata all agree,
 * missing attemptToken on either side still applies so pre-upgrade intents
 * clean residual rows instead of living forever.
 *
 * A live receive with different owner/epoch/metadata/attempt MUST NOT be touched.
 */
async function resolveIntentTarget(
  transferId: string,
  intent: TerminalCleanupIntent,
): Promise<'apply' | 'reject' | 'defer' | 'keep'> {
  const live = receiveSessions.get(transferId)
  if (live) {
    if (!liveMatchesIntent(live, intent)) {
      // Live attempt present — never terminalize it on an untokened legacy intent.
      return keepOrDropLegacyAgainstLive(intent)
    }
    // Same attempt still in memory — apply (e.g. retry after status-write fail).
    return 'apply'
  }

  // No live session: nothing in-memory to protect. Soft-match the durable row
  // (or residual-apply when the row is already gone but chunks may remain).
  try {
    const row = await getTransfer(transferId)
    // TOCTOU: a newer live receive may have been created during the row read.
    // Prefer the live check — never apply a stale intent onto a new attempt.
    const liveAfter = receiveSessions.get(transferId)
    if (liveAfter) {
      if (!liveMatchesIntent(liveAfter, intent)) {
        return keepOrDropLegacyAgainstLive(intent)
      }
      return 'apply'
    }
    if (!row) {
      // No durable row and no live session: residual chunk/status cleanup is
      // still safe and necessary (row may have been written then vanished
      // between validation and revalidation, or chunks may outlive the row).
      // Clearing the intent without applying would abandon orphan chunks.
      return 'apply'
    }
    if (
      (row.peerSessionId != null && row.peerSessionId !== intent.peerSessionId)
      || (row.epoch != null && row.epoch !== intent.epoch)
      || row.fileName !== intent.fileName
      || row.fileSize !== intent.fileSize
      || row.totalChunks !== intent.totalChunks
    ) {
      return 'reject'
    }
    // Exact tokens when both sides have them. Missing token on either side is
    // a legacy soft match once owner/epoch/metadata already agree — so old-build
    // intents/rows without attemptToken still get cleaned instead of abandoned.
    if (!attemptTokensCompatible(intent.attemptToken, row.attemptToken)) {
      return 'reject'
    }
    return 'apply'
  } catch {
    // DB unavailable — retain intent and retry; never apply unvalidated.
    // Still protect a live mismatched attempt that appeared while we failed.
    const liveAfter = receiveSessions.get(transferId)
    if (liveAfter) {
      if (!liveMatchesIntent(liveAfter, intent)) {
        return keepOrDropLegacyAgainstLive(intent)
      }
      return 'apply'
    }
    return 'defer'
  }
}

/** Re-check intent target after every await before mutating or deleting. */
async function revalidateIntentTarget(
  transferId: string,
  intent: TerminalCleanupIntent,
): Promise<'apply' | 'reject' | 'defer' | 'keep'> {
  return resolveIntentTarget(transferId, intent)
}

/**
 * Drop an intent that can never make progress (aged out or keep-bound) so it
 * cannot remain permanently inert. Logs a warning for operator visibility.
 */
function dropUnresolvableCleanupIntent(
  transferId: string,
  kind: TerminalCleanupKind,
  reason: string,
  detail: string,
): void {
  console.warn(
    '[transfer] drop unresolvable terminal cleanup intent',
    transferId, kind, reason, detail,
  )
  clearTerminalCleanupJob(transferId)
  clearTerminalCleanupIntent(transferId)
}

/**
 * Arm a slow backoff timer for a durable intent that must stay owned without
 * mutating unvalidated targets. Used after fail-closed defer exhaustion and
 * for pre-token intents held against a live later attempt.
 *
 * Re-arms preserve the original `scope.at` so the 7-day TTL still applies.
 * Keep cycles are bounded by TERMINAL_CLEANUP_KEEP_MAX.
 */
function armDeferredCleanupRetry(
  transferId: string,
  kind: TerminalCleanupKind,
  reason: string,
  scope: TerminalCleanupIntent,
  attempts: number,
): void {
  if (isIntentAgedOut(scope)) {
    dropUnresolvableCleanupIntent(transferId, kind, reason, 'aged-out')
    return
  }
  // Keep-path reasons carry ":keep" — bound those so a live later attempt
  // cannot pin a pre-token intent forever within a long-lived tab.
  const isKeep = reason.includes(':keep')
  if (isKeep && attempts >= TERMINAL_CLEANUP_KEEP_MAX) {
    dropUnresolvableCleanupIntent(transferId, kind, reason, `keep-max=${TERMINAL_CLEANUP_KEEP_MAX}`)
    return
  }
  cancelTerminalCleanupTimer(transferId)
  persistTerminalCleanupIntent(transferId, kind, scope)
  const job: TerminalCleanupJob = {
    transferId,
    kind,
    reason,
    attempts,
    scope,
  }
  job.timer = setTimeout(() => {
    const live = terminalCleanupJobs.get(transferId)
    if (live) live.timer = undefined
    void runTerminalCleanup(transferId, kind, reason, attempts, scope)
  }, TERMINAL_CLEANUP_DEFER_BACKOFF_MS)
  const t = job.timer as unknown as { unref?: () => void }
  t.unref?.()
  terminalCleanupJobs.set(transferId, job)
}

/**
 * Re-arm in-memory cleanup jobs from durable intents after a tab close/reload
 * or same-tab epoch/token change. Safe to call multiple times; does not destroy
 * completed artefacts. Malformed/stale entries are removed.
 *
 * Cleanup owner for the localStorage map: this function + successful run clear.
 */
export function resumeTerminalCleanupIntents(): void {
  const all = loadCleanupIntents()
  // Rewrite store after filter (drops corrupt/expired and caps).
  saveCleanupIntents(all)
  for (const [transferId, entry] of Object.entries(all)) {
    if (!terminalCleanupJobs.has(transferId)) {
      scheduleTerminalCleanup(transferId, entry.kind, 'resume-after-reload', 0, entry)
    }
  }
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
  scope?: TerminalCleanupIntent | Omit<TerminalCleanupIntent, 'kind' | 'at'>,
): void {
  cancelTerminalCleanupTimer(transferId)
  // Prefer live session scope when not provided (abort path).
  let resolved: TerminalCleanupIntent
  // scope may be Omit<..., 'at'>; only full intents carry a durable arm time.
  const scopeAt = (scope as { at?: number } | undefined)?.at
  const preservedAt =
    typeof scopeAt === 'number' && Number.isFinite(scopeAt) ? scopeAt : Date.now()
  if (scope && isValidIntentShape({
    ...scope,
    kind,
    at: preservedAt,
  })) {
    // Preserve original arm time when re-scheduling a durable intent so TTL
    // does not reset on every resume/keep cycle.
    resolved = {
      kind,
      at: preservedAt,
      peerSessionId: scope.peerSessionId,
      epoch: scope.epoch,
      fileName: scope.fileName,
      fileSize: scope.fileSize,
      totalChunks: scope.totalChunks,
    }
    const token = normalizeAttemptToken(scope.attemptToken)
    if (token !== undefined) resolved.attemptToken = token
  } else {
    const session = receiveSessions.get(transferId)
    const owner = transferOwners.get(transferId)
    if (!session && !owner) {
      // No attempt identity — cannot safely schedule a durable intent.
      console.warn('[transfer] refuse unscoped terminal cleanup', transferId, kind, reason)
      return
    }
    resolved = {
      kind,
      at: Date.now(),
      peerSessionId: session?.peerSessionId ?? owner!.peerSessionId,
      epoch: session?.epoch ?? owner!.epoch,
      fileName: session?.fileName ?? owner!.fileName,
      fileSize: session?.fileSize ?? owner!.fileSize,
      totalChunks: session?.totalChunks ?? owner!.totalChunks,
    }
    if (session?.attemptToken) resolved.attemptToken = session.attemptToken
  }
  persistTerminalCleanupIntent(transferId, kind, resolved)
  if (attempts >= TERMINAL_CLEANUP_MAX_ATTEMPTS) {
    console.warn(
      '[transfer] terminal cleanup exhausted retries; force residual drop',
      transferId, kind, reason,
    )
    void forceResidualTerminalDrop(transferId, kind, resolved, reason)
    return
  }
  const delay = Math.min(5_000, TERMINAL_CLEANUP_BASE_DELAY_MS * (2 ** attempts))
  const job: TerminalCleanupJob = { transferId, kind, reason, attempts, scope: resolved }
  job.timer = setTimeout(() => {
    // Clear timer handle only — do not delete the job entry before run finishes
    // so a concurrent direct abort can cancel this timer via cancelTerminalCleanupTimer.
    const live = terminalCleanupJobs.get(transferId)
    if (live) live.timer = undefined
    void runTerminalCleanup(transferId, kind, reason, attempts, resolved)
  }, delay)
  // Unref so a pending cleanup cannot wedge the Node event loop in tests.
  const t = job.timer as unknown as { unref?: () => void }
  t.unref?.()
  terminalCleanupJobs.set(transferId, job)
}

async function forceResidualTerminalDrop(
  transferId: string,
  kind: TerminalCleanupKind,
  scope: TerminalCleanupIntent,
  reason = 'force-residual',
): Promise<void> {
  // Always cancel any pending timer first so it cannot re-enter after we finish.
  clearTerminalCleanupJob(transferId)
  const decision = await resolveIntentTarget(transferId, scope)
  if (decision === 'reject') {
    clearTerminalCleanupIntent(transferId)
    return
  }
  if (decision === 'defer' || decision === 'keep') {
    // Fail-closed: never mutate unvalidated targets, but stay armed with a
    // backoff timer so the intent is not silently orphaned until init/epoch.
    armDeferredCleanupRetry(
      transferId,
      kind,
      decision === 'keep' ? `${reason}:keep` : `${reason}:defer-backoff`,
      scope,
      TERMINAL_CLEANUP_MAX_ATTEMPTS,
    )
    return
  }

  try {
    await updateTransfer(transferId, { status: kind === 'completed' ? 'completed' : 'failed' })
  } catch { /* last resort */ }

  // Revalidate after every await before destructive mutation.
  const afterStatus = await revalidateIntentTarget(transferId, scope)
  if (afterStatus === 'defer' || afterStatus === 'keep') {
    armDeferredCleanupRetry(transferId, kind, `${reason}:post-status`, scope, TERMINAL_CLEANUP_MAX_ATTEMPTS)
    return
  }
  if (afterStatus === 'reject') {
    clearTerminalCleanupIntent(transferId)
    return
  }
  if (afterStatus !== 'apply') return

  if (kind === 'completed') {
    // NEVER destroy a completed artefact — only drop chunk recovery state.
    await deleteChunks(transferId).catch(() => {})
    const afterChunks = await revalidateIntentTarget(transferId, scope)
    if (afterChunks === 'defer' || afterChunks === 'keep') {
      armDeferredCleanupRetry(transferId, kind, `${reason}:post-chunks`, scope, TERMINAL_CLEANUP_MAX_ATTEMPTS)
      return
    }
    if (afterChunks !== 'apply') return
    // Drop handle maps (not OPFS entries) so we do not pin FSA/OPFS forever.
    writeHandles.delete(transferId)
    opfsHandles.delete(transferId)
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
  {
    const d = await revalidateIntentTarget(transferId, scope)
    if (d === 'defer' || d === 'keep') {
      armDeferredCleanupRetry(transferId, kind, `${reason}:post-fsa`, scope, TERMINAL_CLEANUP_MAX_ATTEMPTS)
      return
    }
    if (d !== 'apply') return
  }
  await cleanupOPFS(transferId).catch(() => {})
  {
    const d = await revalidateIntentTarget(transferId, scope)
    if (d === 'defer' || d === 'keep') {
      armDeferredCleanupRetry(transferId, kind, `${reason}:post-opfs`, scope, TERMINAL_CLEANUP_MAX_ATTEMPTS)
      return
    }
    if (d !== 'apply') return
  }
  await deleteChunks(transferId).catch(() => {})
  {
    const d = await revalidateIntentTarget(transferId, scope)
    if (d === 'defer' || d === 'keep') {
      armDeferredCleanupRetry(transferId, kind, `${reason}:post-chunks`, scope, TERMINAL_CLEANUP_MAX_ATTEMPTS)
      return
    }
    if (d !== 'apply') return
  }
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
  clearTerminalCleanupIntent(transferId)
}

async function runTerminalCleanup(
  transferId: string,
  kind: TerminalCleanupKind,
  reason: string,
  attempts: number,
  scope: TerminalCleanupIntent,
): Promise<void> {
  // Direct abort while a timer is scheduled must not leave a stale fire.
  cancelTerminalCleanupTimer(transferId)

  const decision = await resolveIntentTarget(transferId, scope)
  if (decision === 'reject') {
    clearTerminalCleanupJob(transferId)
    clearTerminalCleanupIntent(transferId)
    return
  }
  if (decision === 'keep') {
    // Pre-token intent cannot touch a live later attempt — stay armed with
    // age + keep-count bounds (see armDeferredCleanupRetry).
    armDeferredCleanupRetry(transferId, kind, `${reason}:keep`, scope, attempts + 1)
    return
  }
  if (decision === 'defer') {
    // Fail closed: schedule retry without mutating unvalidated targets.
    // After ordinary retries exhaust, scheduleTerminalCleanup re-arms via
    // forceResidual → armDeferredCleanupRetry so the intent never goes dormant.
    scheduleTerminalCleanup(transferId, kind, reason, attempts + 1, scope)
    return
  }

  // 1. Durable terminal row first.
  try {
    await updateTransfer(transferId, {
      status: kind === 'completed' ? 'completed' : 'failed',
    })
  } catch (err) {
    console.warn('[transfer] terminal status persist failed; scheduling retry', transferId, err)
    scheduleTerminalCleanup(transferId, kind, reason, attempts + 1, scope)
    return
  }

  // TOCTOU: a newer same-id attempt may have been created during the await.
  const afterStatus = await revalidateIntentTarget(transferId, scope)
  if (afterStatus === 'reject') {
    clearTerminalCleanupJob(transferId)
    clearTerminalCleanupIntent(transferId)
    return
  }
  if (afterStatus === 'keep') {
    armDeferredCleanupRetry(transferId, kind, `${reason}:keep-post-status`, scope, attempts + 1)
    return
  }
  if (afterStatus === 'defer') {
    scheduleTerminalCleanup(transferId, kind, reason, attempts + 1, scope)
    return
  }

  /** After an await: reject clears intent; defer/keep re-arm; apply continues. */
  const stopUnlessApply = async (tag: string): Promise<boolean> => {
    const d = await revalidateIntentTarget(transferId, scope)
    if (d === 'apply') return false
    if (d === 'reject') {
      clearTerminalCleanupJob(transferId)
      clearTerminalCleanupIntent(transferId)
      return true
    }
    if (d === 'keep') {
      armDeferredCleanupRetry(transferId, kind, `${reason}:${tag}:keep`, scope, attempts + 1)
      return true
    }
    // defer
    scheduleTerminalCleanup(transferId, kind, reason, attempts + 1, scope)
    return true
  }

  if (kind === 'completed') {
    // Successful finalization: never destroy the assembled artefact.
    // Only chunks (recovery) may be deleted; OPFS/FSA files stay for download.
    try {
      await deleteChunks(transferId)
    } catch (err) {
      console.warn('[transfer] deleteChunks during completed cleanup; retry', transferId, err)
      scheduleTerminalCleanup(transferId, kind, reason, attempts + 1, scope)
      return
    }
    // Target drifted after chunk delete — stop before wiping live session maps.
    if (await stopUnlessApply('post-chunks')) return
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
  // Backend failures must RETRY, not silently drop handles/intents.
  try {
    await cancelStreamWrite(transferId)
  } catch (err) {
    console.warn('[transfer] cancelStreamWrite during terminal cleanup; retry', transferId, err)
    scheduleTerminalCleanup(transferId, kind, reason, attempts + 1, scope)
    return
  }
  if (await stopUnlessApply('post-fsa')) return
  try {
    await cleanupOPFS(transferId)
  } catch (err) {
    console.warn('[transfer] cleanupOPFS during terminal cleanup; retry', transferId, err)
    scheduleTerminalCleanup(transferId, kind, reason, attempts + 1, scope)
    return
  }
  if (await stopUnlessApply('post-opfs')) return

  // 3. Chunk store.
  try {
    await deleteChunks(transferId)
  } catch (err) {
    console.warn('[transfer] deleteChunks during terminal cleanup; retry', transferId, err)
    scheduleTerminalCleanup(transferId, kind, reason, attempts + 1, scope)
    return
  }
  if (await stopUnlessApply('post-chunks')) return

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
 * @deprecated First finalizeReceive return is the sole delivery. Kept so
 * older audit imports resolve; always returns undefined.
 */
export function takePendingCompletedResult(_transferId: string): undefined {
  return undefined
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
  const scopeSession = session ?? receiveSessions.get(transferId)
  const owner = transferOwners.get(transferId)
  const scope: TerminalCleanupIntent = scopeSession
    ? { ...intentScopeFromSession(scopeSession), kind: 'failed', at: Date.now() }
    : {
        kind: 'failed',
        at: Date.now(),
        peerSessionId: owner?.peerSessionId ?? '',
        epoch: owner?.epoch ?? 0,
        fileName: owner?.fileName ?? '',
        fileSize: owner?.fileSize ?? 0,
        totalChunks: owner?.totalChunks ?? 0,
        // No live session → no proven attempt token (pre-token residual path).
      }
  if (!scope.peerSessionId && !scopeSession) {
    // No attempt identity (caller cancelled an id with no live session/owner).
    // Best-effort residual without durable intent: still mark failed + drop
    // chunks so cancelReceive cannot leak orphan IDB rows.
    try {
      await updateTransfer(transferId, { status: 'failed' })
    } catch { /* ignore */ }
    await cancelStreamWrite(transferId).catch(() => {})
    await cleanupOPFS(transferId).catch(() => {})
    await deleteChunks(transferId).catch(() => {})
    receiveSessions.delete(transferId)
    clearReceiverReady(transferId)
    return
  }
  await runTerminalCleanup(transferId, 'failed', reason, 0, scope)
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
 * SECURITY-015: `owner` scopes the request via the durable row (not the
 * in-memory owner map). After reload/epoch reset `transferOwners` is empty,
 * but a matching persisted receive row must still produce a resume bitmap.
 * A record that belongs to a different peer session (or a previous epoch)
 * must not have its received bitmap disclosed. Records written before
 * ownership existed (`peerSessionId` absent) stay resumable so an upgrade
 * doesn't strand them.
 */
export async function buildResumeRequest(
  transferId: string,
  owner?: TransferOwner,
): Promise<ResumeRequest | null> {
  const record = await getTransfer(transferId)
  if (!record || record.status !== 'active') return null
  // Durable-row check only — assertTransferOwner rejects unknown in-memory
  // ids (correct for peer control) and would break reload-then-resume.
  if (!matchesDurableReceiveOwner(record, owner)) return null

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
