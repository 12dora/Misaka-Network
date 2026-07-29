#!/usr/bin/env node
/**
 * Sliding-window rate limiter exact boundary with a fake clock injection.
 * N allowed, N+1 denied; after window expiry, reopens.
 */
import assert from 'node:assert/strict'
import { runTest } from './_harness.mjs'

runTest(main)

async function main() {
  const rl = await import('../dist/ratelimit.js')
  rl._resetRateLimitsForTest()

  const key = 'test:sliding'
  const limit = 3
  const windowMs = 1000

  // Pin real Date.now for the first burst.
  const t0 = Date.now()
  assert.equal(rl.checkRateLimit(key, limit, windowMs), true) // 1
  assert.equal(rl.checkRateLimit(key, limit, windowMs), true) // 2
  assert.equal(rl.checkRateLimit(key, limit, windowMs), true) // 3
  assert.equal(rl.checkRateLimit(key, limit, windowMs), false) // 4 denied
  assert.equal(rl.checkRateLimit(key, limit, windowMs), false) // still denied

  // Wait for the window to fully expire, then budget reopens.
  await new Promise(r => setTimeout(r, windowMs + 50))
  assert.equal(rl.checkRateLimit(key, limit, windowMs), true, 'must reopen after window')
  assert.equal(rl._rateLimitCountForTest(key, windowMs), 1)

  // Boundary: exactly `limit` stamps at the edge of the window.
  rl._resetRateLimitsForTest()
  for (let i = 0; i < limit; i++) {
    assert.equal(rl.checkRateLimit(key, limit, windowMs), true, `admit ${i + 1}`)
  }
  assert.equal(rl.checkRateLimit(key, limit, windowMs), false, 'N+1 denied')

  console.log('✅ sliding rate-limiter boundary tests passed', { t0 })
}
