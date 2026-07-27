// Protocol version negotiation — the mechanism that lets the P0 delivery-
// semantics group (BUG-013…BUG-017) ship without an old peer and a new peer
// silently disagreeing about what "sent" and "completed" mean.
//
// v1: meta → chunks immediately; "completed" == locally queued; a receiver
//     pause loses in-flight chunks with no repair; no finalization ACK.
// v2: `hello` announces the version; the receiver must ACK `transfer-ready`
//     before payload moves; `transfer-repair` re-queues dropped chunks into
//     the live send task; `transfer-done` is the durable-write ACK.
//
// Both sides run min(mine, theirs), so a v2 client talking to a v1 client
// falls back to v1 wholesale instead of waiting for ACKs that never come.
//
// QUALITY-002 also lives here: the sender's per-chunk `await flushRecord()`
// was an async no-op (there is no sender-side resume-from-IDB path), so the
// send loop must not touch the transfer record once per chunk.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/lib/db', () => ({
  saveTransfer: vi.fn(async () => {}),
  updateTransfer: vi.fn(async () => {}),
  getTransfer: vi.fn(async () => null),
  getActiveTransfers: vi.fn(async () => []),
  saveChunk: vi.fn(async () => {}),
  getChunk: vi.fn(async () => null),
  deleteChunks: vi.fn(async () => {}),
  getSavedChunkIndexes: vi.fn(async () => []),
  pruneTerminalTransfers: vi.fn(async () => 0),
}))

vi.mock('../../src/lib/crypto', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/crypto')>('../../src/lib/crypto')
  return {
    ...actual,
    encryptChunk: vi.fn(async (data: ArrayBuffer) => ({ iv: new Uint8Array(12), encrypted: data })),
    decryptChunk: vi.fn(async (_iv: Uint8Array, encrypted: ArrayBuffer) => encrypted),
    makeChunkIv: vi.fn(async () => new Uint8Array(12)),
    randomIvPrefix: vi.fn(() => new Uint8Array(8)),
  }
})

import {
  PROTOCOL_VERSION, makeHelloMessage,
  setPeerProtocolVersion, getPeerProtocolVersion,
  negotiatedProtocolVersion, clearPeerProtocolVersion,
  sendFileParallel, markReceiverReady, markTransferAcked,
  CHUNK_FRAME_TAG, encodeChunkFrame, decodeChunkFrame,
  CHUNK_SIZE,
} from '../../src/lib/transfer'
import * as db from '../../src/lib/db'

const PEER = 'peer-A'
const OWNER = { peerSessionId: PEER, epoch: 0 }

function makeLane(sink: ArrayBuffer[], control: string[] = []) {
  const listeners: Record<string, Array<() => void>> = {}
  return {
    label: 'misaka-transfer-0',
    readyState: 'open' as RTCDataChannelState,
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    send: (p: string | ArrayBuffer) => {
      if (typeof p === 'string') control.push(p)
      else sink.push(p)
    },
    addEventListener: (t: string, h: () => void) => { (listeners[t] ??= []).push(h) },
    removeEventListener: (t: string, h: () => void) => {
      listeners[t] = (listeners[t] ?? []).filter(x => x !== h)
    },
  } as unknown as RTCDataChannel
}

beforeEach(() => {
  clearPeerProtocolVersion()
  vi.clearAllMocks()
})

describe('protocol version negotiation', () => {
  it('announces the current version in `hello`', () => {
    expect(PROTOCOL_VERSION).toBe(2)
    expect(JSON.parse(makeHelloMessage())).toEqual({ type: 'hello', v: 2 })
  })

  it('treats an unknown / malformed / absent version as v1', () => {
    expect(getPeerProtocolVersion('never-seen')).toBe(1)
    expect(setPeerProtocolVersion('p1', undefined)).toBe(1)
    expect(setPeerProtocolVersion('p2', 'two')).toBe(1)
    expect(setPeerProtocolVersion('p3', 0)).toBe(1)
    expect(setPeerProtocolVersion('p4', 2.5)).toBe(1)
  })

  it('negotiates min(mine, theirs)', () => {
    setPeerProtocolVersion('old', 1)
    setPeerProtocolVersion('new', 2)
    setPeerProtocolVersion('future', 99)
    expect(negotiatedProtocolVersion('old')).toBe(1)
    expect(negotiatedProtocolVersion('new')).toBe(2)
    // A peer claiming a version we don't implement is capped at ours.
    expect(negotiatedProtocolVersion('future')).toBe(PROTOCOL_VERSION)
  })

  it('never downgrades a peer that already proved a higher version', () => {
    setPeerProtocolVersion('p', 2)
    // A stray legacy-shaped message must not strip ACK semantics mid-transfer.
    setPeerProtocolVersion('p', 1)
    expect(getPeerProtocolVersion('p')).toBe(2)
  })

  it('stamps the version onto outbound meta', async () => {
    const control: string[] = []
    const lane = makeLane([], control)
    await sendFileParallel([lane], new File([], 'e.txt'), 'v-meta', 1, PEER, undefined, undefined, undefined, 0)
    const meta = JSON.parse(control[0])
    expect(meta).toMatchObject({ type: 'meta', v: PROTOCOL_VERSION })
  })
})

