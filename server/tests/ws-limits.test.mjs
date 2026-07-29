#!/usr/bin/env node
/**
 * WebSocket abuse boundaries — SECURITY-002 / SECURITY-003, and the
 * WS half of TEST-014 (message-too-large, three-strike, 1009, rate limit,
 * slow-reader backpressure).
 *
 * Prior state:
 *   • No transport `maxPayload`. The 64 KiB check lived in the application
 *     `message` handler, i.e. AFTER `ws` had buffered the whole message and
 *     `raw.toString()` had copied it — an unauthenticated client could make
 *     the process allocate arbitrarily much before being told "too large".
 *   • No inbound budget of any kind: a registered node could stream
 *     well-formed SIGNAL_* frames as fast as the kernel delivered them, each
 *     costing a JSON.parse + zod parse + forward.
 *   • No `bufferedAmount` check on forwards: a peer that stopped reading made
 *     the server queue every frame destined for it, without limit.
 *   • No test referenced 1009, the strike counter, or any of the above.
 *
 * Four servers, because each boundary needs its own configuration:
 *   A — transport ceiling (WS_MAX_MESSAGE_BYTES=4096 → maxPayload=4096)
 *   B — application policy below the transport ceiling, to exercise the
 *       three-strike ERROR path that a raised transport limit leaves live
 *   C — inbound token bucket
 *   D — slow-reader backpressure
 *
 * Usage: node tests/ws-limits.test.mjs
 */

import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { WebSocket } from 'ws'
import { runTest, killChild, spawn } from './_harness.mjs'

runTest(main, { timeoutMs: 120_000 })

const __dirname = dirname(fileURLToPath(import.meta.url))
// Overridable so the fix can be demonstrated against a pre-fix checkout.
const SERVER_DIR = process.env.MISAKA_TEST_SERVER_DIR || join(__dirname, '..')

const PORT_A = 18961   // transport maxPayload
const PORT_B = 18962   // application strike path
const PORT_C = 18963   // inbound rate budget
const PORT_D = 18964   // slow-reader backpressure

const procs = []

async function main() {
  let failed = 0
  const cases = [
    ['A: message just under the limit is accepted',                testUnderLimitAccepted],
    ['A: oversize first frame → 1009 before any app-level ERROR',  testTransportRejectsOversize],
    ['A: fragmented oversize message → 1009, process survives',    testFragmentedOversize],
    ['B: three oversize strikes → ERROR ×2 then close 1009',       testThreeStrikes],
    ['C: flood is throttled, ERROR RATE_LIMITED, then close 1008', testInboundRateLimit],
    ['D: peer that stops reading is dropped, sender unaffected',   testSlowReaderDropped],
  ]

  try {
    for (const [name, fn] of cases) {
      try {
        await fn()
        console.log(`  ✓ ${name}`)
      } catch (e) {
        console.error(`  ✗ ${name}\n      ${e.stack || e.message}`)
        failed++
      }
    }
  } finally {
    for (const p of procs) killChild(p)
  }

  if (failed > 0) {
    console.error(`\n❌ ${failed} 用例失败`)
    process.exitCode = 1
    return
  }
  console.log('\n✅ 全部测试通过')
}

// ── A: transport ceiling ─────────────────────────────────────────────

let serverA = null
async function ensureA() {
  if (serverA) return
  serverA = startServer(PORT_A, { WS_MAX_MESSAGE_BYTES: '4096' })
  procs.push(serverA)
  await waitForServer(PORT_A)
}

