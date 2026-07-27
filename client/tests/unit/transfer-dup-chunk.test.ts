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
  prepareReceiveBackend,
  type MetaMessage,
} from '../../src/lib/transfer'
import { makeMeta, makeChunk } from './_transfer-fixtures'
import * as db from '../../src/lib/db'
import * as crypto from '../../src/lib/crypto'
const decryptSpy = vi.mocked(crypto.decryptChunk)

const OWNER = { peerSessionId: 'peer-A', epoch: 0 }

beforeEach(() => {
  vi.clearAllMocks()
})

// `receiveSessions` is module-scoped in transfer.ts so each test needs a
// unique transferId to avoid bleeding session state across cases.
function metaFor(id: string): MetaMessage {
  return makeMeta({ transferId: id, totalChunks: 4, fileName: 'dup.bin' })
}

// BUG-011: no byte may be written before a backend has been COMMITTED, so
// every receive fixture now drives the real preparation step (which resolves
// to `idb` under jsdom) instead of letting receiveChunk guess.
async function openSession(id: string): Promise<{ meta: MetaMessage }> {
  const meta = metaFor(id)
  await handleMetaMessage(meta, 1, OWNER)
  await prepareReceiveBackend(
    { transferId: id, fileName: meta.fileName, totalChunks: meta.totalChunks, size: meta.fileSize },
    OWNER,
  )
  return { meta }
}

describe('duplicate chunk arrives → bitmap already set → no resave', () => {
  it('saveChunk fires only once per index even after a duplicate', async () => {
    const id = 'dup-save'
    const { meta } = await openSession(id)
    const { iv, encrypted: buf } = makeChunk(meta, 0)

    await receiveChunk(id, 0, iv, buf, 'peer-A')
    expect(db.saveChunk).toHaveBeenCalledTimes(1)

    // Duplicate of index 0.
    await receiveChunk(id, 0, iv, buf, 'peer-A')
    expect(db.saveChunk).toHaveBeenCalledTimes(1) // still 1, not 2
  })

  it('duplicate skips the decrypt step too (CPU saving)', async () => {
    const id = 'dup-decrypt'
    const { meta } = await openSession(id)
    const { iv, encrypted: buf } = makeChunk(meta, 1)

    await receiveChunk(id, 1, iv, buf, 'peer-A')
    expect(decryptSpy).toHaveBeenCalledTimes(1)

    await receiveChunk(id, 1, iv, buf, 'peer-A')
    // Duplicate must NOT pay the AES-GCM decrypt cost. This is the whole
    // point of moving the bitmap check to the top of the function.
    expect(decryptSpy).toHaveBeenCalledTimes(1)
  })

  it('receivedCount does not double-count on duplicates', async () => {
    const id = 'dup-count'
    const meta = metaFor(id)
    const session = await handleMetaMessage(meta, 1, OWNER)
    await prepareReceiveBackend(
      { transferId: id, fileName: meta.fileName, totalChunks: meta.totalChunks, size: meta.fileSize },
      OWNER,
    )
    const { iv, encrypted: buf } = makeChunk(meta, 2)

    await receiveChunk(id, 2, iv, buf, 'peer-A')
    await receiveChunk(id, 2, iv, buf, 'peer-A')
    await receiveChunk(id, 2, iv, buf, 'peer-A')

    expect(session.receivedCount).toBe(1)
  })
})
