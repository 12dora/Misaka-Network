// P1-9: `makeChunkIv` mixes the transferId into the IV prefix so two
// transfers that (cosmically unlikely but possible) get the same random
// 8-byte prefix don't end up producing the same IV for a given chunk
// index. The hash domain-separates the prefix per (key, transfer) so
// IV reuse becomes impossible across distinct transferIds.
//
// We assert:
//   1. Same ivPrefix + same index but DIFFERENT transferId → DIFFERENT IV.
//   2. The new function still returns 12 bytes and the trailing 4-byte
//      index suffix is unchanged big-endian (existing wire contract).
//   3. The legacy 2-arg call still works (deprecated wrapper for
//      backwards compat with any out-of-tree caller).

import { describe, it, expect } from 'vitest'
import { makeChunkIv, randomIvPrefix } from '../../src/lib/crypto'

describe('makeChunkIv: transferId domain separation (P1-9)', () => {
  it('different transferId → different IV under same prefix+index', async () => {
    const prefix = new Uint8Array(8).fill(0x42)
    const iv1 = await makeChunkIv(prefix, 5, 'transfer-a')
    const iv2 = await makeChunkIv(prefix, 5, 'transfer-b')
    expect(iv1.byteLength).toBe(12)
    expect(iv2.byteLength).toBe(12)
    expect(Array.from(iv1)).not.toEqual(Array.from(iv2))
  })

  it('same transferId → same IV (deterministic)', async () => {
    const prefix = new Uint8Array(8).fill(0xab)
    const iv1 = await makeChunkIv(prefix, 7, 'stable')
    const iv2 = await makeChunkIv(prefix, 7, 'stable')
    expect(Array.from(iv1)).toEqual(Array.from(iv2))
  })

  it('preserves the BE-uint32 index in bytes 8..12 (wire contract)', async () => {
    const prefix = new Uint8Array(8)
    const iv = await makeChunkIv(prefix, 0x01020304, 'whatever')
    expect(Array.from(iv.subarray(8, 12))).toEqual([0x01, 0x02, 0x03, 0x04])
  })

  it('produces unique IV across 1000 indexes (per fixed transferId)', async () => {
    const prefix = randomIvPrefix()
    const seen = new Set<string>()
    for (let i = 0; i < 1000; i++) {
      const iv = await makeChunkIv(prefix, i, 'bulk-test')
      seen.add(Array.from(iv).join(','))
    }
    expect(seen.size).toBe(1000)
  })

  it('legacy 2-arg call still returns a valid 12-byte IV (deprecated path)', () => {
    // Existing callers that pre-date the 3-arg signature should keep
    // working — the wrapper falls back to "no domain separation".
    const prefix = new Uint8Array(8).fill(0x33)
    // Sync return — legacy code never awaited.
    const iv = makeChunkIv(prefix, 1) as Uint8Array
    expect(iv.byteLength).toBe(12)
    expect(Array.from(iv.subarray(0, 8))).toEqual(Array.from(prefix))
  })
})
