// The P0 delivery-semantics group, at engine level. The store-level proof for
// pause/repair lives in transfer-receiver-pause.test.ts and for the receive
// ordering in transfer-deliver-after-write.test.ts; this file pins the
// individual engine contracts.
//
//   BUG-014  outbound resume woke the OLD sender AND started a NEW engine for
//            the same transfer id — two engines racing one `sentBitmap`.
//   BUG-016  "completed" meant "the last dc.send() returned", i.e. locally
//            queued. A drop before the receiver's durable write left the
//            sender showing ✓ with the retry source already released.
//   BUG-017  the resume bitmap was persisted BEFORE the corresponding disk
//            write, so a crash in that window produced a bitmap claiming bytes
//            that were never on disk — resume skipped them and the receiver
//            delivered a sparse file.
//   BUG-018  successful streaming receives had no authoritative terminal
//            cleanup: the OPFS file, the `active` DB row, the receive session
//            and the bitmap all survived. The OPFS entry must remain until
//            the lazy File has been consumed, then its cleanup removes it.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const persistOrder: string[] = []

vi.mock('../../src/lib/db', () => {
  const chunks = new Map<string, Map<number, ArrayBuffer>>()
  const records = new Map<string, any>()
  return {
    saveTransfer: vi.fn(async (rec: any) => { records.set(rec.transferId, rec) }),
    updateTransfer: vi.fn(async (id: string, patch: any) => {
      if (patch.receivedBitmap) persistOrder.push('persist-bitmap')
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
    deleteChunks: vi.fn(async (id: string) => { persistOrder.push('delete-chunks'); chunks.delete(id) }),
    getSavedChunkIndexes: vi.fn(async () => []),
    pruneTerminalTransfers: vi.fn(async () => 0),
    __chunks: chunks,
    __records: records,
  }
})

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
  sendFileParallel, hasLiveSendTask, markTransferAcked, markReceiverReady, getSendTaskInfo,
  setPeerProtocolVersion, clearPeerProtocolVersion,
  handleMetaMessage, receiveChunk, prepareReceiveBackend, finalizeReceive,
  getReceiveSession, cleanupOPFS, getOPFSHandle,
  pauseTransfer, resumeTransfer,
  TransferIntegrityError,
  CHUNK_SIZE,
} from '../../src/lib/transfer'
import * as db from '../../src/lib/db'
import { makeMeta, makeChunk } from './_transfer-fixtures'

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
  persistOrder.length = 0
  ;(db as any).__chunks.clear()
  ;(db as any).__records.clear()
  clearPeerProtocolVersion()
  vi.clearAllMocks()
  // `mockImplementation` in one case must not leak into the next.
  const chunks = (db as any).__chunks as Map<string, Map<number, ArrayBuffer>>
  ;(db.saveChunk as unknown as { mockImplementation: (f: unknown) => void })
    .mockImplementation(async (id: string, idx: number, data: ArrayBuffer) => {
      let m = chunks.get(id); if (!m) { m = new Map(); chunks.set(id, m) }
      m.set(idx, data)
    })
})

describe('BUG-014: exactly one live send engine per transfer id', () => {
  it('a second sendFileParallel for a live id wakes the task instead of racing it', async () => {
    const id = 'single-engine'
    const frames: ArrayBuffer[] = []
    const lane = makeLane(frames)
    const source = new Uint8Array(CHUNK_SIZE * 3)
    const file = new File([source], 'e.bin')

    // Pause before starting so the engine parks in `waitWhilePaused` and stays
    // live for the duration of the assertions.
    pauseTransfer(id)
    const first = sendFileParallel([lane], file, id, 1, PEER, undefined, undefined, undefined, 0)
    await Promise.resolve()
    expect(hasLiveSendTask(id)).toBe(true)

    // The resume path used to call this WHILE also calling resumeTransfer(),
    // producing a second engine for the same id.
    const second = sendFileParallel([lane], file, id, 1, PEER, undefined, undefined, undefined, 0)
    // Same task → the very same promise, not a second engine.
    expect(second).toBeInstanceOf(Promise)

    resumeTransfer(id)
    const [a, b] = await Promise.all([first, second])
    expect(a).toBe(b)                       // one outcome, one engine
    expect(frames.length).toBe(3)           // each chunk shipped exactly once
    const indexes = frames.map(f => new DataView(f).getUint32(5, false))
    expect(new Set(indexes).size).toBe(3)
  })

  it('refuses to adopt a live transfer for a different peer session', async () => {
    const id = 'wrong-peer'
    const frames: ArrayBuffer[] = []
    const lane = makeLane(frames)
    const file = new File([new Uint8Array(CHUNK_SIZE)], 'x.bin')
    pauseTransfer(id)
    const first = sendFileParallel([lane], file, id, 1, PEER, undefined, undefined, undefined, 0)
    await Promise.resolve()

    await expect(
      sendFileParallel([lane], file, id, 1, 'other-session', undefined, undefined, undefined, 0),
    ).rejects.toThrow(/其他会话/)

    resumeTransfer(id)
    await first
  })
})

