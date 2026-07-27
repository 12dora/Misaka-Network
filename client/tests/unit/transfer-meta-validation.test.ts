// SECURITY-007: inbound transfer metadata and chunk indexes had NO runtime
// validation. Everything below the DataChannel is attacker-controlled — a
// connected peer in the same identity cluster can put any JSON on the wire —
// and the receiver used the values directly to size a bitmap, to compute an
// `index * CHUNK_SIZE` file offset and to name an OPFS entry.
//
// The concrete attacks, each with a case below:
//   * tiny fileSize + huge totalChunks → hundreds of MB of bitmap allocation;
//   * non-integer / out-of-range chunk index → sparse write far past EOF;
//   * path-bearing or control-char file names → OPFS entry confusion;
//   * a plaintext whose length disagrees with the declared geometry → a file
//     that is silently longer or shorter than `fileSize`.
//
// SECURITY-015: ownership is `(peerSessionId, epoch)`, never `peerNodeId` —
// every device of one identity shares the nodeId, so a third device in the
// cluster could otherwise adopt or control another pair's transfer.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/lib/db', () => ({
  saveTransfer: vi.fn(async () => {}),
  updateTransfer: vi.fn(async () => {}),
  getTransfer: vi.fn(async () => null),
  getActiveTransfers: vi.fn(async () => []),
  saveChunk: vi.fn(async () => {}),
  getChunk: vi.fn(async () => null),
  deleteChunks: vi.fn(async () => {}),
  getSavedChunkIndexes: vi.fn(async () => []),
  pruneTerminalTransfers: vi.fn(async () => 0),
}))

vi.mock('../../src/lib/crypto', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/crypto')>('../../src/lib/crypto')
  return {
    ...actual,
    decryptChunk: vi.fn(async (_iv: Uint8Array, encrypted: ArrayBuffer) => encrypted),
  }
})

import {
  validateMetaMessage,
  isValidChunkIndex,
  expectedChunkCount,
  sanitizeFileName,
  handleMetaMessage,
  receiveChunk,
  prepareReceiveBackend,
  getReceiveSession,
  TransferOwnershipError,
  MAX_FILE_NAME_LENGTH,
  CHUNK_SIZE,
} from '../../src/lib/transfer'
import * as db from '../../src/lib/db'
import { makeMeta, makeChunk } from './_transfer-fixtures'

const OWNER_A = { peerSessionId: 'session-A', epoch: 1 }
const OWNER_B = { peerSessionId: 'session-B', epoch: 1 }

beforeEach(() => { vi.clearAllMocks() })

