#!/usr/bin/env node
/**
 * SIGNAL_ICE_END 信令集成测试
 *
 * 启动信令服务器，验证：
 * 1. SIGNAL_ICE_END 通过 schema 校验（错误 schema 会被丢弃，不会转发）
 * 2. 同 channel 的两节点之间能正确转发 SIGNAL_ICE_END，dest 收到
 *    { t: 'SIGNAL_ICE_END', fromSessionId, fromNodeId }
 * 3. 不在同一 channel 时不会转发
 *
 * Usage: cd server && npx tsx tests/signaling-end.test.mjs
 */

import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { WebSocket } from 'ws'
import { runTest, killChild, spawn } from './_harness.mjs'

runTest(main)

const __dirname = dirname(fileURLToPath(import.meta.url))
const SERVER_DIR = join(__dirname, '..')
const PORT = 19099
const BASE = `http://localhost:${PORT}/api`
const WS_URL = `ws://localhost:${PORT}/ws`

let serverProcess = null

async function main() {
  console.log('[1/4] 启动测试服务器...')
  serverProcess = startServer()
  await waitForServer()

  try {
    await testEndToPeer()
    await testCrossChannelDoesNotForward()
    await testInvalidSchemaIgnored()
    console.log('\n✅ 全部测试通过')
  } catch (e) {
    console.error(`\n❌ 测试失败: ${e.message}`)
    if (e.stack) console.error(e.stack)
    process.exitCode = 1
  } finally {
    killChild(serverProcess)
  }
}

// ── Test: end-of-candidates forwarded between channel peers ─────────

async function testEndToPeer() {
  console.log('[2/4] 同 channel 两节点之间转发 SIGNAL_ICE_END...')

  // Same nodeId + passcode → both sessions land in the same cluster channel.
  const passCode = '424242'
  const nodeId = 17001
  const a = await registerAndConnect(nodeId, passCode)
  const b = await registerAndConnect(nodeId, passCode)

  // Wait for PEER_JOINED so each side knows the other's sessionId
  const aPeer = await waitForPeerJoined(a)
  const bPeer = await waitForPeerJoined(b)
  assert(aPeer.peer.sessionId === b.sessionId, 'A 应看到 B')
  assert(bPeer.peer.sessionId === a.sessionId, 'B 应看到 A')

  // A → SIGNAL_ICE_END → server forwards to B
  const recv = nextMessageMatching(b, m => m.t === 'SIGNAL_ICE_END', 'SIGNAL_ICE_END@B')
  const candidate = {
    candidate: '',
    sdpMid: 'video',
    sdpMLineIndex: 1,
    usernameFragment: 'videoB+/9',
  }
  a.ws.send(JSON.stringify({
    t: 'SIGNAL_ICE_END',
    targetSessionId: b.sessionId,
    candidate,
  }))
  const msg = await withTimeout(recv, 1500, 'B 未在 1.5s 内收到 SIGNAL_ICE_END')

  assertEq(msg.t, 'SIGNAL_ICE_END', '消息类型')
  assertEq(msg.fromSessionId, a.sessionId, 'fromSessionId 应等于 A')
  assertEq(msg.fromNodeId, nodeId, 'fromNodeId 应正确')
  assertEq(msg.candidate?.candidate, '', 'EOC candidate 应为空')
  assertEq(msg.candidate?.sdpMid, 'video', 'EOC sdpMid 应保留')
  assertEq(msg.candidate?.sdpMLineIndex, 1, 'EOC m-line 应保留')
  assertEq(msg.candidate?.usernameFragment, 'videoB+/9', 'EOC ufrag 应保留')
  console.log('   ✓ B 收到带原始 media locator 的 SIGNAL_ICE_END')

  b.buf.clear()
  a.ws.send(JSON.stringify({
    t: 'SIGNAL_ICE_END',
    targetSessionId: b.sessionId,
    candidate: {
      candidate: '',
      sdpMid: 'video',
      sdpMLineIndex: 1,
      usernameFragment: 'B evil\r\ninjected',
    },
  }))
  const invalid = (await collectMessagesFor(b, 250))
    .find(m => m.t === 'SIGNAL_ICE_END')
  assert(!invalid, '非法 ICE ufrag 不应被转发')

  a.ws.close()
  b.ws.close()
}

// ── Test: not-in-channel must not forward ───────────────────────────

