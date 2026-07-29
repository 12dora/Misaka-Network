// Characterization suite for the Wave 4a mechanical split of transfer.ts.
//
// These tests pin the hard contracts AS THEY BEHAVE RIGHT NOW. If the split
// changes behaviour, they must fail. Do not "fix" contracts here — especially
// the 3-arg makeChunkIv SHA-256 domain separation (deliberate anti-reuse).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/lib/db', () => {
  const chunks = new Map<string, Map<number, ArrayBuffer>>()
  const records = new Map<string, any>()
  return {
    saveTransfer: vi.fn(async (rec: any) => { records.set(rec.transferId, rec) }),
    updateTransfer: vi.fn(async (id: string, patch: any) => {
      const cur = records.get(id)
      if (cur) records.set(id, { ...cur, ...patch })
    }),
    getTransfer: vi.fn(async (id: string) => records.get(id) ?? null),
    getActiveTransfers: vi.fn(async () => []),
    deleteTransfer: vi.fn(async (id: string) => { records.delete(id) }),
    saveChunk: vi.fn(async (id: string, idx: number, data: ArrayBuffer) => {
      let m = chunks.get(id); if (!m) { m = new Map(); chunks.set(id, m) }
      m.set(idx, data)
    }),
    getChunk: vi.fn(async (id: string, idx: number) => chunks.get(id)?.get(idx) ?? null),
    deleteChunks: vi.fn(async (id: string) => { chunks.delete(id) }),
    getSavedChunkIndexes: vi.fn(async () => []),
    pruneTerminalTransfers: vi.fn(async () => 0),
    __chunks: chunks,
    __records: records,
  }
})

const peerKeys = new Map<string, CryptoKey>()
async function ensurePeerKey(peerSessionId: string): Promise<CryptoKey> {
  let key = peerKeys.get(peerSessionId)
  if (!key) {
    key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    peerKeys.set(peerSessionId, key)
  }
  return key
}

vi.mock('../../src/lib/crypto', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/crypto')>('../../src/lib/crypto')
  return {
    ...actual,
    encryptChunk: vi.fn(async (
      data: ArrayBuffer,
      peerSessionId: string,
      iv?: Uint8Array,
      additionalData?: Uint8Array,
    ) => {
      const key = await ensurePeerKey(peerSessionId)
      const actualIv = iv ?? crypto.getRandomValues(new Uint8Array(12))
      const params: AesGcmParams = { name: 'AES-GCM', iv: actualIv as BufferSource }
      if (additionalData && additionalData.byteLength > 0) {
        params.additionalData = additionalData as BufferSource
      }
      const encrypted = await crypto.subtle.encrypt(params, key, data)
      return { iv: actualIv as Uint8Array<ArrayBuffer>, encrypted }
    }),
    decryptChunk: vi.fn(async (
      iv: Uint8Array,
      encrypted: ArrayBuffer,
      peerSessionId: string,
      additionalData?: Uint8Array,
    ) => {
      const key = await ensurePeerKey(peerSessionId)
      const params: AesGcmParams = { name: 'AES-GCM', iv: iv as BufferSource }
      if (additionalData && additionalData.byteLength > 0) {
        params.additionalData = additionalData as BufferSource
      }
      return crypto.subtle.decrypt(params, key, encrypted)
    }),
  }
})

import {
  CHUNK_FRAME_TAG,
  CHUNK_FRAME_HEADER_BYTES,
  encodeChunkFrame,
  decodeChunkFrame,
  PROTOCOL_VERSION,
  AAD_PROTOCOL_VERSION,
  setPeerProtocolVersion,
  getPeerProtocolVersion,
  negotiatedProtocolVersion,
  clearPeerProtocolVersion,
  makeHelloMessage,
  validateMetaMessage,
  validateAndNormalizeRanges,
  assertTransferOwner,
  registerTransferOwner,
  clearTransferOwner,
  sendFileParallel,
  markReceiverReady,
  markTransferAcked,
  getSendTaskInfo,
  handleMetaMessage,
  receiveChunk,
  finalizeReceive,
  abortInboundTransfer,
  getReceiveSession,
  cancelReceive,
  forgetTransfer,
  CHUNK_SIZE,
  type MetaMessage,
} from '../../src/lib/transfer'
import { makeChunkIv, chunkAad } from '../../src/lib/crypto'
import * as db from '../../src/lib/db'

