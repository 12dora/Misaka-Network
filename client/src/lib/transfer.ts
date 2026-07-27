import {
  saveTransfer, updateTransfer, getTransfer, getActiveTransfers,
  saveChunk, getChunk, deleteChunks, getSavedChunkIndexes,
  pruneTerminalTransfers,
  type TransferRecord,
} from './db'
import { encryptChunk, decryptChunk, makeChunkIv, randomIvPrefix } from './crypto'
import * as constants from '@/constants'
const {
  CHUNK_SIZE, HIGH_WATER_MARK, LOW_WATER_MARK,
  TRANSFER_PROGRESS_INTERVAL_MS, TRANSFER_RECORD_INTERVAL_MS,
  TRANSFER_LANE_COUNT, MAX_INMEMORY_RECEIVE_BYTES,
} = constants
// P1-5: sender-side upper bound on the file size we accept. The main
// agent will publish `MAX_FILE_SIZE` from constants.ts; until then, fall
// back to 16 GB so the guard still functions. The CHUNK_SIZE×uint32
// index space allows roughly 1 PB but 16 GB matches the practical
// receiver-side OPFS quota on most browsers and stays far away from
// Number.MAX_SAFE_INTEGER (~9 PB) math edges.
const MAX_FILE_SIZE: number =
  (constants as { MAX_FILE_SIZE?: number }).MAX_FILE_SIZE ?? (16 * 1024 * 1024 * 1024)
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

// ── Protocol version (P0 roadmap item 9) ─────────────────────────────
//
// v1  the original delivery semantics: meta → chunks immediately, sender
//     "completed" == locally queued, receiver pause silently drops in-flight
//     chunks, no repair, no finalization ACK.
//
// v2  the delivery semantics this file now implements:
//       * `hello` announces each side's version on the primary channel;
//       * the receiver must ACK `transfer-ready` (its storage backend is
//         committed and writable) before the sender ships any payload;
//       * a pause records what it dropped and `transfer-repair` re-queues
//         exactly those indexes into the SAME live send task;
//       * `transfer-done` is the receiver's durable-write ACK — only then is
//         a send "saved", and only then may the source File be released.
//
// Both sides run `negotiatedProtocolVersion()` = min(mine, theirs). A v2
// client talking to a v1 client therefore falls back to v1 semantics
// wholesale instead of waiting forever for ACKs that will never arrive.
//
// The BINARY CHUNK FRAME IS UNCHANGED between v1 and v2 — tag 0x01 and the
// [tag:1][shortId:4][index:4][iv:12][ciphertext] layout are stable, and so is
// the `makeChunkIv` 8-byte-prefix + 4-byte-BE-index construction. Only the
// JSON control plane grew.
export const PROTOCOL_VERSION = 2
const LEGACY_PROTOCOL_VERSION = 1

const peerProtocolVersions = new Map<string, number>()

/** Record the version a peer announced (via `hello` or the `v` field on
 *  `meta`). Unknown / malformed values pin the peer at v1. */
export function setPeerProtocolVersion(peerSessionId: string, raw: unknown): number {
  const v = typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= 255
    ? raw
    : LEGACY_PROTOCOL_VERSION
  // Never downgrade a peer that already proved a higher version: a stray
  // legacy-shaped message must not strip ACK semantics mid-transfer.
  const prior = peerProtocolVersions.get(peerSessionId) ?? LEGACY_PROTOCOL_VERSION
  const next = Math.max(prior, v)
  peerProtocolVersions.set(peerSessionId, next)
  return next
}

export function getPeerProtocolVersion(peerSessionId: string): number {
  return peerProtocolVersions.get(peerSessionId) ?? LEGACY_PROTOCOL_VERSION
}

/** The semantics both sides actually agree on. */
export function negotiatedProtocolVersion(peerSessionId: string): number {
  return Math.min(PROTOCOL_VERSION, getPeerProtocolVersion(peerSessionId))
}

export function clearPeerProtocolVersion(peerSessionId?: string) {
  if (peerSessionId) peerProtocolVersions.delete(peerSessionId)
  else peerProtocolVersions.clear()
}

/** The handshake frame sent on the primary DataChannel alongside `ecdh-pub`. */
export function makeHelloMessage(): string {
  return JSON.stringify({ type: 'hello', v: PROTOCOL_VERSION })
}

export interface MetaMessage {
  type: 'meta'
  transferId: string
  shortId: number          // compact id embedded in binary chunk frames
  fileName: string
  fileSize: number
  fileHash: string
  totalChunks: number
  mime: string
  /** Protocol version of the sender (v2+). Absent ⇒ legacy v1 peer. */
  v?: number
}

/** Receiver → sender: the storage backend is committed and writable, ship it. */
export interface ReadyMessage {
  type: 'transfer-ready'
  transferId: string
  /** Echoed so the sender can drop an ACK for a superseded attempt. */
  shortId: number
}

/** Receiver → sender: refuse before any payload moves. */
export interface RejectMessage {
  type: 'transfer-reject'
  transferId: string
  reason: string
  message: string
}

/** Receiver → sender: these indexes are still missing, re-queue them. */
export interface RepairRequest {
  type: 'transfer-repair'
  transferId: string
  missingRanges: Array<[number, number]>
}