describe('SECURITY-007: meta validation', () => {
  it('accepts a self-consistent meta and normalises it', () => {
    const result = validateMetaMessage({
      ...makeMeta({ transferId: 'ok-1', totalChunks: 2, tailBytes: 10 }),
      v: 2,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.meta.totalChunks).toBe(2)
    expect(result.meta.v).toBe(2)
    expect(result.meta.mime).toBe('application/octet-stream')
  })

  it('REJECTS a small file that claims a huge chunk count (bitmap bomb)', () => {
    // 1 KB file, 400 million chunks: the old code allocated ceil(4e8/8) = 50 MB
    // of bitmap per such message, plus the same again for the persisted copy.
    const result = validateMetaMessage({
      type: 'meta', transferId: 'bomb', shortId: 1, fileName: 'a.bin',
      fileSize: 1024, fileHash: '', totalChunks: 400_000_000,
      mime: 'application/octet-stream',
    })
    expect(result).toMatchObject({ ok: false, code: 'bad-chunk-count' })
  })

  it('REJECTS non-safe-integer / negative sizes and counts', () => {
    const base = makeMeta({ transferId: 'x', totalChunks: 1 })
    expect(validateMetaMessage({ ...base, fileSize: Number.MAX_SAFE_INTEGER + 2 }))
      .toMatchObject({ ok: false, code: 'bad-file-size' })
    expect(validateMetaMessage({ ...base, fileSize: -1 }))
      .toMatchObject({ ok: false, code: 'bad-file-size' })
    expect(validateMetaMessage({ ...base, fileSize: 1.5 }))
      .toMatchObject({ ok: false, code: 'bad-file-size' })
    expect(validateMetaMessage({ ...base, totalChunks: -3 }))
      .toMatchObject({ ok: false, code: 'bad-chunk-count' })
    expect(validateMetaMessage({ ...base, totalChunks: 2.5 }))
      .toMatchObject({ ok: false, code: 'bad-chunk-count' })
  })

  it('REJECTS an oversized file up-front', () => {
    const huge = 17 * 1024 * 1024 * 1024
    expect(validateMetaMessage({
      type: 'meta', transferId: 'huge', shortId: 1, fileName: 'h.bin',
      fileSize: huge, fileHash: '', totalChunks: expectedChunkCount(huge),
      mime: 'application/octet-stream',
    })).toMatchObject({ ok: false, code: 'bad-file-size' })
  })

  it('REJECTS malformed ids and short ids', () => {
    const base = makeMeta({ transferId: 'x', totalChunks: 1 })
    expect(validateMetaMessage({ ...base, transferId: '../../etc/passwd' }))
      .toMatchObject({ ok: false, code: 'bad-transfer-id' })
    expect(validateMetaMessage({ ...base, transferId: 'a'.repeat(200) }))
      .toMatchObject({ ok: false, code: 'bad-transfer-id' })
    expect(validateMetaMessage({ ...base, transferId: 42 }))
      .toMatchObject({ ok: false, code: 'bad-transfer-id' })
    expect(validateMetaMessage({ ...base, shortId: -1 }))
      .toMatchObject({ ok: false, code: 'bad-short-id' })
    expect(validateMetaMessage({ ...base, shortId: 2 ** 33 }))
      .toMatchObject({ ok: false, code: 'bad-short-id' })
  })

  it('sanitises file names and refuses ones that sanitise to nothing', () => {
    expect(sanitizeFileName('a/b\\c.bin')).toBe('a_b_c.bin')
    expect(sanitizeFileName('../../secret')).toBe('.._.._secret'.replace(/^\.+/, ''))
    expect(sanitizeFileName('...')).toBe('')

    const base = makeMeta({ transferId: 'nm', totalChunks: 1 })
    expect(validateMetaMessage({ ...base, fileName: '' }))
      .toMatchObject({ ok: false, code: 'bad-file-name' })
    expect(validateMetaMessage({ ...base, fileName: '...' }))
      .toMatchObject({ ok: false, code: 'bad-file-name' })

    const long = validateMetaMessage({ ...base, fileName: 'n'.repeat(400) })
    expect(long.ok).toBe(true)
    if (long.ok) expect(long.meta.fileName.length).toBeLessThanOrEqual(MAX_FILE_NAME_LENGTH)
  })

  it('clamps an absurd MIME instead of trusting it', () => {
    const base = makeMeta({ transferId: 'mime', totalChunks: 1 })
    const r = validateMetaMessage({ ...base, mime: 'x'.repeat(5000) })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.meta.mime.length).toBeLessThanOrEqual(128)
  })

  it('bounds chunk indexes against the declared geometry', () => {
    expect(isValidChunkIndex(0, 4)).toBe(true)
    expect(isValidChunkIndex(3, 4)).toBe(true)
    expect(isValidChunkIndex(4, 4)).toBe(false)
    expect(isValidChunkIndex(-1, 4)).toBe(false)
    expect(isValidChunkIndex(1.5, 4)).toBe(false)
    expect(isValidChunkIndex(2 ** 40, 4)).toBe(false)
  })
})