const PEER = 'peer-char'
const OWNER = { peerSessionId: PEER, epoch: 0 }

function makeLane(frames: ArrayBuffer[] = [], control: string[] = []) {
  const listeners: Record<string, Array<() => void>> = {}
  return {
    label: 'misaka-transfer-0',
    readyState: 'open' as RTCDataChannelState,
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    send: (p: string | ArrayBuffer) => {
      if (typeof p === 'string') control.push(p)
      else frames.push(p as ArrayBuffer)
    },
    addEventListener: (t: string, h: () => void) => { (listeners[t] ??= []).push(h) },
    removeEventListener: (t: string, h: () => void) => {
      listeners[t] = (listeners[t] ?? []).filter(x => x !== h)
    },
  } as unknown as RTCDataChannel
}

function makeMeta(partial: Partial<MetaMessage> & Pick<MetaMessage, 'transferId' | 'shortId' | 'fileSize' | 'totalChunks'>): MetaMessage {
  return {
    type: 'meta',
    fileName: partial.fileName ?? 'f.bin',
    fileHash: '',
    mime: 'application/octet-stream',
    v: partial.v,
    ...partial,
  }
}

beforeEach(() => {
  clearPeerProtocolVersion()
  peerKeys.clear()
  vi.clearAllMocks()
  ;(db as any).__chunks.clear()
  ;(db as any).__records.clear()
  // Drop leftover session/owner state from prior cases (module-global maps).
  for (const id of [
    'char-v1', 'char-v2', 'char-aad-reroute', 'own-1', 'char-order',
    'char-fin', 'char-abort', 'char-cancel', 'never-registered',
  ]) {
    forgetTransfer(id)
  }
})

// ── Frame codec ──────────────────────────────────────────────────────

describe('characterization: CHUNK_FRAME_TAG + layout', () => {
  it('tag is 0x01 and header is 21 bytes', () => {
    expect(CHUNK_FRAME_TAG).toBe(0x01)
    expect(CHUNK_FRAME_HEADER_BYTES).toBe(21)
  })

  it('encode/decode round-trip preserves shortId, index, iv, ciphertext', () => {
    const iv = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    const cipher = new Uint8Array([0xaa, 0xbb, 0xcc]).buffer
    const frame = encodeChunkFrame(0x01020304, 0x05060708, iv, cipher)
    const d = decodeChunkFrame(frame)!
    expect(d.shortId).toBe(0x01020304)
    expect(d.index).toBe(0x05060708)
    expect(Array.from(d.iv)).toEqual(Array.from(iv))
    expect(Array.from(new Uint8Array(d.ciphertext))).toEqual([0xaa, 0xbb, 0xcc])
  })

  it('writes exact [tag:1][shortId:4][index:4][iv:12][ciphertext] layout', () => {
    const iv = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    const frame = new Uint8Array(encodeChunkFrame(0x01020304, 0x05060708, iv, new Uint8Array([0xaa, 0xbb]).buffer))
    expect(frame[0]).toBe(0x01)
    expect(Array.from(frame.slice(1, 5))).toEqual([1, 2, 3, 4])
    expect(Array.from(frame.slice(5, 9))).toEqual([5, 6, 7, 8])
    expect(Array.from(frame.slice(9, 21))).toEqual(Array.from(iv))
    expect(Array.from(frame.slice(21))).toEqual([0xaa, 0xbb])
  })

  it('returns null on short frames and wrong tag', () => {
    expect(decodeChunkFrame(new ArrayBuffer(20))).toBeNull()
    const bad = new Uint8Array(25)
    bad[0] = 0x99
    expect(decodeChunkFrame(bad.buffer)).toBeNull()
  })
})

