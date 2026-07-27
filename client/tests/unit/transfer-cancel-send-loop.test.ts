// Regression [P2]: cancelTransfer() set s.cancelled=true then immediately
// `transferSignals.delete(id)` on the next synchronous line. The send loop only
// learns of cancellation via checkSignals() reading transferSignals.get(id) on
// its NEXT async tick — which, after the synchronous delete, saw `undefined`
// and returned false. So the loop never aborted: it transmitted the entire
// remaining file (bytes discarded on the wire by an already-gone receiver) and
// sendFileParallel resolved normally, making sendFileToPeer report a false
// "已发送文件" success. The fix: don't delete synchronously, and throw
// TransferCancelledError once the loop observes the cancel.

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
    // Slow encrypt so the send loop is still running when we cancel mid-flight.
    encryptChunk: vi.fn(async (data: ArrayBuffer, _peer: string, iv?: Uint8Array<ArrayBuffer>) => {
      await new Promise(r => setTimeout(r, 4))
      return { iv: iv ?? new Uint8Array(12) as Uint8Array<ArrayBuffer>, encrypted: data }
    }),
  }
})

import { sendFileParallel, cancelTransfer, cancelReceive, TransferCancelledError, CHUNK_SIZE } from '../../src/lib/transfer'

// TEST-001: the cancel used to be scheduled off a fixed `setTimeout(25)`, which
// races the scheduler — under a loaded parallel suite the send loop had not
// shipped a single chunk yet and the "sent > 0" assertion failed on a correct
// implementation. The fake channel now exposes a barrier that resolves the
// moment a real chunk is observed on the wire, so the cancel is ordered by the
// thing it actually depends on rather than by wall-clock luck.
function makeFakeDc() {
  const sent: ArrayBuffer[] = []
  const strings: string[] = []
  let signalFirstChunk: () => void
  const firstChunkSent = new Promise<void>(resolve => {
    signalFirstChunk = resolve
  })
  return {
    readyState: 'open' as RTCDataChannelState,
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    onbufferedamountlow: null,
    label: 'misaka-transfer-0',
    send: vi.fn((p: ArrayBuffer | string) => {
      if (typeof p === 'string') strings.push(p)
      else {
        sent.push(p)
        signalFirstChunk()
      }
    }),
    addEventListener() {},
    removeEventListener() {},
    _sent: sent,
    _strings: strings,
    _firstChunkSent: firstChunkSent,
  }
}

// Bounded wait: a hang must fail loudly as a hang, not time out the whole file.
function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for ${what}`)), ms),
    ),
  ])
}

describe('cancelTransfer actually stops the send loop', () => {
  it('aborts mid-flight and rejects with TransferCancelledError (no false success)', async () => {
    const TOTAL = 40
    const file = new File([new Uint8Array(TOTAL * CHUNK_SIZE)], 'cancel.bin')
    const dc = makeFakeDc()

    const promise = sendFileParallel(
      [dc] as unknown as RTCDataChannel[],
      file,
      'tid-cancel',
      1,
      'peer-cancel',
      undefined,
      undefined,
    )

    // Wait until the loop has demonstrably shipped a chunk, then cancel exactly
    // as cancelTransferAction does: engineCancelTransfer(id) followed immediately
    // by cancelReceive(id). The latter must NOT delete the send transfer's
    // signal, or the loop would never observe the cancel (the original bug, in a
    // different disguise).
    await withDeadline(dc._firstChunkSent, 5_000, 'the first chunk to reach the channel')
    cancelTransfer('tid-cancel')
    void cancelReceive('tid-cancel')

    await expect(promise).rejects.toBeInstanceOf(TransferCancelledError)

    // The loop must have stopped BEFORE shipping the whole file.
    expect(dc._sent.length).toBeGreaterThan(0)
    expect(dc._sent.length).toBeLessThan(TOTAL)
  })

  it('a non-cancelled send still completes and ships every chunk', async () => {
    const TOTAL = 6
    const file = new File([new Uint8Array(TOTAL * CHUNK_SIZE)], 'ok.bin')
    const dc = makeFakeDc()
    await sendFileParallel(
      [dc] as unknown as RTCDataChannel[],
      file,
      'tid-ok',
      1,
      'peer-ok',
      undefined,
      undefined,
    )
    expect(dc._sent.length).toBe(TOTAL)
  })
})
