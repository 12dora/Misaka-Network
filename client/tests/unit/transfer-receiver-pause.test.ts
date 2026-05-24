// Regression for the receiver-side pause being a UI lie.
//
// Before the fix: receiver clicked "pause" → store flipped the UI status to
// "paused" but the dc.onmessage receive hot path never consulted the pause
// signal, so chunks kept being decrypted and saved. The progress bar showed
// "paused" while the file grew on disk.
//
// After the fix: receiveChunk early-returns when the transferSignals entry
// for that transferId has paused=true (set by pauseTransfer). This test
// drives a real handleMetaMessage + receiveChunk pair against fake-indexeddb
// and asserts that no chunks are persisted while paused, and that resume
// re-enables persistence.

import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock the per-peer crypto so we don't have to install a real AES key in
// this unit context. decryptChunk returns the same buffer it was given
// (after stripping any imagined GCM tag — we just pass the bytes through).
vi.mock('../../src/lib/crypto', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/crypto')>('../../src/lib/crypto')
  return {
    ...actual,
    decryptChunk: vi.fn(async (_iv: Uint8Array, encrypted: ArrayBuffer) => encrypted),
  }
})

vi.mock('../../src/lib/db', () => {
  const records = new Map<string, any>()
  const chunks = new Map<string, Map<number, ArrayBuffer>>()
  return {
    saveTransfer: vi.fn(async (rec: any) => { records.set(rec.transferId, rec) }),
    updateTransfer: vi.fn(async (id: string, patch: any) => {
      const cur = records.get(id)
      if (cur) records.set(id, { ...cur, ...patch })
    }),
    getTransfer: vi.fn(async (id: string) => records.get(id) ?? null),
    getActiveTransfers: vi.fn(async () => []),
    saveChunk: vi.fn(async (id: string, idx: number, data: ArrayBuffer) => {
      let m = chunks.get(id); if (!m) { m = new Map(); chunks.set(id, m) }
      m.set(idx, data)
    }),
    getChunk: vi.fn(async (id: string, idx: number) => chunks.get(id)?.get(idx) ?? null),
    deleteChunks: vi.fn(async (id: string) => { chunks.delete(id) }),
    getSavedChunkIndexes: vi.fn(async (id: string) => Array.from(chunks.get(id)?.keys() ?? []).sort((a, b) => a - b)),
    __chunks: chunks,
    __records: records,
  }
})

import {
  handleMetaMessage, receiveChunk, pauseTransfer, resumeTransfer,
  cancelReceive,
  type MetaMessage,
} from '../../src/lib/transfer'
import * as db from '../../src/lib/db'

const PEER = 'peer-A'

function makeChunk(byte: number, len = 64): { iv: Uint8Array<ArrayBuffer>; encrypted: ArrayBuffer } {
  const iv = new Uint8Array(12) as Uint8Array<ArrayBuffer>
  const buf = new Uint8Array(len)
  buf.fill(byte)
  return { iv, encrypted: buf.buffer }
}

const baseMeta = (id: string): MetaMessage => ({
  type: 'meta',
  transferId: id,
  shortId: 1,
  fileName: 'pause-test.bin',
  fileSize: 256,
  fileHash: '',
  totalChunks: 4,
  mime: 'application/octet-stream',
})

describe('receiveChunk honours the pause signal', () => {
  beforeEach(() => {
    const m = (db as any).__chunks as Map<string, Map<number, ArrayBuffer>>
    m.clear()
    const r = (db as any).__records as Map<string, any>
    r.clear()
    vi.clearAllMocks()
  })

  it('drops chunks while paused, persists again after resume', async () => {
    const transferId = 't-pause-1'
    await handleMetaMessage(baseMeta(transferId), 1)

    // Pre-pause: one chunk arrives and is persisted (storageMode = indexeddb,
    // because no OPFS / FSAccess handle was registered for this transferId).
    const c0 = makeChunk(0xaa)
    await receiveChunk(transferId, 0, c0.iv, c0.encrypted, PEER)
    expect(db.saveChunk).toHaveBeenCalledTimes(1)
    expect(db.saveChunk).toHaveBeenLastCalledWith(transferId, 0, expect.any(ArrayBuffer))

    // Pause: incoming chunks must be dropped — no decrypt, no saveChunk,
    // session.received must NOT advance.
    pauseTransfer(transferId)

    const c1 = makeChunk(0xbb)
    const dropped = await receiveChunk(transferId, 1, c1.iv, c1.encrypted, PEER)
    expect(dropped).toBeUndefined()
    expect(db.saveChunk).toHaveBeenCalledTimes(1) // still just the pre-pause one

    const c2 = makeChunk(0xcc)
    await receiveChunk(transferId, 2, c2.iv, c2.encrypted, PEER)
    expect(db.saveChunk).toHaveBeenCalledTimes(1)

    // Resume: new chunks land on disk again.
    resumeTransfer(transferId)
    const c3 = makeChunk(0xdd)
    await receiveChunk(transferId, 3, c3.iv, c3.encrypted, PEER)
    expect(db.saveChunk).toHaveBeenCalledTimes(2)
    expect(db.saveChunk).toHaveBeenLastCalledWith(transferId, 3, expect.any(ArrayBuffer))

    cancelReceive(transferId)
  })

  it('drops chunks once cancelled', async () => {
    const transferId = 't-cancel-1'
    await handleMetaMessage(baseMeta(transferId), 1)

    const c0 = makeChunk(0x01)
    await receiveChunk(transferId, 0, c0.iv, c0.encrypted, PEER)
    expect(db.saveChunk).toHaveBeenCalledTimes(1)

    // Cancellation tears down the receive session entirely, so receiveChunk
    // hits its top-level guard. But independent of that, the cancelled signal
    // also short-circuits the path before decrypt — this is the guarantee
    // that protects an unrelated peer's session if signals leak.
    cancelReceive(transferId)

    const c1 = makeChunk(0x02)
    const result = await receiveChunk(transferId, 1, c1.iv, c1.encrypted, PEER)
    expect(result).toBeUndefined()
    expect(db.saveChunk).toHaveBeenCalledTimes(1) // unchanged
  })
})
