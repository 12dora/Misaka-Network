// Regression [P2]: the crypto worker pool tracked outstanding ops in a global
// `pending` map, resolved/rejected only from `w.onmessage`. A hard worker error
// (module load/parse failure, uncaught exception, OOM kill) fired `w.onerror`
// but produced NO onmessage reply — so ops already dispatched to that worker
// never settled. `await encryptChunk/decryptChunk` then hung forever with no
// timeout, wedging the whole transfer. The fix rejects that worker's pending
// entries from onerror.

import { describe, it, expect, beforeEach } from 'vitest'

// Stub the Worker constructor BEFORE the pool lazily creates its workers (first
// dispatch). Each instance records itself so the test can trigger its onerror.
class FakeWorker {
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: { message?: string }) => void) | null = null
  static instances: FakeWorker[] = []
  constructor() { FakeWorker.instances.push(this) }
  postMessage() { /* never replies — we simulate a crash instead */ }
  terminate() {}
}

import { encryptInWorker, decryptInWorker } from '../../src/lib/cryptoPool'

beforeEach(() => {
  ;(globalThis as unknown as { Worker: unknown }).Worker = FakeWorker
})

describe('cryptoPool: worker crash rejects in-flight ops instead of hanging', () => {
  it('rejects the pending encrypt promise when its worker fires onerror', async () => {
    const p = encryptInWorker('peer-x', new Uint8Array(12), new ArrayBuffer(16))
    expect(FakeWorker.instances.length).toBeGreaterThan(0)
    // Crash every pooled worker (robust against round-robin cursor position).
    for (const w of FakeWorker.instances) w.onerror?.({ message: 'boom' })
    await expect(p).rejects.toThrow(/crypto worker crashed/)
  })

  it('also settles decrypt ops on crash', async () => {
    const p = decryptInWorker('peer-y', new Uint8Array(12), new ArrayBuffer(16))
    for (const w of FakeWorker.instances) w.onerror?.({ message: 'oom' })
    await expect(p).rejects.toThrow(/crypto worker crashed/)
  })
})
