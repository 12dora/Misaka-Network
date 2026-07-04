// Regression [P1]: OPFS resume delivered as FAILED. deliverCompletedFile gated
// the OPFS branch on `opfsWrittenCount(id) === totalChunks`, a popcount of the
// handle's `written` bitmap — which is only set for chunks written IN THE
// CURRENT session. After a mid-transfer reload, the sender resume-skips the
// already-persisted chunks (they are never re-shipped), so their `written` bits
// are never set this session. When the last missing chunk lands, the receive
// bitmap hits totalChunks but opfsWrittenCount stays < totalChunks — the gate
// was false, delivery fell through to the IDB-assemble branch, and it threw
// "Missing chunk 0" even though every byte was on disk.
//
// This test reproduces the exact resume state and asserts the invariant the
// FIXED gate keys on: the receive session's receivedCount (authoritative) reaches
// totalChunks while opfsWrittenCount does NOT. If someone reverts the network.ts
// gate to opfsWrittenCount, the delivered file would be wrongly rejected.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const TOTAL = 4
const RESUME_ID = 'opfs-resume-deliver'

// A prior record: chunks 0 and 1 were already received and written to OPFS in
// the previous (pre-reload) session.
vi.mock('../../src/lib/db', () => ({
  saveTransfer: vi.fn(async () => {}),
  updateTransfer: vi.fn(async () => {}),
  getTransfer: vi.fn(async (id: string) =>
    id === RESUME_ID
      ? { transferId: RESUME_ID, direction: 'recv', totalChunks: TOTAL, receivedChunks: [0, 1] }
      : null),
  getActiveTransfers: vi.fn(async () => []),
  saveChunk: vi.fn(async () => {}),
  getChunk: vi.fn(async () => null),
  deleteChunks: vi.fn(async () => {}),
  // OPFS-mode chunks are NEVER written to IDB, so getSavedChunkIndexes returns
  // [] for a resumed OPFS transfer — the sender skips them via the restored
  // receive bitmap, not via this list.
  getSavedChunkIndexes: vi.fn(async () => []),
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
  createOPFSReceiveFile,
  writeChunkToOPFS,
  opfsWrittenCount,
  getReceiveSession,
  cleanupOPFS,
  type MetaMessage,
} from '../../src/lib/transfer'

let origStorage: unknown

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

const META: MetaMessage = {
  type: 'meta',
  transferId: RESUME_ID,
  shortId: 1,
  fileName: 'opfs.bin',
  fileSize: TOTAL * 64,
  fileHash: '',
  totalChunks: TOTAL,
  mime: 'application/octet-stream',
}

describe('OPFS resume: deliver must key on receivedCount, not the session-local write bitmap', () => {
  it('receivedCount reaches totalChunks while opfsWrittenCount stays below it', async () => {
    // Fresh OPFS handle (empty `written` bitmap) — as prepareReceiveStorage
    // creates it on resume with keepExistingData:true.
    await createOPFSReceiveFile(RESUME_ID, META.fileName, TOTAL)
    // handleMetaMessage restores the receive bitmap from the prior record
    // (chunks 0,1) → receivedCount starts at 2 without any this-session write.
    await handleMetaMessage(META, 1)

    const session0 = getReceiveSession(RESUME_ID)
    expect(session0?.receivedCount).toBe(2)
    expect(opfsWrittenCount(RESUME_ID)).toBe(0) // nothing written THIS session yet

    const iv = new Uint8Array(12) as Uint8Array<ArrayBuffer>
    const buf = new Uint8Array(64).buffer

    // Only the remaining chunks 2,3 are re-shipped by the sender.
    for (const i of [2, 3]) {
      const result = await receiveChunk(RESUME_ID, i, iv, buf, 'peer-A')
      if (result && result.storageMode === 'stream') {
        await writeChunkToOPFS(RESUME_ID, i, result.decrypted)
      }
    }

    const session = getReceiveSession(RESUME_ID)
    // Authoritative completion signal — every chunk accounted for.
    expect(session?.receivedCount).toBe(TOTAL)
    // The session-local write bitmap only saw 2,3 — it is SHORT of totalChunks.
    expect(opfsWrittenCount(RESUME_ID)).toBe(2)
    expect(opfsWrittenCount(RESUME_ID)).not.toBe(TOTAL)

    // Therefore the fixed gate (receivedCount === totalChunks) delivers via the
    // OPFS branch; the old gate (opfsWrittenCount === totalChunks) would have
    // wrongly fallen through to the IDB-assemble branch and thrown.
  })
})
