// P0-2: `cancelReceive` must drain in-flight saveChunk promises before
// calling deleteChunks. Otherwise a slow IDB write that started just
// before cancel can complete AFTER deleteChunks, leaving an orphan
// chunk row that survives the cleanup forever.
//
// Reproducer: mock saveChunk to delay ~50 ms; fire receiveChunk; cancel
// immediately (without awaiting receiveChunk). The cancel must NOT call
// deleteChunks before saveChunk resolves — once it does, the orphan
// would persist.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// In-memory "IDB" — saveChunk delays, deleteChunks records the order of
// operations so we can assert cancel waited.
const order: string[] = []
const stored = new Map<string, ArrayBuffer>()

vi.mock('../../src/lib/db', () => ({
  saveTransfer: vi.fn(async () => {}),
  updateTransfer: vi.fn(async () => {}),
  getTransfer: vi.fn(async () => null),
  getActiveTransfers: vi.fn(async () => []),
  saveChunk: vi.fn(async (id: string, idx: number, data: ArrayBuffer) => {
    // Simulate a slow disk write.
    await new Promise(r => setTimeout(r, 30))
    stored.set(`${id}:${idx}`, data)
    order.push(`save:${idx}`)
  }),
  getChunk: vi.fn(async () => null),
  deleteChunks: vi.fn(async (id: string) => {
    order.push('delete')
    for (const k of Array.from(stored.keys())) {
      if (k.startsWith(`${id}:`)) stored.delete(k)
    }
  }),
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
  cancelReceive,
  type MetaMessage,
} from '../../src/lib/transfer'

const META: MetaMessage = {
  type: 'meta',
  transferId: 'cancel-inflight',
  shortId: 1,
  fileName: 'inflight.bin',
  fileSize: 4 * 64,
  fileHash: '',
  totalChunks: 4,
  mime: 'application/octet-stream',
}

beforeEach(() => {
  order.length = 0
  stored.clear()
  vi.clearAllMocks()
})

describe('cancelReceive waits for in-flight saveChunk before deleteChunks', () => {
  it('drains pending saves so no orphan rows survive cleanup', async () => {
    await handleMetaMessage(META, 1)

    const iv = new Uint8Array(12) as Uint8Array<ArrayBuffer>
    const buf = new Uint8Array(64).buffer

    // Fire 3 receives WITHOUT awaiting — they're now in flight in the
    // mocked saveChunk delay.
    const pending = [
      receiveChunk('cancel-inflight', 0, iv, buf, 'peer-A'),
      receiveChunk('cancel-inflight', 1, iv, buf, 'peer-A'),
      receiveChunk('cancel-inflight', 2, iv, buf, 'peer-A'),
    ]

    // Cancel mid-flight. Returns a promise the caller awaits so the
    // delete is sequenced after the in-flight saves finish.
    const cancelPromise = cancelReceive('cancel-inflight')

    await Promise.allSettled(pending)
    // `cancelReceive` returns void today, but the contract requires the
    // delete to be enqueued AFTER the saves resolve. Awaiting the result
    // (which may be void or a promise) lets us settle either shape.
    await cancelPromise

    // Either ordering is acceptable as long as all `save:*` events happen
    // before the `delete` event.
    const deleteAt = order.indexOf('delete')
    expect(deleteAt).toBeGreaterThanOrEqual(0)
    for (let i = 0; i < deleteAt; i++) {
      expect(order[i]).toMatch(/^save:/)
    }
    // And no orphans linger after cancel.
    expect(stored.size).toBe(0)
  })
})
