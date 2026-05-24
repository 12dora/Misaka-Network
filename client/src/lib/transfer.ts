import {
  saveTransfer, updateTransfer, getTransfer, getActiveTransfers,
  saveChunk, getChunk, deleteChunks, getSavedChunkIndexes,
  type TransferRecord,
} from './db'
import { encryptChunk, decryptChunk, makeChunkIv, randomIvPrefix } from './crypto'
import {
  CHUNK_SIZE, HIGH_WATER_MARK, LOW_WATER_MARK,
  TRANSFER_PROGRESS_INTERVAL_MS, TRANSFER_RECORD_INTERVAL_MS,
  TRANSFER_LANE_COUNT, MAX_INMEMORY_RECEIVE_BYTES,
} from '@/constants'
import {
  newBitmap, bitmapSet, bitmapHas, bitmapPopcount,
  bitmapFromIndexes, bitmapToRanges, rangesToBitmap,
  preferRangesOverIndexes,
} from './chunk-bitmap'

export { CHUNK_SIZE }

/**
 * Build a Uint8Array bitmap from whatever shape a TransferRecord happens
 * to carry. New records persist `receivedBitmap`; legacy records still
 * have `receivedChunks: number[]`. Either way callers get a bitmap they
 * can mutate freely (the result is always a fresh allocation — we never
 * hand back an alias into the record).
 */
function bitmapFromRecord(record: TransferRecord): Uint8Array<ArrayBuffer> {
  if (record.receivedBitmap && record.receivedBitmap.byteLength > 0) {
    // Copy: the underlying buffer was structured-cloned out of IDB but the
    // session is about to mutate it; never share storage between two live
    // sessions for the same transferId (cancel-then-resume edge case).
    const copy = record.receivedBitmap.slice(0) as ArrayBuffer
    return new Uint8Array(copy)
  }
  if (record.receivedChunks && record.receivedChunks.length > 0) {
    return bitmapFromIndexes(record.receivedChunks, record.totalChunks)
  }
  return newBitmap(record.totalChunks)
}

// ── Protocol types ───────────────────────────────────────────────────

export interface MetaMessage {
  type: 'meta'
  transferId: string
  shortId: number          // compact id embedded in binary chunk frames
  fileName: string
  fileSize: number
  fileHash: string
  totalChunks: number
  mime: string
}

/**
 * Resume request sent by the receiver to the sender after reconnect. The
 * wire format carries one of two encodings:
 *
 *   - `receivedRanges`: RLE pairs [start, length]. Preferred when the
 *     receiver already has many chunks (~> 1 K) — even after thousands of
 *     contiguous chunks this is typically a handful of entries.
 *
 *   - `receivedChunks`: the legacy flat array. Used for small transfers
 *     and to remain parseable by older clients that don't know about
 *     `receivedRanges`.
 *
 * Receivers MAY include both; the sender prefers `receivedRanges` when
 * present. Parsing always tolerates omissions and arbitrary index ordering.
 */
export interface ResumeRequest {
  type: 'resume'
  transferId: string
  receivedChunks?: number[]
  receivedRanges?: Array<[number, number]>
}

export type DCProtocolMessage = MetaMessage | ResumeRequest | { type: 'ecdh-pub'; pub: string }

// ── Binary chunk frame ──────────────────────────────────────────────
// One SCTP message per chunk. Layout:
//   [0]      tag = 0x01
//   [1..5)   shortId (uint32 BE) — registered by the meta message
//   [5..9)   chunk index (uint32 BE)
//   [9..21)  AES-GCM IV (12 bytes)
//   [21..]   ciphertext (plaintext + 16-byte GCM auth tag)
// Replaces the prior "JSON header + binary body" pair, halving the
// DataChannel message count and removing JSON parse from the hot path.

export const CHUNK_FRAME_TAG = 0x01
const CHUNK_FRAME_HEADER_BYTES = 21

