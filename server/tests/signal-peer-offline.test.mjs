#!/usr/bin/env node
/**
 * P1-8: signaling forwards directed at a target that is no longer online
 * trigger a PEER_OFFLINE reply to the sender (instead of being silently
 * dropped). The client uses this to drop the stale entry from its peer
 * list, avoiding the half-open transfer hangs we saw in QA.
 *
 * We reproduce the scenario with two clients joined to the same identity
 * cluster: client A sends a SIGNAL_SDP to client B, then B disconnects,
 * then A sends another SIGNAL_SDP — the second send should come back as
 * PEER_OFFLINE.
 */

import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { WebSocket } from 'ws'
import { runTest, killChild } from './_harness.mjs'

runTest(main, { timeoutMs: 30_000 })

const __dirname = dirname(fileURLToPath(import.meta.url))
const SERVER_DIR = join(__dirname, '..')
const PORT = 18977
const BASE = `http://localhost:${PORT}/api`
const WS_URL = `ws://localhost:${PORT}/ws`

let serverProcess = null

async function main() {
  console.log('[1] 启动测试服务器...')
  serverProcess = startServer()
  await waitForServer()

  let failed = 0
  try {
    await testPeerOffline()
    console.log('  ✓ SIGNAL_SDP 目标下线 → 发送方收到 PEER_OFFLINE')
  } catch (e) {
    console.error(`  ✗ ${e.stack || e.message}`)
    failed++
  }

  killChild(serverProcess)

  if (failed > 0) {
    console.error(`\n❌ ${failed} 用例失败`)
    process.exitCode = 1
    return
  }
  console.log('\n✅ 全部测试通过')
}

async function testPeerOffline() {
  // Two devices for the same identity → they auto-join the same cluster.
  const nodeId = 17090
  const code = '123456'
  const regA = await post('/register', { nodeId, passCode: code })
  const regB = await post('/register', { nodeId, passCode: code })
  if (!regA.token || !regB.token) throw new Error('register 失败')

  const a = await openAndAuth(regA.token)
  const b = await openAndAuth(regB.token)

  // Both join cluster. After the second JOIN, A will have seen a
  // PEER_JOINED for B (carrying B's sessionId).
  a.ws.send(JSON.stringify({ t: 'JOIN_CLUSTER' }))
  b.ws.send(JSON.stringify({ t: 'JOIN_CLUSTER' }))

  const joined = await waitFor(() => a.messages.find(m => m.t === 'PEER_JOINED'), 3000)
  const targetSessionId = joined.peer.sessionId

  // Sanity: first SIGNAL_SDP should reach B.
  a.ws.send(JSON.stringify({ t: 'SIGNAL_SDP', targetSessionId, sdp: { type: 'offer', sdp: 'v=0' } }))
  await waitFor(() => b.messages.find(m => m.t === 'SIGNAL_SDP'), 2000)

  // B disconnects.
  b.ws.close()
  await sleep(300)   // let the server clean up B's slot

  // Snapshot A's message count, then send again. A should now receive
  // PEER_OFFLINE carrying B's sessionId.
  const before = a.messages.length
  a.ws.send(JSON.stringify({ t: 'SIGNAL_SDP', targetSessionId, sdp: { type: 'offer', sdp: 'v=0' } }))

  // A may also still receive a stale PEER_LEFT from the close; we look
  // specifically for PEER_OFFLINE.
  const offline = await waitFor(() => a.messages.slice(before).find(m => m.t === 'PEER_OFFLINE'), 2000)
  if (offline.targetSessionId !== targetSessionId) {
    throw new Error(`PEER_OFFLINE.targetSessionId 不匹配: ${offline.targetSessionId} vs ${targetSessionId}`)
  }

  a.ws.close()
}

// ── Helpers ──────────────────────────────────────────────────────────

async function openAndAuth(token) {
  const ws = new WebSocket(WS_URL)
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  const messages = []
  ws.on('message', raw => { try { messages.push(JSON.parse(raw.toString())) } catch {} })
  ws.send(JSON.stringify({ t: 'AUTH', token }))
  await waitFor(() => messages.find(m => m.t === 'WELCOME'), 2000)
  return { ws, messages }
}

async function waitFor(probe, ms) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    const v = probe()
    if (v) return v
    await sleep(50)
  }
  throw new Error(`waitFor 超时 (${ms}ms)`)
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
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
    try {
      const res = await fetch(`${BASE}/health`)
      if (res.ok) return
    } catch { /* not ready */ }
    await sleep(300)
  }
  throw new Error('服务器启动超时')
}