/** Receiver → sender: the file is durably written and delivered. */
export interface DoneMessage {
  type: 'transfer-done'
  transferId: string
  bytes: number
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

export type DCProtocolMessage =
  | MetaMessage
  | ResumeRequest
  | ReadyMessage
  | RejectMessage
  | RepairRequest
  | DoneMessage
  | { type: 'hello'; v: number }
  | { type: 'ecdh-pub'; pub: string }

// ── Inbound validation (SECURITY-007) ────────────────────────────────
// Everything below the DataChannel is attacker-controlled: a connected peer
// in the same identity cluster can put any JSON on the wire. Before ANY
// state change (bitmap allocation, IDB row, OPFS file, sparse disk write) we
// prove the metadata is internally consistent and bounded.
//
// The concrete attacks this closes:
//   * tiny `fileSize` + huge `totalChunks` → hundreds of MB of bitmap and a
//     `newBitmap()` allocation the tab cannot survive;
//   * out-of-range / non-integer chunk index → `index * CHUNK_SIZE` sparse
//     write far past the declared end of file (OPFS quota bomb);
//   * oversized / path-bearing / control-char file names → directory-entry
//     confusion in OPFS and a nasty download name;
//   * a plaintext whose length disagrees with the declared geometry → a file
//     that is silently longer or shorter than `fileSize`.

export const MAX_TRANSFER_ID_LENGTH = 128
export const MAX_FILE_NAME_LENGTH = 255
export const MAX_MIME_LENGTH = 128
// Chunk indexes travel as uint32 in the binary frame, so the index space is
// hard-bounded regardless of what `meta` claims.
export const MAX_TOTAL_CHUNKS = 0xffffffff

// UUIDs, the ids our own `createTransferId()` mints, and the readable ids the
// unit tests use. Deliberately excludes path separators, quotes and anything
// that could confuse an OPFS entry name (`${transferId}-${fileName}`).
const TRANSFER_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/g

/** Exact number of chunks a file of `fileSize` bytes must be split into. */
export function expectedChunkCount(fileSize: number): number {
  return fileSize === 0 ? 0 : Math.ceil(fileSize / CHUNK_SIZE)
}

/** Exact plaintext length of chunk `index` for a file of `fileSize` bytes. */
export function expectedChunkLength(fileSize: number, index: number): number {
  const start = index * CHUNK_SIZE
  return Math.max(0, Math.min(CHUNK_SIZE, fileSize - start))
}

/**
 * Strip anything that could escape the intended file name: path separators
 * (both flavours), control characters, and leading dots that would produce a
 * hidden entry. Returns '' when nothing usable is left, which the caller
 * treats as a validation failure rather than substituting a name of its own.
 */
export function sanitizeFileName(raw: string): string {
  const flat = raw.replace(CONTROL_CHARS_RE, '').replace(/[\\/]+/g, '_').trim()
  const noDotDot = flat.replace(/^\.+/, '')
  return noDotDot.slice(0, MAX_FILE_NAME_LENGTH)
}

export interface MetaValidationFailure {
  ok: false
  code:
    | 'malformed'
    | 'bad-transfer-id'
    | 'bad-short-id'
    | 'bad-file-name'
    | 'bad-file-size'
    | 'bad-chunk-count'
  message: string
}

export type MetaValidationResult =
  | { ok: true; meta: MetaMessage }
  | MetaValidationFailure

/**
 * Validate + normalise an inbound `meta` message. Returns a NEW object — the
 * caller must use the returned `meta`, never the raw wire value, so that the
 * sanitised file name and clamped MIME are what reach storage.
 */
export function validateMetaMessage(raw: unknown): MetaValidationResult {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, code: 'malformed', message: '传输元数据格式非法' }
  }
  const m = raw as Record<string, unknown>
  if (m.type !== 'meta') {
    return { ok: false, code: 'malformed', message: '传输元数据格式非法' }
  }

  const transferId = m.transferId
  if (typeof transferId !== 'string' || !TRANSFER_ID_RE.test(transferId)) {
    return { ok: false, code: 'bad-transfer-id', message: '传输 ID 非法' }
  }

  const shortId = m.shortId
  if (typeof shortId !== 'number' || !Number.isInteger(shortId) || shortId < 0 || shortId > 0xffffffff) {
    return { ok: false, code: 'bad-short-id', message: '传输短 ID 非法' }
  }

  const rawName = typeof m.fileName === 'string' ? m.fileName : ''
  if (rawName.length === 0 || rawName.length > MAX_FILE_NAME_LENGTH * 4) {
    return { ok: false, code: 'bad-file-name', message: '文件名非法' }
  }
  const fileName = sanitizeFileName(rawName)
  if (fileName.length === 0) {
    return { ok: false, code: 'bad-file-name', message: '文件名非法' }
  }

  const fileSize = m.fileSize
  if (
    typeof fileSize !== 'number' || !Number.isSafeInteger(fileSize)
    || fileSize < 0 || fileSize > MAX_FILE_SIZE
  ) {
    return { ok: false, code: 'bad-file-size', message: '文件大小超出允许范围' }
  }

  const totalChunks = m.totalChunks
  if (
    typeof totalChunks !== 'number' || !Number.isSafeInteger(totalChunks)
    || totalChunks < 0 || totalChunks > MAX_TOTAL_CHUNKS
  ) {
    return { ok: false, code: 'bad-chunk-count', message: '分片数量非法' }
  }
  // THE key invariant: chunk count is fully determined by file size. This is
  // what stops "1 KB file, 400 000 000 chunks" from allocating a 50 MB bitmap
  // and an IDB row per index.
  if (totalChunks !== expectedChunkCount(fileSize)) {
    return {
      ok: false,
      code: 'bad-chunk-count',
      message: `分片数量与文件大小不符（声明 ${totalChunks}，应为 ${expectedChunkCount(fileSize)}）`,
    }
  }

  const rawMime = typeof m.mime === 'string' ? m.mime : ''
  const mime = rawMime.replace(CONTROL_CHARS_RE, '').slice(0, MAX_MIME_LENGTH)
    || 'application/octet-stream'

  return {
    ok: true,
    meta: {
      type: 'meta',
      transferId,
      shortId,
      fileName,
      fileSize,
      fileHash: typeof m.fileHash === 'string' ? m.fileHash.slice(0, 128) : '',
      totalChunks,
      mime,
      v: typeof m.v === 'number' && Number.isInteger(m.v) ? m.v : LEGACY_PROTOCOL_VERSION,
    },
  }
}

/** Is `index` a legal chunk index for this transfer geometry? */
export function isValidChunkIndex(index: number, totalChunks: number): boolean {
  return Number.isSafeInteger(index) && index >= 0 && index < totalChunks
}

// ── Transfer ownership (SECURITY-015) ────────────────────────────────
// A transfer belongs to exactly one `(peerSessionId, epoch)` pair. `nodeId`
// is NOT an owner: every device of one identity shares it, so a third device
// in the same cluster could otherwise learn a transferId and then observe the
// resume bitmap or issue pause/cancel against a transfer between two other
// devices. Every control-plane entry point runs `assertTransferOwner` first.

export interface TransferOwner {
  peerSessionId: string
  epoch: number
}

interface OwnerRecord extends TransferOwner {
  direction: 'send' | 'recv'
  /** Immutable metadata — a second `meta` claiming different geometry for the
   *  same id is an attack (or a bug) and must be refused, not merged. */
  fileName: string
  fileSize: number
  totalChunks: number
}

