// P1-5: incoming files larger than MAX_INMEMORY_RECEIVE_BYTES must be
// refused up-front when the only available storage path is the IDB
// in-memory fallback (Firefox < 111 / very old Safari / privacy modes).
//
// We're testing the pure check function — `checkMetaOOMGuard` — so the
// browser feature detection is exercised through real implementations,
// not mocked. jsdom has no FileSystemAccess and no OPFS, so the guard's
// "no streaming target available" branch fires naturally.

import { describe, it, expect } from 'vitest'
import { checkMetaOOMGuard, type MetaMessage } from '../../src/lib/transfer'
import { MAX_INMEMORY_RECEIVE_BYTES } from '../../src/constants'

function meta(fileSize: number): MetaMessage {
  return {
    type: 'meta',
    transferId: 't',
    shortId: 1,
    fileName: 'big.bin',
    fileSize,
    fileHash: '',
    totalChunks: Math.ceil(fileSize / (252 * 1024)),
    mime: 'application/octet-stream',
  }
}

describe('checkMetaOOMGuard', () => {
  it('returns null for small files (under the cap)', () => {
    expect(checkMetaOOMGuard(meta(0))).toBeNull()
    expect(checkMetaOOMGuard(meta(1024))).toBeNull()
    expect(checkMetaOOMGuard(meta(MAX_INMEMORY_RECEIVE_BYTES - 1))).toBeNull()
    expect(checkMetaOOMGuard(meta(MAX_INMEMORY_RECEIVE_BYTES))).toBeNull()  // exactly at limit is OK
  })

  it('rejects oversize files when no streaming-disk target is available', () => {
    // jsdom has no FSAccess, no OPFS — the guard's worst case.
    const rejection = checkMetaOOMGuard(meta(MAX_INMEMORY_RECEIVE_BYTES + 1))
    expect(rejection).not.toBeNull()
    expect(rejection!.reason).toBe('too-large-for-fallback')
    expect(rejection!.limitBytes).toBe(MAX_INMEMORY_RECEIVE_BYTES)
    // Message must mention both the file size and the limit so the UI
    // can render a self-explanatory error.
    expect(rejection!.message).toMatch(/MB/)
    // Message must mention a remediation path (newer browser / OPFS).
    expect(rejection!.message).toMatch(/Chrome|Firefox|111|流式落盘/)
  })

  it('passes when a streaming-disk path is available (OPFS stubbed)', () => {
    // Inject a fake OPFS surface so supportsOPFS() returns true. The guard
    // should then accept arbitrarily large files.
    const original = (navigator as any).storage
    ;(navigator as any).storage = {
      ...(original ?? {}),
      getDirectory: async () => null,
    }
    try {
      const huge = MAX_INMEMORY_RECEIVE_BYTES * 8
      expect(checkMetaOOMGuard(meta(huge))).toBeNull()
    } finally {
      if (original === undefined) {
        delete (navigator as any).storage
      } else {
        ;(navigator as any).storage = original
      }
    }
  })
})
