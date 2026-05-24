// P1-4: duplicate chunk arriving for an index already in the bitmap
// should short-circuit: no decrypt, no saveChunk, no progress double-
// count. Before the fix, receiveChunk decrypted every duplicate and
// (in IDB mode) re-saved the chunk — for a resume that re-ships
// thousands of already-stored chunks, this is wasted CPU + write
// amplification that can stall an entire transfer behind the redundant
// writes.

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
}))

// vi.mock() factories are hoisted above ALL top-level statements; we
// can't close over an outer `decryptSpy` const. Stub inside the factory
// and read the spy back via the mocked module afterwards.
vi.mock('../../src/lib/crypto', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/crypto')>('../../src/lib/crypto')
  return {
    ...actual,
    decryptChunk: vi.fn(async (_iv: Uint8Array, encrypted: ArrayBuffer) => encrypted),
  }
})

import {
  handleMetaMessage,
  receiveChunk,
  type MetaMessage,
} from '../../src/lib/transfer'
import * as db from '../../src/lib/db'
import * as crypto from '../../src/lib/crypto'
const decryptSpy = vi.mocked(crypto.decryptChunk)

const META: MetaMessage = {
  type: 'meta',
  transferId: 'dup',
  shortId: 1,
  fileName: 'dup.bin',
  fileSize: 4 * 64,
  fileHash: '',
  totalChunks: 4,
  mime: 'application/octet-stream',
}

beforeEach(() => {
  vi.clearAllMocks()
})

// `receiveSessions` is module-scoped in transfer.ts so each test needs a
// unique transferId to avoid bleeding session state across cases.
function metaFor(id: string): MetaMessage {
  return { ...META, transferId: id }
}

describe('duplicate chunk arrives → bitmap already set → no resave', () => {
  it('saveChunk fires only once per index even after a duplicate', async () => {
    const id = 'dup-save'
    await handleMetaMessage(metaFor(id), 1)
    const iv = new Uint8Array(12) as Uint8Array<ArrayBuffer>
    const buf = new Uint8Array(64).buffer

    await receiveChunk(id, 0, iv, buf, 'peer-A')
    expect(db.saveChunk).toHaveBeenCalledTimes(1)

    // Duplicate of index 0.
    await receiveChunk(id, 0, iv, buf, 'peer-A')
    expect(db.saveChunk).toHaveBeenCalledTimes(1) // still 1, not 2
  })

  it('duplicate skips the decrypt step too (CPU saving)', async () => {
    const id = 'dup-decrypt'
    await handleMetaMessage(metaFor(id), 1)
    const iv = new Uint8Array(12) as Uint8Array<ArrayBuffer>
    const buf = new Uint8Array(64).buffer

    await receiveChunk(id, 1, iv, buf, 'peer-A')
    expect(decryptSpy).toHaveBeenCalledTimes(1)

    await receiveChunk(id, 1, iv, buf, 'peer-A')
    // Duplicate must NOT pay the AES-GCM decrypt cost. This is the whole
    // point of moving the bitmap check to the top of the function.
    expect(decryptSpy).toHaveBeenCalledTimes(1)
  })

  it('receivedCount does not double-count on duplicates', async () => {
    const id = 'dup-count'
    const session = await handleMetaMessage(metaFor(id), 1)
    const iv = new Uint8Array(12) as Uint8Array<ArrayBuffer>
    const buf = new Uint8Array(64).buffer

    await receiveChunk(id, 2, iv, buf, 'peer-A')
    await receiveChunk(id, 2, iv, buf, 'peer-A')
    await receiveChunk(id, 2, iv, buf, 'peer-A')

    expect(session.receivedCount).toBe(1)
  })
})
