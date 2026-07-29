#!/usr/bin/env node
/**
 * Tier1 — body parser after /api rate limit; malformed/oversize → JSON 400/413
 * and still consume the IP budget.
 */
import assert from 'node:assert/strict'
import { runTest, killChild, spawnTestServer } from './_harness.mjs'

runTest(main)

async function main() {
  const { proc, base } = await spawnTestServer({
    RATE_LIMIT_PER_MIN: '5',
  })

  try {
    // Malformed JSON → 400 JSON, not HTML.
    const bad = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    })
    assert.equal(bad.status, 400)
    const badBody = await bad.json()
    assert.equal(badBody.error, 'INVALID_JSON')

    // Oversized body → 413 JSON.
    const big = 'x'.repeat(70 * 1024)
    const over = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: `{"nodeId":1,"passCode":"123456","pad":"${big}"}`,
    })
    assert.equal(over.status, 413)
    const overBody = await over.json()
    assert.equal(overBody.error, 'BODY_TOO_LARGE')

    // RATE_LIMIT_PER_MIN=5. Two bad bodies already consumed 2 slots, so the
    // next 3 well-formed must succeed and the 6th total request is 429.
    // If malformed bodies did NOT count, all 5 well-formed would succeed and
    // only the 6th well-formed (8th total) would 429 — this exact pin fails
    // the old parser-first path.
    const statuses = []
    for (let i = 0; i < 4; i++) {
      const r = await fetch(`${base}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeId: 10 + i, passCode: '123456' }),
      })
      statuses.push(r.status)
    }
    // slots used: 2 bad + 3 ok = 5; 4th well-formed is the 6th request → 429
    assert.equal(statuses[0], 200, `1st well-formed (3rd total) must 200, got ${statuses[0]}`)
    assert.equal(statuses[1], 200, `2nd well-formed (4th total) must 200, got ${statuses[1]}`)
    assert.equal(statuses[2], 200, `3rd well-formed (5th total) must 200, got ${statuses[2]}`)
    assert.equal(statuses[3], 429, `4th well-formed (6th total) must 429 if bad bodies counted, got ${statuses[3]}`)

    console.log('✅ body-order + JSON error mapping tests passed')
  } finally {
    await killChild(proc)
  }
}