const transferOwners = new Map<string, OwnerRecord>()

export class TransferOwnershipError extends Error {
  code: 'owner-mismatch' | 'metadata-mismatch'
  constructor(code: 'owner-mismatch' | 'metadata-mismatch', message: string) {
    super(message)
    this.name = 'TransferOwnershipError'
    this.code = code
  }
}

export function getTransferOwner(transferId: string): TransferOwner | undefined {
  const rec = transferOwners.get(transferId)
  return rec ? { peerSessionId: rec.peerSessionId, epoch: rec.epoch } : undefined
}

export function registerTransferOwner(transferId: string, record: OwnerRecord) {
  transferOwners.set(transferId, record)
}

export function clearTransferOwner(transferId: string) {
  transferOwners.delete(transferId)
}

/**
 * True when `owner` may act on `transferId`. An UNKNOWN transfer is not
 * owned by anybody yet, so it passes — registration happens in the same tick
 * as the first legitimate use (`handleMetaMessage` / `sendFileParallel`) and
 * a control message for an unknown id is a no-op anyway.
 */
export function assertTransferOwner(transferId: string, owner: TransferOwner | undefined): boolean {
  const rec = transferOwners.get(transferId)
  if (!rec) return true
  if (!owner) return false
  return rec.peerSessionId === owner.peerSessionId && rec.epoch === owner.epoch
}

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
  settled: boolean
  promise: Promise<SendOutcome>
  /** Re-queue indexes the receiver reports missing (BUG-013 repair). */
  requeue: (indexes: Iterable<number>) => number
  /** Merge a fresh peer bitmap into the skip set (resume). */
  applyPeerBitmap: (bitmap: Uint8Array) => void
  /** Receiver finalization ACK plumbing (BUG-016). */
  acked: boolean
  notifyAck?: () => void
  /** Wakes an ACK wait when a repair request arrives instead (BUG-013). */
  notifyRepair?: () => void
}

const sendTasks = new Map<string, SendTask>()

export function getSendTaskInfo(transferId: string):
  { peerSessionId: string; epoch: number; settled: boolean; acked: boolean } | undefined {
  const t = sendTasks.get(transferId)
  if (!t) return undefined
  return { peerSessionId: t.peerSessionId, epoch: t.epoch, settled: t.settled, acked: t.acked }
}

export function hasLiveSendTask(transferId: string): boolean {
  const t = sendTasks.get(transferId)
  return !!t && !t.settled
}

/**
 * Receiver's `transfer-done` ACK landed (BUG-016). Ownership-checked: only
 * the peer that owns the transfer may confirm it.
 */
export function markTransferAcked(transferId: string, owner: TransferOwner | undefined): boolean {
  if (!assertTransferOwner(transferId, owner)) return false
  const task = sendTasks.get(transferId)
  if (!task) return false
  if (owner && task.peerSessionId !== owner.peerSessionId) return false
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
 */
export function applyRepairRequest(
  req: { transferId: string; missingRanges?: Array<[number, number]>; missing?: number[] },
  owner: TransferOwner | undefined,
): number {
  if (!assertTransferOwner(req.transferId, owner)) return -1
  const task = sendTasks.get(req.transferId)
  if (!task || task.settled) return -1
  if (owner && task.peerSessionId !== owner.peerSessionId) return -1
  const indexes: number[] = []
  if (Array.isArray(req.missingRanges)) {
    for (const range of req.missingRanges) {
      if (!Array.isArray(range) || range.length !== 2) continue
      const [start, length] = range
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length)) continue
      if (start < 0 || length <= 0 || length > MAX_TOTAL_CHUNKS) continue
      for (let i = start; i < start + length; i++) indexes.push(i)
    }
  }
  if (Array.isArray(req.missing)) {
    for (const i of req.missing) if (Number.isSafeInteger(i) && i >= 0) indexes.push(i)
  }
  return task.requeue(indexes)
}