async function testUnderLimitAccepted() {
  await ensureA()
  const reg = await register(PORT_A, 15100, '111111')
  const ws = await openWS(PORT_A)
  const msgs = collect(ws)
  ws.send(JSON.stringify({ t: 'AUTH', token: reg.token }))
  await waitFor(() => msgs.find(m => m.t === 'WELCOME'), 2000)

  // A well-formed frame a little under the ceiling must still round-trip.
  const padded = { t: 'SIGNAL_SDP', targetSessionId: 'nobody', sdp: { blob: 'x'.repeat(3500) } }
  const encoded = JSON.stringify(padded)
  assert(Buffer.byteLength(encoded) < 4096, '构造的消息应小于上限')
  ws.send(encoded)
  // Unknown target → PEER_OFFLINE. Proves the frame was parsed, not dropped.
  const reply = await waitFor(() => msgs.find(m => m.t === 'PEER_OFFLINE'), 2000)
  assertEq(reply.targetSessionId, 'nobody', '上限内的消息应被正常处理')
  ws.close()
}

async function testTransportRejectsOversize() {
  await ensureA()
  const ws = await openWS(PORT_A)
  const msgs = collect(ws)
  ws.on('error', () => { /* ws surfaces the 1009 abort as an error too */ })

  // 64 KiB — 16× the ceiling, sent before AUTH by an anonymous client.
  ws.send(JSON.stringify({ t: 'PING', pad: 'x'.repeat(64 * 1024) }))
  const closure = await waitForClose(ws, 5000)
  assertEq(closure.code, 1009, '超过 transport maxPayload 应以 1009 关闭')
  assert(
    !msgs.some(m => m.code === 'MESSAGE_TOO_LARGE'),
    '拒绝必须发生在 transport 层：应用层不应先缓冲完整消息再回 ERROR',
  )

  // The process must still be healthy for everyone else.
  const health = await (await fetch(`http://localhost:${PORT_A}/api/health`)).json()
  assertEq(health.ok, true, '超大帧不得影响服务进程')
}

async function testFragmentedOversize() {
  await ensureA()
  const ws = await openWS(PORT_A)
  ws.on('error', () => { /* expected on abort */ })

  // maxPayload is enforced on the ACCUMULATED length, so an attacker can't
  // dodge it by fragmenting. 8 × 1 KiB continuation frames cross the 4 KiB
  // ceiling partway through.
  for (let i = 0; i < 8; i++) ws.send('x'.repeat(1024), { fin: false })
  ws.send('y', { fin: true })

  const closure = await waitForClose(ws, 5000)
  assertEq(closure.code, 1009, '分片消息的累计长度也必须受 maxPayload 约束')

  const health = await (await fetch(`http://localhost:${PORT_A}/api/health`)).json()
  assertEq(health.ok, true, '分片攻击后服务仍存活')
}

// ── B: application strike path ───────────────────────────────────────

async function testThreeStrikes() {
  // Transport ceiling deliberately raised ABOVE the application policy limit
  // (the shape a deployment terminating WS at a re-framing proxy would use),
  // so the app-level check is the one that fires.
  const proc = startServer(PORT_B, { WS_MAX_MESSAGE_BYTES: '1024', WS_MAX_PAYLOAD_BYTES: '65536' })
  procs.push(proc)
  await waitForServer(PORT_B)

  const ws = await openWS(PORT_B)
  const msgs = collect(ws)
  ws.on('error', () => { /* ignore */ })

  const oversize = JSON.stringify({ t: 'PING', pad: 'x'.repeat(4096) })
  ws.send(oversize)
  ws.send(oversize)
  await waitFor(() => msgs.filter(m => m.code === 'MESSAGE_TOO_LARGE').length >= 2, 3000)

  ws.send(oversize)
  const closure = await waitForClose(ws, 3000)
  assertEq(closure.code, 1009, '第三次超限应以 1009 断开')
  assertEq(closure.reason, 'TOO_MANY_OVERSIZE', 'close reason 应说明原因')
  assertEq(
    msgs.filter(m => m.code === 'MESSAGE_TOO_LARGE').length, 3,
    '前三次都应回 ERROR，之后连接已关闭',
  )
}

// ── C: inbound rate budget ───────────────────────────────────────────

