#!/usr/bin/env node
/**
 * SECURITY-005: WS IP resolution must follow the same Express trust-proxy
 * semantics as `req.ip`.
 *
 * The old `getWSIP` took the LEFT-MOST X-Forwarded-For entry whenever
 * TRUST_PROXY was enabled. That is the attacker-controlled end of the chain:
 * a proxy APPENDS the peer it observed, so a client sending
 * `X-Forwarded-For: <forged>` makes the header arrive as
 * `<forged>, <real client>` and the server picked `<forged>`. The forged
 * value was then written onto the session (`s.ip = getWSIP(req)`) on every
 * AUTH, poisoning the per-IP node cap, the brute-force lock, rate limits and
 * TURN byte attribution — and disagreeing with `req.ip` for the very same
 * client, which is how the two halves of the same defence end up keyed
 * differently.
 *
 * Cases:
 *   1. TRUST_PROXY=1 — the session IP after WS AUTH must equal what Express
 *      derives for an identical HTTP request (the RIGHT-most XFF entry, i.e.
 *      the address the trusted hop actually saw), NOT the forged left-most
 *      one. Observed through /api/release-by-ip, which is scoped by session
 *      IP.
 *   2. TRUST_PROXY=1 — the forged left-most address must NOT match any
 *      session, i.e. an attacker cannot make their session attributable to
 *      someone else's IP.
 *   3. TRUST_PROXY unset — XFF is ignored entirely and the socket address
 *      wins, exactly as on the HTTP side.
 *
 * Usage: node tests/ws-trust-proxy.test.mjs
 */

import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { WebSocket } from 'ws'
import { runTest, killChild, spawn } from './_harness.mjs'

runTest(main, { timeoutMs: 60_000 })

const __dirname = dirname(fileURLToPath(import.meta.url))
// Overridable so the fix can be demonstrated against a pre-fix checkout.
const SERVER_DIR = process.env.MISAKA_TEST_SERVER_DIR || join(__dirname, '..')

const PORT_TRUSTED = 18965
const PORT_UNTRUSTED = 18966

// `FORGED` is what a hostile client puts in the header itself; `REAL` is what
// the trusted proxy appends. A correct implementation must land on REAL.
const FORGED = '203.0.113.99'
const REAL = '198.51.100.7'
const CHAIN = `${FORGED}, ${REAL}`

const procs = []

async function main() {
  let failed = 0
  const cases = [
    ['TRUST_PROXY=1: WS session IP == Express req.ip (rightmost hop)', testTrustedHopWins],
    ['TRUST_PROXY=1: forged leftmost XFF owns nothing',               testForgedIpOwnsNothing],
    ['TRUST_PROXY unset: XFF on the upgrade is ignored',              testUntrustedIgnoresXff],
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

let trusted = null
async function ensureTrusted() {
  if (trusted) return
  trusted = startServer(PORT_TRUSTED, { TRUST_PROXY: '1' })
  procs.push(trusted)
  await waitForServer(PORT_TRUSTED)
}

// ── Cases ─────────────────────────────────────────────────────────────

async function testTrustedHopWins() {
  await ensureTrusted()
  const reg = await register(PORT_TRUSTED, 15400, '444444', CHAIN)
  await authenticateWS(PORT_TRUSTED, reg.token, CHAIN)

  // release-by-ip only touches sessions whose stored `ip` equals the caller's
  // Express-derived req.ip. Sending the same header makes req.ip = REAL, so a
  // release of 1 proves the WS wrote REAL onto the session.
  const released = await releaseByIp(PORT_TRUSTED, reg.token, CHAIN)
  assertEq(released, 1, 'WS AUTH 后的 session.ip 必须与 Express req.ip 一致（可信跳的地址）')
}

async function testForgedIpOwnsNothing() {
  await ensureTrusted()
  const reg = await register(PORT_TRUSTED, 15401, '555555', CHAIN)
  await authenticateWS(PORT_TRUSTED, reg.token, CHAIN)

  // Same bearer, but this call presents itself as coming straight from the
  // forged address. If the WS had stamped FORGED onto the session, this would
  // release it.
  const released = await releaseByIp(PORT_TRUSTED, reg.token, FORGED)
  assertEq(released, 0, '客户端伪造的最左侧 XFF 不得成为 session 的归属 IP')

  // The session is still there, keyed on the real hop.
  const releasedReal = await releaseByIp(PORT_TRUSTED, reg.token, CHAIN)
  assertEq(releasedReal, 1, '会话应仍归属于真实的可信跳地址')
}

async function testUntrustedIgnoresXff() {
  const proc = startServer(PORT_UNTRUSTED, {})   // TRUST_PROXY unset → OFF
  procs.push(proc)
  await waitForServer(PORT_UNTRUSTED)

  const reg = await register(PORT_UNTRUSTED, 15402, '666666', CHAIN)
  await authenticateWS(PORT_UNTRUSTED, reg.token, CHAIN)

  // Untrusted mode collapses everything to the socket address on both
  // transports, so a call carrying the same header still matches.
  const released = await releaseByIp(PORT_UNTRUSTED, reg.token, CHAIN)
  assertEq(released, 1, '不信任代理时 HTTP 与 WS 都应折叠到 socket 地址')
}

// ── Helpers ───────────────────────────────────────────────────────────

async function register(port, nodeId, passCode, xff) {
  const res = await fetch(`http://localhost:${port}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': xff },
    body: JSON.stringify({ nodeId, passCode }),
  })
  if (!res.ok) throw new Error(`register ${nodeId} 失败: HTTP ${res.status}`)
  return res.json()
}

async function releaseByIp(port, token, xff) {
  const res = await fetch(`http://localhost:${port}/api/release-by-ip`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'X-Forwarded-For': xff },
  })
  if (!res.ok) throw new Error(`release-by-ip 失败: HTTP ${res.status}`)
  const body = await res.json()
  return body.released
}

function authenticateWS(port, token, xff) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`, { headers: { 'X-Forwarded-For': xff } })
    const timer = setTimeout(() => {
      try { ws.terminate() } catch { /* ignore */ }
      reject(new Error('WS AUTH 超时'))
    }, 5000)
    ws.once('error', err => { clearTimeout(timer); reject(err) })
    ws.once('open', () => ws.send(JSON.stringify({ t: 'AUTH', token })))
    ws.on('message', raw => {
      let msg
      try { msg = JSON.parse(raw.toString()) } catch { return }
      if (msg.t !== 'WELCOME') return
      clearTimeout(timer)
      // Close before the assertion so the session's socket is gone but the
      // session (and its stamped IP) remain.
      ws.close()
      ws.once('close', () => resolve(msg))
    })
  })
}

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
      // Long, so nothing below can be explained by the idle sweep.
      DISCONNECTED_TTL_MS: '60000',
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