export function encodeChunkFrame(
  shortId: number,
  index: number,
  iv: Uint8Array,
  ciphertext: ArrayBuffer,
): ArrayBuffer {
  const out = new Uint8Array(CHUNK_FRAME_HEADER_BYTES + ciphertext.byteLength)
  const view = new DataView(out.buffer)
  view.setUint8(0, CHUNK_FRAME_TAG)
  view.setUint32(1, shortId >>> 0, false)
  view.setUint32(5, index >>> 0, false)
  out.set(iv, 9)
  out.set(new Uint8Array(ciphertext), CHUNK_FRAME_HEADER_BYTES)
  return out.buffer
}

export interface DecodedChunkFrame {
  shortId: number
  index: number
  iv: Uint8Array<ArrayBuffer>
  ciphertext: ArrayBuffer
}

export function decodeChunkFrame(buf: ArrayBuffer): DecodedChunkFrame | null {
  if (buf.byteLength < CHUNK_FRAME_HEADER_BYTES) return null
  const view = new DataView(buf)
  if (view.getUint8(0) !== CHUNK_FRAME_TAG) return null
  const shortId = view.getUint32(1, false)
  const index = view.getUint32(5, false)
  const iv = new Uint8Array(buf.slice(9, 21)) as Uint8Array<ArrayBuffer>
  const ciphertext = buf.slice(CHUNK_FRAME_HEADER_BYTES)
  return { shortId, index, iv, ciphertext }
}

let shortIdCounter = (Math.random() * 0xffffffff) >>> 0
function nextShortId(): number {
  shortIdCounter = (shortIdCounter + 1) >>> 0
  if (shortIdCounter === 0) shortIdCounter = 1
  return shortIdCounter
}

// Per-chunk AES-GCM auth tags already provide cryptographic integrity for
// every chunk we deliver; computing a whole-file SHA-256 before sending and
// re-reading the assembled file at the receiver to verify it was a redundant
// 2× full-file scan that pegged CPU and delayed send start by several seconds
// on large files. The `fileHash` field in MetaMessage / TransferRecord
// remains for backwards-compat with old persisted records but is no longer
// populated.

// ── Send file ────────────────────────────────────────────────────────

export interface SendCallbacks {
  onProgress?: (sent: number, total: number) => void
  onError?: (error: string) => void
}