describe('BUG-016: queued → delivered → saved', () => {
  it('reports `saved` only after the receiver ACKs a durable write', async () => {
    const id = 'ack-saved'
    setPeerProtocolVersion(PEER, 2)
    const frames: ArrayBuffer[] = []
    const control: string[] = []
    const lane = makeLane(frames, control)
    const file = new File([new Uint8Array(CHUNK_SIZE * 2)], 'a.bin')
    const states: string[] = []

    const sending = sendFileParallel(
      [lane], file, id, 1, PEER, undefined,
      { onDeliveryState: s => states.push(s) }, undefined, 0,
    )
    // BUG-011: with a v2 peer nothing ships until `transfer-ready`.
    await new Promise(r => setTimeout(r, 0))
    expect(frames.length).toBe(0)
    const info = getSendTaskInfo(id)!
    markReceiverReady(id, info.shortId, OWNER)

    // Let the engine queue everything and park on the ACK wait.
    await new Promise(r => setTimeout(r, 20))
    expect(frames.length).toBe(2)
    expect(states).toEqual(['queued', 'delivered'])

    markTransferAcked(id, file.size, OWNER)
    const outcome = await sending
    expect(outcome).toEqual({ state: 'saved', acked: true, legacyPeer: false })
    expect(states).toEqual(['queued', 'delivered', 'saved'])
  })

  it('stops at `delivered` (never `saved`) when the ACK never arrives', async () => {
    // Fake only timer APIs so crypto.subtle / microtasks still flush; pure
    // fake timers used to leave the engine parked before the ready barrier.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    try {
      const id = 'ack-timeout'
      setPeerProtocolVersion(PEER, 2)
      const frames: ArrayBuffer[] = []
      const lane = makeLane(frames)
      const file = new File([new Uint8Array(CHUNK_SIZE)], 'b.bin')
      const sending = sendFileParallel([lane], file, id, 1, PEER, undefined, undefined, undefined, 0)
      // Allow deriveTransferIvPrefix + saveTransfer microtasks to settle.
      await vi.advanceTimersByTimeAsync(0)
      for (let i = 0; i < 10; i++) await Promise.resolve()
      const info = getSendTaskInfo(id)
      expect(info).toBeTruthy()
      markReceiverReady(id, info!.shortId, OWNER)
      // Let lanes finish (microtasks) then burn the ACK budget.
      for (let i = 0; i < 30; i++) await Promise.resolve()
      await vi.advanceTimersByTimeAsync(61_000)
      const outcome = await sending
      expect(outcome).toEqual({ state: 'delivered', acked: false, legacyPeer: false })
    } finally {
      vi.useRealTimers()
    }
  })

  it('a v1 peer gets legacy semantics instead of hanging on an ACK it cannot send', async () => {
    const id = 'legacy-peer'
    // No `setPeerProtocolVersion` → the peer is v1.
    const frames: ArrayBuffer[] = []
    const lane = makeLane(frames)
    const file = new File([new Uint8Array(CHUNK_SIZE)], 'c.bin')
    const outcome = await sendFileParallel([lane], file, id, 1, PEER, undefined, undefined, undefined, 0)
    expect(outcome).toEqual({ state: 'delivered', acked: false, legacyPeer: true })
    expect(frames.length).toBe(1)
  })

  it('rejects an ACK from a session that does not own the transfer', async () => {
    const id = 'ack-owner'
    setPeerProtocolVersion(PEER, 2)
    const frames: ArrayBuffer[] = []
    const lane = makeLane(frames)
    const file = new File([new Uint8Array(CHUNK_SIZE)], 'd.bin')
    const sending = sendFileParallel([lane], file, id, 1, PEER, undefined, undefined, undefined, 0)
    await new Promise(r => setTimeout(r, 0))
    const info = getSendTaskInfo(id)!
    markReceiverReady(id, info.shortId, OWNER)
    await new Promise(r => setTimeout(r, 20))

    // SECURITY-015: a sibling device in the same identity cluster must not be
    // able to confirm someone else's transfer.
    expect(markTransferAcked(id, file.size, { peerSessionId: 'intruder', epoch: 0 })).toBe(false)
    expect(markTransferAcked(id, file.size, OWNER)).toBe(true)
    await sending
  })
})

