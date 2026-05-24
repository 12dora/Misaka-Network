// P0-1: `prepareReceiveStorage(meta)` three-tier fallback.
//
// Contract:
//   1. If File System Access (showSaveFilePicker) is available, try it.
//      User cancellation (AbortError / NotAllowedError) must NOT bubble —
//      it falls through to OPFS.
//   2. If OPFS is available AND probing `createWritable()` does not throw,
//      use OPFS. iOS Safari <17 exposes the directory handle but
//      `createWritable` throws NotAllowedError — that case must fall
//      through to IDB.
//   3. Otherwise → 'idb'.
//
// We test by stubbing the surfaces transfer.ts uses internally
// (showSaveFilePicker, navigator.storage.getDirectory) and asserting the
// returned mode for each branch.

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

import { prepareReceiveStorage } from '../../src/lib/transfer'

type MetaArg = { transferId: string; fileName: string; totalChunks: number; size: number }
const meta = (id = 't1'): MetaArg => ({
  transferId: id,
  fileName: `${id}.bin`,
  totalChunks: 4,
  size: 4 * 1024,
})

// Track originals so we can restore between tests.
let origStorage: unknown
let origShowSave: unknown

beforeEach(() => {
  origStorage = (navigator as any).storage
  origShowSave = (window as any).showSaveFilePicker
})

afterEach(() => {
  if (origStorage === undefined) delete (navigator as any).storage
  else (navigator as any).storage = origStorage
  if (origShowSave === undefined) delete (window as any).showSaveFilePicker
  else (window as any).showSaveFilePicker = origShowSave
})

function installFSA(behavior: 'accept' | 'cancel' | 'throw') {
  ;(window as any).showSaveFilePicker = vi.fn(async () => {
    if (behavior === 'cancel') {
      const err = new Error('user cancelled')
      err.name = 'AbortError'
      throw err
    }
    if (behavior === 'throw') {
      const err = new Error('not allowed')
      err.name = 'NotAllowedError'
      throw err
    }
    return {
      kind: 'file' as const,
      name: 'picked.bin',
      createWritable: async () => ({
        write: async () => {},
        close: async () => {},
        seek: async () => {},
        truncate: async () => {},
      }),
      getFile: async () => new File([], 'picked.bin'),
    }
  })
}

function installOPFS(opts: { writableThrows?: boolean }) {
  const writeFn = vi.fn(async () => {})
  const closeFn = vi.fn(async () => {})
  const fileHandle = {
    kind: 'file' as const,
    name: 'probe',
    createWritable: vi.fn(async () => {
      if (opts.writableThrows) {
        const err = new Error('createWritable disallowed')
        err.name = 'NotAllowedError'
        throw err
      }
      return { write: writeFn, close: closeFn, seek: async () => {}, truncate: async () => {} }
    }),
    getFile: vi.fn(async () => new File([], 'probe')),
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
  return { fileHandle, dir }
}

describe('prepareReceiveStorage: three-tier fallback', () => {
  it('uses FSA when showSaveFilePicker resolves', async () => {
    installFSA('accept')
    // Even if OPFS is around, FSA wins.
    installOPFS({})
    const r = await prepareReceiveStorage(meta('fsa-ok'))
    expect(r.mode).toBe('fsa')
  })

  it('falls back to OPFS when user cancels the save picker', async () => {
    installFSA('cancel')
    installOPFS({})
    const r = await prepareReceiveStorage(meta('fsa-cancel'))
    expect(r.mode).toBe('opfs')
  })

  it('falls back to IDB when OPFS createWritable throws (iOS Safari <17)', async () => {
    // No FSA available.
    delete (window as any).showSaveFilePicker
    installOPFS({ writableThrows: true })
    const r = await prepareReceiveStorage(meta('opfs-fail'))
    expect(r.mode).toBe('idb')
  })

  it('falls back to IDB when neither FSA nor OPFS exists', async () => {
    delete (window as any).showSaveFilePicker
    delete (navigator as any).storage
    const r = await prepareReceiveStorage(meta('no-storage'))
    expect(r.mode).toBe('idb')
  })

  it('falls back to OPFS when FSA throws non-AbortError', async () => {
    installFSA('throw')
    installOPFS({})
    const r = await prepareReceiveStorage(meta('fsa-throw'))
    expect(r.mode).toBe('opfs')
  })
})
