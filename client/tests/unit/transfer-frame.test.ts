// Wire-format and IV-derivation tests for transfer.ts.
//
// The chunk frame layout and the IV construction are the two places where a
// silent off-by-one corrupts every byte after it without any error popping up.
// Symptoms: receiver throws AES-GCM auth-tag failures, or worse, decrypts to
// garbage if the index/IV slip stays self-consistent across sender/receiver
// during the same session but diverges after a restart.
//
// We pin both layers down:
//   1. encodeChunkFrame / decodeChunkFrame: byte layout + round-trip.
//   2. makeChunkIv: 8-byte prefix preserved, 4-byte big-endian index suffix,
//      always 12 bytes total (AES-GCM standard IV length).
//   3. End-to-end: an IV produced by makeChunkIv successfully decrypts what
//      the same IV encrypted under AES-GCM. We use globalThis.crypto.subtle
//      directly instead of encryptChunk(), because encryptChunk dispatches
//      through a Worker pool that does not exist under jsdom — but the
//      cryptographic shape is exactly what the worker does.

import { describe, it, expect } from 'vitest'
import {
  encodeChunkFrame,
  decodeChunkFrame,
  CHUNK_FRAME_TAG,
} from '../../src/lib/transfer'
import { makeChunkIv, randomIvPrefix } from '../../src/lib/crypto'

function bytes(...values: number[]) {
  return new Uint8Array(values)
}

describe('encodeChunkFrame / decodeChunkFrame', () => {
  it('round-trips an empty ciphertext', () => {
    const iv = new Uint8Array(12).fill(0xab)
    const frame = encodeChunkFrame(1, 0, iv, new ArrayBuffer(0))
    const decoded = decodeChunkFrame(frame)
    expect(decoded).not.toBeNull()
    expect(decoded!.shortId).toBe(1)
    expect(decoded!.index).toBe(0)
    expect(Array.from(decoded!.iv)).toEqual(Array.from(iv))
    expect(decoded!.ciphertext.byteLength).toBe(0)
  })

  it('round-trips a real-sized chunk payload', () => {
    const iv = new Uint8Array(12)
    for (let i = 0; i < 12; i++) iv[i] = i * 17 & 0xff
    const ciphertext = new Uint8Array(64 * 1024)
    for (let i = 0; i < ciphertext.length; i++) ciphertext[i] = (i * 31) & 0xff

    const frame = encodeChunkFrame(0xdeadbeef, 12345, iv, ciphertext.buffer)
    const decoded = decodeChunkFrame(frame)

    expect(decoded).not.toBeNull()
    expect(decoded!.shortId).toBe(0xdeadbeef)
    expect(decoded!.index).toBe(12345)
    expect(Array.from(decoded!.iv)).toEqual(Array.from(iv))
    expect(new Uint8Array(decoded!.ciphertext)).toEqual(ciphertext)
  })

  it('writes the byte layout the wire format promises', () => {
    // Pin the layout to fixed bytes so a refactor that rearranges fields
    // gets caught immediately, even if it still round-trips with itself.
    const iv = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    const frame = new Uint8Array(encodeChunkFrame(0x01020304, 0x05060708, iv, bytes(0xaa, 0xbb).buffer))

    expect(frame[0]).toBe(CHUNK_FRAME_TAG)              // tag
    expect(Array.from(frame.slice(1, 5))).toEqual([1, 2, 3, 4])   // shortId BE
    expect(Array.from(frame.slice(5, 9))).toEqual([5, 6, 7, 8])   // index BE
    expect(Array.from(frame.slice(9, 21))).toEqual(Array.from(iv)) // iv
    expect(Array.from(frame.slice(21))).toEqual([0xaa, 0xbb])     // ciphertext
  })

  it('returns null on too-short buffer (cannot contain header)', () => {
    const tooShort = new ArrayBuffer(20)
    expect(decodeChunkFrame(tooShort)).toBeNull()
  })

  it('returns null when the tag byte is wrong (e.g. a stale framing format)', () => {
    const buf = new Uint8Array(25)
    buf[0] = 0x99 // not CHUNK_FRAME_TAG
    expect(decodeChunkFrame(buf.buffer)).toBeNull()
  })
})

