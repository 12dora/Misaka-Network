// P1 regression / contract test: across two calls to sendFileParallel that
// share the same File but target different peers, the AES-GCM IV used for
// chunk index `i` MUST differ between the two transfers. Otherwise we'd
// be reusing an (AES key, IV) pair across messages — fatal for AES-GCM
// integrity / confidentiality if the AES key were also shared.
//
// In practice our keys are per-peerSessionId (derived via ECDH), so a
// reused IV across peers is technically not catastrophic — but the contract
// in crypto.ts requires per-transfer uniqueness, and an inadvertent
// optimisation that hoists `ivPrefix` outside the per-call scope would
// break that invariant silently. This test traps that regression.

import { describe, it, expect, vi } from 'vitest'

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

// Capture the IV passed to every encryptChunk call so we can compare across
// the two sendFileParallel invocations.
const ivsByPeer = new Map<string, Uint8Array[]>()
vi.mock('../../src/lib/crypto', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/crypto')>('../../src/lib/crypto')
  return {
    ...actual,
    encryptChunk: vi.fn(async (
      _data: ArrayBuffer,
      peerSessionId: string,
      iv?: Uint8Array<ArrayBuffer>,
    ) => {
      if (iv) {
        const arr = ivsByPeer.get(peerSessionId) ?? []
        arr.push(new Uint8Array(iv))
        ivsByPeer.set(peerSessionId, arr)
      }
      return { iv: iv ?? new Uint8Array(12), encrypted: new ArrayBuffer(0) }
    }),
  }
})

import { sendFileParallel, CHUNK_SIZE } from '../../src/lib/transfer'

function makeFakeDc(): RTCDataChannel {
  const sent: ArrayBuffer[] = []
  return {
    readyState: 'open',
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    onbufferedamountlow: null,
    send: vi.fn((p: ArrayBuffer | string) => {
      if (typeof p !== 'string') sent.push(p)
    }),
    label: 'misaka-transfer-0',
    _sent: sent,
  } as unknown as RTCDataChannel
}

describe('IV contract: per-(peer, transfer) uniqueness across broadcast', () => {
  it('two sendFileParallel calls for the same file → distinct IV prefixes', async () => {
    ivsByPeer.clear()
    // Use a single-chunk file so we get one IV per peer deterministically.
    // CHUNK_SIZE is 256 KB; one byte under that fits in chunk index 0.
    const bytes = new Uint8Array(1024)
    const file = new File([bytes], 'iv-test.bin', { type: 'application/octet-stream' })

    await sendFileParallel(
      [makeFakeDc()], file,
      'transfer-A', 1, 'peer-A',
      undefined, undefined,
    )
    await sendFileParallel(
      [makeFakeDc()], file,
      'transfer-B', 2, 'peer-B',
      undefined, undefined,
    )

    const ivsA = ivsByPeer.get('peer-A') ?? []
    const ivsB = ivsByPeer.get('peer-B') ?? []
    expect(ivsA.length).toBeGreaterThan(0)
    expect(ivsB.length).toBeGreaterThan(0)

    // For chunk index 0 (last 4 bytes of IV are 0x00000000 BE), the leading
    // 8 bytes are the prefix. Those must differ between the two calls.
    const prefixA = Array.from(ivsA[0].subarray(0, 8)).join(',')
    const prefixB = Array.from(ivsB[0].subarray(0, 8)).join(',')
    expect(prefixA).not.toBe(prefixB)

    // Stronger: the full IV for the same chunk index across peers must
    // differ — this is what AES-GCM uniqueness ultimately cares about.
    const ivA = Array.from(ivsA[0]).join(',')
    const ivB = Array.from(ivsB[0]).join(',')
    expect(ivA).not.toBe(ivB)
  })

  it('within a single transfer, IVs for distinct chunk indexes differ', async () => {
    ivsByPeer.clear()
    // Two chunks: 1 KB + 1 KB makes the file > CHUNK_SIZE only when CHUNK_SIZE
    // is small. Use a buffer guaranteed to exceed CHUNK_SIZE so we get two
    // chunks regardless of the constant.
    const bytes = new Uint8Array(CHUNK_SIZE + 1024)
    const file = new File([bytes], 'two-chunk.bin', { type: 'application/octet-stream' })

    await sendFileParallel(
      [makeFakeDc()], file,
      'transfer-2chunk', 3, 'peer-2chunk',
      undefined, undefined,
    )

    const ivs = ivsByPeer.get('peer-2chunk') ?? []
    expect(ivs.length).toBeGreaterThanOrEqual(2)
    // The 8-byte prefix is shared within a transfer; only the 4-byte index
    // tail should differ between any two chunks of the same call.
    const prefix0 = Array.from(ivs[0].subarray(0, 8)).join(',')
    const prefix1 = Array.from(ivs[1].subarray(0, 8)).join(',')
    expect(prefix0).toBe(prefix1)

    const tail0 = Array.from(ivs[0].subarray(8, 12)).join(',')
    const tail1 = Array.from(ivs[1].subarray(8, 12)).join(',')
    expect(tail0).not.toBe(tail1)
  })
})
