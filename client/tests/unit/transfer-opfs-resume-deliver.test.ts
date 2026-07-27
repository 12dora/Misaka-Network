// Regression [P1]: OPFS resume delivered as FAILED. The delivery gate keyed on
// `opfsWrittenCount(id) === totalChunks`, a popcount of the handle's `written`
// bitmap — which is only set for chunks written IN THE CURRENT session. After a
// mid-transfer reload the sender resume-skips the already-persisted chunks, so
// their `written` bits are never set again: the receive bitmap hit totalChunks
// while `opfsWrittenCount` stayed below it, the gate was false, delivery fell
// through to the IDB-assemble branch and threw "Missing chunk 0" even though
// every byte was on disk.
//
// TEST-006 note: the end-to-end proof that a resumed transfer is delivered FROM
// OPFS now lives in `transfer-deliver-after-write.test.ts`, which drives the
// real store handler. This file keeps the tight engine-level invariant that the
// gate must key on: `session.receivedCount`, never the session-local write
// bitmap. It drives the production `receiveChunk` (which, since BUG-017, owns
// the durable write itself) rather than re-implementing the write order.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const TOTAL = 4
const RESUME_ID = 'opfs-resume-deliver'

vi.mock('../../src/lib/db', () => ({
  saveTransfer: vi.fn(async () => {}),
  updateTransfer: vi.fn(async () => {}),
  getTransfer: vi.fn(async (id: string) =>
    id === RESUME_ID
      ? {
          transferId: RESUME_ID, direction: 'recv', peerSessionId: 'peer-A', epoch: 0,
          fileSize: TOTAL * 252 * 1024, totalChunks: TOTAL, receivedChunks: [0, 1],
        }
      : null),
  getActiveTransfers: vi.fn(async () => []),
  saveChunk: vi.fn(async () => {}),
  getChunk: vi.fn(async () => null),
  deleteChunks: vi.fn(async () => {}),
  // OPFS-mode chunks are NEVER written to IDB, so getSavedChunkIndexes returns
  // [] for a resumed OPFS transfer — the sender skips them via the restored
  // receive bitmap, not via this list.
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
  handleMetaMessage,
  receiveChunk,
  prepareReceiveBackend,
  opfsWrittenCount,
  getReceiveSession,
  cleanupOPFS,
  type MetaMessage,
} from '../../src/lib/transfer'
import { makeMeta, makeChunk } from './_transfer-fixtures'

let origStorage: unknown
const OWNER = { peerSessionId: 'peer-A', epoch: 0 }

beforeEach(() => {
  origStorage = (navigator as any).storage
  const writable = {
    write: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    seek: async () => {},
    truncate: async () => {},
  }
  const fileHandle = {
    kind: 'file',
    name: 'opfs.bin',
    createWritable: vi.fn(async () => writable),
    getFile: vi.fn(async () => new File([], 'opfs.bin')),
  }
  const dir = {
    getDirectoryHandle: vi.fn(async () => dir),
    getFileHandle: vi.fn(async () => fileHandle),
    removeEntry: vi.fn(async () => {}),
    [Symbol.asyncIterator]: async function* () { /* empty */ },
  }
  ;(navigator as any).storage = { getDirectory: vi.fn(async () => dir) }
})

afterEach(async () => {
  await cleanupOPFS(RESUME_ID).catch(() => {})
  if (origStorage === undefined) delete (navigator as any).storage
  else (navigator as any).storage = origStorage
})

const META: MetaMessage = makeMeta({
  transferId: RESUME_ID, totalChunks: TOTAL, fileName: 'opfs.bin',
})

describe('OPFS resume: deliver must key on receivedCount, not the session-local write bitmap', () => {
  it('receivedCount reaches totalChunks while opfsWrittenCount stays below it', async () => {
    // handleMetaMessage restores the receive bitmap from the prior record
    // (chunks 0,1) → receivedCount starts at 2 without any this-session write.
    await handleMetaMessage(META, 1, OWNER)
    // Real backend selection commits a FRESH OPFS handle (empty `written`
    // bitmap), exactly as it does on resume with keepExistingData:true.
    const prepared = await prepareReceiveBackend({
      transferId: RESUME_ID, fileName: META.fileName,
      totalChunks: TOTAL, size: META.fileSize,
    }, OWNER)
    expect(prepared).toMatchObject({ ok: true, mode: 'opfs' })

    const session0 = getReceiveSession(RESUME_ID)
    expect(session0?.receivedCount).toBe(2)
    expect(opfsWrittenCount(RESUME_ID)).toBe(0) // nothing written THIS session yet

    // Only the remaining chunks 2,3 are re-shipped by the sender. `receiveChunk`
    // performs the OPFS write itself (BUG-017), so nothing here re-implements
    // the ordering.
    for (const i of [2, 3]) {
      const c = makeChunk(META, i)
      await receiveChunk(RESUME_ID, i, c.iv, c.encrypted, 'peer-A')
    }

    const session = getReceiveSession(RESUME_ID)
    // Authoritative completion signal — every chunk accounted for.
    expect(session?.receivedCount).toBe(TOTAL)
    // The session-local write bitmap only saw 2,3 — it is SHORT of totalChunks.
    expect(opfsWrittenCount(RESUME_ID)).toBe(2)
    expect(opfsWrittenCount(RESUME_ID)).not.toBe(TOTAL)
  })
})
