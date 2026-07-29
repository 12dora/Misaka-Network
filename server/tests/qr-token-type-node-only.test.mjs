#!/usr/bin/env node
/**
 * Contract 7 server side — /api/qr-token only ever stores type:'node'.
 * Reject any body that tries to bind a resource (file/channel).
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
      body: JSON.stringify({ nodeId: 55, passCode: '999999' }),
    }).then(r => r.json())

    // Body with type=file must be rejected (strict empty body).
    const bad = await fetch(`${base}/qr-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${reg.token}`,
      },
      body: JSON.stringify({ type: 'file', fileSessionId: 'abc' }),
    })
    assert.equal(bad.status, 400)
    const badBody = await bad.json()
    assert.equal(badBody.error, 'INVALID_INPUT')

    const bad2 = await fetch(`${base}/qr-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${reg.token}`,
      },
      body: JSON.stringify({ type: 'channel', channelId: 'xyz' }),
    })
    assert.equal(bad2.status, 400)

    // Empty body → ok, type is always node on the server.
    const ok = await fetch(`${base}/qr-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${reg.token}`,
      },
      body: JSON.stringify({}),
    })
    assert.equal(ok.status, 200)
    const body = await ok.json()
    assert.ok(body.qrToken)
    assert.ok(body.channelId)

    console.log('✅ qr-token type=node only tests passed')
  } finally {
    await killChild(proc)
  }
}
