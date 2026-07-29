// Unit tests for the chunk-index bitmap helpers. The bitmap replaces the
// previous `Set<number>` / sorted `number[]` representation in both the
// hot path and the IDB persistence layer (P1-4) so it has to behave
// EXACTLY the same as the Set semantics on the boundaries:
//   - set/has are O(1) and stable
//   - popcount matches the number of distinct set bits
//   - bitmap ↔ indexes round-trip preserves identity
//   - bitmap → ranges → bitmap round-trip preserves identity
//   - Set → ranges takes the same shape as bitmap → ranges
//
// Random fuzz cases lean on the round-trips so we catch off-by-one
// boundary errors at byte edges (idx=7, 8, 15, 16 …) without enumerating.

import { describe, it, expect } from 'vitest'
import {
  bitmapByteLength,
  newBitmap,
  bitmapSet,
  bitmapHas,
  bitmapPopcount,
  bitmapFromIndexes,
  bitmapToIndexes,
  bitmapToRanges,
  rangesToBitmap,
  setToRanges,
  preferRangesOverIndexes,
  validateAndNormalizeRanges,
  MAX_RANGE_COUNT,
} from '../../src/lib/chunk-bitmap'

describe('chunk-bitmap basics', () => {
  it('byte length rounds up to whole bytes', () => {
    expect(bitmapByteLength(0)).toBe(0)
    expect(bitmapByteLength(1)).toBe(1)
    expect(bitmapByteLength(7)).toBe(1)
    expect(bitmapByteLength(8)).toBe(1)
    expect(bitmapByteLength(9)).toBe(2)
    expect(bitmapByteLength(16)).toBe(2)
    expect(bitmapByteLength(17)).toBe(3)
    expect(bitmapByteLength(1024)).toBe(128)
  })

  it('set/has agree across byte boundaries', () => {
    const b = newBitmap(20)
    expect(bitmapHas(b, 0)).toBe(false)
    expect(bitmapSet(b, 0)).toBe(true)   // 0→1
    expect(bitmapSet(b, 0)).toBe(false)  // already set
    expect(bitmapHas(b, 0)).toBe(true)
    // boundary cases: bit 7 (last of byte 0) and bit 8 (first of byte 1)
    bitmapSet(b, 7)
    bitmapSet(b, 8)
    bitmapSet(b, 15)
    bitmapSet(b, 19)
    expect(bitmapHas(b, 7)).toBe(true)
    expect(bitmapHas(b, 8)).toBe(true)
    expect(bitmapHas(b, 15)).toBe(true)
    expect(bitmapHas(b, 19)).toBe(true)
    expect(bitmapHas(b, 16)).toBe(false)
    expect(bitmapHas(b, 9)).toBe(false)
  })

  it('out-of-range set / has silently no-op', () => {
    const b = newBitmap(10)
    expect(bitmapSet(b, -1)).toBe(false)
    expect(bitmapSet(b, 999)).toBe(false)
    expect(bitmapHas(b, -1)).toBe(false)
    expect(bitmapHas(b, 999)).toBe(false)
  })

  it('popcount matches manual count', () => {
    const b = newBitmap(64)
    for (const i of [0, 1, 2, 7, 8, 31, 63]) bitmapSet(b, i)
    expect(bitmapPopcount(b)).toBe(7)
  })
})