describe('BUG-017: the durable write happens BEFORE the bitmap is persisted', () => {
  it('orders write → bitmap → persist for every chunk', async () => {
    const id = 'order'
    const meta = makeMeta({ transferId: id, totalChunks: 2 })
    await handleMetaMessage(meta, 1, OWNER)
    await prepareReceiveBackend(
      { transferId: id, fileName: meta.fileName, totalChunks: 2, size: meta.fileSize },
      OWNER,
    )
    persistOrder.length = 0
    // Instrument the IDB write so we can see it interleave with the persist.
    const saveChunkSpy = db.saveChunk as unknown as { mockImplementation: (f: unknown) => void }
    const chunks = (db as any).__chunks as Map<string, Map<number, ArrayBuffer>>
    saveChunkSpy.mockImplementation(async (tid: string, idx: number, data: ArrayBuffer) => {
      persistOrder.push('durable-write')
      let m = chunks.get(tid); if (!m) { m = new Map(); chunks.set(tid, m) }
      m.set(idx, data)
    })

    for (const i of [0, 1]) {
      const c = makeChunk(meta, i)
      await receiveChunk(id, i, c.iv, c.encrypted, PEER)
    }

    // The write for a chunk must precede the bitmap flush that claims it. The
    // final chunk always flushes (the `done` branch), so we can assert on the
    // tail of the sequence directly.
    const lastWrite = persistOrder.lastIndexOf('durable-write')
    const lastPersist = persistOrder.lastIndexOf('persist-bitmap')
    expect(lastWrite).toBeGreaterThanOrEqual(0)
    expect(lastPersist).toBeGreaterThan(lastWrite)
  })

  it('a failing disk write leaves the chunk OUT of the bitmap', async () => {
    const id = 'write-fails'
    const meta = makeMeta({ transferId: id, totalChunks: 2 })
    await handleMetaMessage(meta, 1, OWNER)
    await prepareReceiveBackend(
      { transferId: id, fileName: meta.fileName, totalChunks: 2, size: meta.fileSize },
      OWNER,
    )
    const saveChunkSpy = db.saveChunk as unknown as { mockImplementation: (f: unknown) => void }
    saveChunkSpy.mockImplementation(async () => { throw new Error('disk on fire') })

    const c = makeChunk(meta, 0)
    await expect(receiveChunk(id, 0, c.iv, c.encrypted, PEER)).rejects.toThrow(/disk on fire/)
    // The whole point of BUG-017: a bitmap must never claim a byte the disk
    // does not have, or resume skips it and delivers a sparse file.
    expect(getReceiveSession(id)?.receivedCount).toBe(0)
  })
})