describe('makeChunkIv', () => {
  it('produces a 12-byte IV (AES-GCM standard length)', () => {
    const iv = makeChunkIv(randomIvPrefix(), 0)
    expect(iv.byteLength).toBe(12)
  })

  it('copies the first 8 prefix bytes verbatim', () => {
    const prefix = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80])
    const iv = makeChunkIv(prefix, 0)
    expect(Array.from(iv.subarray(0, 8))).toEqual(Array.from(prefix))
  })

  it('encodes the chunk index as big-endian uint32 in bytes 8..12', () => {
    const prefix = new Uint8Array(8)
    const iv = makeChunkIv(prefix, 0x01020304)
    expect(Array.from(iv.subarray(8, 12))).toEqual([0x01, 0x02, 0x03, 0x04])
  })

  it('handles index 0 and the max uint32 correctly', () => {
    const prefix = new Uint8Array(8)
    expect(Array.from(makeChunkIv(prefix, 0).subarray(8, 12))).toEqual([0, 0, 0, 0])
    expect(Array.from(makeChunkIv(prefix, 0xffffffff).subarray(8, 12)))
      .toEqual([0xff, 0xff, 0xff, 0xff])
  })

  it('produces a unique IV for every index under a fixed prefix', () => {
    const prefix = new Uint8Array(8).fill(0x42)
    const seen = new Set<string>()
    for (let i = 0; i < 1000; i++) {
      seen.add(Array.from(makeChunkIv(prefix, i)).join(','))
    }
    expect(seen.size).toBe(1000)
  })

  it('only reads the first 8 bytes of a longer prefix (defensive)', () => {
    // Caller might (incorrectly) pass a 12-byte buffer. We must not let the
    // index bytes overlap with prefix bytes.
    const prefix = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 9])
    const iv = makeChunkIv(prefix, 0x000000ff)
    expect(Array.from(iv.subarray(0, 8))).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(Array.from(iv.subarray(8, 12))).toEqual([0, 0, 0, 0xff])
  })
})

describe('randomIvPrefix', () => {
  it('returns 8 random bytes', () => {
    expect(randomIvPrefix().byteLength).toBe(8)
  })

  it('is non-deterministic (1000 draws should not all collide)', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 1000; i++) seen.add(Array.from(randomIvPrefix()).join(','))
    expect(seen.size).toBeGreaterThan(990)
  })
})

// ── End-to-end: AES-GCM round-trip with the real IV construction ────
//
// encryptChunk()/decryptChunk() in src/lib/crypto.ts go through a Worker
// pool that jsdom does not provide. The cryptographic operation those
// workers perform is plain crypto.subtle.encrypt/decrypt against the AES
// key, with the same IV bytes makeChunkIv produces. Exercising that
// directly catches IV-shape bugs without needing the worker plumbing.

describe('AES-GCM round-trip with makeChunkIv', () => {
  async function deriveKey() {
    return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  }

  it('encrypts then decrypts each chunk under its derived IV', async () => {
    const key = await deriveKey()
    const prefix = randomIvPrefix()

    const plaintexts = [
      new TextEncoder().encode('first chunk').buffer,
      new TextEncoder().encode('second chunk has different content').buffer,
      new Uint8Array(1024).fill(0xa5).buffer,
    ]

    for (let i = 0; i < plaintexts.length; i++) {
      const iv = makeChunkIv(prefix, i)
      const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintexts[i])
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct)
      expect(new Uint8Array(pt)).toEqual(new Uint8Array(plaintexts[i]))
    }
  })

  it('refuses to decrypt with a wrong-index IV (auth tag fails)', async () => {
    const key = await deriveKey()
    const prefix = randomIvPrefix()
    const pt = new TextEncoder().encode('chunk #5').buffer
    const ivCorrect = makeChunkIv(prefix, 5)
    const ivWrong = makeChunkIv(prefix, 6)

    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ivCorrect }, key, pt)
    await expect(crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivWrong }, key, ct))
      .rejects.toThrow()
  })

  it('survives a full encode → wire → decode → decrypt loop', async () => {
    // This is the contract the receiver runs on every chunk. If the frame
    // layout, makeChunkIv math, or AES-GCM expectations drift apart, this
    // test goes red even if the unit-level pieces still look fine.
    const key = await deriveKey()
    const prefix = randomIvPrefix()
    const shortId = 0xcafebabe
    const index = 42
    const plaintext = new TextEncoder().encode('roundtrip payload').buffer

    const iv = makeChunkIv(prefix, index)
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext)
    const frame = encodeChunkFrame(shortId, index, iv, ciphertext)

    const decoded = decodeChunkFrame(frame)
    expect(decoded).not.toBeNull()
    expect(decoded!.shortId).toBe(shortId)
    expect(decoded!.index).toBe(index)

    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: decoded!.iv },
      key,
      decoded!.ciphertext,
    )
    expect(new Uint8Array(pt)).toEqual(new Uint8Array(plaintext))
  })
})
