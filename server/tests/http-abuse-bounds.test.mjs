#!/usr/bin/env node
/**
 * SECURITY-018 — public transfer stats must not be forgeable or overflowable.
 * SECURITY-016 — the E2E release-by-ip escape hatch must not be reachable in
 *                a production process.
 *
 * SECURITY-018 background: `/api/transfer-done` accepts a self-reported byte
 * count from any registered client and publishes the running total on the
 * unauthenticated `/api/stats`. The old schema was
 * `z.number().int().min(0).optional()` — and `Number.isInteger(1e308)` is
 * true, so a single call pushed `totalBytes` to 1e308 and a second one to
 * Infinity. There was no dedicated rate limit either, so the counters could
 * be inflated in a loop.
 *
 * SECURITY-016 background: `E2E_ALLOW_UNAUTH_RELEASE_BY_IP=1` alone turned
 * release-by-ip into "delete every session on my apparent IP", with no auth
 * and no environment gate. On a shared NAT / proxy-collapsed deployment that
 * is a mass-disconnect primitive available to anyone.
 *
 * Usage: node tests/http-abuse-bounds.test.mjs
 */

import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { runTest, killChild, spawn } from './_harness.mjs'

runTest(main, { timeoutMs: 90_000 })

const __dirname = dirname(fileURLToPath(import.meta.url))
// Overridable so the fix can be demonstrated against a pre-fix checkout.
const SERVER_DIR = process.env.MISAKA_TEST_SERVER_DIR || join(__dirname, '..')

const PORT_STATS = 18968   // transfer-done bounds
const PORT_PROD = 18969    // NODE_ENV=production + E2E flag set
const PORT_TEST = 18959    // E2E flag set, non-production (the harness shape)

const procs = []

async function main() {
  let failed = 0
  const cases = [
    ['stats: honest report is counted',                      testHonestReportCounted],
    ['stats: 1e308 bytes rejected, totals stay finite',      testOverflowRejected],
    ['stats: non-safe-integer + over-cap bytes rejected',    testUnrealisticBytesRejected],
    ['stats: repeated reports hit a dedicated rate limit',   testReportRateLimited],
    ['release: E2E bypass ignored when NODE_ENV=production', testBypassBlockedInProduction],
    ['release: E2E bypass still works for the test harness', testBypassWorksForHarness],
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

// ── SECURITY-018 ─────────────────────────────────────────────────────

let statsServer = null
async function ensureStatsServer() {
  if (statsServer) return
  statsServer = startServer(PORT_STATS, { TRANSFER_DONE_RATE_LIMIT: '5' })
  procs.push(statsServer)
  await waitForServer(PORT_STATS)
}

async function testHonestReportCounted() {
  await ensureStatsServer()
  const reg = await register(PORT_STATS, 15500, '111111')
  const before = await stats(PORT_STATS)

  const res = await transferDone(PORT_STATS, reg.token, 1024)
  assertEq(res.status, 204, '正常上报应成功')

  const after = await stats(PORT_STATS)
  assertEq(after.totalBytes - before.totalBytes, 1024, '字节数应如实累加')
  assertEq(after.totalTransfers - before.totalTransfers, 1, '传输次数应 +1')
}

async function testOverflowRejected() {
  await ensureStatsServer()
  const reg = await register(PORT_STATS, 15501, '222222')
  const before = await stats(PORT_STATS)

  const res = await transferDone(PORT_STATS, reg.token, 1e308)
  assertEq(res.status, 400, '1e308（JS 眼中的整数）必须被拒绝')

  const after = await stats(PORT_STATS)
  assertEq(after.totalBytes, before.totalBytes, '被拒绝的上报不得改变公共计数')
  assert(Number.isFinite(after.totalBytes), '公共计数必须保持有限')
}

async function testUnrealisticBytesRejected() {
  await ensureStatsServer()
  const reg = await register(PORT_STATS, 15502, '333333')
  const before = await stats(PORT_STATS)

  // Beyond Number.MAX_SAFE_INTEGER: still an "integer" to zod, but arithmetic
  // on it is no longer exact.
  const unsafe = await transferDone(PORT_STATS, reg.token, Number.MAX_SAFE_INTEGER + 2)
  assertEq(unsafe.status, 400, '超出安全整数范围的 bytes 必须被拒绝')

  // Within safe-integer range but far beyond any real transfer.
  const huge = await transferDone(PORT_STATS, reg.token, 900 * 1024 * 1024 * 1024 * 1024)
  assertEq(huge.status, 400, '超出现实体积上限的 bytes 必须被拒绝')

  const after = await stats(PORT_STATS)
  assertEq(after.totalBytes, before.totalBytes, '两次拒绝都不得改变公共计数')
}

async function testReportRateLimited() {
  await ensureStatsServer()
  const reg = await register(PORT_STATS, 15503, '444444')

  let limited = 0
  for (let i = 0; i < 12; i++) {
    const res = await transferDone(PORT_STATS, reg.token, 1)
    if (res.status === 429) limited++
  }
  assert(limited > 0, '重复上报必须触发专用频率限制（否则计数可被循环刷高）')

  const after = await stats(PORT_STATS)
  assert(Number.isFinite(after.totalBytes) && Number.isFinite(after.totalTransfers), '计数保持有限')
}

// ── SECURITY-016 ─────────────────────────────────────────────────────

async function testBypassBlockedInProduction() {
  const proc = startServer(PORT_PROD, {
    NODE_ENV: 'production',
    E2E_ALLOW_UNAUTH_RELEASE_BY_IP: '1',
  })
  procs.push(proc)
  await waitForServer(PORT_PROD)

  const victim = await register(PORT_PROD, 15600, '555555')
  assert(victim.token, '受害者会话已建立')

  const res = await fetch(`http://localhost:${PORT_PROD}/api/release-by-ip`, { method: 'POST' })
  assertEq(res.status, 401, '生产进程中误设的 E2E 开关不得授予未认证的 IP 级删除')

  // Session untouched: a different passcode on the same nodeId still conflicts.
  const collide = await registerRaw(PORT_PROD, 15600, '999999')
  assert(collide.status === 409 || collide.status === 423, `会话应完好，实际 ${collide.status}`)
}

async function testBypassWorksForHarness() {
  // Same flag, no NODE_ENV — this is exactly how client/playwright.config.ts
  // starts the signaling server, and that workflow must keep working.
  const proc = startServer(PORT_TEST, { E2E_ALLOW_UNAUTH_RELEASE_BY_IP: '1' })
  procs.push(proc)
  await waitForServer(PORT_TEST)

  await register(PORT_TEST, 15700, '666666')
  const res = await fetch(`http://localhost:${PORT_TEST}/api/release-by-ip`, { method: 'POST' })
  assertEq(res.status, 200, '测试环境下的 loopback 调用仍应被接受')
  const body = await res.json()
  assert(body.released >= 1, `应释放会话，实际 ${body.released}`)
}

// ── Helpers ───────────────────────────────────────────────────────────

async function register(port, nodeId, passCode) {
  const res = await fetch(`http://localhost:${port}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodeId, passCode }),
  })
  if (!res.ok) throw new Error(`register ${nodeId} 失败: HTTP ${res.status}`)
  return res.json()
}

async function registerRaw(port, nodeId, passCode) {
  const res = await fetch(`http://localhost:${port}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodeId, passCode }),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

async function transferDone(port, token, bytes) {
  const res = await fetch(`http://localhost:${port}/api/transfer-done`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, bytes }),
  })
  return { status: res.status }
}

async function stats(port) {
  const res = await fetch(`http://localhost:${port}/api/stats`)
  return res.json()
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
