// End-to-end test for the bitmap persistence + wire format (P1-4).
//
// Three things must hold for the new format to not regress resume:
//   1. handleMetaMessage with a prior record (legacy `receivedChunks` OR
//      new `receivedBitmap`) restores the bitmap correctly.
//   2. buildResumeRequest produces a compact wire shape — RLE ranges
//      when popcount is large, flat indexes otherwise.
//   3. decodeResumeRequest accepts BOTH wire shapes and produces a
//      bitmap that round-trips. (Cross-version compatibility: a new
//      client should parse what an old client sent and vice versa.)

import { describe, it, expect, vi, beforeEach } from 'vitest'

// In-memory db mock — must let us round-trip TransferRecord with the new
// `receivedBitmap` field.
const records = new Map<string, any>()
const chunks = new Map<string, Map<number, ArrayBuffer>>()

vi.mock('../../src/lib/db', () => ({
  saveTransfer: vi.fn(async (rec: any) => { records.set(rec.transferId, rec) }),
  updateTransfer: vi.fn(async (id: string, patch: any) => {
    const cur = records.get(id)
    if (cur) records.set(id, { ...cur, ...patch })
  }),
  getTransfer: vi.fn(async (id: string) => records.get(id) ?? null),
  getActiveTransfers: vi.fn(async () => Array.from(records.values())),
  saveChunk: vi.fn(async (id: string, idx: number, data: ArrayBuffer) => {
    let m = chunks.get(id); if (!m) { m = new Map(); chunks.set(id, m) }
    m.set(idx, data)
  }),
  getChunk: vi.fn(async (id: string, idx: number) => chunks.get(id)?.get(idx) ?? null),
  deleteChunks: vi.fn(async (id: string) => { chunks.delete(id) }),
  getSavedChunkIndexes: vi.fn(async (id: string) =>
    Array.from(chunks.get(id)?.keys() ?? []).sort((a, b) => a - b),
  ),
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
  buildResumeRequest,
  decodeResumeRequest,
  type MetaMessage,
} from '../../src/lib/transfer'
import {
  bitmapToIndexes,
  bitmapPopcount,
} from '../../src/lib/chunk-bitmap'

const PEER = 'peer-A'

function makeIv(): Uint8Array<ArrayBuffer> {
  return new Uint8Array(12) as Uint8Array<ArrayBuffer>
}

function makeMeta(transferId: string, totalChunks: number): MetaMessage {
  return {
    type: 'meta',
    transferId,
    shortId: 1,
    fileName: 'bitmap-test.bin',
    fileSize: totalChunks * 64,
    fileHash: '',
    totalChunks,
    mime: 'application/octet-stream',
  }
}

beforeEach(() => {
  records.clear()
  chunks.clear()
  vi.clearAllMocks()
})

describe('receiver bitmap persistence', () => {
  it('receiveChunk advances receivedCount and persists bitmap (not number[])', async () => {
    await handleMetaMessage(makeMeta('p1', 10), 1)

    // Initial save uses bitmap, not chunks.
    const initial = records.get('p1')
    expect(initial.receivedChunks).toEqual([])
    expect(initial.receivedBitmap).toBeInstanceOf(ArrayBuffer)
    expect(initial.receivedBitmap.byteLength).toBe(2) // ceil(10/8)

    // Send 3 chunks — they should land in the bitmap, not as a JSON array.
    const buf = new Uint8Array(64).buffer
    for (const i of [0, 2, 7]) {
      await receiveChunk('p1', i, makeIv(), buf, PEER)
    }
    // Force a flush by also waiting the throttle window. Our test uses
    // performance.now via vitest fake env; instead, jump straight to the
    // last chunk so the "size === total" branch flushes synchronously.
    for (const i of [1, 3, 4, 5, 6, 8, 9]) {
      await receiveChunk('p1', i, makeIv(), buf, PEER)
    }

    const final = records.get('p1')
    expect(final.receivedChunks).toEqual([])
    expect(final.receivedBitmap).toBeInstanceOf(ArrayBuffer)
    // All 10 bits should now be set — popcount == 10.
    const bm = new Uint8Array(final.receivedBitmap)
    expect(bitmapPopcount(bm)).toBe(10)
    expect(bitmapToIndexes(bm, 10)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('handleMetaMessage restores from a legacy receivedChunks[] record', async () => {
    // Simulate a record written by an OLD client (only number[]).
    records.set('p2', {
      transferId: 'p2',
      direction: 'recv',
      peerNodeId: 1,
      fileName: 'legacy.bin',
      fileSize: 64 * 100,
      fileHash: '',
      totalChunks: 100,
      receivedChunks: [0, 1, 2, 50, 99],
      status: 'active',
      createdAt: 0,
      updatedAt: 0,
    })

    const session = await handleMetaMessage(makeMeta('p2', 100), 1)
    expect(session.receivedCount).toBe(5)
    // After meta restore, the persisted record should be migrated to
    // bitmap format (receivedChunks emptied, receivedBitmap set).
    const after = records.get('p2')
    expect(after.receivedChunks).toEqual([])
    expect(after.receivedBitmap).toBeInstanceOf(ArrayBuffer)
    const bm = new Uint8Array(after.receivedBitmap)
    expect(bitmapToIndexes(bm, 100)).toEqual([0, 1, 2, 50, 99])
  })

  it('handleMetaMessage restores from an already-bitmap record', async () => {
    // Prior bitmap with bits 5, 6, 7 set.
    const prior = new Uint8Array([0b11100000])
    records.set('p3', {
      transferId: 'p3',
      direction: 'recv',
      peerNodeId: 1,
      fileName: 'b.bin',
      fileSize: 64 * 20,
      fileHash: '',
      totalChunks: 20,
      receivedChunks: [],
      receivedBitmap: prior.buffer.slice(0),
      status: 'active',
      createdAt: 0,
      updatedAt: 0,
    })

    const session = await handleMetaMessage(makeMeta('p3', 20), 1)
    expect(session.receivedCount).toBe(3)
    expect(bitmapToIndexes(session.received, 20)).toEqual([5, 6, 7])
  })
})

describe('resume wire format', () => {
  it('small in-progress transfer emits flat receivedChunks (legacy compatible)', async () => {
    // Seed a record with a few received chunks (under the RLE threshold).
    records.set('small', {
      transferId: 'small',
      direction: 'recv',
      peerNodeId: 1,
      fileName: 's.bin',
      fileSize: 64 * 10,
      fileHash: '',
      totalChunks: 10,
      receivedChunks: [],
      receivedBitmap: bitmapFromIdxs([0, 1, 5, 9], 10).buffer.slice(0),
      status: 'active',
      createdAt: 0,
      updatedAt: 0,
    })

    const req = await buildResumeRequest('small')
    expect(req).not.toBeNull()
    expect(req!.receivedChunks).toEqual([0, 1, 5, 9])
    expect(req!.receivedRanges).toBeUndefined()
  })

  it('large in-progress transfer emits RLE receivedRanges', async () => {
    // 2000 contiguous chunks — well past the 1024 RLE threshold.
    const buf = new Uint8Array(250) // 2000 / 8
    for (let i = 0; i < 2000; i++) buf[i >> 3] |= 1 << (i & 7)
    records.set('big', {
      transferId: 'big',
      direction: 'recv',
      peerNodeId: 1,
      fileName: 'b.bin',
      fileSize: 64 * 4000,
      fileHash: '',
      totalChunks: 4000,
      receivedChunks: [],
      receivedBitmap: buf.buffer.slice(0),
      status: 'active',
      createdAt: 0,
      updatedAt: 0,
    })

    const req = await buildResumeRequest('big')
    expect(req).not.toBeNull()
    expect(req!.receivedRanges).toEqual([[0, 2000]])
    expect(req!.receivedChunks).toBeUndefined()
  })

  it('decodeResumeRequest accepts BOTH formats (cross-version compat)', () => {
    const fromIndexes = decodeResumeRequest({ receivedChunks: [0, 1, 2, 9] }, 10)
    expect(bitmapToIndexes(fromIndexes, 10)).toEqual([0, 1, 2, 9])

    const fromRanges = decodeResumeRequest({ receivedRanges: [[0, 3], [9, 1]] }, 10)
    expect(bitmapToIndexes(fromRanges, 10)).toEqual([0, 1, 2, 9])

    // Empty / missing both — returns an empty bitmap, not undefined.
    const empty = decodeResumeRequest({}, 10)
    expect(bitmapPopcount(empty)).toBe(0)
    expect(empty.length).toBe(2)

    // Out-of-range indexes / lengths are silently clamped (defense
    // against a malicious peer pushing a huge alloc).
    const clamped = decodeResumeRequest({ receivedChunks: [5, 10_000_000] }, 10)
    expect(bitmapToIndexes(clamped, 10)).toEqual([5])
    expect(clamped.length).toBe(2)

    const clampedR = decodeResumeRequest({ receivedRanges: [[0, 1_000_000]] }, 10)
    expect(bitmapToIndexes(clampedR, 10)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(clampedR.length).toBe(2)
  })
})

// ── tiny helper ────────────────────────────────────────────────────
function bitmapFromIdxs(indexes: number[], total: number): Uint8Array {
  const buf = new Uint8Array(Math.ceil(total / 8))
  for (const i of indexes) {
    if (i >= 0 && i < total) buf[i >> 3] |= 1 << (i & 7)
  }
  return buf
}
