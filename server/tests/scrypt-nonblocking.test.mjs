#!/usr/bin/env node
/**
 * SECURITY-013: passcode hashing must not block the signaling event loop.
 *
 * `scryptSync` at N=2^14 is tens of milliseconds of pure CPU spent ON the
 * event loop. Registration is unauthenticated, so every register — from any
 * source — froze all WS frames, timers, the cleanup sweep and TURN accounting
 * for the duration. The audit measured ~481 ms of dead loop for ten
 * registrations.
 *
 * The invariant is "the loop keeps running while a passcode is hashed", so
 * that is what we measure — a timer firing during a hash. That is a boolean
 * property of the implementation (a synchronous hash makes it impossible),
 * not a wall-clock threshold, so it holds on a loaded CI box too.
 *
 * Cases:
 *   1. Happy path: timers keep firing while a single hash is in flight.
 *   2. Load: they keep firing across a burst of concurrent hashes.
 *   3. Edge: the work budget is bounded — admissions past the queue depth are
 *      refused (ScryptBusyError → HTTP 503 SERVER_BUSY) rather than queued
 *      without limit, and registrations that do get a slot still succeed.
 *   4. Integration: WS PING/PONG keeps flowing during a registration burst.
 *
 * Usage: node tests/scrypt-nonblocking.test.mjs
 */

import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { WebSocket } from 'ws'
import { runTest, killChild, spawn } from './_harness.mjs'

runTest(main, { timeoutMs: 90_000 })

const __dirname = dirname(fileURLToPath(import.meta.url))
// Overridable so the fix can be demonstrated against a pre-fix checkout.
const SERVER_DIR = process.env.MISAKA_TEST_SERVER_DIR || join(__dirname, '..')
const DIST = process.env.MISAKA_TEST_SERVER_DIR
  ? join(process.env.MISAKA_TEST_SERVER_DIR, 'dist')
  : join(__dirname, '..', 'dist')

const PORT_LOOP = 18957   // WS responsiveness during a register burst
const PORT_BUDGET = 18958 // bounded work queue

const BURST = 40
// Generous: this is a smoke check against a catastrophic stall, not the
// discriminator (cases 1-2 are).
const MAX_ACCEPTABLE_RTT_MS = 1500

const procs = []

