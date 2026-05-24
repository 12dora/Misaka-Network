// P1-8: cleanupOPFS must only remove the entry that exactly matches
// `${transferId}-${fileName}`, not anything that starts with the
// transferId. With the prior `name.startsWith(transferId)` check, two
// concurrent transfers whose IDs share a prefix (e.g. `abc-123-foo.bin`
// and `abc-123abcd-bar.bin` if a UUID collision ever occurred, or more
// practically: a parent UUID and its child slug) would mass-delete
// unrelated files when one was cancelled.

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

import { createOPFSReceiveFile, cleanupOPFS } from '../../src/lib/transfer'

let origStorage: unknown
let dirEntries: string[]
let removedEntries: string[]

beforeEach(() => {
  origStorage = (navigator as any).storage
  removedEntries = []
  dirEntries = ['transfer-A-foo.bin', 'transfer-A-bar.bin', 'transfer-AB-other.bin']

  const writable = {
    write: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    seek: async () => {},
    truncate: async () => {},
  }
  const fileHandle = {
    kind: 'file',
    name: 'whatever',
    createWritable: vi.fn(async () => writable),
    getFile: vi.fn(async () => new File([], 'whatever')),
  }
  const dir: any = {
    getDirectoryHandle: vi.fn(async () => dir),
    getFileHandle: vi.fn(async () => fileHandle),
    removeEntry: vi.fn(async (name: string) => {
      removedEntries.push(name)
      dirEntries = dirEntries.filter(n => n !== name)
    }),
    [Symbol.asyncIterator]: async function* () {
      for (const name of dirEntries) yield [name, fileHandle] as const
    },
  }
  ;(navigator as any).storage = {
    getDirectory: vi.fn(async () => dir),
  }
})

afterEach(() => {
  if (origStorage === undefined) delete (navigator as any).storage
  else (navigator as any).storage = origStorage
})

describe('cleanupOPFS only removes the exact entry it owns', () => {
  it('removes ONLY `${transferId}-${fileName}`, not prefix matches', async () => {
    // Create a handle so cleanupOPFS doesn't no-op on the in-memory side.
    await createOPFSReceiveFile('transfer-A', 'foo.bin', 4)
    await cleanupOPFS('transfer-A')
    // Only `transfer-A-foo.bin` may have been removed. Both
    // `transfer-A-bar.bin` (different file under same transferId — would
    // have been wrongly removed under the old startsWith) and
    // `transfer-AB-other.bin` (different transfer entirely) must survive.
    expect(removedEntries).toEqual(['transfer-A-foo.bin'])
  })

  it('no-ops when the entry does not exist', async () => {
    // No createOPFSReceiveFile this time: handle map is empty. cleanupOPFS
    // should still attempt the directory removal but not pull in any
    // unrelated files.
    await cleanupOPFS('nonexistent')
    expect(removedEntries).toEqual([])
  })
})
