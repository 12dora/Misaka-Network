#!/usr/bin/env node
/**
 * WS rate-violation sliding window on the SAME socket: a burst that would
 * close if accumulated, after waiting out the window, must not inherit those
 * strikes. A fresh-socket-only test cannot discriminate this property.
 */
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import { runTest, killChild, spawnTestServer } from './_harness.mjs'

runTest(main, { timeoutMs: 60_000 })

async function main() {
  // Tiny burst + low violation max + short window so we can cross the boundary
  // on one socket inside CI time.
  const WINDOW_MS = 400
  const { proc, base, wsUrl } = await spawnTestServer({
    WS_MSG_BURST: '2',
    WS_MSG_RATE_PER_SEC: '1',
    WS_MAX_RATE_VIOLATIONS: '5',
    WS_RATE_VIOLATION_WINDOW_MS: String(WINDOW_MS),
    WS_AUTH_GRACE_MS: '10000',
  })

  try {
    const reg = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId: 19200, passCode: '121212' }),
    }).then(r => r.json())

    const ws = await openWS(wsUrl)
    ws.send(JSON.stringify({ t: 'AUTH', token: reg.token }))
    await waitWelcome(ws)

    // Burst 1: enough over-budget frames to approach but stay under the close
    // threshold (max=5). With burst=2 and rate=1, most of these are violations.
    for (let i = 0; i < 4; i++) ws.send(JSON.stringify({ t: 'PING' }))
    await sleep(150)
    assert.equal(ws.readyState, WebSocket.OPEN, 'under-threshold burst must keep socket open')

    // Cross the violation window on the SAME socket. If decay is broken, the
    // next burst's violations stack with the first and trip the close.
    await sleep(WINDOW_MS + 200)

    // Burst 2: same size as burst 1 — under threshold only if burst 1 decayed.
    for (let i = 0; i < 4; i++) ws.send(JSON.stringify({ t: 'PING' }))
    await sleep(200)
    assert.equal(
      ws.readyState,
      WebSocket.OPEN,
      'same-socket post-window burst must not inherit prior violations',
    )

    // Sustained over-budget still closes (proves the counter is live, not disabled).
    for (let i = 0; i < 30; i++) ws.send(JSON.stringify({ t: 'PING' }))
    const closed = await waitClose(ws, 5000)
    assert.ok(closed, 'sustained over-budget must close')
    assert.equal(closed.code, 1008)

    console.log('✅ WS same-socket violation-window decay tests passed')
  } finally {
    await killChild(proc)
  }
}

function openWS(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

function waitWelcome(ws) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no WELCOME')), 3000)
    ws.on('message', raw => {
      try {
        const m = JSON.parse(raw.toString())
        if (m.t === 'WELCOME') { clearTimeout(t); resolve(m) }
      } catch { /* */ }
    })
  })
}

function waitClose(ws, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no close')), ms)
    ws.once('close', (code, reason) => {
      clearTimeout(t)
      resolve({ code, reason: reason.toString() })
    })
  })
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
