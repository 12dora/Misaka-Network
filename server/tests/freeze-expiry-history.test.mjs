#!/usr/bin/env node
/**
 * Freeze expiry must retain in-window failure history so a re-trigger is
 * exact — not a full fresh budget the moment frozenUntil elapses.
 *
 * Driven entirely through the real HTTP /register path (no manual
 * nodeFreezes mutation, no reimplemented threshold). Counterfactual: if
 * history were wiped on expiry, re-trigger would need THRESHOLD fresh
 * failures instead of one.
 */
import assert from 'node:assert/strict'
import { runTest, killChild, spawnTestServer } from './_harness.mjs'

runTest(main, { timeoutMs: 45_000 })

const NODE = 18888
const CORRECT = '424242'
const THRESHOLD = 3
const DURATION_MS = 1200
const WINDOW_MS = 8000

async function main() {
  const { proc, base } = await spawnTestServer({
    NODE_FREEZE_THRESHOLD: String(THRESHOLD),
    NODE_FREEZE_WINDOW_MS: String(WINDOW_MS),
    NODE_FREEZE_DURATION_MS: String(DURATION_MS),
    // Distinct IPs below keep each (ip,nodeId) under MAX_ATTEMPTS=3.
    TRUST_PROXY: '1',
    RATE_LIMIT_PER_MIN: '10000',
  })

  try {
    // Owner occupies the node so wrong guesses take the NODE_OCCUPIED path.
    const owner = await register(base, NODE, CORRECT, '203.0.113.10')
    assert.equal(owner.status, 200, `owner register failed: ${owner.status}`)

    // Drive exactly THRESHOLD failures through HTTP from distinct IPs.
    // Freeze engages on the THRESHOLD-th record, but that response is still
    // 409; freeze is enforced at the start of the *next* request.
    for (let i = 0; i < THRESHOLD; i++) {
      const r = await register(base, NODE, '000000', `198.51.100.${10 + i}`)
      assert.notEqual(
        r.body?.reason,
        'NODE_FROZEN',
        `attempt ${i + 1}/${THRESHOLD} must not be frozen yet: ${JSON.stringify(r.body)}`,
      )
      assert.ok(
        r.status === 409 || (r.status === 423 && r.body?.reason === 'WRONG_PASSCODE'),
        `attempt ${i + 1} expected wrong-passcode response, got ${r.status} ${JSON.stringify(r.body)}`,
      )
    }

    // Next request must observe the freeze.
    const frozen = await register(base, NODE, '111111', '198.51.100.50')
    assert.equal(frozen.status, 423, `expected 423 NODE_FROZEN, got ${frozen.status}`)
    assert.equal(frozen.body?.reason, 'NODE_FROZEN')
    const unlockAt = frozen.body?.unlockAt
    assert.ok(typeof unlockAt === 'number' && unlockAt > Date.now() - 1000)

    // Wait until freeze duration elapses (and a little past).
    const waitMs = Math.max(0, unlockAt - Date.now()) + 150
    await sleep(waitMs)

    // One more real HTTP failure must re-engage freeze from retained history
    // — not require a full fresh budget of THRESHOLD.
    const reTrip = await register(base, NODE, '222222', '198.51.100.60')
    // The re-trip request itself still returns 409 (freeze checked next).
    assert.ok(
      reTrip.status === 409 || (reTrip.status === 423 && reTrip.body?.reason === 'WRONG_PASSCODE'),
      `post-expiry failure should be charged, got ${reTrip.status} ${JSON.stringify(reTrip.body)}`,
    )

    const reFrozen = await register(base, NODE, '333333', '198.51.100.61')
    assert.equal(
      reFrozen.status,
      423,
      `one post-expiry failure must re-trigger freeze, got ${reFrozen.status} ${JSON.stringify(reFrozen.body)}`,
    )
    assert.equal(reFrozen.body?.reason, 'NODE_FROZEN')

    // Cross-boundary: after the rolling window elapses with freeze expired,
    // history must not count — need a full fresh budget again.
    // Wait out active freeze + window.
    const unlock2 = reFrozen.body?.unlockAt ?? (Date.now() + DURATION_MS)
    await sleep(Math.max(0, unlock2 - Date.now()) + 150)
    await sleep(WINDOW_MS + 200)

    // THRESHOLD-1 failures must NOT freeze; only the THRESHOLD-th + next does.
    for (let i = 0; i < THRESHOLD - 1; i++) {
      const r = await register(base, NODE, '444444', `198.51.100.${70 + i}`)
      assert.notEqual(
        r.body?.reason,
        'NODE_FROZEN',
        `after window expiry, attempt ${i + 1} must not freeze from ghost history`,
      )
    }
    // Fill to threshold
    const last = await register(base, NODE, '555555', '198.51.100.80')
    assert.notEqual(last.body?.reason, 'NODE_FROZEN', 'threshold-th failure response is not yet frozen')
    const tripAfterWindow = await register(base, NODE, '666666', '198.51.100.81')
    assert.equal(tripAfterWindow.status, 423)
    assert.equal(tripAfterWindow.body?.reason, 'NODE_FROZEN')

    console.log('✅ freeze-expiry exact history tests passed')
  } finally {
    await killChild(proc)
  }
}

async function register(base, nodeId, passCode, ip) {
  const res = await fetch(`${base}/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': ip,
    },
    body: JSON.stringify({ nodeId, passCode }),
  })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
