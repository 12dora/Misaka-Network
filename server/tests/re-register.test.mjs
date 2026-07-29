#!/usr/bin/env node
/**
 * Contract 1 — re-registration proof.
 * POST /api/re-register reuses identity, mints new sessionId/token/proof,
 * terminates the old session so the old token is unusable.
 */
import assert from 'node:assert/strict'
import { runTest, killChild, spawnTestServer } from './_harness.mjs'

runTest(main)

async function main() {
  const { proc, base } = await spawnTestServer()

  try {
    const reg = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId: 7777, passCode: '654321' }),
    }).then(r => r.json())
    assert.ok(reg.reRegisterProof, 'register must return reRegisterProof')
    assert.ok(reg.token)
    const oldToken = reg.token
    const proof = reg.reRegisterProof

    const rereg = await fetch(`${base}/re-register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proof }),
    })
    assert.equal(rereg.status, 200)
    const body = await rereg.json()
    assert.notEqual(body.sessionId, reg.sessionId)
    assert.notEqual(body.token, oldToken)
    assert.notEqual(body.reRegisterProof, proof)
    assert.equal(body.resumed, false)
    assert.ok(body.expiresAt > Date.now())

    // Old token dead.
    const oldUse = await fetch(`${base}/turn-credentials`, {
      headers: { Authorization: `Bearer ${oldToken}` },
    })
    assert.equal(oldUse.status, 401)

    // Old proof is single-use.
    const reuse = await fetch(`${base}/re-register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proof }),
    })
    assert.equal(reuse.status, 401)
    const reuseBody = await reuse.json()
    assert.equal(reuseBody.error, 'INVALID_PROOF')

    // New proof works.
    const rereg2 = await fetch(`${base}/re-register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proof: body.reRegisterProof }),
    })
    assert.equal(rereg2.status, 200)

    // Invalid proof → 401
    const bad = await fetch(`${base}/re-register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proof: 'a'.repeat(64) }),
    })
    assert.equal(bad.status, 401)

    console.log('✅ re-register contract tests passed')
  } finally {
    await killChild(proc)
  }
}
