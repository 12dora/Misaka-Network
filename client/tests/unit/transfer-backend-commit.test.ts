// BUG-011 — multi-lane metadata raced the async receive-storage selection.
//   `meta` is sent down EVERY lane, so up to TRANSFER_LANE_COUNT copies arrive
//   nearly simultaneously and each used to start its own `prepareReceiveStorage`.
//   Whichever finished last won the `opfsHandles` entry, while chunks that had
//   already landed went to IndexedDB — delivery then preferred the (empty) OPFS
//   file and handed the user a truncated or zero-byte download.
//
// BUG-012 — the large-file OOM guard checked for API EXISTENCE, not for a
//   committed writable backend. `supportsFileSystemAccess()` is true in every
//   Chromium tab, including ones where the save picker is refused for want of
//   user activation; `supportsOPFS()` is true on iOS Safari <17 where
//   `createWritable()` throws. Both fell back to the in-memory IndexedDB
//   assemble — the exact path the cap exists to protect — with the guard
//   already satisfied.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../src/lib/db', () => {
  const chunks = new Map<string, Map<number, ArrayBuffer>>()
  return {
    saveTransfer: vi.fn(async () => {}),
    updateTransfer: vi.fn(async () => {}),
    getTransfer: vi.fn(async () => null),
    getActiveTransfers: vi.fn(async () => []),
    saveChunk: vi.fn(async (id: string, idx: number, data: ArrayBuffer) => {
      let m = chunks.get(id); if (!m) { m = new Map(); chunks.set(id, m) }
      m.set(idx, data)
    }),
    getChunk: vi.fn(async (id: string, idx: number) => chunks.get(id)?.get(idx) ?? null),
    deleteChunks: vi.fn(async (id: string) => { chunks.delete(id) }),
    getSavedChunkIndexes: vi.fn(async () => []),
    pruneTerminalTransfers: vi.fn(async () => 0),
    __chunks: chunks,
  }
})

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
  isReceiveBackendReady,
  checkBackendOOMGuard,
  getReceiveSession,
  cleanupOPFS,
} from '../../src/lib/transfer'
import * as db from '../../src/lib/db'
import { MAX_INMEMORY_RECEIVE_BYTES } from '../../src/constants'
import { makeMeta, makeChunk } from './_transfer-fixtures'

const OWNER = { peerSessionId: 'peer-A', epoch: 0 }

let origStorage: unknown
let origWindowFsa: unknown
let createWritableCalls = 0

beforeEach(() => {
  createWritableCalls = 0
  origStorage = (navigator as any).storage
  origWindowFsa = (window as any).showSaveFilePicker
  delete (window as any).showSaveFilePicker
  ;(db as any).__chunks.clear()
  vi.clearAllMocks()
})

afterEach(() => {
  if (origStorage === undefined) delete (navigator as any).storage
  else (navigator as any).storage = origStorage
  if (origWindowFsa === undefined) delete (window as any).showSaveFilePicker
  else (window as any).showSaveFilePicker = origWindowFsa
})

/** OPFS that works. `writeOk=false` simulates iOS Safari <17. */
function installOPFS({ writable = true }: { writable?: boolean } = {}) {
  const stream = {
    write: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    seek: async () => {},
    truncate: async () => {},
  }
  const fileHandle = {
    kind: 'file',
    name: 'f.bin',
    createWritable: vi.fn(async () => {
      createWritableCalls++
      if (!writable) {
        const err = new Error('not allowed')
        err.name = 'NotAllowedError'
        throw err
      }
      return stream
    }),
    getFile: vi.fn(async () => new File([], 'f.bin')),
  }
  const dir = {
    getDirectoryHandle: vi.fn(async () => dir),
    getFileHandle: vi.fn(async () => fileHandle),
    removeEntry: vi.fn(async () => {}),
    [Symbol.asyncIterator]: async function* () { /* empty */ },
  }
  ;(navigator as any).storage = { getDirectory: vi.fn(async () => dir) }
  return { stream, fileHandle, dir }
}