// ── makeChunkIv golden bytes ─────────────────────────────────────────

describe('characterization: makeChunkIv exact bytes (do not "fix")', () => {
  const PREFIX = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
  const INDEX = 0x0000002a
  const TID = 'char-test-xfer'

  it('legacy 2-arg: prefix || BE32(index) — exact bytes', () => {
    const iv = makeChunkIv(PREFIX, INDEX) as Uint8Array
    expect(Array.from(iv)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 0, 0, 0, 42])
  })

  it('3-arg SHA-256 domain path: exact golden output (anti-reuse is deliberate)', async () => {
    // Golden: SHA-256(prefix[0..8) || UTF-8(transferId))[0..8) || BE32(index)
    // Computed independently; if this fails after a "cleanup", REVERT — do not
    // update the expected bytes without a protocol version bump.
    const iv = await makeChunkIv(PREFIX, INDEX, TID)
    expect(Array.from(iv)).toEqual([
      147, 130, 164, 68, 138, 12, 119, 221, 0, 0, 0, 42,
    ])
  })

  it('same prefix+index, different transferId → different IV', async () => {
    const a = await makeChunkIv(PREFIX, INDEX, 'transfer-a')
    const b = await makeChunkIv(PREFIX, INDEX, 'transfer-b')
    expect(Array.from(a)).not.toEqual(Array.from(b))
    // Index suffix still BE
    expect(Array.from(a.subarray(8, 12))).toEqual([0, 0, 0, 42])
    expect(Array.from(b.subarray(8, 12))).toEqual([0, 0, 0, 42])
  })
})

// ── Protocol version ─────────────────────────────────────────────────

describe('characterization: protocol version negotiation', () => {
  it('hello announces PROTOCOL_VERSION=3; AAD_PROTOCOL_VERSION=3', () => {
    expect(PROTOCOL_VERSION).toBe(3)
    expect(AAD_PROTOCOL_VERSION).toBe(3)
    expect(JSON.parse(makeHelloMessage())).toEqual({ type: 'hello', v: 3 })
  })

  it('absent/unknown ⇒ v1; min(mine, theirs)', () => {
    expect(getPeerProtocolVersion('never')).toBe(1)
    expect(setPeerProtocolVersion('p', undefined)).toBe(1)
    expect(setPeerProtocolVersion('p', 'nope')).toBe(1)
    setPeerProtocolVersion('old', 1)
    setPeerProtocolVersion('mid', 2)
    setPeerProtocolVersion('future', 99)
    expect(negotiatedProtocolVersion('old')).toBe(1)
    expect(negotiatedProtocolVersion('mid')).toBe(2)
    expect(negotiatedProtocolVersion('future')).toBe(PROTOCOL_VERSION)
  })

  it('v1 tops out at delivered; v2+ can reach saved after transfer-done', async () => {
    // v1
    const frames1: ArrayBuffer[] = []
    const file1 = new File([new Uint8Array(CHUNK_SIZE)], 'v1.bin')
    const out1 = await sendFileParallel([makeLane(frames1)], file1, 'char-v1', 1, PEER, undefined, undefined, undefined, 0)
    expect(out1).toEqual({ state: 'delivered', acked: false, legacyPeer: true })

    // v2 + transfer-done
    setPeerProtocolVersion(PEER, 2)
    const frames2: ArrayBuffer[] = []
    const file2 = new File([new Uint8Array(CHUNK_SIZE)], 'v2.bin')
    const sending = sendFileParallel([makeLane(frames2)], file2, 'char-v2', 1, PEER, undefined, undefined, undefined, 0)
    await new Promise(r => setTimeout(r, 5))
    const info = getSendTaskInfo('char-v2')!
    markReceiverReady('char-v2', info.shortId, OWNER)
    await new Promise(r => setTimeout(r, 20))
    expect(markTransferAcked('char-v2', file2.size, OWNER)).toBe(true)
    await expect(sending).resolves.toMatchObject({ state: 'saved', acked: true })
  })
})

