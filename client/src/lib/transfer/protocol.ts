/**
 * transfer/protocol.ts — version, message types, meta/control validation, frame codec.
 * Cleanup owner: peerProtocolVersions → clearPeerProtocolVersion / resetTransferModuleState (registry).
 * The tag and layout do NOT change: CHUNK_FRAME_TAG = 0x01,
 * [tag:1][shortId:4][index:4][iv:12][ciphertext].
 */
import * as constants from '@/constants'
const { CHUNK_SIZE } = constants
// P1-5: sender-side upper bound. Fall back to 16 GB until constants publishes MAX_FILE_SIZE.
export const MAX_FILE_SIZE: number =
  (constants as { MAX_FILE_SIZE?: number }).MAX_FILE_SIZE ?? (16 * 1024 * 1024 * 1024)

export { CHUNK_SIZE }
export { validateAndNormalizeRanges } from '../chunk-bitmap'

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
// The BINARY CHUNK FRAME IS UNCHANGED across v1/v2/v3 — tag 0x01 and the
// [tag:1][shortId:4][index:4][iv:12][ciphertext] layout are stable, and so is
// the `makeChunkIv` 8-byte-prefix + 4-byte-BE-index construction.
//
// v3 adds AES-GCM AAD binding (transferId, shortId, index, plaintextLength)
// so a frame cannot be re-routed across indexes/transfers without the tag
// failing. Negotiated via min(mine, theirs); v1/v2 peers keep empty-AAD.
export const PROTOCOL_VERSION = 3
export const LEGACY_PROTOCOL_VERSION = 1
/** Protocol version at which AES-GCM AAD is required on every chunk. */
export const AAD_PROTOCOL_VERSION = 3

// Cleanup owner: clearPeerProtocolVersion / registry.resetTransferModuleState
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
export const CHUNK_FRAME_HEADER_BYTES = 21
export const CHUNK_FRAME_IV_OFFSET = 9
export const CHUNK_FRAME_IV_LENGTH = 12
export const CHUNK_FRAME_CIPHER_OFFSET = 21

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
  /** View over the IV region. May alias the source buffer — do not mutate. */
  iv: Uint8Array<ArrayBuffer>
  /**
   * Ciphertext region. Prefer `rawFrame` + offsets for worker hand-off so the
   * main thread never copies ~252 KB per message. When only this field is
   * used, it is a slice (copy) for backwards-compatible callers.
   */
  ciphertext: ArrayBuffer
  /** Original frame buffer for zero-copy worker decrypt. */
  rawFrame: ArrayBuffer
  ivOffset: number
  cipherOffset: number
  cipherLength: number
}

export function decodeChunkFrame(buf: ArrayBuffer): DecodedChunkFrame | null {
  if (buf.byteLength < CHUNK_FRAME_HEADER_BYTES) return null
  const view = new DataView(buf)
  if (view.getUint8(0) !== CHUNK_FRAME_TAG) return null
  const shortId = view.getUint32(1, false)
  const index = view.getUint32(5, false)
  // Views over the original buffer — no ciphertext copy on the hot path.
  // Production receive uses rawFrame + offsets with decryptFrameInWorker.
  // `.ciphertext` is a lazy getter for legacy unit tests only.
  const iv = new Uint8Array(buf, CHUNK_FRAME_IV_OFFSET, CHUNK_FRAME_IV_LENGTH) as Uint8Array<ArrayBuffer>
  const cipherOffset = CHUNK_FRAME_CIPHER_OFFSET
  const cipherLength = buf.byteLength - cipherOffset
  const frame: DecodedChunkFrame = {
    shortId,
    index,
    iv,
    get ciphertext() {
      return buf.slice(cipherOffset)
    },
    rawFrame: buf,
    ivOffset: CHUNK_FRAME_IV_OFFSET,
    cipherOffset,
    cipherLength,
  }
  return frame
}

// Cleanup owner: process lifetime (monotonic counter; never cleared).
let shortIdCounter = (Math.random() * 0xffffffff) >>> 0
export function nextShortId(): number {
  shortIdCounter = (shortIdCounter + 1) >>> 0
  if (shortIdCounter === 0) shortIdCounter = 1
  return shortIdCounter
}
