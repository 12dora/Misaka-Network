// P1-7: OPFSReceiveHandle.written migrated from Set<number> to a chunk
// bitmap so a 1 TB transfer no longer needs ~800 MB of Set overhead just
// to track which indexes landed.
//
// Asserts:
//   1. The field is a Uint8Array (not a Set), sized for the bitmap.
//   2. `writeChunkToOPFS` marks the bit (idempotent: setting the same
//      index twice doesn't double-count).
//   3. `opfsWrittenCount(transferId)` returns the popcount — the helper
//      the store now uses in place of `opfsHandle.written.size`.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

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

import {
  createOPFSReceiveFile,
  writeChunkToOPFS,
  getOPFSHandle,
  opfsWrittenCount,
  cleanupOPFS,
} from '../../src/lib/transfer'
import { bitmapHas, bitmapByteLength } from '../../src/lib/chunk-bitmap'

let origStorage: unknown

beforeEach(() => {
  origStorage = (navigator as any).storage
  // Minimal in-memory OPFS shim. Records writes per file so we can
  // assert idempotency.
  const writes: Array<{ offset: number; bytes: number }> = []
  const writable = {
    write: vi.fn(async (req: any) => {
      writes.push({ offset: req.position, bytes: req.data.byteLength })
    }),
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
  // Best-effort cleanup so handles don't leak across tests.
  await cleanupOPFS('opfs-bitmap-test').catch(() => {})
  if (origStorage === undefined) delete (navigator as any).storage
  else (navigator as any).storage = origStorage
})

describe('OPFSReceiveHandle.written is now a bitmap (P1-7)', () => {
  it('createOPFSReceiveFile allocates a Uint8Array sized for totalChunks', async () => {
    const total = 17
    const handle = await createOPFSReceiveFile('opfs-bitmap-test', 'big.bin', total)
    expect(handle.written).toBeInstanceOf(Uint8Array)
    expect(handle.written.byteLength).toBe(bitmapByteLength(total))
    // Nothing set yet.
    expect(opfsWrittenCount('opfs-bitmap-test')).toBe(0)
  })

  it('writeChunkToOPFS sets the bit; duplicates do not double-count', async () => {
    await createOPFSReceiveFile('opfs-bitmap-test', 'big.bin', 10)
    const buf = new Uint8Array(64).buffer

    await writeChunkToOPFS('opfs-bitmap-test', 0, buf)
    await writeChunkToOPFS('opfs-bitmap-test', 5, buf)
    expect(opfsWrittenCount('opfs-bitmap-test')).toBe(2)

    const handle = getOPFSHandle('opfs-bitmap-test')!
    expect(bitmapHas(handle.written, 0)).toBe(true)
    expect(bitmapHas(handle.written, 5)).toBe(true)
    expect(bitmapHas(handle.written, 9)).toBe(false)

    // Idempotent: writing index 5 again still leaves popcount at 2.
    await writeChunkToOPFS('opfs-bitmap-test', 5, buf)
    expect(opfsWrittenCount('opfs-bitmap-test')).toBe(2)
  })

  it('opfsWrittenCount returns 0 for unknown transfer (no handle registered)', () => {
    expect(opfsWrittenCount('nonexistent')).toBe(0)
  })
})
