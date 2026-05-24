// ── Chunk-index bitmap ────────────────────────────────────────────────
// Fixed-size bit-array for tracking which chunks of a transfer have been
// received (or sent). Replaces `Set<number>` / sorted `number[]` in the
// hot path so:
//
//   - In-memory cost is O(totalChunks/8) instead of ~50 B per chunk.
//     A 1 TB transfer (~16M chunks at 64 KB) goes from ~800 MB Set to
//     ~2 MB Uint8Array.
//
//   - Persistence cost is O(totalChunks/8) bytes per `updateTransfer` call
//     instead of a freshly serialised JSON array of every received index.
//     A 10 GB transfer used to write ~1 MB of JSON every TRANSFER_RECORD_
//     INTERVAL_MS; the bitmap is ~20 KB.
//
//   - Wire-format compactness for resume requests: we send RLE ranges
//     (one [start, length] pair per contiguous run), which is typically
//     ≤ a few hundred bytes even for in-progress resumes after many
//     thousand chunks.
//
// All functions here are pure and side-effect-free so they're trivially
// unit-testable without jsdom.

/** Bytes needed to store `totalChunks` bits (rounded up). */
export function bitmapByteLength(totalChunks: number): number {
  if (totalChunks <= 0) return 0
  return (totalChunks + 7) >>> 3
}

/** Allocate an empty bitmap sized for `totalChunks` bits. Always backed
 *  by a regular ArrayBuffer (not SharedArrayBuffer) so it round-trips
 *  through structured clone into IDB without TS variance complaints. */
export function newBitmap(totalChunks: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new ArrayBuffer(bitmapByteLength(totalChunks)))
}

/**
 * Set bit `idx`. Returns true if the bit transitioned 0→1 (caller can
 * use this to maintain an O(1) popcount). Bounds check silently no-ops
 * out-of-range indexes so callers don't have to (the caller side already
 * has `idx < totalChunks` invariants from the chunk-frame decoder).
 */
export function bitmapSet(buf: Uint8Array, idx: number): boolean {
  if (idx < 0) return false
  const byte = idx >>> 3
  if (byte >= buf.length) return false
  const mask = 1 << (idx & 7)
  if ((buf[byte] & mask) !== 0) return false
  buf[byte] |= mask
  return true
}

/** Read bit `idx`. */
export function bitmapHas(buf: Uint8Array, idx: number): boolean {
  if (idx < 0) return false
  const byte = idx >>> 3
  if (byte >= buf.length) return false
  return (buf[byte] & (1 << (idx & 7))) !== 0
}

/** Count set bits. O(n) over the buffer — not in the hot path; call
 *  sparingly (e.g. one-shot when migrating a legacy record). The receive
 *  hot path maintains its own counter alongside the bitmap. */
export function bitmapPopcount(buf: Uint8Array): number {
  let n = 0
  for (let i = 0; i < buf.length; i++) {
    let v = buf[i]
    v = v - ((v >> 1) & 0x55)
    v = (v & 0x33) + ((v >> 2) & 0x33)
    n += ((v + (v >> 4)) & 0x0f)
  }
  return n
}

/**
 * Build a bitmap from an arbitrary iterable of indexes (used for migrating
 * legacy `receivedChunks: number[]` records and for parsing wire-format
 * `receivedChunks` from older peers). `totalChunks` caps the bit space —
 * indexes >= totalChunks are dropped silently.
 */
export function bitmapFromIndexes(
  indexes: Iterable<number>,
  totalChunks: number,
): Uint8Array<ArrayBuffer> {
  const buf = newBitmap(totalChunks)
  for (const idx of indexes) bitmapSet(buf, idx)
  return buf
}

/**
 * Decode a bitmap into a sorted, deduped index array. ONLY use when you
 * actually need the array (e.g. legacy wire-format for resume, or a debug
 * dump). Allocates O(popcount) numbers; for huge transfers this is the
 * point you'd normally OOM, so prefer `bitmapToRanges` when possible.
 */
export function bitmapToIndexes(buf: Uint8Array, totalChunks: number): number[] {
  const out: number[] = []
  const max = Math.min(totalChunks, buf.length * 8)
  for (let byte = 0; byte < buf.length; byte++) {
    const v = buf[byte]
    if (v === 0) continue
    const base = byte * 8
    for (let bit = 0; bit < 8; bit++) {
      if (base + bit >= max) break
      if ((v & (1 << bit)) !== 0) out.push(base + bit)
    }
  }
  return out
}

/**
 * RLE-encode a bitmap as `[start, length]` runs. For in-order receive
 * (the common case) this collapses to a tiny number of entries — even
 * after a partial transfer with thousands of contiguous chunks, this is
 * typically a single pair.
 *
 * Wire format chosen so it's directly JSON-serializable as
 * `number[][]` and round-trips through JSON.parse without re-shaping.
 */
export function bitmapToRanges(buf: Uint8Array, totalChunks: number): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  const max = Math.min(totalChunks, buf.length * 8)
  let runStart = -1
  for (let idx = 0; idx < max; idx++) {
    const byte = idx >>> 3
    const set = (buf[byte] & (1 << (idx & 7))) !== 0
    if (set && runStart < 0) {
      runStart = idx
    } else if (!set && runStart >= 0) {
      ranges.push([runStart, idx - runStart])
      runStart = -1
    }
  }
  if (runStart >= 0) ranges.push([runStart, max - runStart])
  return ranges
}

/** Inverse of `bitmapToRanges`: rebuild bitmap from runs. */
export function rangesToBitmap(
  ranges: ReadonlyArray<readonly [number, number]>,
  totalChunks: number,
): Uint8Array<ArrayBuffer> {
  const buf = newBitmap(totalChunks)
  for (const [start, length] of ranges) {
    const end = Math.min(start + length, totalChunks)
    for (let i = Math.max(0, start); i < end; i++) bitmapSet(buf, i)
  }
  return buf
}

/**
 * Same shape as `bitmapToRanges` but takes a Set<number> directly — used
 * during transition where in-memory state is still a Set and we want the
 * cheapest wire encoding on send.
 */
export function setToRanges(set: ReadonlySet<number>, totalChunks: number): Array<[number, number]> {
  if (set.size === 0) return []
  const sorted = Array.from(set).filter(i => i >= 0 && i < totalChunks).sort((a, b) => a - b)
  if (sorted.length === 0) return []
  const ranges: Array<[number, number]> = []
  let runStart = sorted[0]
  let prev = sorted[0]
  for (let i = 1; i < sorted.length; i++) {
    const v = sorted[i]
    if (v === prev + 1) {
      prev = v
      continue
    }
    ranges.push([runStart, prev - runStart + 1])
    runStart = v
    prev = v
  }
  ranges.push([runStart, prev - runStart + 1])
  return ranges
}

/** Decision helper: should this transfer's resume payload prefer RLE
 *  ranges over a flat index array? RLE is always at least as compact for
 *  in-order receives, and a few-KB threshold means small transfers stay
 *  on the chatty legacy format that's easier to debug. */
export function preferRangesOverIndexes(setSize: number): boolean {
  return setSize > 1024
}