describe('bitmap ↔ index round-trips', () => {
  it('fromIndexes → toIndexes preserves the sorted unique set', () => {
    const indexes = [5, 1, 19, 1, 5, 0, 19, 7, 8]
    const b = bitmapFromIndexes(indexes, 20)
    expect(bitmapToIndexes(b, 20)).toEqual([0, 1, 5, 7, 8, 19])
  })

  it('out-of-range indexes are dropped, not aliased', () => {
    const b = bitmapFromIndexes([5, 100, -1, 8], 10)
    expect(bitmapToIndexes(b, 10)).toEqual([5, 8])
  })

  it('empty bitmap → empty array', () => {
    expect(bitmapToIndexes(newBitmap(100), 100)).toEqual([])
  })

  it('fuzz: seeded PRNG index sets round-trip identically', () => {
    // Mulberry32 — deterministic, seed printed on failure for repro.
    const seed = 0xC0FFEE ^ 0x5EED
    let state = seed >>> 0
    const rand = () => {
      state = (state + 0x6D2B79F5) >>> 0
      let t = state
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }

    const TOTAL = 200
    for (let trial = 0; trial < 50; trial++) {
      const want = new Set<number>()
      const count = Math.floor(rand() * TOTAL)
      for (let k = 0; k < count; k++) {
        want.add(Math.floor(rand() * TOTAL))
      }
      const b = bitmapFromIndexes(want, TOTAL)
      const got = new Set(bitmapToIndexes(b, TOTAL))
      try {
        expect(got.size).toBe(want.size)
        for (const i of want) expect(got.has(i)).toBe(true)
      } catch (err) {
        throw new Error(
          `bitmap fuzz failed (seed=0x${seed.toString(16)}, trial=${trial}): ${(err as Error).message}`,
        )
      }
    }
  })

  it('byte-boundary cases: 7/8, 31/32, trailing padding bits', () => {
    // Last bit of the first byte.
    const b7 = bitmapFromIndexes([7], 16)
    expect(bitmapToIndexes(b7, 16)).toEqual([7])
    expect(bitmapPopcount(b7)).toBe(1)

    // First bit of the second byte.
    const b8 = bitmapFromIndexes([8], 16)
    expect(bitmapToIndexes(b8, 16)).toEqual([8])
    expect(bitmapPopcount(b8)).toBe(1)

    // Last bit of the fourth byte / first of the fifth.
    const b31 = bitmapFromIndexes([31], 40)
    expect(bitmapToIndexes(b31, 40)).toEqual([31])
    const b32 = bitmapFromIndexes([32], 40)
    expect(bitmapToIndexes(b32, 40)).toEqual([32])

    // totalChunks not a multiple of 8 — trailing padding bits must stay clear.
    const bPad = bitmapFromIndexes([0, 1, 6], 7)
    expect(bitmapToIndexes(bPad, 7)).toEqual([0, 1, 6])
    // Setting index 7 would be out of range for total=7.
    const over = bitmapFromIndexes([0, 7], 7)
    expect(bitmapToIndexes(over, 7)).toEqual([0])
  })
})

describe('RLE ranges', () => {
  it('contiguous run produces a single range', () => {
    const b = bitmapFromIndexes([0, 1, 2, 3, 4], 10)
    expect(bitmapToRanges(b, 10)).toEqual([[0, 5]])
  })

  it('multiple gaps produce multiple ranges', () => {
    const b = bitmapFromIndexes([0, 1, 5, 6, 7, 9], 10)
    expect(bitmapToRanges(b, 10)).toEqual([[0, 2], [5, 3], [9, 1]])
  })

  it('empty bitmap → no ranges', () => {
    expect(bitmapToRanges(newBitmap(50), 50)).toEqual([])
  })

  it('range touching the end is included', () => {
    const b = bitmapFromIndexes([7, 8, 9], 10)
    expect(bitmapToRanges(b, 10)).toEqual([[7, 3]])
  })

  it('rangesToBitmap is the exact inverse', () => {
    const original = bitmapFromIndexes([0, 1, 2, 9, 13, 14, 19], 20)
    const ranges = bitmapToRanges(original, 20)
    const rebuilt = rangesToBitmap(ranges, 20)
    expect(bitmapToIndexes(rebuilt, 20)).toEqual(bitmapToIndexes(original, 20))
  })

  it('rangesToBitmap silently clamps oversize ranges', () => {
    const buf = rangesToBitmap([[5, 100]], 10)
    expect(bitmapToIndexes(buf, 10)).toEqual([5, 6, 7, 8, 9])
  })

  it('validateAndNormalizeRanges rejects hostile u32 expansion and over-count floods', () => {
    expect(validateAndNormalizeRanges([[0, 4294967295]], 8)).toEqual([[0, 8]])
    expect(validateAndNormalizeRanges(new Array(MAX_RANGE_COUNT + 1).fill([0, 1]), 16)).toEqual([])
    expect(validateAndNormalizeRanges([[-1, 4], [1.5, 2], ['x', 1]], 10)).toEqual([])
  })

  it('setToRanges agrees with bitmapToRanges', () => {
    const set = new Set([0, 1, 2, 9, 13, 14, 19])
    const fromSet = setToRanges(set, 20)
    const fromBitmap = bitmapToRanges(bitmapFromIndexes(set, 20), 20)
    expect(fromSet).toEqual(fromBitmap)
  })
})

describe('memory cost', () => {
  it('a 1 TB transfer (~16M chunks) fits in ~2 MB', () => {
    const totalChunks = 16_000_000
    const bytes = bitmapByteLength(totalChunks)
    expect(bytes).toBeLessThan(2.1 * 1024 * 1024)
    expect(bytes).toBeGreaterThan(1.9 * 1024 * 1024)
  })
})

describe('preferRangesOverIndexes', () => {
  it('small sets prefer the indexes form', () => {
    expect(preferRangesOverIndexes(0)).toBe(false)
    expect(preferRangesOverIndexes(100)).toBe(false)
    expect(preferRangesOverIndexes(1024)).toBe(false)
  })
  it('large sets prefer RLE ranges', () => {
    expect(preferRangesOverIndexes(1025)).toBe(true)
    expect(preferRangesOverIndexes(1_000_000)).toBe(true)
  })
})