async function testCrossChannelDoesNotForward() {
  console.log('[3/4] 不同 channel 不转发...')

  const a = await registerAndConnect(17100, '111111')
  const b = await registerAndConnect(17101, '222222')

  // Different identities → different cluster channels. SIGNAL_ICE_END must
  // not leak across channels. Drain anything we receive on B for 800ms and
  // verify no SIGNAL_ICE_END appears.
  b.buf.clear()
  a.ws.send(JSON.stringify({ t: 'SIGNAL_ICE_END', targetSessionId: b.sessionId }))
  const msgs = await collectMessagesFor(b, 800)

  const leak = msgs.find(m => m.t === 'SIGNAL_ICE_END')
  assert(!leak, `不在同一 channel 不应转发，但收到了: ${JSON.stringify(leak)}`)
  console.log('   ✓ 跨 channel 的 SIGNAL_ICE_END 被丢弃')

  a.ws.close()
  b.ws.close()
}

// ── Test: invalid schema doesn't crash and doesn't forward ──────────

async function testInvalidSchemaIgnored() {
  console.log('[4/4] 错误 schema 不会引发副作用...')

  const a = await registerAndConnect(17200, '333333')
  // Missing targetSessionId → schema rejects → server silently ignores.
  // We just verify the connection survives a few seconds and PING/PONG works.
  a.ws.send(JSON.stringify({ t: 'SIGNAL_ICE_END' }))
  await sleep(200)
  const pong = nextMessageMatching(a, m => m.t === 'PONG', 'PONG')
  a.ws.send(JSON.stringify({ t: 'PING' }))
  await withTimeout(pong, 1000, '畸形消息后 PING/PONG 应仍然工作')
  console.log('   ✓ 畸形 SIGNAL_ICE_END 被丢弃，连接仍然存活')
  a.ws.close()
}

// ── helpers ─────────────────────────────────────────────────────────

// Buffered message reader: drains every WS message into a queue so that a
// `waitFor` can match messages received before the call was made.
function makeBuffer(ws) {
  const queue = []
  const waiters = []

  function tryResolve() {
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i]
      const idx = queue.findIndex(w.predicate)
      if (idx >= 0) {
        const [m] = queue.splice(idx, 1)
        clearTimeout(w.timer)
        waiters.splice(i, 1)
        w.resolve(m)
      }
    }
  }

  ws.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw.toString()) } catch { return }
    queue.push(msg)
    tryResolve()
  })

  return {
    waitFor(predicate, timeoutMs = 2000, label = '') {
      const idx = queue.findIndex(predicate)
      if (idx >= 0) {
        const [m] = queue.splice(idx, 1)
        return Promise.resolve(m)
      }
      return new Promise((resolve, reject) => {
        const w = { predicate, resolve }
        w.timer = setTimeout(() => {
          const i = waiters.indexOf(w)
          if (i >= 0) waiters.splice(i, 1)
          reject(new Error(`waitFor 超时 (${timeoutMs}ms)${label ? ' — ' + label : ''}`))
        }, timeoutMs)
        waiters.push(w)
      })
    },
    snapshot() { return queue.slice() },
    clear() { queue.length = 0 },
  }
}

async function registerAndConnect(nodeId, passCode) {
  const reg = await post('/register', { nodeId, passCode })
  if (!reg.token) throw new Error(`register failed: ${JSON.stringify(reg)}`)

  const ws = new WebSocket(WS_URL)
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  const buf = makeBuffer(ws)

  ws.send(JSON.stringify({ t: 'AUTH', token: reg.token }))
  const welcome = await buf.waitFor(m => m.t === 'WELCOME', 2000, 'WELCOME')
  ws.send(JSON.stringify({ t: 'JOIN_CLUSTER' }))
  // JOIN_CLUSTER has no ack; small delay so the channel membership is set
  // before subsequent calls examine peer state.
  await sleep(50)
  return { ws, buf, sessionId: welcome.sessionId, nodeId: welcome.myNodeId }
}

function waitForPeerJoined(conn) {
  return conn.buf.waitFor(m => m.t === 'PEER_JOINED', 2000, 'PEER_JOINED')
}

function nextMessageMatching(conn, predicate, label) {
  return conn.buf.waitFor(predicate, 2000, label)
}

async function collectMessagesFor(conn, ms) {
  await sleep(ms)
  return conn.buf.snapshot()
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label)), ms)),
  ])
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

function assertEq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg}: 期望 ${expected}, 实际 ${actual}`)
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

function startServer() {
  const proc = spawn('node', ['dist/index.js'], {
    cwd: SERVER_DIR,
    env: { ...process.env, PORT: String(PORT), MAX_NODES: '200', TURN_AUTO_ENABLED: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  proc.stderr.on('data', (d) => {
    const s = d.toString()
    if (!s.includes('ExperimentalWarning')) process.stderr.write(d)
  })
  proc.on('error', (err) => {
    console.error(`无法启动服务器: ${err.message}`)
    process.exit(1)
  })
  return proc
}

async function waitForServer() {
  for (let i = 0; i < 25; i++) {
    try {
      const res = await fetch(`${BASE}/stats`)
      if (res.ok) return
    } catch { /* server not ready */ }
    await sleep(300)
  }
  throw new Error('服务器启动超时')
}