// ── v3 AAD ───────────────────────────────────────────────────────────

describe('characterization: v3 AAD exact bytes + re-route fails auth', () => {
  it('chunkAad exact field layout', () => {
    const tid = 'tid-exact'
    const a = chunkAad(3, tid, 7, 3, 100)
    const view = new DataView(a.buffer)
    expect(view.getUint32(0, false)).toBe(3)
    expect(view.getUint32(4, false)).toBe(tid.length)
    expect(new TextDecoder().decode(a.subarray(8, 8 + tid.length))).toBe(tid)
    const o = 8 + tid.length
    expect(view.getUint32(o, false)).toBe(7)
    expect(view.getUint32(o + 4, false)).toBe(3)
    expect(view.getUint32(o + 8, false)).toBe(100)
  })

  it('ciphertext moved to another index fails authentication', async () => {
    setPeerProtocolVersion(PEER, 3)
    const transferId = 'char-aad-reroute'
    const shortId = 42
    const plain = new Uint8Array(CHUNK_SIZE).fill(0x11)
    const { encryptChunk } = await import('../../src/lib/crypto')
    const aad0 = chunkAad(3, transferId, shortId, 0, CHUNK_SIZE)
    const enc0 = await encryptChunk(plain.buffer, PEER, makeChunkIv(new Uint8Array(8).fill(1), 0) as Uint8Array<ArrayBuffer>, aad0)
    await handleMetaMessage(
      makeMeta({ transferId, shortId, fileSize: CHUNK_SIZE * 2, totalChunks: 2, v: 3 }),
      1, OWNER,
    )
    const session = getReceiveSession(transferId)!
    session.backend = 'idb'
    session.storageMode = 'indexeddb'
    await expect(receiveChunk(transferId, 1, enc0.iv, enc0.encrypted, PEER)).rejects.toThrow()
  })
})

// ── Ownership ────────────────────────────────────────────────────────

describe('characterization: ownership (peerSessionId, epoch)', () => {
  it('unknown transferId ⇒ assertTransferOwner returns false', () => {
    expect(assertTransferOwner('never-registered', OWNER)).toBe(false)
  })

  it('matches only (peerSessionId, epoch), never nodeId alone', () => {
    registerTransferOwner('own-1', {
      peerSessionId: PEER, epoch: 3, direction: 'send',
      fileName: 'a.bin', fileSize: 1, totalChunks: 1,
    })
    expect(assertTransferOwner('own-1', { peerSessionId: PEER, epoch: 3 })).toBe(true)
    expect(assertTransferOwner('own-1', { peerSessionId: PEER, epoch: 0 })).toBe(false)
    expect(assertTransferOwner('own-1', { peerSessionId: 'other', epoch: 3 })).toBe(false)
    clearTransferOwner('own-1')
  })
})

// ── validateMetaMessage + ranges ─────────────────────────────────────

describe('characterization: validateMetaMessage + validateAndNormalizeRanges', () => {
  it('rejects geometry that disagrees with ceil(fileSize/CHUNK_SIZE)', () => {
    const r = validateMetaMessage({
      type: 'meta', transferId: 'geom', shortId: 1, fileName: 'a.bin',
      fileSize: 1024, fileHash: '', totalChunks: 400_000_000,
      mime: 'application/octet-stream',
    })
    expect(r).toMatchObject({ ok: false, code: 'bad-chunk-count' })
  })

  it('clamps hostile u32 ranges to totalChunks', () => {
    expect(validateAndNormalizeRanges([[0, 4294967295]], 64)).toEqual([[0, 64]])
    expect(validateAndNormalizeRanges([[-1, 4], [1.5, 2]], 10)).toEqual([])
  })
})

// ── Receive order + terminal APIs ────────────────────────────────────