// How long the sender waits for the receiver's durable-write ACK before
// giving up and reporting `delivered` (not `saved`). Generous: the receiver
// may still be draining a multi-GB OPFS write queue when the last chunk
// lands.
export const RECEIVER_ACK_TIMEOUT_MS = 60_000
// Upper bound on how long we wait for the lanes' SCTP buffers to drain
// before declaring `delivered`.
const LANE_DRAIN_TIMEOUT_MS = 30_000

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

  const task: SendTask = {
    transferId,
    peerSessionId,
    epoch,
    settled: false,
    acked: false,
    promise: undefined as unknown as Promise<SendOutcome>,
    requeue: () => -1,
    applyPeerBitmap: () => {},
  }
  // Registered SYNCHRONOUSLY (runSendEngine runs up to its first await inside
  // this same tick), so a second entry point can never slip past the guard.
  sendTasks.set(transferId, task)
  registerTransferOwner(transferId, {
    peerSessionId, epoch, direction: 'send',
    fileName: wireFileName, fileSize: file.size,
    totalChunks: expectedChunkCount(file.size),
  })

  const promise = runSendEngine(
    task, dcs, file, transferId, peerNodeId, peerSessionId,
    existingRecord, callbacks, peerReceivedBitmap, wireFileName,
  )
  task.promise = promise
  promise.then(
    () => { task.settled = true },
    () => { task.settled = true },
  ).finally(() => {
    if (sendTasks.get(transferId) === task) sendTasks.delete(transferId)
  })
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
  const shortId = nextShortId()
  // 8-byte random prefix; combined with the 4-byte chunk index it yields a
  // unique 12-byte IV per chunk without an RNG syscall in the hot loop.
  const ivPrefix = randomIvPrefix()
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
  let sent = bitmapPopcount(skipBitmap)
  let nextChunk = 0
  let cancelled = false
  let lastProgressAt = performance.now()
  // Set by `task.requeue` when the receiver reports missing chunks after a
  // pause; makes the outer loop run the lanes again instead of finishing a
  // transfer that is knowingly incomplete (BUG-013).
  let repairRequested = false

  // BUG-013: the receiver's repair request lands here. Clearing the bits is
  // what makes `acquireChunk` hand those indexes out again; rewinding
  // `nextChunk` is what makes the cursor reach them.
  task.requeue = (indexes: Iterable<number>) => {
    let n = 0
    for (const idx of indexes) {
      if (!isValidChunkIndex(idx, totalChunks)) continue
      const byte = idx >>> 3
      const mask = 1 << (idx & 7)
      let cleared = false
      if ((sentBitmap[byte] & mask) !== 0) { sentBitmap[byte] &= ~mask; cleared = true }
      if ((skipBitmap[byte] & mask) !== 0) { skipBitmap[byte] &= ~mask; cleared = true }
      if (cleared) sent = Math.max(0, sent - 1)
      nextChunk = Math.min(nextChunk, idx)
      n++
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
    for (let i = 0; i < copyLen; i++) skipBitmap[i] |= bitmap[i]
    sent = Math.max(sent, bitmapPopcount(skipBitmap))
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

  // BUG-011: with a v2 receiver, no payload may move until the receiver has
  // COMMITTED a writable storage backend and ACKed `transfer-ready`. Under
  // v1 the receiver has no way to ACK, so we keep the legacy behaviour of
  // shipping immediately (the receiver then buffers early chunks itself).
  const legacyPeer = negotiatedProtocolVersion(peerSessionId) < 2
  if (!legacyPeer && file.size > 0) {
    const ready = await waitForReceiverReady(transferId)
    if (!ready) {
      const signal = transferSignals.get(transferId)
      if (signal?.cancelled) {
        transferSignals.delete(transferId)
        throw new TransferCancelledError()
      }
      throw new Error('接收端未就绪（存储准备超时）')
    }
  }

  // Zero-byte files complete the moment meta has been sent — no chunks
  // follow. Synthesize the (1,1) tick so the UI doesn't render NaN%.
  //
  // BUG-016 nuance: an empty file is FULLY described by the meta message, so
  // there is no payload that a mid-flight drop could truncate. We therefore
  // report `saved` (and release the retry source) without waiting for an ACK
  // that would otherwise pin the source File for the full ACK timeout.
  if (file.size === 0) {
    callbacks?.onProgress?.(1, 1)
    callbacks?.onDeliveryState?.('queued')
    callbacks?.onDeliveryState?.('delivered')
    callbacks?.onDeliveryState?.('saved')
    await updateTransfer(transferId, { status: 'completed' })
    return { state: 'saved', acked: false, legacyPeer }
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
    // P1-9: domain-separate the IV with transferId so two transfers
    // can never produce the same (key, IV) pair even if their random
    // 8-byte prefixes happen to collide.
    const ivForChunk = await makeChunkIv(ivPrefix, i, transferId)
    const { iv, encrypted } = await encryptChunk(raw, peerSessionId, ivForChunk)
    return { i, iv, encrypted }
  }

  async function laneLoop(dc: RTCDataChannel) {
    // Kick off the first chunk; from then on each iteration starts the next
    // chunk's prepare before awaiting the current chunk's send.
    let prepared = await prepareNext()
    while (prepared && !cancelled) {
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
      transferSignals.delete(transferId)
      throw new TransferCancelledError()
    }
    if (repairRequested && activeLanes.some(dc => dc.readyState === 'open')) continue
    // If we exited with anything still un-sent (all lanes died), fail loudly.
    if (sent < totalChunks) {
      throw new Error(`传输中断：${totalChunks - sent} 个分片未送达`)
    }

    // ── BUG-016: queued → delivered → saved ───────────────────────────
    callbacks?.onDeliveryState?.('queued')
    await drainLanes(activeLanes)
    if (repairRequested) continue
    callbacks?.onDeliveryState?.('delivered')

    if (legacyPeer) {
      // A v1 peer will never ACK. Legacy semantics: local drain is as good as
      // it gets — but we report it honestly as `delivered`, not `saved`.
      await updateTransfer(transferId, { status: 'completed' })
      return { state: 'delivered', acked: false, legacyPeer: true }
    }

    const settled = await waitForReceiverAck(task, RECEIVER_ACK_TIMEOUT_MS)
    if (settled === 'repair') continue
    if (settled === 'cancelled') {
      transferSignals.delete(transferId)
      throw new TransferCancelledError()
    }
    if (settled === 'timeout') {
      // No ACK: the receive side may still be writing, or the link died
      // between our last send and its durable write. Do NOT claim `saved`;
      // the caller keeps the source File so the user can retry.
      await updateTransfer(transferId, { status: 'completed' })
      return { state: 'delivered', acked: false, legacyPeer: false }
    }
    callbacks?.onDeliveryState?.('saved')
    await updateTransfer(transferId, { status: 'completed' })
    return { state: 'saved', acked: true, legacyPeer: false }
  }

  if (cancelled) {
    transferSignals.delete(transferId)
    throw new TransferCancelledError()
  }
  throw new Error(`传输中断：修复轮次超过上限（${MAX_REPAIR_ROUNDS}）`)
}

// A repair storm must terminate: each round can only re-queue indexes the
// receiver is still missing, so a healthy link converges in one or two.
const MAX_REPAIR_ROUNDS = 8

/** Wait until every lane's SCTP buffer has drained (or the lane died). */
async function drainLanes(lanes: RTCDataChannel[]): Promise<void> {
  const deadline = Date.now() + LANE_DRAIN_TIMEOUT_MS
  for (const dc of lanes) {
    while (dc.readyState === 'open' && dc.bufferedAmount > 0) {
      if (Date.now() > deadline) return
      await waitForBuffer(dc)
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
// says its storage backend is committed. Keyed by transferId; the resolver is
// invoked by `markReceiverReady()` from the control-plane dispatcher.

export const RECEIVER_READY_TIMEOUT_MS = 30_000

const receiverReadyWaiters = new Map<string, (ready: boolean) => void>()
const receiverReadyFlags = new Set<string>()

/** Receiver ACKed `transfer-ready`. Ownership-checked. */
export function markReceiverReady(transferId: string, owner: TransferOwner | undefined): boolean {
  if (!assertTransferOwner(transferId, owner)) return false
  receiverReadyFlags.add(transferId)
  const settle = receiverReadyWaiters.get(transferId)
  receiverReadyWaiters.delete(transferId)
  settle?.(true)
  return true
}

/** Receiver refused the transfer up-front — unpark the sender immediately. */
export function markReceiverRejected(transferId: string, owner: TransferOwner | undefined): boolean {
  if (!assertTransferOwner(transferId, owner)) return false
  const settle = receiverReadyWaiters.get(transferId)
  receiverReadyWaiters.delete(transferId)
  settle?.(false)
  return true
}

export function clearReceiverReady(transferId: string) {
  receiverReadyFlags.delete(transferId)
  const settle = receiverReadyWaiters.get(transferId)
  receiverReadyWaiters.delete(transferId)
  settle?.(false)
}

function waitForReceiverReady(transferId: string, timeoutMs = RECEIVER_READY_TIMEOUT_MS): Promise<boolean> {
  if (receiverReadyFlags.has(transferId)) return Promise.resolve(true)
  return new Promise<boolean>(resolve => {
    const timer = setTimeout(() => {
      if (receiverReadyWaiters.get(transferId) === settle) receiverReadyWaiters.delete(transferId)
      resolve(false)
    }, timeoutMs)
    const settle = (ready: boolean) => {
      clearTimeout(timer)
      resolve(ready)
    }
    receiverReadyWaiters.set(transferId, settle)
  })
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
  direction: 'recv'
  // P0-2: track every saveChunk promise we kick off so `cancelReceive`
  // can drain them BEFORE deleteChunks runs.
  inflightSaves: Set<Promise<unknown>>
  /** BUG-011: chunks that arrived before the backend was committed. Bounded;
   *  anything past the bound is dropped and recovered by the repair path. */
  buffered: Array<{ index: number; iv: Uint8Array<ArrayBuffer>; encrypted: ArrayBuffer }>
  /** BUG-013: indexes dropped because the receiver was paused. These become
   *  the `transfer-repair` request on resume. */
  droppedWhilePaused: Uint8Array<ArrayBuffer>
  droppedCount: number
  /** BUG-018: set by `finalizeReceive` so a second completion is a no-op. */
  finalized: boolean
}

const receiveSessions = new Map<string, ReceiveSession>()

// BUG-011: at most this many pre-commit frames are held per transfer. 32 ×
// 252 KB ≈ 8 MB — enough to cover a legacy (v1) sender that starts blasting
// the moment it has sent `meta`, without giving a hostile peer an unbounded
// memory sink. Overflow is safe: the repair/resume path re-requests them.
const MAX_BUFFERED_PRECOMMIT_FRAMES = 32

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
    received: newBitmap(msg.totalChunks),
    receivedCount: 0,
    lastRecordAt: performance.now(),
    lastProgressAt: 0,
    storageMode: 'pending',
    backend: null,
    direction: 'recv',
    inflightSaves: new Set(),
    buffered: [],
    droppedWhilePaused: newBitmap(msg.totalChunks),
    droppedCount: 0,
    finalized: false,
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
  if (msg.v !== undefined && owner.peerSessionId) {
    setPeerProtocolVersion(owner.peerSessionId, msg.v)
  }

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

const backendPreparations = new Map<string, Promise<PrepareBackendResult>>()

export type PrepareBackendResult =
  | { ok: true; mode: 'fsa' | 'opfs' | 'idb' }
  | { ok: false; rejection: MetaRejection }

function preparationKey(owner: TransferOwner, transferId: string): string {
  return `${owner.peerSessionId}\u0000${transferId}`
}

/**
 * Select, PROVE-WRITABLE and commit a receive backend, then apply the
 * in-memory cap to the committed result (BUG-012). Concurrent calls for the
 * same `(peerSessionId, transferId)` share one preparation (BUG-011).
 */
export function prepareReceiveBackend(
  meta: { transferId: string; fileName: string; totalChunks: number; size: number },
  owner: TransferOwner = { peerSessionId: '', epoch: 0 },
): Promise<PrepareBackendResult> {
  const key = preparationKey(owner, meta.transferId)
  const inFlight = backendPreparations.get(key)
  if (inFlight) return inFlight

  const task = (async (): Promise<PrepareBackendResult> => {
    const selected = await selectWritableBackend(meta)
    const rejection = checkBackendOOMGuard(meta.size, selected)
    if (rejection) {
      // Undo whatever we committed — we are refusing this transfer.
      if (selected === 'opfs') await cleanupOPFS(meta.transferId).catch(() => {})
      if (selected === 'fsa') cancelStreamWrite(meta.transferId)
      return { ok: false, rejection }
    }
    const session = receiveSessions.get(meta.transferId)
    if (session) {
      session.backend = selected
      session.storageMode = selected === 'idb' ? 'indexeddb' : 'stream'
      // Everything buffered while we were preparing can now be persisted, in
      // index order, through the exact same path a live chunk takes.
      await flushBufferedChunks(session)
    }
    return { ok: true, mode: selected }
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

async function flushBufferedChunks(session: ReceiveSession) {
  if (session.buffered.length === 0) return
  const queued = session.buffered.slice().sort((a, b) => a.index - b.index)
  session.buffered.length = 0
  for (const frame of queued) {
    try {
      await persistChunk(session, frame.index, frame.iv, frame.encrypted, session.peerSessionId)
    } catch (err) {
      console.warn('[transfer] buffered chunk replay failed', frame.index, err)
    }
  }
}

export async function receiveChunk(
  transferId: string,
  index: number,
  iv: Uint8Array<ArrayBuffer>,
  encrypted: ArrayBuffer,
  peerSessionId: string,
  callbacks?: ReceiveCallbacks,
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

  // P1-4: duplicate-chunk fast path.
  if (bitmapHas(session.received, index)) return

  // BUG-011: no backend committed yet → buffer, never guess. Writing to
  // IndexedDB "for now" is what produced half-IDB / half-OPFS files.
  if (session.backend === null) {
    if (session.buffered.length < MAX_BUFFERED_PRECOMMIT_FRAMES
      && !session.buffered.some(f => f.index === index)) {
      session.buffered.push({ index, iv, encrypted })
    }
    return
  }

  return persistChunk(session, index, iv, encrypted, peerSessionId, callbacks)
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
): Promise<{ decrypted: ArrayBuffer; storageMode: 'stream' | 'indexeddb'; done: boolean } | undefined> {
  const transferId = session.transferId
  // P0-2: track the WHOLE receive-and-persist operation so cancelReceive
  // can drain in-flight work before deleteChunks.
  let opResolve!: () => void
  const opPromise = new Promise<void>(resolve => { opResolve = resolve })
  session.inflightSaves.add(opPromise)

  try {
    // AES-GCM authenticates the encrypted payload — no separate per-chunk
    // checksum is needed (and the sender no longer ships one).
    const decrypted = await decryptChunk(iv, encrypted, peerSessionId)

    // SECURITY-007: the plaintext length is fully determined by the declared
    // geometry. A chunk that disagrees would make the assembled file longer or
    // shorter than `fileSize` — silent corruption we must refuse.
    const expected = expectedChunkLength(session.fileSize, index)
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
        if (isQuotaExceeded(err)) {
          cancelReceive(transferId).catch(() => {})
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

  // Never finalize a transfer that is not actually complete — that is how a
  // sparse file used to reach the user.
  if (session.receivedCount !== session.totalChunks) {
    throw new TransferIntegrityError(
      `传输不完整：${session.totalChunks - session.receivedCount} 个分片缺失`,
    )
  }
  session.finalized = true

  const backend = session.backend ?? 'idb'
  // Capture the OPFS entry name BEFORE `getOPFSFile` drops the handle. This is
  // the concrete BUG-018 leak: `cleanupOPFS` looked the name up from the
  // handle, which no longer existed by the time it ran, so it returned early
  // and the origin-private copy of every received file survived forever.
  const opfsEntryName = backend === 'opfs' ? getOPFSHandle(transferId)?.fileName : undefined
  let file: File
  try {
    if (backend === 'fsa') {
      file = await finalizeStreamedFile(transferId)
    } else if (backend === 'opfs') {
      file = await getOPFSFile(transferId)
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

  // ── terminal cleanup, in one place ──
  await deleteChunks(transferId).catch(() => {})
  // OPFS File objects are lazy views over the directory entry. Deleting the
  // entry here makes the just-created object URL fail with NotFoundError (and
  // browsers report the download as cancelled). Transfer ownership/session
  // state can retire now, but the entry itself is released by the UI when the
  // download URL is consumed, pruned or the network epoch ends.
  const cleanup = backend === 'opfs' && opfsEntryName
    ? async () => { await removeOPFSEntry(transferId, opfsEntryName).catch(() => {}) }
    : undefined
  await updateTransfer(transferId, { status: 'completed' }).catch(() => {})
  receiveSessions.delete(transferId)
  transferSignals.delete(transferId)
  clearTransferOwner(transferId)
  clearReceiverReady(transferId)
  // Terminal rows have no consumer (QUALITY-001) — prune opportunistically so
  // the policy runs without a separate scheduler.
  void pruneTerminalTransfers().catch(() => {})

  return { file: named, bytes: named.size, backend, cleanup }
}

/** Legacy name kept for callers/tests that only want the assembled File. */
export async function completeReceive(transferId: string): Promise<File> {
  const result = await finalizeReceive(transferId)
  return result.file
}

export function cancelReceive(transferId: string): Promise<void> {
  const session = receiveSessions.get(transferId)
  receiveSessions.delete(transferId)
  // Only a genuine RECEIVE transfer owns the control signal here.
  if (session) transferSignals.delete(transferId)
  clearReceiverReady(transferId)
  // P0-2: drain any in-flight saveChunk promises BEFORE deleteChunks.
  const pending = session?.inflightSaves ? Array.from(session.inflightSaves) : []
  return Promise.allSettled(pending).then(() => {
    return deleteChunks(transferId).catch(() => {})
  }).then(() => {
    return updateTransfer(transferId, { status: 'failed' }).catch(() => {})
  }).then(() => {
    clearTransferOwner(transferId)
  })
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

// ── Flow control ─────────────────────────────────────────────────────

// P2-11: was a 200 ms setTimeout polling loop — woke the event loop
// every 200 ms during long pauses and added up to 200 ms latency to
// resume. Now: pause stores a `notifyResume` resolver on the signal;
// `resumeTransfer` calls it directly. Zero polling, zero latency.
function waitWhilePaused(transferId: string): Promise<void> {
  const s = transferSignals.get(transferId)
  if (!s || !s.paused) return Promise.resolve()
  return new Promise<void>(resolve => {
    // Chain any prior notifier so multiple awaiters all wake up. In
    // practice there's only ever one waiter (the lane prep loop) but
    // we don't bake that assumption into the signal shape.
    const prior = s.notifyResume
    s.notifyResume = () => {
      prior?.()
      resolve()
    }
  })
}

/**
 * Park until the channel's send buffer drains below the low-water mark.
 *
 * BUG-015: this used to install the waiter on `dc.onbufferedamountlow`, a
 * SINGLE-SLOT property. Two concurrent transfers over the same peer (two
 * files, or two lanes of the same file above the high-water mark) both wrote
 * that slot: the second waiter overwrote the first, and the first waiter's
 * `cleanup()` then nulled the second one out. Whichever promise lost the race
 * never resolved, `Promise.allSettled` over the lanes never settled, and the
 * send hung with the UI parked at N%.
 *
 * Now every waiter owns an independent `addEventListener` registration and
 * removes exactly its own handlers, so N concurrent waiters on one channel all
 * wake on the same `bufferedamountlow` event.
 */
export function waitForBuffer(dc: RTCDataChannel): Promise<void> {
  return new Promise(resolve => {
    // If the channel is already closing/closed, or below the watermark, resolve
    // immediately — the caller re-checks readyState right after and re-queues.
    if (dc.readyState !== 'open' || dc.bufferedAmount <= HIGH_WATER_MARK) {
      resolve()
      return
    }
    let settled = false
    // A channel that closes while parked above HIGH_WATER_MARK never fires
    // `bufferedamountlow`, so without also listening for close/error this promise
    // would hang forever and wedge the whole send (Promise.allSettled never
    // resolves). Settle on channel death too; laneLoop's next readyState check
    // then re-queues the chunk and exits the lane.
    const cleanup = () => {
      dc.removeEventListener('bufferedamountlow', onLow)
      dc.removeEventListener('close', onDead)
      dc.removeEventListener('error', onDead)
    }
    const settle = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }
    const onLow = () => settle()
    const onDead = () => settle()
    // Threshold is a channel-wide property, not a per-waiter one — writing the
    // same value from several waiters is idempotent and safe.
    dc.bufferedAmountLowThreshold = LOW_WATER_MARK
    dc.addEventListener('bufferedamountlow', onLow)
    dc.addEventListener('close', onDead)
    dc.addEventListener('error', onDead)
  })
}

// ── Helpers ──────────────────────────────────────────────────────────

// ── Transfer control signals ──────────────────────────────────────────

interface TransferSignal {
  paused: boolean
  cancelled: boolean
  // P2-11: replaces the prior 200 ms polling loop in `waitWhilePaused`.
  // Set when the lane parks itself; cleared+invoked from `resumeTransfer`
  // and `cancelTransfer` to wake the waiter immediately. May be undefined
  // when nobody is waiting.
  notifyResume?: () => void
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
  const s = getSignal(transferId)
  s.paused = false
  // P2-11: wake the pause-waiter immediately rather than waiting up to
  // 200 ms for the next polling tick.
  const notify = s.notifyResume
  s.notifyResume = undefined
  notify?.()
}

export function cancelTransfer(transferId: string) {
  const s = getSignal(transferId)
  s.cancelled = true
  s.paused = false // unblock any waiting
  // P2-11: also fire the wake so any awaiter sees cancelled === true.
  const notify = s.notifyResume
  s.notifyResume = undefined
  notify?.()
  // Do NOT delete the signal here. The send loop only learns of cancellation
  // by reading transferSignals.get(id).cancelled on its NEXT async checkSignals;
  // deleting synchronously (no yield point) meant every subsequent read saw
  // `undefined` → the loop never aborted, transmitted the whole remaining file,
  // and reported a false success. Cleanup happens once the owner observes the
  // cancel: sendFileParallel (send) / cancelReceive+completeReceive (receive).
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

// Thrown by sendFileParallel when the transfer was cancelled mid-flight, so the
// caller can distinguish a user/peer abort from a genuine transmission failure.
export class TransferCancelledError extends Error {
  constructor() {
    super('传输已取消')
    this.name = 'TransferCancelledError'
  }
}

// Drop a transfer's control signal. Called by the owning path once the transfer
// is fully torn down (send completion/abort, receive completion/cancel) so the
// map doesn't leak an entry per transfer.
export function clearTransferSignal(transferId: string) {
  transferSignals.delete(transferId)
}

/**
 * Drop every piece of module state a transfer owns. Called from the store's
 * epoch teardown once per transfer, and by `resetTransferModuleState()` for a
 * whole-epoch wipe. Idempotent.
 */
export function forgetTransfer(transferId: string) {
  transferSignals.delete(transferId)
  transferOwners.delete(transferId)
  receiveSessions.delete(transferId)
  sendTasks.delete(transferId)
  clearReceiverReady(transferId)
  for (const key of [...backendPreparations.keys()]) {
    // preparationKey() joins with a NUL, which cannot occur in a session id.
    if (key.endsWith(`\u0000${transferId}`)) backendPreparations.delete(key)
  }
}

/**
 * Whole-epoch teardown: every transfer belonged to the identity that just went
 * away, so nothing here may survive into the next epoch — including the
 * negotiated protocol versions, which were announced by peers of the old
 * session.
 */
export function resetTransferModuleState() {
  transferSignals.clear()
  transferOwners.clear()
  receiveSessions.clear()
  sendTasks.clear()
  receiverReadyFlags.clear()
  for (const settle of receiverReadyWaiters.values()) settle(false)
  receiverReadyWaiters.clear()
  backendPreparations.clear()
  peerProtocolVersions.clear()
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

// P1-6: detect QuotaExceededError across the three storage paths we
// touch (IDB, OPFS, FSAccess). DOMException name is `QuotaExceededError`
// in all modern browsers; older Safari sometimes uses code 22. Stringy
// fallback covers the rare case where the underlying lib re-wraps with
// `Error` (idb-on-error path, mocked DOMs).
function isQuotaExceeded(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { name?: string; code?: number; message?: string }
  if (e.name === 'QuotaExceededError') return true
  if (e.code === 22) return true
  if (typeof e.message === 'string' && e.message.includes('QuotaExceeded')) return true
  return false
}

// Uniform error class so receivers / UI can pattern-match without
// regexing on message text. We tag the original error on `.cause`
// manually because the 2-arg `Error(msg, { cause })` constructor needs
// ES2022 and the project targets ES2020.
class StorageQuotaExceededError extends Error {
  cause?: unknown
  constructor(cause: unknown) {
    super('STORAGE_QUOTA_EXCEEDED')
    this.name = 'StorageQuotaExceededError'
    this.cause = cause
  }
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
  // P1-7: was `Set<number>` (~50 B per chunk → ~800 MB for a 1 TB
  // transfer). Now a fixed-size bitmap sized at handle creation. We keep
  // the field name `written` to minimise call-site churn; helpers
  // `bitmapSet` / `bitmapHas` handle the bit math.
  written: Uint8Array<ArrayBuffer>
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
  const handle: OPFSReceiveHandle = {
    writable,
    fileHandle,
    written: newBitmap(totalChunks),
    totalChunks,
    fileName,
    queue: new WriteQueue(),
  }
  opfsHandles.set(transferId, handle)
  return handle
}

export function getOPFSHandle(transferId: string): OPFSReceiveHandle | undefined {
  return opfsHandles.get(transferId)
}

/** Popcount over the OPFS handle's `written` bitmap. Use this in place of
 *  `opfsHandle.written.size` after the bitmap migration (P1-7); the field
 *  is now a Uint8Array, not a Set. Returns 0 when the handle isn't known. */
export function opfsWrittenCount(transferId: string): number {
  const handle = opfsHandles.get(transferId)
  if (!handle) return 0
  return bitmapPopcount(handle.written)
}

export async function writeChunkToOPFS(
  transferId: string,
  index: number,
  data: ArrayBuffer,
): Promise<void> {
  const handle = opfsHandles.get(transferId)
  if (!handle) return
  const offset = index * CHUNK_SIZE
  bitmapSet(handle.written, index)
  // P1-6: kick off the write with a quota-normalising wrapper so callers
  // see one error string regardless of which storage backend ran out.
  const writePromise = handle.writable.write({ type: 'write', position: offset, data: new Uint8Array(data) })
  const tagged = writePromise.catch((err: unknown) => {
    if (isQuotaExceeded(err)) throw new StorageQuotaExceededError(err)
    throw err
  })
  const wait = handle.queue.enqueue(tagged, data.byteLength)
  // Always await the tagged write so a synchronous quota error reaches
  // the caller instead of being swallowed by the WriteQueue's logging
  // catch. The backpressure await (`wait`) still applies when set.
  if (wait) await wait
  await tagged
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

/**
 * Delete exactly one OPFS entry by its known name. Split out of `cleanupOPFS`
 * because the terminal completion path (BUG-018) has already released the
 * handle by the time it needs to remove the file, and `cleanupOPFS` could only
 * ever recover the name FROM that handle.
 */
export async function removeOPFSEntry(transferId: string, fileName: string) {
  try {
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle('misaka-transfers', { create: false })
    await dir.removeEntry(`${transferId}-${fileName}`).catch(() => {})
  } catch { /* directory may not exist */ }
}

export async function cleanupOPFS(transferId: string) {
  const handle = opfsHandles.get(transferId)
  const fileName = handle?.fileName
  if (handle) {
    // Drain queued writes BEFORE closing — otherwise pending write promises
    // reject with "stream closed" and the OPFS directory entry can briefly
    // re-appear after `removeEntry` because a late write recreated it.
    await handle.queue.drain().catch(() => {})
    await handle.writable.close().catch(() => {})
    opfsHandles.delete(transferId)
  }
  // P1-8: only remove the EXACT entry this transfer owns. Previously we
  // walked the directory and matched `name.startsWith(transferId)`,
  // which could wipe unrelated files when one transferId was a prefix
  // of another (UUID collisions, or any two IDs that happened to share
  // a prefix). With the in-memory handle we already know the file name;
  // use it directly.
  if (!fileName) return
  try {
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle('misaka-transfers', { create: false })
    await dir.removeEntry(`${transferId}-${fileName}`).catch(() => {})
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
  // P1-6: same quota-normalising pattern as writeChunkToOPFS.
  const writePromise = handle.writable.write({ type: 'write', position: offset, data: new Uint8Array(data) })
  const tagged = writePromise.catch((err: unknown) => {
    if (isQuotaExceeded(err)) throw new StorageQuotaExceededError(err)
    throw err
  })
  const wait = handle.queue.enqueue(tagged, data.byteLength)
  if (wait) await wait
  await tagged
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

// ── Receive storage selection (3-tier fallback) ───────────────────────
// One entry point that picks — and PROVES — the disk-backed write target for
// an incoming transfer. Order:
//
//   1. File System Access (showSaveFilePicker) — Chromium desktop, Edge.
//      Requires a user gesture; the caller is responsible for invoking
//      this from within the click handler that accepts the file. User
//      cancellation (AbortError / NotAllowedError) silently falls through.
//
//   2. OPFS — modern Chrome/Edge/Firefox 111+/Safari 15.2+. Origin-private,
//      no picker. iOS Safari <17 exposes the directory handle but
//      `createWritable()` throws NotAllowedError.
//
//   3. IndexedDB chunk store (`saveChunk`). Always available; whole-file Blob
//      assembly is bounded by `checkBackendOOMGuard` against THIS result.
//
// BUG-012: "supported" is not "writable". Each tier must survive an actual
// `createWritable()` — and for OPFS a real zero-byte `write()` — before it is
// allowed to be the committed backend. Anything less and a Chromium tab
// without user activation, or iOS Safari <17, silently degraded to the IDB
// path with the size cap already waved through.
export interface PrepareReceiveStorageResult {
  mode: 'fsa' | 'opfs' | 'idb'
}

async function selectWritableBackend(meta: {
  transferId: string
  fileName: string
  totalChunks: number
  size: number
}): Promise<'fsa' | 'opfs' | 'idb'> {
  // Tier 1: File System Access. `requestWriteHandle` only resolves after
  // `createWritable()` succeeded, so a resolved promise IS the proof.
  if (supportsFileSystemAccess()) {
    try {
      await requestWriteHandle(meta.transferId, meta.fileName, meta.totalChunks)
      return 'fsa'
    } catch (err) {
      // AbortError = user cancelled; NotAllowedError = no gesture / blocked.
      // Either way fall through to the next tier rather than failing the
      // entire transfer.
      const name = (err as { name?: string })?.name
      if (name && name !== 'AbortError' && name !== 'NotAllowedError') {
        console.warn('[transfer] FSA save picker failed', err)
      }
    }
  }

  // Tier 2: OPFS.
  if (supportsOPFS()) {
    let writable: FileSystemWritableFileStream | null = null
    try {
      const root = await navigator.storage.getDirectory()
      const dir = await root.getDirectoryHandle('misaka-transfers', { create: true })
      const probeName = `${meta.transferId}-${meta.fileName}`
      const fileHandle = await dir.getFileHandle(probeName, { create: true })
      // Proof #1: the stream can be opened at all.
      writable = await fileHandle.createWritable({ keepExistingData: true })
      // Proof #2: a real (zero-length, position-0) write is accepted. Some
      // restricted environments hand back a writable whose first `write()`
      // rejects — discovering that at chunk 0 instead of here is what made
      // the OOM guard moot.
      await writable.write({ type: 'write', position: 0, data: new Uint8Array(0) })
      // Reuse the same handle for the real receive path so we don't pay
      // a second `createWritable` (some browsers serialize all writes to
      // a single open writable per file).
      const handle: OPFSReceiveHandle = {
        writable,
        fileHandle,
        written: newBitmap(meta.totalChunks),
        totalChunks: meta.totalChunks,
        fileName: meta.fileName,
        queue: new WriteQueue(),
      }
      opfsHandles.set(meta.transferId, handle)
      return 'opfs'
    } catch (err) {
      // Clean up any partial OPFS state (the probe file may have been
      // created even though createWritable/write failed).
      if (writable) { try { await writable.close() } catch { /* ignored */ } }
      opfsHandles.delete(meta.transferId)
      try {
        const root = await navigator.storage.getDirectory()
        const dir = await root.getDirectoryHandle('misaka-transfers', { create: false })
        await dir.removeEntry(`${meta.transferId}-${meta.fileName}`).catch(() => {})
      } catch { /* ignored */ }
      const name = (err as { name?: string })?.name
      if (name !== 'NotAllowedError') {
        console.warn('[transfer] OPFS probe failed, falling back to IDB', err)
      }
    }
  }

  // Tier 3: IndexedDB.
  return 'idb'
}

/**
 * Legacy entry point: selects and commits a backend without applying the
 * committed-backend size cap. Prefer `prepareReceiveBackend`, which
 * deduplicates concurrent lane metas and enforces BUG-012's cap.
 */
export async function prepareReceiveStorage(meta: {
  transferId: string
  fileName: string
  totalChunks: number
  size: number
}): Promise<PrepareReceiveStorageResult> {
  return { mode: await selectWritableBackend(meta) }
}