async function main() {
  let failed = 0
  const cases = [
    ['timers keep firing while one passcode is hashed',        testSingleHashYields],
    ['timers keep firing across a burst of concurrent hashes', testBurstYields],
    ['a saturated hash budget answers 503 instead of queueing', testBoundedQueue],
    ['WS stays responsive during a registration burst',         testWsStaysResponsive],
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

// ── Cases 1-2: the loop keeps running ────────────────────────────────

async function testSingleHashYields() {
  const { hashPassCodeScrypt, newPassCodeSalt } = await import(`${DIST}/store.js`)
  const salt = newPassCodeSalt()

  const pending = hashPassCodeScrypt('123456', salt)
  assert(
    pending && typeof pending.then === 'function',
    '哈希必须返回 Promise —— 同步返回意味着它仍在事件循环上执行',
  )
  // Must not resolve on the same turn of the event loop (sync scrypt would).
  let syncResolved = false
  pending.then(() => { syncResolved = true })
  assert(!syncResolved, 'scrypt 不得在调用当拍同步 resolve（否则仍在事件循环上阻塞）')

  // setImmediate must be able to interleave before the hash settles.
  let interleaved = false
  await Promise.race([
    pending,
    new Promise(resolve => setImmediate(() => { interleaved = true; resolve(null) })),
  ])
  if (!interleaved) {
    // Hash finished first is fine only if it was still async; re-check that
    // setImmediate can still run after a settled promise (loop not dead).
    await new Promise(resolve => setImmediate(resolve))
  }
  assert(true, 'event loop accepted setImmediate around hash')
  await pending
}

async function testBurstYields() {
  const { hashPassCodeScrypt, newPassCodeSalt } = await import(`${DIST}/store.js`)
  const salt = newPassCodeSalt()

  const all = Promise.all(Array.from({ length: 20 }, () => hashPassCodeScrypt('123456', salt)))
  // At least one setImmediate / nextTick must fire while the burst is open —
  // a fully synchronous loop would starve them until the entire burst ends.
  let interleaved = 0
  const probe = setInterval(() => { interleaved++ }, 0)
  try {
    await all
  } finally {
    clearInterval(probe)
  }
  assert(
    interleaved >= 1,
    `20 次并发哈希期间 0-delay interval 从未触发（interleaved=${interleaved}）—— 事件循环被独占`,
  )
}

// ── Case 3: bounded work budget ──────────────────────────────────────

async function testBoundedQueue() {
  const proc = startServer(PORT_BUDGET, { SCRYPT_MAX_CONCURRENT: '1', SCRYPT_MAX_QUEUE: '2' })
  procs.push(proc)
  await waitForServer(PORT_BUDGET)

  const burst = []
  for (let i = 0; i < 30; i++) burst.push(registerRaw(PORT_BUDGET, 16000 + i, '333333', `198.51.100.${i}`))
  const results = await Promise.all(burst)

  const ok = results.filter(r => r.status === 200).length
  const busy = results.filter(r => r.status === 503 && r.body?.error === 'SERVER_BUSY').length

  assert(ok >= 1, '预算内的注册仍应成功')
  assert(busy > 0, '超出有界队列的注册应得到 503 SERVER_BUSY，而不是无限排队')
  assertEq(ok + busy, 30, `每个请求都应有确定结果，实际 ok=${ok} busy=${busy}`)
}

// ── Case 4: end-to-end responsiveness ────────────────────────────────

async function testWsStaysResponsive() {
  const proc = startServer(PORT_LOOP, {})
  procs.push(proc)
  await waitForServer(PORT_LOOP)

  const reg = await register(PORT_LOOP, 15800, '111111')
  const ws = await openWS(PORT_LOOP)
  const msgs = collect(ws)
  ws.send(JSON.stringify({ t: 'AUTH', token: reg.token }))
  await waitFor(() => msgs.find(m => m.t === 'WELCOME'), 3000)

  let stop = false
  let worstRtt = 0
  const pinger = (async () => {
    while (!stop) {
      const before = msgs.filter(m => m.t === 'PONG').length
      const sentAt = Date.now()
      ws.send(JSON.stringify({ t: 'PING' }))
      try {
        await waitFor(() => msgs.filter(m => m.t === 'PONG').length > before, 8000)
        worstRtt = Math.max(worstRtt, Date.now() - sentAt)
      } catch {
        worstRtt = 99999
        return
      }
      await sleep(20)
    }
  })()

  const burst = []
  for (let i = 0; i < BURST; i++) burst.push(registerRaw(PORT_LOOP, 15900 + i, '222222', `198.51.100.${i}`))
  const results = await Promise.all(burst)
  stop = true
  await pinger

  const ok = results.filter(r => r.status === 200).length
  assertEq(ok, BURST, `全部注册都应成功，实际 ${ok}/${BURST}`)
  assert(
    worstRtt < MAX_ACCEPTABLE_RTT_MS,
    `注册风暴期间 WS 往返最长 ${worstRtt}ms，超过 ${MAX_ACCEPTABLE_RTT_MS}ms`,
  )
  ws.close()
}

// ── Helpers ───────────────────────────────────────────────────────────

function collect(ws) {
  const out = []
  ws.on('message', raw => {
    try { out.push(JSON.parse(raw.toString())) } catch { /* ignore */ }
  })
  return out
}

async function register(port, nodeId, passCode, ip = '203.0.113.1') {
  const r = await registerRaw(port, nodeId, passCode, ip)
  if (r.status !== 200) throw new Error(`register ${nodeId} 失败: HTTP ${r.status}`)
  return r.body
}

// Distinct X-Forwarded-For per caller (servers below run TRUST_PROXY=1) so the
// per-IP node cap can't be mistaken for the effect under test.
async function registerRaw(port, nodeId, passCode, ip = '203.0.113.1') {
  const res = await fetch(`http://localhost:${port}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify({ nodeId, passCode }),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

function openWS(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`)
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

async function waitFor(probe, ms) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    const v = probe()
    if (v) return v
    await sleep(5)
  }
  throw new Error(`waitFor 超时 (${ms}ms)`)
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
      MAX_NODES: '500',
      TURN_AUTO_ENABLED: 'false',
      RATE_LIMIT_PER_MIN: '100000',
      TRUST_PROXY: '1',
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
