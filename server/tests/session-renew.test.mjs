#!/usr/bin/env node
/**
 * Contract 2 — seamless session renewal.
 * Keeps the same sessionId, mints a new token + reRegisterProof, extends TTL.
 */
import assert from 'node:assert/strict'
import { runTest, killChild, spawnTestServer } from './_harness.mjs'

runTest(main)

async function main() {
  const { proc, base } = await spawnTestServer({
    SESSION_TTL_MS: '5000',
  })

  try {
    const reg = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId: 4242, passCode: '123456' }),
    }).then(r => r.json())
    assert.ok(reg.token)
    assert.ok(reg.reRegisterProof)
    assert.equal(typeof reg.sessionId, 'string')
    const oldToken = reg.token
    const oldProof = reg.reRegisterProof
    const oldExpires = reg.expiresAt

    const renew = await fetch(`${base}/session-renew`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${oldToken}`,
      },
    })
    assert.equal(renew.status, 200)
    const body = await renew.json()
    assert.equal(body.sessionId, reg.sessionId, 'sessionId must be unchanged')
    assert.notEqual(body.token, oldToken, 'token must rotate')
    assert.notEqual(body.reRegisterProof, oldProof, 'proof must rotate')
    assert.ok(body.expiresAt > oldExpires, 'expiresAt must extend')

    // Old token must be dead.
    const oldStat = await fetch(`${base}/turn-credentials`, {
      headers: { Authorization: `Bearer ${oldToken}` },
    })
    assert.equal(oldStat.status, 401)

    // New token works.
    const newStat = await fetch(`${base}/turn-credentials`, {
      headers: { Authorization: `Bearer ${body.token}` },
    })
    // 503 NOT_CONFIGURED is fine — we only care it is not 401.
    assert.notEqual(newStat.status, 401)

    // Expired session rejects renew.
    const noAuth = await fetch(`${base}/session-renew`, {
      method: 'POST',
      headers: { Authorization: 'Bearer deadbeef' },
    })
    assert.equal(noAuth.status, 401)

    console.log('✅ session-renew contract tests passed')
  } finally {
    await killChild(proc)
  }
}
