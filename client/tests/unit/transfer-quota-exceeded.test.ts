// P1-6: QuotaExceededError surfaces uniformly as STORAGE_QUOTA_EXCEEDED.
//
// Three storage paths can run out of space:
//   - IDB saveChunk   (transfer.ts hot path)
//   - OPFS write       (writeChunkToOPFS)
//   - File System Access write (streamChunkToDisk)
//
// All three must rethrow as `STORAGE_QUOTA_EXCEEDED` so the UI can
// surface one consistent error instead of three different DOMException
// flavours. The receiver-side hot path catches that signal and triggers
// cancelReceive — without this, the partial chunks would linger in IDB
// until the next manual cancel.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// IDB mock that we'll switch between "OK" and "throws quota" mid-test.
let idbThrowsQuota = false
vi.mock('../../src/lib/db', () => ({
  saveTransfer: vi.fn(async () => {}),
  updateTransfer: vi.fn(async () => {}),
  getTransfer: vi.fn(async () => null),
  getActiveTransfers: vi.fn(async () => []),
  saveChunk: vi.fn(async () => {
    if (idbThrowsQuota) {
      const err = new Error('QuotaExceededError: not enough storage')
      err.name = 'QuotaExceededError'
      throw err
    }
  }),
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
  prepareReceiveBackend,
  createOPFSReceiveFile,
  writeChunkToOPFS,
  cleanupOPFS,
  type MetaMessage,
} from '../../src/lib/transfer'

import { makeMeta, makeChunk } from './_transfer-fixtures'

const OWNER = { peerSessionId: 'peer-A', epoch: 0 }
const META: MetaMessage = makeMeta({ transferId: 'quota', totalChunks: 4, fileName: 'quota.bin' })

beforeEach(() => {
  idbThrowsQuota = false
  vi.clearAllMocks()
})

describe('saveChunk QuotaExceeded → STORAGE_QUOTA_EXCEEDED', () => {
  it('receiveChunk rethrows a uniform STORAGE_QUOTA_EXCEEDED error', async () => {
    const id = 'q-idb'
    const meta = { ...META, transferId: id }
    await handleMetaMessage(meta, 1, OWNER)
    // BUG-011: commit the (IndexedDB) backend before any chunk is accepted.
    await prepareReceiveBackend(
      { transferId: id, fileName: meta.fileName, totalChunks: meta.totalChunks, size: meta.fileSize },
      OWNER,
    )
    idbThrowsQuota = true
    const { iv, encrypted: buf } = makeChunk(meta, 0)

    await expect(
      receiveChunk(id, 0, iv, buf, 'peer-A'),
    ).rejects.toThrow(/STORAGE_QUOTA_EXCEEDED/)
  })
})

describe('writeChunkToOPFS QuotaExceeded → STORAGE_QUOTA_EXCEEDED', () => {
  let origStorage: unknown
  beforeEach(() => {
    origStorage = (navigator as any).storage
    const writable = {
      write: vi.fn(async () => {
        const err = new Error('QuotaExceededError: OPFS quota')
        err.name = 'QuotaExceededError'
        throw err
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
    await cleanupOPFS('q-opfs').catch(() => {})
    if (origStorage === undefined) delete (navigator as any).storage
    else (navigator as any).storage = origStorage
  })

  it('writeChunkToOPFS rethrows STORAGE_QUOTA_EXCEEDED', async () => {
    await createOPFSReceiveFile('q-opfs', 'opfs.bin', 4)
    const buf = new Uint8Array(64).buffer
    // The first call may resolve (queue backpressure not yet hit). Push
    // enough writes to force the writeQueue to await one of them, which
    // is where the error surfaces.
    await expect(async () => {
      // 32 MB worth of "writes" guarantees the queue waits at least once.
      const big = new ArrayBuffer(20 * 1024 * 1024)
      await writeChunkToOPFS('q-opfs', 0, big)
      await writeChunkToOPFS('q-opfs', 1, big)
      await writeChunkToOPFS('q-opfs', 2, big)
    }).rejects.toThrow(/STORAGE_QUOTA_EXCEEDED/)
  })
})
