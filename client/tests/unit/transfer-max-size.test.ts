// P1-5: sender must refuse to start a transfer for a file larger than
// MAX_FILE_SIZE upfront. Without this guard, a 100 GB drag-drop would
// either OOM the tab on the read step or silently truncate at the
// receiver's IDB ceiling many gigabytes in. The guard runs synchronously
// at the top of sendFileParallel so the UI can surface a clear error
// before any DataChannel work begins.
//
// 16 GB picked because: math headroom against Number.MAX_SAFE_INTEGER
// (252 KB * MAX_TOTAL_CHUNKS = ~1 PB theoretical, but we keep it
// practical) and matches what the receiver's chunk-index BE uint32 can
// address without flirting with overflow.

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

import { sendFileParallel } from '../../src/lib/transfer'

// 16 GB cap — tracks `MAX_FILE_SIZE` in constants.ts (or transfer.ts's
// local fallback if the constant isn't published yet).
const MAX = 16 * 1024 * 1024 * 1024

// Build a File that LIES about its size — we can't actually allocate
// 16 GB in jsdom. The implementation only inspects `file.size` for the
// guard, so a tiny backing Blob with an overridden `.size` is enough.
function fakeFileOfSize(size: number, name = 'huge.bin'): File {
  const real = new File([new Uint8Array(0)], name, { type: 'application/octet-stream' })
  Object.defineProperty(real, 'size', { value: size, configurable: true })
  return real
}

function makeFakeDc(): RTCDataChannel {
  return {
    readyState: 'open',
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    onbufferedamountlow: null,
    send: vi.fn(),
    label: 'misaka-transfer-0',
  } as unknown as RTCDataChannel
}

describe('sendFileParallel: file-size guard', () => {
  it('rejects a file larger than the 16 GB cap', async () => {
    const tooBig = fakeFileOfSize(MAX + 1)

    await expect(
      sendFileParallel(
        [makeFakeDc()], tooBig,
        'transfer-too-big', 1, 'peer-X',
      ),
    ).rejects.toThrow(/16/)
  })

  it('accepts a file exactly at the cap (boundary) — guard does not fire', async () => {
    // We can't actually push 16 GB through jsdom. Pass an empty `dcs[]`
    // so the function fails AFTER the size guard with the "no open
    // DataChannel lane" error — that's how we know the guard let this
    // file through.
    const atCap = fakeFileOfSize(MAX)
    await expect(
      sendFileParallel(
        [], atCap,
        'transfer-at-cap', 2, 'peer-Y',
      ),
    ).rejects.toThrow(/No open DataChannel/)
  })

  it('accepts a small file (no guard hit)', async () => {
    const small = fakeFileOfSize(0)
    await expect(
      sendFileParallel(
        [makeFakeDc()], small,
        'transfer-tiny', 3, 'peer-Z',
      ),
    ).resolves.toBeUndefined()
  })
})