async function testInboundRateLimit() {
  const proc = startServer(PORT_C, {
    WS_MSG_BURST: '5',
    WS_MSG_RATE_PER_SEC: '1',
    WS_MAX_RATE_VIOLATIONS: '20',
  })
  procs.push(proc)
  await waitForServer(PORT_C)

  const reg = await register(PORT_C, 15200, '222222')
  const ws = await openWS(PORT_C)
  const msgs = collect(ws)
  ws.on('error', () => { /* ignore */ })
  // Arm the close listener up front — the flood below may well trip the
  // violation cap before we get a chance to await it.
  const closed = trackClose(ws)
  ws.send(JSON.stringify({ t: 'AUTH', token: reg.token }))
  await waitFor(() => msgs.find(m => m.t === 'WELCOME'), 2000)

  const before = msgs.length
  // 120 PINGs back to back against a bucket of 5 @ 1/s, cap 20 violations.
  for (let i = 0; i < 120; i++) ws.send(JSON.stringify({ t: 'PING' }))

  await waitFor(() => msgs.some(m => m.code === 'RATE_LIMITED'), 3000)

  const pongs = msgs.slice(before).filter(m => m.t === 'PONG').length
  assert(pongs <= 12, `超预算消息必须被丢弃，实际回了 ${pongs} 个 PONG`)

  // …and a socket that keeps overrunning is dropped, not served forever.
  const closure = await closed(5000)
  assertEq(closure.code, 1008, '持续超预算应以 1008 断开')
  assertEq(closure.reason, 'RATE_LIMITED', 'close reason 应说明原因')
}

// ── D: slow-reader backpressure ──────────────────────────────────────

async function testSlowReaderDropped() {
  const proc = startServer(PORT_D, {
    // Big inbound budget: this case is about the OUTBOUND queue, not rate.
    WS_MSG_BURST: '100000',
    WS_MSG_RATE_PER_SEC: '100000',
    WS_MAX_BUFFERED_BYTES: '65536',
    WS_MAX_BUFFERED_HARD_BYTES: '1048576',
    WS_SLOW_CONSUMER_GRACE_MS: '500',
  })
  procs.push(proc)
  await waitForServer(PORT_D)

  // Two devices of the SAME identity land in one cluster channel, so A can
  // address B directly.
  const a = await register(PORT_D, 15300, '333333')
  const b = await register(PORT_D, 15300, '333333')

  const wsA = await openWS(PORT_D)
  const wsB = await openWS(PORT_D)
  const msgsA = collect(wsA)
  const msgsB = collect(wsB)
  wsA.on('error', () => { /* ignore */ })
  wsB.on('error', () => { /* ignore */ })

  wsA.send(JSON.stringify({ t: 'AUTH', token: a.token }))
  wsB.send(JSON.stringify({ t: 'AUTH', token: b.token }))
  await waitFor(() => msgsA.find(m => m.t === 'WELCOME'), 2000)
  await waitFor(() => msgsB.find(m => m.t === 'WELCOME'), 2000)
  wsA.send(JSON.stringify({ t: 'JOIN_CLUSTER' }))
  wsB.send(JSON.stringify({ t: 'JOIN_CLUSTER' }))
  await waitFor(() => msgsA.find(m => m.t === 'PEER_JOINED') || msgsB.find(m => m.t === 'PEER_JOINED'), 3000)

  const online = await onlineNodes(PORT_D)
  assertEq(online, 2, '两个节点均在线')

  // B stops draining its socket entirely — the classic slow reader.
  wsB.pause()
  wsB._socket.pause()

  // Burst enough to push B over the soft mark, then STOP sending. The grace
  // timer must fire on its own — a "next send only" implementation would
  // leave B connected forever once the flood stops.
  const blob = 'x'.repeat(48 * 1024)
  const frame = JSON.stringify({ t: 'SIGNAL_SDP', targetSessionId: b.sessionId, sdp: { blob } })
  for (let i = 0; i < 80; i++) wsA.send(frame)

  // Processing barrier: a PING after the flood must elicit PONG only once the
  // server has drained every prior frame from A's receive queue. Without this,
  // on a slow runner the soft-mark (and grace arm) may not have been reached
  // yet when we start waiting — and a next-send-only implementation can still
  // pass if later processing coincides with the long wait window.
  const barrierId = msgsA.length
  wsA.send(JSON.stringify({ t: 'PING' }))
  await waitFor(() => msgsA.slice(barrierId).some(m => m.t === 'PONG'), 5000)

  // No further client frames during the grace window.
  const graceStart = Date.now()

  // The independent recheck timer (WS_SLOW_CONSUMER_GRACE_MS=500) must shed B
  // without any additional traffic from A. Bound the wait relative to grace
  // so we do not quietly accept a multi-second "eventually dropped" pass.
  const dropped = await waitForCond(async () => (await onlineNodes(PORT_D)) === 1, 3000)
  assert(dropped, '慢客户端必须在 grace 内被独立定时器断开（无需继续发送）')
  const elapsed = Date.now() - graceStart
  assert(elapsed < 2500, `shed must follow grace timer, not a long poll (elapsed ${elapsed}ms)`)

  // …and A must be untouched: shedding a slow reader is not allowed to take
  // the sender down with it.
  assertEq(wsA.readyState, WebSocket.OPEN, '发送方不应受影响')

  wsA.close()
  try { wsB.terminate() } catch { /* ignore */ }
}

