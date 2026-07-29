#!/usr/bin/env node
/**
 * Token and re-register-proof tombstones must be reclaimed by the periodic
 * cleanup task. Lazy-on-lookup alone never shrinks maps whose keys are never
 * presented again (normal expiry/release/renew/rotation).
 */
import assert from 'node:assert/strict'
import { runTest } from './_harness.mjs'

runTest(main)

async function main() {
  const store = await import('../dist/store.js')
  const cleanup = await import('../dist/cleanup.js')

  const now = Date.now()
  // Proof resolver requires length >= 32; use full-length keys.
  const liveProof = 'a'.repeat(32) + 'live'
  const liveToken = 'b'.repeat(32) + 'live'
  // Live tombstones (still within TTL) — must survive.
  store._seedProofTombstoneForTest(liveProof, 42, now + 60_000)
  store._seedTokenTombstoneForTest(liveToken, now + 60_000)
  // Expired tombstones — must be reclaimed without presenting the keys.
  for (let i = 0; i < 50; i++) {
    store._seedProofTombstoneForTest(`${'c'.repeat(32)}exp${i}`, 100 + i, now - 1_000 - i)
    store._seedTokenTombstoneForTest(`${'d'.repeat(32)}exp${i}`, now - 1_000 - i)
  }

  const before = store._tombstoneCountsForTest()
  assert.equal(before.proofs, 51, `expected 51 proof tombs, got ${before.proofs}`)
  assert.equal(before.tokens, 51, `expected 51 token tombs, got ${before.tokens}`)

  cleanup.runCleanupTick(now)

  const after = store._tombstoneCountsForTest()
  assert.equal(after.proofs, 1, `cleanup must drop expired proofs, left ${after.proofs}`)
  assert.equal(after.tokens, 1, `cleanup must drop expired tokens, left ${after.tokens}`)

  // Live keys still resolve as tombstones (not silently deleted).
  const r = store.resolveReRegisterProof(liveProof)
  assert.equal(r.status, 'invalid')
  assert.equal(r.nodeId, 42)
  assert.equal(store.resolveSessionByToken(liveToken).kind, 'expired')

  // A second tick does not go negative or thrash live entries.
  cleanup.runCleanupTick(now + 1)
  const again = store._tombstoneCountsForTest()
  assert.equal(again.proofs, 1)
  assert.equal(again.tokens, 1)

  // Advance past the live TTL — next tick reclaims them too.
  cleanup.runCleanupTick(now + 120_000)
  const empty = store._tombstoneCountsForTest()
  assert.equal(empty.proofs, 0)
  assert.equal(empty.tokens, 0)

  console.log('✅ tombstone map periodic cleanup tests passed')
}