describe('SECURITY-007: chunk-level validation at the receive path', () => {
  async function openSession(id: string, totalChunks = 3, owner = OWNER_A) {
    const meta = makeMeta({ transferId: id, totalChunks })
    await handleMetaMessage(meta, 1, owner)
    await prepareReceiveBackend(
      { transferId: id, fileName: meta.fileName, totalChunks, size: meta.fileSize },
      owner,
    )
    return meta
  }

  it('drops an out-of-range index without touching storage', async () => {
    const meta = await openSession('idx-range')
    const c = makeChunk(meta, 0)
    // index 99 for a 3-chunk transfer: the old code would have computed a
    // 99 * 252 KB offset and produced a ~25 MB sparse file.
    const result = await receiveChunk('idx-range', 99, c.iv, c.encrypted, OWNER_A.peerSessionId)
    expect(result).toBeUndefined()
    expect(db.saveChunk).not.toHaveBeenCalled()
    expect(getReceiveSession('idx-range')?.receivedCount).toBe(0)
  })

  it('rejects a chunk whose plaintext length disagrees with the geometry', async () => {
    const meta = await openSession('len-bad')
    const iv = new Uint8Array(12) as Uint8Array<ArrayBuffer>
    const short = new Uint8Array(CHUNK_SIZE - 1).buffer   // one byte short
    await expect(
      receiveChunk('len-bad', 0, iv, short, OWNER_A.peerSessionId),
    ).rejects.toThrow(/长度非法/)
    expect(getReceiveSession('len-bad')?.receivedCount).toBe(0)
    void meta
  })

  it('accepts the correctly-sized short tail chunk', async () => {
    const id = 'len-tail'
    const meta = makeMeta({ transferId: id, totalChunks: 2, tailBytes: 7 })
    await handleMetaMessage(meta, 1, OWNER_A)
    await prepareReceiveBackend(
      { transferId: id, fileName: meta.fileName, totalChunks: 2, size: meta.fileSize },
      OWNER_A,
    )
    const tail = makeChunk(meta, 1)
    expect(tail.encrypted.byteLength).toBe(7)
    await receiveChunk(id, 1, tail.iv, tail.encrypted, OWNER_A.peerSessionId)
    expect(getReceiveSession(id)?.receivedCount).toBe(1)
  })
})

describe('SECURITY-015: ownership is (peerSessionId, epoch), never nodeId', () => {
  it('refuses a second meta for the same id from a different session', async () => {
    const meta = makeMeta({ transferId: 'own-1', totalChunks: 2 })
    await handleMetaMessage(meta, 7, OWNER_A)
    // Same nodeId (7) — a sibling device of the SAME identity. Under the old
    // code this simply returned the existing session and let the third device
    // observe and drive the transfer.
    await expect(handleMetaMessage(meta, 7, OWNER_B))
      .rejects.toBeInstanceOf(TransferOwnershipError)
  })

  it('refuses a re-meta that mutates immutable geometry', async () => {
    const meta = makeMeta({ transferId: 'own-2', totalChunks: 2 })
    await handleMetaMessage(meta, 7, OWNER_A)
    const tampered = { ...meta, fileSize: meta.fileSize + 1, totalChunks: 3 }
    await expect(handleMetaMessage(tampered, 7, OWNER_A))
      .rejects.toBeInstanceOf(TransferOwnershipError)
  })

  it('is idempotent for the true owner (resume re-sends meta)', async () => {
    const meta = makeMeta({ transferId: 'own-3', totalChunks: 2 })
    const first = await handleMetaMessage(meta, 7, OWNER_A)
    const again = await handleMetaMessage(meta, 7, OWNER_A)
    expect(again).toBe(first)
  })

  it('ignores chunks pushed by a peer session that does not own the transfer', async () => {
    const id = 'own-4'
    const meta = makeMeta({ transferId: id, totalChunks: 2 })
    await handleMetaMessage(meta, 7, OWNER_A)
    await prepareReceiveBackend(
      { transferId: id, fileName: meta.fileName, totalChunks: 2, size: meta.fileSize },
      OWNER_A,
    )
    const c = makeChunk(meta, 0)
    const result = await receiveChunk(id, 0, c.iv, c.encrypted, OWNER_B.peerSessionId)
    expect(result).toBeUndefined()
    expect(getReceiveSession(id)?.receivedCount).toBe(0)
  })
})