describe('BUG-011: one committed backend per (peerSessionId, transferId)', () => {
  it('deduplicates concurrent lane metas into a single preparation', async () => {
    installOPFS()
    const id = 'lane-dedupe'
    const meta = makeMeta({ transferId: id, totalChunks: 2 })
    await handleMetaMessage(meta, 1, OWNER)

    const args = {
      transferId: id, fileName: meta.fileName,
      totalChunks: meta.totalChunks, size: meta.fileSize,
    }
    // Four lanes, four metas, all in the same tick — exactly the production
    // shape. They must share ONE preparation.
    const results = await Promise.all([
      prepareReceiveBackend(args, OWNER),
      prepareReceiveBackend(args, OWNER),
      prepareReceiveBackend(args, OWNER),
      prepareReceiveBackend(args, OWNER),
    ])
    expect(results.every(r => r.ok)).toBe(true)
    expect(new Set(results.map(r => (r as { mode: string }).mode)).size).toBe(1)
    // A single `createWritable` proves only one preparation actually ran.
    expect(createWritableCalls).toBe(1)
  })

  it('buffers chunks that arrive before the backend commits, then replays them', async () => {
    // No OPFS, no FSA → the committed backend will be IndexedDB.
    delete (navigator as any).storage
    const id = 'precommit'
    const meta = makeMeta({ transferId: id, totalChunks: 3 })
    await handleMetaMessage(meta, 1, OWNER)
    expect(isReceiveBackendReady(id)).toBe(false)

    // A legacy (v1) sender starts blasting immediately after meta.
    for (const i of [0, 1, 2]) {
      const c = makeChunk(meta, i)
      const r = await receiveChunk(id, i, c.iv, c.encrypted, OWNER.peerSessionId)
      // Nothing may be written or counted before the backend exists — the old
      // code guessed `indexeddb` here and split the file across two backends.
      expect(r).toBeUndefined()
    }
    expect(db.saveChunk).not.toHaveBeenCalled()
    expect(getReceiveSession(id)?.receivedCount).toBe(0)

    await prepareReceiveBackend(
      { transferId: id, fileName: meta.fileName, totalChunks: 3, size: meta.fileSize },
      OWNER,
    )

    // Committing replays the buffered frames, in index order, through the very
    // same persist path a live chunk takes.
    expect(isReceiveBackendReady(id)).toBe(true)
    expect(getReceiveSession(id)?.receivedCount).toBe(3)
    const saved = (db.saveChunk as unknown as { mock: { calls: unknown[][] } }).mock.calls
    expect(saved.map(c => c[1])).toEqual([0, 1, 2])
  })
})

describe('BUG-012: the OOM cap applies to the COMMITTED backend', () => {
  it('checkBackendOOMGuard ignores size when a streaming backend committed', () => {
    const huge = MAX_INMEMORY_RECEIVE_BYTES * 4
    expect(checkBackendOOMGuard(huge, 'opfs')).toBeNull()
    expect(checkBackendOOMGuard(huge, 'fsa')).toBeNull()
  })

  it('checkBackendOOMGuard refuses an oversized file once we fell back to IDB', () => {
    const huge = MAX_INMEMORY_RECEIVE_BYTES + 1
    const rejection = checkBackendOOMGuard(huge, 'idb')
    expect(rejection).toMatchObject({ reason: 'too-large-for-fallback' })
    expect(rejection!.limitBytes).toBe(MAX_INMEMORY_RECEIVE_BYTES)
    // Under the cap the IDB path is fine.
    expect(checkBackendOOMGuard(MAX_INMEMORY_RECEIVE_BYTES, 'idb')).toBeNull()
  })

  it('an unwritable OPFS + oversized file is REJECTED, not silently downgraded', async () => {
    // The iOS Safari <17 shape: getDirectory works, createWritable throws.
    installOPFS({ writable: false })
    const id = 'oom-opfs'
    const size = MAX_INMEMORY_RECEIVE_BYTES + 1024
    const totalChunks = Math.ceil(size / (252 * 1024))
    await handleMetaMessage(
      { type: 'meta', transferId: id, shortId: 1, fileName: 'big.bin', fileSize: size, fileHash: '', totalChunks, mime: 'application/octet-stream' },
      1, OWNER,
    )
    const result = await prepareReceiveBackend(
      { transferId: id, fileName: 'big.bin', totalChunks, size }, OWNER,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.reason).toBe('too-large-for-fallback')
    // Nothing was committed, so no chunk can slip into the in-memory path.
    expect(isReceiveBackendReady(id)).toBe(false)
    await cleanupOPFS(id).catch(() => {})
  })

  it('a Chromium tab whose save picker is refused still gets the cap applied', async () => {
    // FSA "supported" but the picker throws NotAllowedError (no user gesture),
    // and there is no OPFS → the real backend is IndexedDB.
    ;(window as any).showSaveFilePicker = vi.fn(async () => {
      const err = new Error('no activation')
      err.name = 'NotAllowedError'
      throw err
    })
    delete (navigator as any).storage

    const id = 'oom-fsa'
    const size = MAX_INMEMORY_RECEIVE_BYTES + 4096
    const totalChunks = Math.ceil(size / (252 * 1024))
    await handleMetaMessage(
      { type: 'meta', transferId: id, shortId: 2, fileName: 'big2.bin', fileSize: size, fileHash: '', totalChunks, mime: 'application/octet-stream' },
      1, OWNER,
    )
    const result = await prepareReceiveBackend(
      { transferId: id, fileName: 'big2.bin', totalChunks, size }, OWNER,
    )
    expect(result).toMatchObject({ ok: false })
    expect(isReceiveBackendReady(id)).toBe(false)
  })

  it('the same oversized file is ACCEPTED when OPFS really is writable', async () => {
    installOPFS({ writable: true })
    const id = 'oom-ok'
    const size = MAX_INMEMORY_RECEIVE_BYTES + 4096
    const totalChunks = Math.ceil(size / (252 * 1024))
    await handleMetaMessage(
      { type: 'meta', transferId: id, shortId: 3, fileName: 'big3.bin', fileSize: size, fileHash: '', totalChunks, mime: 'application/octet-stream' },
      1, OWNER,
    )
    const result = await prepareReceiveBackend(
      { transferId: id, fileName: 'big3.bin', totalChunks, size }, OWNER,
    )
    expect(result).toMatchObject({ ok: true, mode: 'opfs' })
    expect(isReceiveBackendReady(id)).toBe(true)
    await cleanupOPFS(id).catch(() => {})
  })
})
