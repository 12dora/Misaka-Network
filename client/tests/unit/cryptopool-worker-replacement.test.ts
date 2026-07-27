// BUG-027: a crashed crypto worker stayed in the round-robin queue.
//
// Settling the dead worker's pending promises (the earlier fix, covered by
// cryptopool-worker-error.test.ts) was only half the story: the corpse stayed
// in the pool array, so every Nth subsequent chunk was still `postMessage`d
// into it and never answered. A transfer that survived the first crash then
// hung on a later chunk with no error surfaced.
//
// The pool must now terminate + evict the dead worker, spawn a replacement,
// re-seed it with every known peer key (a fresh worker has an empty key map),
// and reject immediately once no healthy worker is left.
//
// The pool is module-scoped singleton state, so every case re-imports it
// through `vi.resetModules()` to get a clean pool.

import { describe, it, expect, vi, beforeEach } from 'vitest'

class FakeWorker {
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: { message?: string }) => void) | null = null
  terminated = false
  posted: Array<Record<string, unknown>> = []
  static instances: FakeWorker[] = []
  constructor() { FakeWorker.instances.push(this) }
  postMessage(msg: Record<string, unknown>) { this.posted.push(msg) }
  terminate() { this.terminated = true }
}

type Pool = typeof import('../../src/lib/cryptoPool')

async function freshPool(): Promise<Pool> {
  vi.resetModules()
  FakeWorker.instances = []
  ;(globalThis as unknown as { Worker: unknown }).Worker = FakeWorker
  return import('../../src/lib/cryptoPool')
}

beforeEach(() => {
  ;(globalThis as unknown as { Worker: unknown }).Worker = FakeWorker
})

describe('BUG-027: a crashed worker leaves the rotation', () => {
  it('terminates the crashed worker and spawns a re-seeded replacement', async () => {
    const pool = await freshPool()
    const fakeKey = {} as CryptoKey
    pool.registerPeerKey('peer-k', fakeKey)

    const sizeBefore = pool.healthyWorkerCount()
    expect(sizeBefore).toBeGreaterThan(0)
    const spawnedBefore = FakeWorker.instances.length
    const victim = FakeWorker.instances[0]

    victim.onerror?.({ message: 'module load failure' })

    // The corpse is terminated…
    expect(victim.terminated).toBe(true)
    // …exactly one replacement was spawned…
    expect(FakeWorker.instances.length).toBe(spawnedBefore + 1)
    // …the pool is back to full strength…
    expect(pool.healthyWorkerCount()).toBe(sizeBefore)
    // …and the replacement knows every peer key, otherwise ops routed to it
    // would fail with "no key for peer" for the rest of the session.
    const replacement = FakeWorker.instances[FakeWorker.instances.length - 1]
    expect(replacement.posted).toContainEqual(
      expect.objectContaining({ type: 'set-key', peerSessionId: 'peer-k' }),
    )
  })

  it('never dispatches another op into the crashed worker', async () => {
    const pool = await freshPool()
    // Prime the pool.
    void pool.encryptInWorker('p', new Uint8Array(12), new ArrayBuffer(8)).catch(() => {})
    const victim = FakeWorker.instances[0]
    victim.onerror?.({ message: 'crash' })
    const postedAfterCrash = victim.posted.length

    // More ops than the pool size, so a round-robin cursor would certainly
    // have come back around to the dead slot at least once.
    for (let i = 0; i < 16; i++) {
      void pool.encryptInWorker('p', new Uint8Array(12), new ArrayBuffer(8)).catch(() => {})
    }
    expect(victim.posted.length).toBe(postedAfterCrash)
  })

  it('rejects immediately — no hang — once every worker is gone', async () => {
    const pool = await freshPool()
    void pool.encryptInWorker('p', new Uint8Array(12), new ArrayBuffer(8)).catch(() => {})

    // Keep crashing until the replacement budget is exhausted and the pool
    // is empty. The budget is finite by design: a worker module that fails to
    // parse would otherwise be respawned forever.
    for (let round = 0; round < 20 && pool.healthyWorkerCount() > 0; round++) {
      for (const w of [...FakeWorker.instances]) {
        if (!w.terminated) w.onerror?.({ message: 'fatal' })
      }
    }
    expect(pool.healthyWorkerCount()).toBe(0)

    await expect(
      pool.encryptInWorker('p', new Uint8Array(12), new ArrayBuffer(8)),
    ).rejects.toThrow(/加密工作线程/)
  })
})
