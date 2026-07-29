#!/usr/bin/env node
/**
 * Contract 1 — invalid re-registration proofs charge the owning node's freeze
 * budget exactly like a wrong passcode (not synthetic node 0).
 */
import assert from 'node:assert/strict'
import { runTest, killChild, spawnTestServer } from './_harness.mjs'

runTest(main)

async function main() {
  const NODE_ID = 19191
  // Freeze before any single-IP hard lock (MAX_ATTEMPTS=3): use distinct IPs
  // so each (ip, nodeId) lock stays at 1 while the global node freeze fills.
  const THRESHOLD = 4
  const { proc, base } = await spawnTestServer({
    NODE_FREEZE_THRESHOLD: String(THRESHOLD),
    NODE_FREEZE_DURATION_MS: '60000',
    TRUST_PROXY: '1',
    RATE_LIMIT_PER_MIN: '10000',
  })

  try {
    const reg = await fetch(`${base}/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '198.51.100.1',
      },
      body: JSON.stringify({ nodeId: NODE_ID, passCode: '654321' }),
    }).then(r => r.json())
    assert.ok(reg.reRegisterProof)

    // Consume the proof once so it becomes a tombstone with nodeId attribution.
    const once = await fetch(`${base}/re-register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '198.51.100.1',
      },
      body: JSON.stringify({ proof: reg.reRegisterProof }),
    })
    assert.equal(once.status, 200)
    const body = await once.json()
    assert.ok(body.reRegisterProof)

    // Hammer the RETIRED proof from DISTINCT IPs so failures feed the owner
    // freeze, not a single (ip, nodeId) hard lock.
    for (let i = 0; i < THRESHOLD; i++) {
      const r = await fetch(`${base}/re-register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': `198.51.100.${10 + i}`,
        },
        body: JSON.stringify({ proof: reg.reRegisterProof }),
      })
      assert.ok(
        r.status === 401 || (r.status === 423 && (await r.clone().json()).reason === 'NODE_FROZEN'),
        `retired proof attempt ${i + 1} status ${r.status}`,
      )
    }

    // Fresh IP: owning identity must be NODE_FROZEN (not WRONG_PASSCODE on node 0).
    const frozen = await fetch(`${base}/re-register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '198.51.100.99',
      },
      body: JSON.stringify({ proof: reg.reRegisterProof }),
    })
    const reBody = await frozen.json()
    assert.equal(frozen.status, 423, `expected 423, got ${frozen.status} ${JSON.stringify(reBody)}`)
    assert.equal(reBody.reason, 'NODE_FROZEN', `must be NODE_FROZEN not ${reBody.reason}`)

    // Wrong-passcode register on same nodeId from yet another IP is also frozen.
    const regBlocked = await fetch(`${base}/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '198.51.100.200',
      },
      body: JSON.stringify({ nodeId: NODE_ID, passCode: '000000' }),
    })
    const regBody = await regBlocked.json()
    assert.equal(regBody.reason, 'NODE_FROZEN', `register must see owner freeze: ${JSON.stringify(regBody)}`)

    console.log('✅ re-register bad-proof freeze attribution tests passed')
  } finally {
    await killChild(proc)
  }
}
