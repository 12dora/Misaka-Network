#!/usr/bin/env node
/**
 * Contract 5 + 09 P1 — /api/release must make the token unusable and deliver
 * PEER_LEFT to channel peers. Previously it only nulled the socket.
 */
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import { runTest, killChild, spawnTestServer } from './_harness.mjs'

runTest(main, { timeoutMs: 30_000 })

async function main() {
  const { proc, base, wsUrl } = await spawnTestServer()

  try {
    const a = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId: 1001, passCode: '111111' }),
    }).then(r => r.json())
    const b = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId: 1001, passCode: '111111' }),
    }).then(r => r.json())

    // Connect both, join cluster.
    const wsB = new WebSocket(wsUrl)
    await new Promise((res, rej) => { wsB.once('open', res); wsB.once('error', rej) })
    const msgsB = []
    wsB.on('message', raw => { try { msgsB.push(JSON.parse(raw.toString())) } catch {} })
    wsB.send(JSON.stringify({ t: 'AUTH', token: b.token }))
    await waitFor(() => msgsB.some(m => m.t === 'WELCOME'), 2000)
    wsB.send(JSON.stringify({ t: 'JOIN_CLUSTER' }))

    const wsA = new WebSocket(wsUrl)
    await new Promise((res, rej) => { wsA.once('open', res); wsA.once('error', rej) })
    const msgsA = []
    wsA.on('message', raw => { try { msgsA.push(JSON.parse(raw.toString())) } catch {} })
    wsA.send(JSON.stringify({ t: 'AUTH', token: a.token }))
    await waitFor(() => msgsA.some(m => m.t === 'WELCOME'), 2000)
    wsA.send(JSON.stringify({ t: 'JOIN_CLUSTER' }))
    await waitFor(() => msgsB.some(m => m.t === 'PEER_JOINED' && m.peer?.sessionId === a.sessionId), 2000)

    // Release A.
    const rel = await fetch(`${base}/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: a.token }),
    })
    assert.equal(rel.status, 204)

    // Token must be dead.
    const dead = await fetch(`${base}/turn-credentials`, {
      headers: { Authorization: `Bearer ${a.token}` },
    })
    assert.equal(dead.status, 401, 'released token must be unusable')

    // B must see PEER_LEFT for A.
    await waitFor(
      () => msgsB.some(m => m.t === 'PEER_LEFT' && m.sessionId === a.sessionId),
      2000,
    )

    // Release is idempotent on unknown token.
    const rel2 = await fetch(`${base}/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: a.token }),
    })
    assert.equal(rel2.status, 204)

    wsA.close(); wsB.close()
    console.log('✅ release terminates session + PEER_LEFT')
  } finally {
    await killChild(proc)
  }
}

function waitFor(pred, ms) {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (pred()) return resolve(true)
      if (Date.now() - start > ms) return reject(new Error('timeout'))
      setTimeout(tick, 20)
    }
    tick()
  })
}
