// Regression for the zero-byte file deadlock.
//
// Before the fix: dragging an empty file into the picker resulted in
//   - sender: Math.ceil(0/CHUNK_SIZE) = 0 → lane loop never enters → resolves
//     instantly, but no completion progress emitted; UI showed NaN%.
//   - receiver: meta arrived with totalChunks=0, but `received === total` is
//     only ever checked inside receiveChunk(), which was never called →
//     the file card never appeared on the recipient side.
//
// The fix short-circuits both paths so an empty file completes deterministically.

import { describe, it, expect, vi } from 'vitest'
import { sendFileParallel, handleMetaMessage, getReceiveSession, type MetaMessage } from '../../src/lib/transfer'

// Stub the DB layer so we don't touch IndexedDB in jsdom.
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
    // No chunks are ever sent for a zero-byte file, so encrypt is unused; but
    // safer to stub so anything weird shows up as a sync fail not a hang.
    encryptChunk: vi.fn(async () => ({ iv: new Uint8Array(12), encrypted: new ArrayBuffer(0) })),
  }
})

function makeFakeDc(): RTCDataChannel {
  const sent: string[] = []
  return {
    readyState: 'open',
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    onbufferedamountlow: null,
    send: vi.fn((p: string) => { sent.push(p) }),
    label: 'misaka-transfer-0',
    // expose for assertions
    _sent: sent,
  } as unknown as RTCDataChannel
}

describe('sendFileParallel: zero-byte file', () => {
  it('resolves without throwing and emits a (1,1) progress tick', async () => {
    const dc = makeFakeDc()
    const empty = new File([], 'empty.txt', { type: 'text/plain' })
    const progress: Array<[number, number]> = []

    // No peer protocol registered → v1. v1 tops out at `delivered` (never
    // `saved`); only transfer-done promotes to saved under v2/v3.
    await expect(
      sendFileParallel(
        [dc], empty,
        'transfer-id-empty',
        1, 'peer-session',
        undefined,
        { onProgress: (sent, total) => progress.push([sent, total]) },
      ),
    ).resolves.toMatchObject({ state: 'delivered', acked: false, legacyPeer: true })

    // Final tick must be 1/1, not 0/0 (which renders NaN%).
    expect(progress.at(-1)).toEqual([1, 1])
    // Exactly one meta message went over the wire (no chunk frames).
    // Use the typed accessor instead of `as any` to satisfy the linter.
    const dcSent = (dc as unknown as { _sent: string[] })._sent
    expect(dcSent.length).toBe(1)
    const meta = JSON.parse(dcSent[0])
    expect(meta).toMatchObject({
      type: 'meta', fileSize: 0, totalChunks: 0,
    })
  })
})

// Receiver-side regression. The store in network.ts has an explicit branch
// for `totalChunks === 0 && fileSize === 0` that synthesizes the completion
// (no chunk frames will ever follow a zero-byte meta). This test locks in
// the *transfer engine's* contract that supports that flow: after
// handleMetaMessage with totalChunks=0, the registered ReceiveSession must
// be in a state where `receivedCount === totalChunks` is already true.
describe('handleMetaMessage: zero-byte receiver session', () => {
  it('creates a session whose completion gate is already satisfied', async () => {
    const meta: MetaMessage = {
      type: 'meta',
      transferId: 'zero-recv',
      shortId: 1,
      fileName: 'empty.txt',
      fileSize: 0,
      fileHash: '',
      totalChunks: 0,
      mime: 'text/plain',
    }
    const session = await handleMetaMessage(meta, 42)

    // Completion gate: receivedCount === totalChunks. Both are 0, so the
    // gate is true the instant the session is registered, without any
    // receiveChunk() call. network.ts:1262 reads this state to deliver the
    // empty File synchronously.
    expect(session.totalChunks).toBe(0)
    expect(session.receivedCount).toBe(0)
    expect(session.receivedCount).toBe(session.totalChunks)
    // bitmap is sized for totalChunks; zero chunks → zero-length array.
    expect(session.received).toBeInstanceOf(Uint8Array)
    expect(session.received.length).toBe(0)

    // The session must also be retrievable by transferId so the meta
    // handler in network.ts can clean up the demux entry afterwards.
    expect(getReceiveSession('zero-recv')).toBe(session)
  })
})
