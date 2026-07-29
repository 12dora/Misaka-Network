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
  markReceiverRejected, applyRepairRequest, getSendTaskInfo,
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
    expect(PROTOCOL_VERSION).toBe(3)
    expect(JSON.parse(makeHelloMessage())).toEqual({ type: 'hello', v: 3 })
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

    const info = getSendTaskInfo('gate')!
    markReceiverReady('gate', info.shortId, OWNER)
    await new Promise(r => setTimeout(r, 20))
    expect(frames.length).toBe(2)

    markTransferAcked('gate', file.size, OWNER)
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

// Frame layout is covered thoroughly by transfer-frame.test.ts. This suite
// owns the JSON control-plane version differences only (05 P3).
describe('JSON control-plane version differences', () => {
  it('v2: transfer-reject ends the wait without ever sending payload', async () => {
    setPeerProtocolVersion(PEER, 2)
    const frames: ArrayBuffer[] = []
    const control: string[] = []
    const lane = makeLane(frames, control)
    const file = new File([new Uint8Array(CHUNK_SIZE)], 'reject.bin')
    const sending = sendFileParallel(
      [lane], file, 'rej', 1, PEER, undefined, undefined, undefined, 0,
    )

    await new Promise(r => setTimeout(r, 5))
    expect(frames.length).toBe(0)
    // `meta.v` announces OUR version, not the negotiated one — the peer is v2
    // here, so negotiation settles on 2 while we still advertise PROTOCOL_VERSION.
    expect(JSON.parse(control[0])).toMatchObject({ type: 'meta', v: PROTOCOL_VERSION })

    expect(markReceiverRejected('rej', OWNER)).toBe(true)
    await expect(sending).rejects.toThrow()
    expect(frames.length).toBe(0)
  })

  it('v2: transfer-repair re-queues into the live send task (not a second engine)', async () => {
    setPeerProtocolVersion(PEER, 2)
    const frames: ArrayBuffer[] = []
    const lane = makeLane(frames)
    const file = new File([new Uint8Array(CHUNK_SIZE * 3)], 'repair.bin')
    const sending = sendFileParallel(
      [lane], file, 'rep', 1, PEER, undefined, undefined, undefined, 0,
    )
    // The shortId is minted inside the engine — sendFileParallel's 4th argument
    // is peerNodeId. A ready ACK carrying any other shortId is rejected, which
    // is the whole point of the attempt check, so read the live one.
    const shortId = getSendTaskInfo('rep')!.shortId
    expect(markReceiverReady('rep', shortId, OWNER)).toBe(true)
    // Let a chunk or two leave so there is a live task to repair into.
    await new Promise(r => setTimeout(r, 20))
    const requeued = applyRepairRequest(
      { transferId: 'rep', missingRanges: [[0, 1]] },
      OWNER,
    )
    // Live task: returns the number of indexes re-queued (≥ 0). -1 would mean
    // "no live task — spawn a second engine", which protocol v2 forbids.
    expect(requeued).toBeGreaterThanOrEqual(0)
    // bytes must equal the declared file size exactly, or the ACK is rejected.
    expect(markTransferAcked('rep', file.size, OWNER)).toBe(true)
    await expect(sending).resolves.toMatchObject({ state: 'saved' })
  })

  it('v1 peer never waits for transfer-ready / transfer-done', async () => {
    // Already covered above as `delivered` + immediate payload; pin the
    // control plane: no ready wait means frames leave without markReceiverReady.
    const frames: ArrayBuffer[] = []
    const control: string[] = []
    const lane = makeLane(frames, control)
    const file = new File([new Uint8Array(8)], 'v1-small.bin')
    const outcome = await sendFileParallel(
      [lane], file, 'v1s', 1, PEER, undefined, undefined, undefined, 0,
    )
    expect(JSON.parse(control[0])).toMatchObject({ type: 'meta', v: PROTOCOL_VERSION })
    expect(frames.length).toBeGreaterThan(0)
    expect(outcome).toEqual({ state: 'delivered', acked: false, legacyPeer: true })
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