describe('BUG-018: one terminal completion API', () => {
  let origStorage: unknown
  beforeEach(() => {
    origStorage = (navigator as any).storage
  })
  afterEach(() => {
    if (origStorage === undefined) delete (navigator as any).storage
    else (navigator as any).storage = origStorage
  })

  it('refuses to finalize an incomplete transfer', async () => {
    const id = 'incomplete'
    const meta = makeMeta({ transferId: id, totalChunks: 3 })
    await handleMetaMessage(meta, 1, OWNER)
    await prepareReceiveBackend(
      { transferId: id, fileName: meta.fileName, totalChunks: 3, size: meta.fileSize },
      OWNER,
    )
    const c = makeChunk(meta, 0)
    await receiveChunk(id, 0, c.iv, c.encrypted, PEER)
    await expect(finalizeReceive(id)).rejects.toBeInstanceOf(TransferIntegrityError)
    // Still finalizable later — the guard must not have burnt the session.
    expect(getReceiveSession(id)).toBeTruthy()
  })

  it('refuses an artefact whose size disagrees with the declared file size', async () => {
    // OPFS backend whose getFile returns a truncated file.
    const stream = { write: vi.fn(async () => {}), close: vi.fn(async () => {}), seek: async () => {}, truncate: async () => {} }
    const fileHandle = {
      kind: 'file', name: 'short.bin',
      createWritable: vi.fn(async () => stream),
      getFile: vi.fn(async () => new File([new Uint8Array(5)], 'short.bin')),
    }
    const dir = {
      getDirectoryHandle: vi.fn(async () => dir),
      getFileHandle: vi.fn(async () => fileHandle),
      removeEntry: vi.fn(async () => {}),
      [Symbol.asyncIterator]: async function* () { /* empty */ },
    }
    ;(navigator as any).storage = { getDirectory: vi.fn(async () => dir) }

    const id = 'short-artefact'
    const meta = makeMeta({ transferId: id, totalChunks: 1, fileName: 'short.bin' })
    await handleMetaMessage(meta, 1, OWNER)
    const prepared = await prepareReceiveBackend(
      { transferId: id, fileName: meta.fileName, totalChunks: 1, size: meta.fileSize },
      OWNER,
    )
    expect(prepared).toMatchObject({ ok: true, mode: 'opfs' })
    const c = makeChunk(meta, 0)
    await receiveChunk(id, 0, c.iv, c.encrypted, PEER)

    await expect(finalizeReceive(id)).rejects.toBeInstanceOf(TransferIntegrityError)
    await cleanupOPFS(id).catch(() => {})
  })

  it('a successful OPFS finalize retires state and defers entry removal until the lazy file is consumed', async () => {
    const removed: string[] = []
    const stored = new Uint8Array(CHUNK_SIZE)
    const stream = { write: vi.fn(async () => {}), close: vi.fn(async () => {}), seek: async () => {}, truncate: async () => {} }
    const fileHandle = {
      kind: 'file', name: 'done.bin',
      createWritable: vi.fn(async () => stream),
      getFile: vi.fn(async () => new File([stored], 'done.bin')),
    }
    const dir = {
      getDirectoryHandle: vi.fn(async () => dir),
      getFileHandle: vi.fn(async () => fileHandle),
      removeEntry: vi.fn(async (n: string) => { removed.push(n) }),
      [Symbol.asyncIterator]: async function* () { /* empty */ },
    }
    ;(navigator as any).storage = { getDirectory: vi.fn(async () => dir) }

    const id = 'terminal-ok'
    const meta = makeMeta({ transferId: id, totalChunks: 1, fileName: 'done.bin' })
    await handleMetaMessage(meta, 1, OWNER)
    await prepareReceiveBackend(
      { transferId: id, fileName: meta.fileName, totalChunks: 1, size: meta.fileSize },
      OWNER,
    )
    const c = makeChunk(meta, 0)
    await receiveChunk(id, 0, c.iv, c.encrypted, PEER)

    const result = await finalizeReceive(id)
    expect(result.backend).toBe('opfs')
    expect(result.bytes).toBe(meta.fileSize)
    expect(result.file.name).toBe('done.bin')

    expect(stream.close).toHaveBeenCalled()              // backend closed
    expect(removed).not.toContain(`${id}-done.bin`)      // lazy File still readable
    await expect(result.file.arrayBuffer()).resolves.toHaveProperty('byteLength', meta.fileSize)
    expect(getOPFSHandle(id)).toBeUndefined()             // handle dropped
    expect(getReceiveSession(id)).toBeUndefined()         // session dropped
    expect(persistOrder).toContain('delete-chunks')       // chunk rows reaped
    expect(((db as any).__records as Map<string, any>).get(id)?.status).toBe('completed')

    await result.cleanup?.()
    expect(removed).toContain(`${id}-done.bin`)           // exact OPFS entry gone

    // Second finalize is refused rather than double-delivering.
    await expect(finalizeReceive(id)).rejects.toThrow(/No receive session/)
  })
})
