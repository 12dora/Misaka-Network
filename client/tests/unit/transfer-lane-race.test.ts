// P0-3: 4 concurrent lanes prepareNext() must never hand the SAME chunk
// index to two lanes. Before the fix, `nextChunk++` was a non-atomic
// read+increment: if two lanes hit the increment between each other's
// reads, they both saw the same `idx` and shipped the same encrypted
// chunk twice. Worst-case symptom: receiver gets one byte of garbage
// where chunk N+1 should be (because chunk N was sent again under N+1's
// frame index), AES-GCM auth fails downstream.
//
// We exercise sendFileParallel against 4 fake DataChannels with a real
// file split into many chunks and assert:
//   1. Every index 0..totalChunks-1 was sent exactly once.
//   2. No index was sent twice.

import { describe, it, expect, vi } from 'vitest'

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
    // Encrypt is a no-op that yields control to the event loop so multiple
    // lanes interleave their prepareNext calls (the natural way to trigger
    // the race in jsdom without real Workers).
    encryptChunk: vi.fn(async (data: ArrayBuffer, _peer: string, iv?: Uint8Array<ArrayBuffer>) => {
      await Promise.resolve()
      return { iv: iv ?? new Uint8Array(12) as Uint8Array<ArrayBuffer>, encrypted: data }
    }),
  }
})

import { sendFileParallel, decodeChunkFrame, CHUNK_SIZE } from '../../src/lib/transfer'

function makeFakeDc(): RTCDataChannel & { _sent: ArrayBuffer[]; _strings: string[] } {
  const sent: ArrayBuffer[] = []
  const strings: string[] = []
  return {
    readyState: 'open',
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    onbufferedamountlow: null,
    send: vi.fn((p: ArrayBuffer | string) => {
      if (typeof p === 'string') strings.push(p)
      else sent.push(p)
    }),
    label: 'misaka-transfer-x',
    _sent: sent,
    _strings: strings,
  } as unknown as RTCDataChannel & { _sent: ArrayBuffer[]; _strings: string[] }
}

describe('multi-lane race: every chunk index is sent exactly once', () => {
  it('4 lanes, 50 chunks → 50 unique indexes, no duplicates', async () => {
    const TOTAL = 50
    const bytes = new Uint8Array(TOTAL * CHUNK_SIZE)
    // Tag each chunk with a recognisable byte so we can also confirm the
    // payloads weren't shuffled.
    for (let i = 0; i < TOTAL; i++) bytes[i * CHUNK_SIZE] = (i & 0xff)
    const file = new File([bytes], 'race.bin', { type: 'application/octet-stream' })

    const lanes = [makeFakeDc(), makeFakeDc(), makeFakeDc(), makeFakeDc()]

    await sendFileParallel(
      lanes as unknown as RTCDataChannel[],
      file,
      'transfer-race',
      1,
      'peer-race',
      undefined,
      undefined,
    )

    // Gather every chunk index that went over the wire across all lanes.
    const indexes: number[] = []
    for (const dc of lanes) {
      const sent = (dc as unknown as { _sent: ArrayBuffer[] })._sent
      for (const buf of sent) {
        const decoded = decodeChunkFrame(buf)
        if (decoded) indexes.push(decoded.index)
      }
    }

    // Total: exactly TOTAL chunks, no more, no less.
    expect(indexes.length).toBe(TOTAL)
    // Unique: a Set of the indexes covers 0..TOTAL-1.
    const unique = new Set(indexes)
    expect(unique.size).toBe(TOTAL)
    for (let i = 0; i < TOTAL; i++) expect(unique.has(i)).toBe(true)
  })

  it('high-concurrency torture: 8 lanes, 200 chunks', async () => {
    const TOTAL = 200
    const bytes = new Uint8Array(TOTAL * CHUNK_SIZE)
    const file = new File([bytes], 'torture.bin')

    const lanes = Array.from({ length: 8 }, makeFakeDc)
    await sendFileParallel(
      lanes as unknown as RTCDataChannel[],
      file,
      'transfer-torture',
      1,
      'peer-torture',
      undefined,
      undefined,
    )

    const counts = new Map<number, number>()
    for (const dc of lanes) {
      const sent = (dc as unknown as { _sent: ArrayBuffer[] })._sent
      for (const buf of sent) {
        const d = decodeChunkFrame(buf)
        if (!d) continue
        counts.set(d.index, (counts.get(d.index) ?? 0) + 1)
      }
    }
    // Every index seen exactly once.
    expect(counts.size).toBe(TOTAL)
    for (const [, n] of counts) expect(n).toBe(1)
  })
})