function shouldFlushProgress(lastAt: number, done: number, total: number) {
  return done === total || performance.now() - lastAt >= TRANSFER_PROGRESS_INTERVAL_MS
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
): Promise<void> {
  const lanes = dcs.filter(dc => dc.readyState === 'open').slice(0, TRANSFER_LANE_COUNT)
  const activeLanes = lanes.length > 0 ? lanes : (dcs[0] ? [dcs[0]] : [])
  if (activeLanes.length === 0) throw new Error('No open DataChannel lane available')

  const fileHash = existingRecord?.fileHash ?? ''
  // Zero-byte files: math.ceil(0/CHUNK_SIZE) = 0 → no chunks ever sent, so the
  // receiver's `received === total` completion gate (which only fires from
  // receiveChunk) never trips. Use 1 as the synthetic chunk count for empty
  // files; the meta message is enough on its own and the receiver detects the
  // empty case to deliver immediately.
  const totalChunks = file.size === 0 ? 0 : Math.ceil(file.size / CHUNK_SIZE)
  const shortId = nextShortId()
  // 8-byte random prefix; combined with the 4-byte chunk index it yields a
  // unique 12-byte IV per chunk without an RNG syscall in the hot loop.
  const ivPrefix = randomIvPrefix()
  const record: TransferRecord = existingRecord ?? {
    transferId,
    direction: 'send',
    peerNodeId,
    fileName: file.name,
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
  // sentBitmap mirrors what we've successfully shipped (and the receiver
  // ack'd via DataChannel ordering — DC is ordered+reliable, so once
  // dc.send returns the chunk has been queued and SCTP will deliver it).
  // Seeded from the existing record so cross-session resume picks up where
  // it left off.
  const sentBitmap = bitmapFromRecord(record)
  let sent = bitmapPopcount(skipBitmap)
  let nextChunk = 0
  let cancelled = false
  let lastProgressAt = performance.now()
  let lastRecordAt = performance.now()
  let recordDirty = false

  // Meta is always (re)sent so the receiver can register the new shortId for
  // this connection — cheap and avoids a separate "remap" message on resume.
  const meta = JSON.stringify({
    type: 'meta',
    transferId,
    shortId,
    fileName: file.name,
    fileSize: file.size,
    fileHash,
    totalChunks,
    mime: file.type || 'application/octet-stream',
  } satisfies MetaMessage)
  for (const lane of activeLanes) lane.send(meta)

  // Zero-byte files complete the moment meta has been sent — no chunks
  // follow. Synthesize the (1,1) tick so the UI doesn't render NaN%.
  if (file.size === 0) {
    callbacks?.onProgress?.(1, 1)
    await updateTransfer(transferId, { status: 'completed' })
    return
  }

  callbacks?.onProgress?.(sent, totalChunks)

  function nextIndex(): number | null {
    while (nextChunk < totalChunks) {
      const idx = nextChunk++
      if (!bitmapHas(skipBitmap, idx)) return idx
    }
    return null
  }

  async function flushRecord(force = false) {
    if (!recordDirty && !force) return
    if (!force && performance.now() - lastRecordAt < TRANSFER_RECORD_INTERVAL_MS) return
    // Persist the bitmap (fixed-size, O(totalChunks/8) bytes) instead of
    // serialising every chunk index. IDB structured-clones the buffer at
    // commit time so we keep our session's buffer pristine while the
    // copy is on the IDB side.
    record.receivedChunks = []
    record.receivedBitmap = sentBitmap.buffer.slice(0)
    await updateTransfer(transferId, {
      receivedChunks: [],
      receivedBitmap: record.receivedBitmap,
    })
    recordDirty = false
    lastRecordAt = performance.now()
  }

  // Pause/cancel check shared by the prefetcher and the send loop.
  // Returns true if the caller should abort the lane (cancelled).
  async function checkSignals(): Promise<boolean> {
    const signal = transferSignals.get(transferId)
    if (signal?.cancelled) {
      cancelled = true
      await updateTransfer(transferId, { status: 'failed' })
      return true
    }
    if (signal?.paused) {
      await updateTransfer(transferId, { status: 'paused' })
      await waitWhilePaused(transferId)
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

  // Read + encrypt the next chunk for a lane. Returns null when the queue is
  // drained (or the transfer was cancelled mid-prep). Runs on its own
  // microtask so the previous chunk's dc.send can overlap with disk I/O and
  // AES-GCM — this is the core of the lane-level pipeline.
  async function prepareNext(): Promise<{ i: number; iv: Uint8Array; encrypted: ArrayBuffer } | null> {
    if (cancelled) return null
    if (await checkSignals()) return null
    const i = nextIndex()
    if (i === null) return null
    const start = i * CHUNK_SIZE
    const end = Math.min(start + CHUNK_SIZE, file.size)
    const raw = await file.slice(start, end).arrayBuffer()
    const { iv, encrypted } = await encryptChunk(raw, peerSessionId, makeChunkIv(ivPrefix, i))
    return { i, iv, encrypted }
  }

  async function laneLoop(dc: RTCDataChannel) {
    // Kick off the first chunk; from then on each iteration starts the next
    // chunk's prepare before awaiting the current chunk's send.
    let prepared = await prepareNext()
    while (prepared && !cancelled) {
      // If this lane has closed under us (NAT/firewall reset a single SCTP
      // stream), don't take the chunk off the queue with a doomed send.
      // Put it back so a healthy lane can pick it up. (Bitmap doesn't
      // need explicit clears — nextChunk rewind makes the index re-enter
      // the loop and bitmapHas(skipBitmap, idx) is still false since we
      // never set it.)
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
        await waitForBuffer(dc)
        if (cancelled) return
        if (dc.readyState !== 'open') throw new Error('lane closed')
        dc.send(packet)
      } catch (laneErr) {
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

      if (bitmapSet(sentBitmap, current.i)) sent++
      recordDirty = true
      if (shouldFlushProgress(lastProgressAt, sent, totalChunks)) {
        callbacks?.onProgress?.(sent, totalChunks)
        lastProgressAt = performance.now()
      }
      await flushRecord(sent === totalChunks)

      prepared = await upcoming
    }
  }

  // Use allSettled: one lane's hard failure now triggers a re-queue + lane
  // exit (see laneLoop above), but the OTHER lanes must keep draining.
  await Promise.allSettled(activeLanes.map(lane => laneLoop(lane)))
  // If we exited with anything still un-sent (because all lanes died),
  // fail loudly. The success path already updates status='completed' below.
  if (!cancelled && sent < totalChunks) {
    throw new Error(`传输中断：${totalChunks - sent} 个分片未送达`)
  }
  await flushRecord(true)
  if (!cancelled) await updateTransfer(transferId, { status: 'completed' })
}

// ── Receive file ─────────────────────────────────────────────────────

export interface ReceiveCallbacks {
  onMeta?: (meta: MetaMessage) => void
  onProgress?: (received: number, total: number) => void
  onError?: (error: string) => void
}

type ReceiveSession = {
  transferId: string
  fileName: string
  fileSize: number
  fileHash: string
  totalChunks: number
  mime: string
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
  direction: 'recv'
}

const receiveSessions = new Map<string, ReceiveSession>()

export function getReceiveSession(transferId: string): ReceiveSession | undefined {
  return receiveSessions.get(transferId)
}

/**
 * Reason why a transfer's meta should be rejected before any chunks land.
 * Currently only one case (P1-5): receiver lacks both File System Access
 * and OPFS, and the incoming file is bigger than what an in-memory IDB
 * assemble can safely handle on a low-end device.
 */
export interface MetaRejection {
  reason: 'too-large-for-fallback'
  message: string
  limitBytes: number
}

/**
 * Pre-flight check: would accepting this transfer almost certainly OOM the
 * tab on the only storage path we have? If yes, returns a rejection the
 * caller can surface as a `failed:unsupported` transfer card and propagate
 * to the sender via the existing `transfer-cancel` control plane.
 *
 * Returns null when the transfer is fine to accept.
 */
export function checkMetaOOMGuard(meta: MetaMessage): MetaRejection | null {
  if (meta.fileSize <= MAX_INMEMORY_RECEIVE_BYTES) return null
  // If EITHER streaming-disk path is available, we won't hit the
  // in-memory IDB assemble step.
  if (supportsFileSystemAccess()) return null
  if (supportsOPFS()) return null
  const mb = Math.round(meta.fileSize / (1024 * 1024))
  const limitMb = Math.round(MAX_INMEMORY_RECEIVE_BYTES / (1024 * 1024))
  return {
    reason: 'too-large-for-fallback',
    message: `文件大小 ${mb} MB 超出当前浏览器的内存接收上限（${limitMb} MB）。请使用 Chrome / Edge 或升级 Firefox 到 111+ 以支持大文件流式落盘。`,
    limitBytes: MAX_INMEMORY_RECEIVE_BYTES,
  }
}

export async function handleMetaMessage(msg: MetaMessage, peerNodeId: number): Promise<ReceiveSession> {
  const existing = receiveSessions.get(msg.transferId)
  if (existing) return existing

  // CRITICAL: register the session SYNCHRONOUSLY before any await. The
  // DataChannel's onmessage queues meta + chunks back-to-back; if we await
  // any I/O before set()ing receiveSessions, the very next message (a
  // chunk for the same transfer on the same lane) reaches receiveChunk
  // BEFORE the session exists and gets silently dropped. Symptom: the
  // transfer card appears on the recipient but progress stays at 0%
  // forever even though the sender finished. (Hit during the folder e2e
  // test — race introduced when this function gained an `await getTransfer`
  // for resume restoration.)
  const session: ReceiveSession = {
    transferId: msg.transferId,
    fileName: msg.fileName,
    fileSize: msg.fileSize,
    fileHash: msg.fileHash,
    totalChunks: msg.totalChunks,
    mime: msg.mime,
    received: newBitmap(msg.totalChunks),
    receivedCount: 0,
    lastRecordAt: performance.now(),
    lastProgressAt: 0,
    storageMode: 'pending',
    direction: 'recv',
  }
  receiveSessions.set(msg.transferId, session)

  // Resume-aware: if a TransferRecord already exists from a prior session
  // (page reload mid-transfer), restore the bitmap so subsequent chunk
  // arrivals can still hit the `received === total` completion gate.
  // Chunks that race ahead of this restoration just set their bits
  // normally — bitmapSet is idempotent.
  try {
    const prior = await getTransfer(msg.transferId)
    if (prior && prior.direction === 'recv') {
      const fromRecord = bitmapFromRecord(prior)
      // OR-merge into session.received.
      for (let i = 0; i < fromRecord.length && i < session.received.length; i++) {
        session.received[i] |= fromRecord[i]
      }
      // Chunks already persisted on disk (IDB or OPFS may have written
      // them between the last record flush and the shutdown).
      const saved = await getSavedChunkIndexes(msg.transferId)
      for (const idx of saved) bitmapSet(session.received, idx)
      session.receivedCount = bitmapPopcount(session.received)
    }
  } catch { /* fresh transfer */ }

  // Persist (with whatever we just restored — keeps the record in sync if
  // the prior shutdown happened between a chunk save and the next interval
  // flush). New writes leave `receivedChunks: []` and persist the bitmap.
  await saveTransfer({
    transferId: msg.transferId,
    direction: 'recv',
    peerNodeId,
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

export async function receiveChunk(
  transferId: string,
  index: number,
  iv: Uint8Array<ArrayBuffer>,
  encrypted: ArrayBuffer,
  peerSessionId: string,
  callbacks?: ReceiveCallbacks,
): Promise<{ decrypted: ArrayBuffer; storageMode: 'stream' | 'indexeddb' } | undefined> {
  const session = receiveSessions.get(transferId)
  if (!session) return

  // Receiver-side pause: when the user clicks "pause" on the receive side,
  // network.ts sets this signal AND tells the sender to stop. In-flight
  // chunks (already buffered in the SCTP queue when the pause hit) keep
  // arriving briefly — drop them silently so we don't waste CPU on decrypt
  // and don't grow the on-disk file past the user's pause point. Cancelled
  // transfers fall through the same path; receiveSessions delete happens in
  // cancelReceive so the early-return at the top of this function takes over.
  const signal = transferSignals.get(transferId)
  if (signal?.paused) return
  if (signal?.cancelled) return

  // AES-GCM authenticates the encrypted payload — no separate per-chunk
  // checksum is needed (and the sender no longer ships one).
  const decrypted = await decryptChunk(iv, encrypted, peerSessionId)

  const hasStreamingTarget = getWriteHandle(transferId) || getOPFSHandle(transferId)
  if (session.storageMode === 'pending') {
    session.storageMode = hasStreamingTarget ? 'stream' : 'indexeddb'
  }
  if (session.storageMode === 'indexeddb') {
    await saveChunk(transferId, index, decrypted)
  }

  // bitmapSet returns true only on the 0→1 transition, so a duplicate
  // chunk doesn't double-count toward receivedCount.
  if (bitmapSet(session.received, index)) session.receivedCount++

  if (
    performance.now() - session.lastRecordAt >= TRANSFER_RECORD_INTERVAL_MS ||
    session.receivedCount === session.totalChunks
  ) {
    // Slice into a fresh buffer so IDB's structured-clone copy and the
    // session bitmap don't share underlying storage. Cost is one O(bytes)
    // memcpy per TRANSFER_RECORD_INTERVAL_MS — orders of magnitude cheaper
    // than the previous JSON serialise of every received chunk index.
    await updateTransfer(transferId, {
      receivedChunks: [],
      receivedBitmap: session.received.buffer.slice(0),
      updatedAt: Date.now(),
    })
    session.lastRecordAt = performance.now()
  }

  // Throttle progress callbacks the same way the sender does. Without this
  // the receiver fires setState ~4000×/GB, drowning the main thread in React
  // re-renders. Always emit the final tick so the "received === total"
  // delivery hook in network.ts still runs.
  const done = session.receivedCount === session.totalChunks
  if (done || performance.now() - session.lastProgressAt >= TRANSFER_PROGRESS_INTERVAL_MS) {
    callbacks?.onProgress?.(session.receivedCount, session.totalChunks)
    session.lastProgressAt = performance.now()
  }

  return { decrypted, storageMode: session.storageMode }
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
  // or truncated chunk would have failed decrypt above. No need to re-read
  // the whole file through SHA-256.
  return new File([blob], session.fileName, { type: session.mime })
}

export async function completeReceive(transferId: string): Promise<File> {
  const file = await assembleFile(transferId)
  await deleteChunks(transferId)
  await updateTransfer(transferId, { status: 'completed' })
  receiveSessions.delete(transferId)
  return file
}

export function cancelReceive(transferId: string) {
  receiveSessions.delete(transferId)
  // Without this, cancelled IndexedDB-fallback transfers leak their partial
  // chunks forever — multi-GB orphans accumulate across many cancellations
  // and silently consume the user's storage quota.
  deleteChunks(transferId).catch(() => {})
  updateTransfer(transferId, { status: 'failed' })
}

// ── Resume ───────────────────────────────────────────────────────────

export async function buildResumeRequest(transferId: string): Promise<ResumeRequest | null> {
  const record = await getTransfer(transferId)
  if (!record || record.status !== 'active') return null

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

// ── Flow control ─────────────────────────────────────────────────────

function waitWhilePaused(transferId: string): Promise<void> {
  return new Promise(resolve => {
    const check = () => {
      const s = transferSignals.get(transferId)
      if (!s || !s.paused) resolve()
      else setTimeout(check, 200)
    }
    check()
  })
}

function waitForBuffer(dc: RTCDataChannel): Promise<void> {
  return new Promise(resolve => {
    if (dc.bufferedAmount <= HIGH_WATER_MARK) {
      resolve()
      return
    }
    dc.bufferedAmountLowThreshold = LOW_WATER_MARK
    dc.onbufferedamountlow = () => {
      dc.onbufferedamountlow = null
      resolve()
    }
  })
}

// ── Helpers ──────────────────────────────────────────────────────────

// ── Transfer control signals ──────────────────────────────────────────

interface TransferSignal {
  paused: boolean
  cancelled: boolean
}

const transferSignals = new Map<string, TransferSignal>()

function getSignal(transferId: string): TransferSignal {
  let s = transferSignals.get(transferId)
  if (!s) {
    s = { paused: false, cancelled: false }
    transferSignals.set(transferId, s)
  }
  return s
}

export function pauseTransfer(transferId: string) {
  getSignal(transferId).paused = true
}

export function resumeTransfer(transferId: string) {
  getSignal(transferId).paused = false
}

export function cancelTransfer(transferId: string) {
  const s = getSignal(transferId)
  s.cancelled = true
  s.paused = false // unblock any waiting
  transferSignals.delete(transferId)
}

export function humanizeError(error: Error | string, channelType?: string): string {
  const msg = typeof error === 'string' ? error : error.message
  if (msg.includes('超时') || msg.includes('timeout')) {
    if (channelType === 'stun') return '连接超时 — 尝试在设置中开启 TURN 中继以穿越防火墙'
    return '连接超时 — 请检查网络或稍后重试'
  }
  if (msg.includes('加密') || msg.includes('AES') || msg.includes('key')) return '加密协商失败，请重新连接后重试'
  if (msg.includes('checksum')) return '数据校验失败，文件可能已损坏'
  if (msg.includes('DataChannel')) return '数据信道断开 — 尝试更换信道类型'
  return msg || '传输失败，请检查网络连接后重试'
}

export function createTransferId(): string {
  return crypto.randomUUID()
}

export async function checkForResumableTransfers(): Promise<TransferRecord[]> {
  return getActiveTransfers()
}

// ── Async write queue (fire-and-forget + backpressure) ────────────────
// FileSystemWritableFileStream serializes writes internally, so awaiting
// each chunk in the receive hot path gates throughput on disk latency.
// Fire writes without awaiting per chunk; cap outstanding bytes so the
// in-process queue can't grow without bound on slow disks.

const WRITE_BACKPRESSURE_BYTES = 16 * 1024 * 1024  // 16 MB outstanding cap

class WriteQueue {
  private pending = new Set<Promise<unknown>>()
  private pendingBytes = 0

  /**
   * Enqueue a write. Returns a promise that resolves immediately unless the
   * outstanding-bytes cap has been hit, in which case it waits for one
   * in-flight write to complete (coarse backpressure).
   */
  enqueue(promise: Promise<unknown>, bytes: number): Promise<unknown> | undefined {
    const tracked = promise.catch(err => {
      console.warn('[transfer] disk write failed', err)
    })
    this.pending.add(tracked)
    this.pendingBytes += bytes
    tracked.finally(() => {
      this.pending.delete(tracked)
      this.pendingBytes -= bytes
    })
    if (this.pendingBytes >= WRITE_BACKPRESSURE_BYTES && this.pending.size > 0) {
      return Promise.race(this.pending)
    }
    return undefined
  }

  async drain(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled(this.pending)
    }
  }
}

// ── OPFS disk-backed receive (all modern browsers) ────────────────────
// Uses navigator.storage.getDirectory() to write chunks to disk as they
// arrive, avoiding the all-in-memory Blob assembly. Available in Chrome
// 86+, Safari 15.2+, Firefox 111+. Falls back to IndexedDB + Blob for
// very old browsers.

export interface OPFSReceiveHandle {
  writable: FileSystemWritableFileStream
  fileHandle: FileSystemFileHandle
  written: Set<number>
  totalChunks: number
  fileName: string
  queue: WriteQueue
}

const opfsHandles = new Map<string, OPFSReceiveHandle>()

export function supportsOPFS(): boolean {
  return typeof navigator !== 'undefined' && 'storage' in navigator && 'getDirectory' in navigator.storage
}

export async function createOPFSReceiveFile(
  transferId: string,
  fileName: string,
  totalChunks: number,
): Promise<OPFSReceiveHandle> {
  const root = await navigator.storage.getDirectory()
  const dir = await root.getDirectoryHandle('misaka-transfers', { create: true })
  const fileHandle = await dir.getFileHandle(`${transferId}-${fileName}`, { create: true })
  // Keep existing data so a page-refresh mid-transfer doesn't truncate the
  // already-written bytes. The resume bitmap (built from IndexedDB) tells the
  // sender which chunk indexes are still missing; sparse writes here fill
  // exactly those.
  const writable = await fileHandle.createWritable({ keepExistingData: true })
  const handle: OPFSReceiveHandle = { writable, fileHandle, written: new Set(), totalChunks, fileName, queue: new WriteQueue() }
  opfsHandles.set(transferId, handle)
  return handle
}

export function getOPFSHandle(transferId: string): OPFSReceiveHandle | undefined {
  return opfsHandles.get(transferId)
}

export async function writeChunkToOPFS(
  transferId: string,
  index: number,
  data: ArrayBuffer,
): Promise<void> {
  const handle = opfsHandles.get(transferId)
  if (!handle) return
  const offset = index * CHUNK_SIZE
  handle.written.add(index)
  const wait = handle.queue.enqueue(
    handle.writable.write({ type: 'write', position: offset, data: new Uint8Array(data) }),
    data.byteLength,
  )
  if (wait) await wait
}

export async function getOPFSFile(transferId: string): Promise<File> {
  const handle = opfsHandles.get(transferId)
  if (!handle) throw new Error('No OPFS handle')
  await handle.queue.drain()
  await handle.writable.close()
  const file = await handle.fileHandle.getFile()
  opfsHandles.delete(transferId)
  return file
}

export async function cleanupOPFS(transferId: string) {
  const handle = opfsHandles.get(transferId)
  if (handle) {
    // Drain queued writes BEFORE closing — otherwise pending write promises
    // reject with "stream closed" and the OPFS directory entry can briefly
    // re-appear after `removeEntry` because a late write recreated it.
    await handle.queue.drain().catch(() => {})
    await handle.writable.close().catch(() => {})
    opfsHandles.delete(transferId)
  }
  try {
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle('misaka-transfers', { create: false })
    // Find and remove the OPFS file for this transfer
    for await (const [name] of dir as any) {
      if (name.startsWith(transferId)) {
        await dir.removeEntry(name).catch(() => {})
      }
    }
  } catch { /* directory may not exist */ }
}

// ── File System Access API streaming write (Chromium) ──────────────────

export interface FileWriteHandle {
  writable: FileSystemWritableFileStream
  fileHandle: FileSystemFileHandle
  written: Set<number>
  totalChunks: number
  queue: WriteQueue
}

const writeHandles = new Map<string, FileWriteHandle>()

export function supportsFileSystemAccess(): boolean {
  return typeof window !== 'undefined' && 'showSaveFilePicker' in window
}

export async function requestWriteHandle(
  transferId: string,
  suggestedName: string,
  totalChunks: number,
): Promise<FileWriteHandle> {
  // Use type assertion for File System Access API (not in all TS libs)
  const ext = suggestedName.split('.').pop() ?? 'bin'
  const fileHandle = await (window as any).showSaveFilePicker({
    suggestedName,
    types: [{ description: suggestedName, accept: { 'application/octet-stream': [`.${ext}`] } }],
  }) as FileSystemFileHandle
  const writable = await fileHandle.createWritable()
  const handle: FileWriteHandle = { writable, fileHandle, written: new Set(), totalChunks, queue: new WriteQueue() }
  writeHandles.set(transferId, handle)
  return handle
}

export function getWriteHandle(transferId: string): FileWriteHandle | undefined {
  return writeHandles.get(transferId)
}

export async function streamChunkToDisk(
  transferId: string,
  index: number,
  data: ArrayBuffer,
): Promise<void> {
  const handle = writeHandles.get(transferId)
  if (!handle) return
  const offset = index * CHUNK_SIZE
  handle.written.add(index)
  const wait = handle.queue.enqueue(
    handle.writable.write({ type: 'write', position: offset, data: new Uint8Array(data) }),
    data.byteLength,
  )
  if (wait) await wait
}

export async function finalizeStreamedFile(transferId: string): Promise<File> {
  const handle = writeHandles.get(transferId)
  if (!handle) throw new Error('No write handle')

  await handle.queue.drain()
  await handle.writable.close()
  writeHandles.delete(transferId)

  return handle.fileHandle.getFile()
}

export function cancelStreamWrite(transferId: string) {
  const handle = writeHandles.get(transferId)
  if (handle) {
    handle.writable.close().catch(() => {})
    writeHandles.delete(transferId)
  }
}