describe('version-gated delivery semantics', () => {
  it('v2: no payload moves until the receiver ACKs `transfer-ready`', async () => {
    setPeerProtocolVersion(PEER, 2)
    const frames: ArrayBuffer[] = []
    const lane = makeLane(frames)
    const file = new File([new Uint8Array(CHUNK_SIZE * 2)], 'g.bin')
    const sending = sendFileParallel([lane], file, 'gate', 1, PEER, undefined, undefined, undefined, 0)

    await new Promise(r => setTimeout(r, 5))
    expect(frames.length).toBe(0)      // parked on the readiness barrier

    markReceiverReady('gate', OWNER)
    await new Promise(r => setTimeout(r, 20))
    expect(frames.length).toBe(2)

    markTransferAcked('gate', OWNER)
    await expect(sending).resolves.toMatchObject({ state: 'saved' })
  })

  it('v1: payload flows immediately and completion is `delivered`, not `saved`', async () => {
    // No version registered → the peer is v1. It cannot ACK, so waiting for one
    // would hang every legacy transfer forever.
    const frames: ArrayBuffer[] = []
    const lane = makeLane(frames)
    const file = new File([new Uint8Array(CHUNK_SIZE * 2)], 'legacy.bin')
    const outcome = await sendFileParallel(
      [lane], file, 'legacy', 1, PEER, undefined, undefined, undefined, 0,
    )
    expect(frames.length).toBe(2)
    expect(outcome).toEqual({ state: 'delivered', acked: false, legacyPeer: true })
  })
})

describe('the binary chunk frame is UNCHANGED across v1 and v2', () => {
  it('keeps tag 0x01 and the [tag:1][shortId:4][index:4][iv:12][ciphertext] layout', () => {
    expect(CHUNK_FRAME_TAG).toBe(0x01)
    const iv = new Uint8Array(12).fill(7)
    const cipher = new Uint8Array([1, 2, 3, 4]).buffer
    const frame = encodeChunkFrame(0xdeadbeef, 0x01020304, iv, cipher)
    const view = new DataView(frame)
    expect(view.getUint8(0)).toBe(0x01)
    expect(view.getUint32(1, false)).toBe(0xdeadbeef)
    expect(view.getUint32(5, false)).toBe(0x01020304)
    expect(frame.byteLength).toBe(21 + 4)

    const decoded = decodeChunkFrame(frame)!
    expect(decoded.shortId).toBe(0xdeadbeef)
    expect(decoded.index).toBe(0x01020304)
    expect(Array.from(decoded.iv)).toEqual(Array.from(iv))
    expect(Array.from(new Uint8Array(decoded.ciphertext))).toEqual([1, 2, 3, 4])
  })
})

describe('QUALITY-002: no per-chunk record flush', () => {
  it('the sender touches the transfer record once, not once per chunk', async () => {
    const frames: ArrayBuffer[] = []
    const lane = makeLane(frames)
    // 8 chunks: the old code awaited an async no-op `flushRecord()` after each
    // one, paying a Promise + microtask boundary per chunk and implying a
    // sender-side persistence contract that does not exist.
    const file = new File([new Uint8Array(CHUNK_SIZE * 8)], 'q.bin')
    await sendFileParallel([lane], file, 'no-flush', 1, PEER, undefined, undefined, undefined, 0)
    expect(frames.length).toBe(8)
    // Exactly one terminal `status: 'completed'` write — no per-chunk writes.
    const calls = (db.updateTransfer as unknown as { mock: { calls: unknown[][] } }).mock.calls
    expect(calls.length).toBe(1)
    expect(calls[0][1]).toMatchObject({ status: 'completed' })
  })
})
