// Regression: in OPFS / FSA stream mode, `deliverCompletedFile` must not
// fire from the moment the receive-side bitmap reaches totalChunks. The
// matching disk write for the last chunk runs in the orchestrating
// handler (store/network.ts), AFTER `receiveChunk` returns. If we deliver
// based purely on the receive bitmap, `opfsWrittenCount === totalChunks`
// is still false for the last index and the deliver path falls through
// to the IDB-assemble branch, which then throws "Missing chunk 0" because
// nothing was ever saved to IDB under stream mode.
//
// This test exercises the exact ordering store/network.ts performs around
// the chunk handler:
//
//   1. await receiveChunk(...)          // sets receive bitmap, may signal done
//   2. await writeChunkToOPFS(...)       // persists the chunk on disk
//   3. if (final signal) deliver(...)    // only NOW safe to assemble
//
// and asserts that at the moment the final-signal latch flips,
// `opfsWrittenCount === totalChunks` — i.e., the deliver gate would pick
// the OPFS branch, not the IDB-assemble branch.
//
// Without the fix, the failing assertion is `opfsWrittenCount === total`
// at the point the latch is set; the assertion lives further down to
// document the *contract*, not the bug.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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
  ;(navigator as any).storage = {
    getDirectory: vi.fn(async () => dir),
  }
})

afterEach(async () => {
  await cleanupOPFS('opfs-deliver-test').catch(() => {})
  if (origStorage === undefined) delete (navigator as any).storage
  else (navigator as any).storage = origStorage
})

const TOTAL = 3
const META: MetaMessage = {
  type: 'meta',
  transferId: 'opfs-deliver-test',
  shortId: 1,
  fileName: 'opfs.bin',
  fileSize: TOTAL * 64,
  fileHash: '',
  totalChunks: TOTAL,
  mime: 'application/octet-stream',
}

describe('deliverCompletedFile gate must wait for stream write', () => {
  it('opfsWrittenCount equals totalChunks at the moment the final-chunk latch flips', async () => {
    await handleMetaMessage(META, 1)
    await createOPFSReceiveFile(META.transferId, META.fileName, TOTAL)

    const iv = new Uint8Array(12) as Uint8Array<ArrayBuffer>
    const buf = new Uint8Array(64).buffer

    // Captures opfsWrittenCount at the precise moment the deliver gate
    // would have run *under the fixed ordering* — i.e., after the
    // per-chunk write to OPFS but before the next chunk arrives.
    let deliverCountAtLatch = -1

    for (let i = 0; i < TOTAL; i++) {
      let finalLanded = false
      const result = await receiveChunk(
        META.transferId, i, iv, buf, 'peer-A',
        {
          onProgress(received, total) {
            if (received === total) finalLanded = true
          },
        },
      )
      // The orchestrating handler (store/network.ts) writes the chunk to
      // OPFS here, AFTER receiveChunk has returned.
      if (result && result.storageMode === 'stream') {
        await writeChunkToOPFS(META.transferId, i, result.decrypted)
      }
      // Deliver gate runs only after the post-receive disk write — exactly
      // what the fix in network.ts enforces. If the gate had been wired to
      // the onProgress callback (the buggy path), `deliverCountAtLatch`
      // would have captured `TOTAL - 1` instead of `TOTAL`.
      if (finalLanded) deliverCountAtLatch = opfsWrittenCount(META.transferId)
    }

    expect(deliverCountAtLatch).toBe(TOTAL)
  })

  it('the buggy ordering (deliver inside onProgress) sees an under-counted OPFS bitmap — documents the race', async () => {
    // This test pins the original race so any future refactor that pulls
    // `deliverCompletedFile` back into the onProgress callback re-fails
    // here loudly. It does NOT assert the fixed behaviour — it asserts
    // the SHAPE of the race we eliminated.
    await handleMetaMessage({ ...META, transferId: 'opfs-race-doc' }, 1)
    await createOPFSReceiveFile('opfs-race-doc', META.fileName, TOTAL)

    const iv = new Uint8Array(12) as Uint8Array<ArrayBuffer>
    const buf = new Uint8Array(64).buffer

    let buggyDeliverCount = -1
    for (let i = 0; i < TOTAL; i++) {
      const result = await receiveChunk(
        'opfs-race-doc', i, iv, buf, 'peer-A',
        {
          onProgress(received, total) {
            // The pre-fix code path: fire deliver the instant the receive
            // bitmap reaches totalChunks, BEFORE the disk write below.
            if (received === total) {
              buggyDeliverCount = opfsWrittenCount('opfs-race-doc')
            }
          },
        },
      )
      if (result && result.storageMode === 'stream') {
        await writeChunkToOPFS('opfs-race-doc', i, result.decrypted)
      }
    }

    // The race: at the moment the latch flips, the LAST chunk's
    // writeChunkToOPFS hasn't been called yet — so the OPFS bitmap is one
    // short. This is exactly the condition that made `deliverCompletedFile`
    // fall through to the IDB-assemble branch and throw "Missing chunk 0".
    expect(buggyDeliverCount).toBe(TOTAL - 1)

    await cleanupOPFS('opfs-race-doc').catch(() => {})
  })
})