// ── Helpers ───────────────────────────────────────────────────────────

function collect(ws) {
  const out = []
  ws.on('message', raw => {
    try { out.push(JSON.parse(raw.toString())) } catch { /* ignore */ }
  })
  return out
}

async function register(port, nodeId, passCode) {
  const res = await fetch(`http://localhost:${port}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodeId, passCode }),
  })
  if (!res.ok) throw new Error(`register ${nodeId} 失败: HTTP ${res.status}`)
  return res.json()
}

async function onlineNodes(port) {
  const res = await fetch(`http://localhost:${port}/api/health`)
  const body = await res.json()
  return body.onlineNodes
}

function openWS(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`)
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

/**
 * Start listening for 'close' immediately and hand back an awaitable. Needed
 * whenever the action under test may close the socket before the assertion
 * runs — a plain `waitForClose` after the fact would miss the event.
 */
function trackClose(ws) {
  let settle = null
  const result = new Promise(resolve => { settle = resolve })
  ws.once('close', (code, reason) => settle({ code, reason: reason.toString() }))
  return (ms) => Promise.race([
    result,
    sleep(ms).then(() => { throw new Error(`未在 ${ms}ms 内收到 close`) }),
  ])
}

function waitForClose(ws, ms) {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.CLOSED) {
      reject(new Error('连接已关闭，未捕获到 close 事件'))
      return
    }
    const t = setTimeout(() => reject(new Error(`未在 ${ms}ms 内收到 close`)), ms)
    ws.once('close', (code, reason) => {
      clearTimeout(t)
      resolve({ code, reason: reason.toString() })
    })
  })
}

async function waitFor(probe, ms) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    const v = probe()
    if (v) return v
    await sleep(25)
  }
  throw new Error(`waitFor 超时 (${ms}ms)`)
}

async function waitForCond(probe, ms) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (await probe()) return true
    await sleep(150)
  }
  return false
}

function assert(cond, msg) { if (!cond) throw new Error(msg) }
function assertEq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg}: 期望 ${JSON.stringify(expected)}, 实际 ${JSON.stringify(actual)}`)
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function startServer(port, extraEnv) {
  const proc = spawn('node', ['dist/index.js'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      MAX_NODES: '200',
      TURN_AUTO_ENABLED: 'false',
      RATE_LIMIT_PER_MIN: '100000',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  proc.stderr.on('data', (d) => {
    const s = d.toString()
    if (!s.includes('ExperimentalWarning')) process.stderr.write(d)
  })
  return proc
}

async function waitForServer(port) {
  for (let i = 0; i < 25; i++) {
    try {
      const res = await fetch(`http://localhost:${port}/api/health`)
      if (res.ok) return
    } catch { /* not ready */ }
    await sleep(300)
  }
  throw new Error(`服务器 ${port} 启动超时`)
}
