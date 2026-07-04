#!/usr/bin/env node
/**
 * Regression [P1]: on reconnect (mobile network handoff, sleep/wake) the client
 * re-sends AUTH with the same cached token, so the server reuses the SAME
 * NodeSession and re-points session.socket at the new ws WITHOUT closing the old
 * one. When the old half-open socket finally fired its 'close' event, the
 * (unguarded) close handler nulled session.socket — which now pointed at the
 * LIVE reconnected socket — removed the session from its channel, and broadcast
 * PEER_LEFT, rendering a fully-connected peer invisible/unreachable.
 *
 * Fix: (1) close the superseded socket on AUTH re-attach; (2) guard the close
 * handler with `session.socket !== ws` so a stale socket's late close can't tear
 * down a session that a newer socket now owns.
 *
 * We register one identity twice (device A + a watcher B in the same cluster),
 * connect A on ws1, then reconnect A on ws2 with the same token, let ws1 close,
 * and assert the watcher B never sees a PEER_LEFT for A and that ws2 stays live.
 *
 * Usage: node tests/ws-reconnect-supersede.test.mjs
 */

import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { WebSocket } from 'ws'
import { runTest, killChild } from './_harness.mjs'

runTest(main, { timeoutMs: 30_000 })

const __dirname = dirname(fileURLToPath(import.meta.url))
const SERVER_DIR = join(__dirname, '..')
const PORT = 18962
const BASE = `http://localhost:${PORT}/api`
const WS_URL = `ws://localhost:${PORT}/ws`

const NODE_ID = 15500
const PASS = '424242'

let serverProcess = null

async function main() {
  console.log('[1] 启动测试服务器...')
  serverProcess = startServer()
  await waitForServer()

  let failed = 0
  try {
    await testReconnectDoesNotEvictLiveSession()
    console.log('  ✓ reconnect keeps the session live; watcher sees no bogus PEER_LEFT')
  } catch (e) {
    console.error(`  ✗ ${e.stack || e.message}`)
    failed++
  }

  killChild(serverProcess)
  if (failed > 0) { console.error(`\n❌ ${failed} 用例失败`); process.exitCode = 1; return }
  console.log('\n✅ 全部测试通过')
}

async function testReconnectDoesNotEvictLiveSession() {
  // Two devices of the SAME identity → same cluster channel.
  const regA = await post('/register', { nodeId: NODE_ID, passCode: PASS })
  const regB = await post('/register', { nodeId: NODE_ID, passCode: PASS })
  if (!regA.token || !regB.token) throw new Error('register failed')

  // Watcher B: auth + join, collect messages.
  const wsB = await openWS()
  const msgsB = []
  wsB.on('message', raw => { try { msgsB.push(JSON.parse(raw.toString())) } catch { /* ignore */ } })
  wsB.send(JSON.stringify({ t: 'AUTH', token: regB.token }))
  await waitFor(() => msgsB.find(m => m.t === 'WELCOME'), 1500)
  wsB.send(JSON.stringify({ t: 'JOIN_CLUSTER' }))

  // Device A on ws1: auth + join. B should see A join the cluster.
  const wsA1 = await openWS()
  const msgsA1 = []
  wsA1.on('message', raw => { try { msgsA1.push(JSON.parse(raw.toString())) } catch { /* ignore */ } })
  wsA1.send(JSON.stringify({ t: 'AUTH', token: regA.token }))
  await waitFor(() => msgsA1.find(m => m.t === 'WELCOME'), 1500)
  wsA1.send(JSON.stringify({ t: 'JOIN_CLUSTER' }))
  const joinedA = await waitFor(
    () => msgsB.find(m => m.t === 'PEER_JOINED' && m.peer?.sessionId === regA.sessionId),
    1500,
  )
  if (!joinedA) throw new Error('watcher never saw A join the cluster')

  // Reconnect A on ws2 with the SAME token. The server must close ws1
  // (SUPERSEDED) and keep the session pointed at ws2.
  const wsA2 = await openWS()
  const msgsA2 = []
  wsA2.on('message', raw => { try { msgsA2.push(JSON.parse(raw.toString())) } catch { /* ignore */ } })
  const ws1ClosePromise = waitForClose(wsA1, 3000).catch(() => null)
  wsA2.send(JSON.stringify({ t: 'AUTH', token: regA.token }))
  const welcome2 = await waitFor(() => msgsA2.find(m => m.t === 'WELCOME'), 1500)
  if (welcome2.sessionId !== regA.sessionId) throw new Error('ws2 WELCOME should reuse the same sessionId')

  // ws1 should be closed by the server (superseded).
  await ws1ClosePromise

  // Record how many PEER_LEFT(A) B had seen up to now, then wait for the window
  // in which the buggy stale-close would have fired one.
  const before = msgsB.filter(m => m.t === 'PEER_LEFT' && m.sessionId === regA.sessionId).length
  await sleep(800)
  const after = msgsB.filter(m => m.t === 'PEER_LEFT' && m.sessionId === regA.sessionId).length
  if (after > before) throw new Error('watcher received a bogus PEER_LEFT for the reconnected session')

  // ws2 must be alive and serviced.
  const pong = await roundTripPing(wsA2, msgsA2)
  if (!pong) throw new Error('reconnected socket ws2 is not live (no PONG)')

  wsA2.close(); wsB.close()
}

// ── Helpers ──────────────────────────────────────────────────────────

async function roundTripPing(ws, msgs) {
  const before = msgs.filter(m => m.t === 'PONG').length
  ws.send(JSON.stringify({ t: 'PING' }))
  try {
    await waitFor(() => msgs.filter(m => m.t === 'PONG').length > before, 1500)
    return true
  } catch { return false }
}

function openWS() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL)
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

function waitForClose(ws, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`未在 ${ms}ms 内收到 close`)), ms)
    ws.once('close', (code, reason) => { clearTimeout(t); resolve({ code, reason: reason.toString() }) })
  })
}

async function waitFor(probe, ms) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    const v = probe()
    if (v) return v
    await sleep(40)
  }
  throw new Error(`waitFor 超时 (${ms}ms)`)
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  return res.json()
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function startServer() {
  const proc = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: SERVER_DIR,
    env: { ...process.env, PORT: String(PORT), MAX_NODES: '200', TURN_AUTO_ENABLED: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  proc.stderr.on('data', (d) => {
    const s = d.toString()
    if (!s.includes('ExperimentalWarning')) process.stderr.write(d)
  })
  return proc
}

async function waitForServer() {
  for (let i = 0; i < 25; i++) {
    try { const res = await fetch(`${BASE}/health`); if (res.ok) return } catch { /* not ready */ }
    await sleep(300)
  }
  throw new Error('服务器启动超时')
}