async function encryptForPeer(plain: Uint8Array, peerSessionId: string) {
  const { encryptChunk } = await import('../../src/lib/crypto')
  const iv = new Uint8Array(12).fill(3) as Uint8Array<ArrayBuffer>
  const buf = plain.buffer.slice(plain.byteOffset, plain.byteOffset + plain.byteLength) as ArrayBuffer
  return encryptChunk(buf, peerSessionId, iv)
}

describe('characterization: fixed receive order + terminal APIs', () => {
  it('durable write precedes bitmap persist (decrypt → write → bitmap → persist → progress)', async () => {
    const order: string[] = []
    const id = 'char-order'
    const meta = makeMeta({ transferId: id, shortId: 1, fileSize: CHUNK_SIZE, totalChunks: 1 })
    await handleMetaMessage(meta, 1, OWNER)
    // Force IDB so we don't open FSA/OPFS in unit tests.
    const session = getReceiveSession(id)!
    session.backend = 'idb'
    session.storageMode = 'indexeddb'
    session.preparedResult = { ok: true, mode: 'idb' }

    const saveChunkSpy = db.saveChunk as unknown as { mockImplementation: (f: unknown) => void }
    const updateSpy = db.updateTransfer as unknown as { mockImplementation: (f: unknown) => void }
    const chunks = (db as any).__chunks as Map<string, Map<number, ArrayBuffer>>
    const records = (db as any).__records as Map<string, any>
    saveChunkSpy.mockImplementation(async (tid: string, idx: number, data: ArrayBuffer) => {
      order.push('durable-write')
      let m = chunks.get(tid); if (!m) { m = new Map(); chunks.set(tid, m) }
      m.set(idx, data)
    })
    updateSpy.mockImplementation(async (tid: string, patch: any) => {
      if (patch.receivedBitmap) order.push('persist-bitmap')
      const cur = records.get(tid)
      if (cur) records.set(tid, { ...cur, ...patch })
    })

    const plain = new Uint8Array(CHUNK_SIZE).fill(7)
    const enc = await encryptForPeer(plain, PEER)
    await receiveChunk(id, 0, enc.iv, enc.encrypted, PEER)
    expect(order.indexOf('durable-write')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('persist-bitmap')).toBeGreaterThan(order.indexOf('durable-write'))
  })

  it('finalizeReceive is the single successful terminal API (IDB path)', async () => {
    const id = 'char-fin'
    const meta = makeMeta({ transferId: id, shortId: 1, fileSize: CHUNK_SIZE, totalChunks: 1 })
    await handleMetaMessage(meta, 1, OWNER)
    const session = getReceiveSession(id)!
    session.backend = 'idb'
    session.storageMode = 'indexeddb'
    session.preparedResult = { ok: true, mode: 'idb' }
    const plain = new Uint8Array(CHUNK_SIZE).fill(9)
    const enc = await encryptForPeer(plain, PEER)
    await receiveChunk(id, 0, enc.iv, enc.encrypted, PEER)
    const result = await finalizeReceive(id)
    expect(result.backend).toBe('idb')
    expect(result.bytes).toBe(CHUNK_SIZE)
    expect(getReceiveSession(id)).toBeUndefined()
  })

  it('abortInboundTransfer / cancelReceive is the single abnormal terminal API', async () => {
    const id = 'char-abort'
    const meta = makeMeta({ transferId: id, shortId: 1, fileSize: CHUNK_SIZE, totalChunks: 1 })
    await handleMetaMessage(meta, 1, OWNER)
    expect(getReceiveSession(id)).toBeTruthy()
    await abortInboundTransfer(id, 'char-test')
    expect(getReceiveSession(id)).toBeUndefined()

    // cancelReceive is a thin alias of abortInboundTransfer
    await handleMetaMessage(
      makeMeta({ transferId: 'char-cancel', shortId: 2, fileSize: CHUNK_SIZE, totalChunks: 1 }),
      1, OWNER,
    )
    await cancelReceive('char-cancel')
    expect(getReceiveSession('char-cancel')).toBeUndefined()
  })
})
