// Shared fixtures for the transfer-engine unit tests.
//
// SECURITY-007 made inbound `meta` strictly self-consistent: `totalChunks`
// must be exactly `ceil(fileSize / CHUNK_SIZE)` and every chunk's plaintext
// must be exactly the length that geometry implies. Hand-rolled "3 chunks of
// 64 bytes" fixtures are now (correctly) rejected, so every test builds its
// metadata and payloads through these helpers instead.

import { CHUNK_SIZE, type MetaMessage } from '../../src/lib/transfer'

export { CHUNK_SIZE }

export interface MetaOptions {
  transferId: string
  totalChunks: number
  /** Bytes in the LAST chunk. Defaults to a full chunk. */
  tailBytes?: number
  shortId?: number
  fileName?: string
  mime?: string
  /** Protocol version to advertise. Omit for a legacy (v1) sender. */
  v?: number
}

/** Build a `meta` whose declared geometry is internally consistent. */
export function makeMeta(opts: MetaOptions): MetaMessage {
  const { transferId, totalChunks } = opts
  const tail = opts.tailBytes ?? CHUNK_SIZE
  const fileSize = totalChunks === 0 ? 0 : (totalChunks - 1) * CHUNK_SIZE + tail
  const meta: MetaMessage = {
    type: 'meta',
    transferId,
    shortId: opts.shortId ?? 1,
    fileName: opts.fileName ?? 'fixture.bin',
    fileSize,
    fileHash: '',
    totalChunks,
    mime: opts.mime ?? 'application/octet-stream',
  }
  if (opts.v !== undefined) meta.v = opts.v
  return meta
}

/** Plaintext length chunk `index` must have for this meta. */
export function chunkLength(meta: MetaMessage, index: number): number {
  return Math.max(0, Math.min(CHUNK_SIZE, meta.fileSize - index * CHUNK_SIZE))
}

/**
 * A correctly-sized chunk payload. The tests mock `decryptChunk` as a
 * pass-through, so the "ciphertext" and the plaintext are the same bytes and
 * the length check in `persistChunk` sees exactly this buffer.
 */
export function makeChunk(meta: MetaMessage, index: number, fill = index & 0xff): {
  iv: Uint8Array<ArrayBuffer>
  encrypted: ArrayBuffer
} {
  const iv = new Uint8Array(12) as Uint8Array<ArrayBuffer>
  const buf = new Uint8Array(chunkLength(meta, index))
  buf.fill(fill)
  return { iv, encrypted: buf.buffer }
}

/** Deterministic byte pattern so a reassembled file can be compared exactly. */
export function patternedChunk(meta: MetaMessage, index: number): {
  iv: Uint8Array<ArrayBuffer>
  encrypted: ArrayBuffer
  bytes: Uint8Array
} {
  const iv = new Uint8Array(12) as Uint8Array<ArrayBuffer>
  const len = chunkLength(meta, index)
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) bytes[i] = (index * 31 + i * 7) & 0xff
  return { iv, encrypted: bytes.buffer.slice(0), bytes }
}
