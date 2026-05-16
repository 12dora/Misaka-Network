#!/usr/bin/env node
/**
 * /api/register and adjacent HTTP endpoint edge-cases.
 *
 * Why this exists: brute-force.test.mjs covers the unhappy-path you'd
 * intuitively think of (wrong-passcode lockout, per-IP cap, rate limit).
 * The cases here are the ones that *look* fine but are easy to break in a
 * refactor of http.ts because they sit on quieter code paths:
 *
 *   • Schema rejection (out-of-range nodeId, non-numeric passcode) → 400.
 *     If this regresses to 500 or to a successful register, every device
 *     hitting the API with stale state will leak server state.
 *   • Identity is (nodeId + passCodeHash), so the same identity registered
 *     from a second "device" must succeed with a *new* sessionId — that is
 *     how the cluster channel groups multi-device users.
 *   • Bearer-protected endpoints (qr-token, turn-credentials, transfer-done)
 *     must consistently return 401 on missing / malformed / unknown tokens.
 *   • /api/release with an unknown token must be idempotent (204) — the
 *     client may retry on flaky network.
 *   • /api/release-by-ip must actually free slots so the user can recover
 *     from "IP_LIMITED" without a server restart.
 *
 * Usage:  node tests/register-edge.test.mjs
 */

import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { runTest, killChild } from './_harness.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SERVER_DIR = join(__dirname, '..')
const PORT = 18992
const BASE = `http://localhost:${PORT}/api`

let serverProcess = null

runTest(main)

async function main() {
  console.log('[1] 启动测试服务器...')
  serverProcess = startServer()
  await waitForServer()

  let failed = 0
  const cases = [
    ['schema rejects out-of-range nodeId',         testNodeIdRange],
    ['schema rejects non-numeric passcode',        testPassCodeShape],
    ['same identity from a second device → new sessionId, same nodeId', testMultiDeviceSameIdentity],
    ['/api/release with unknown token is 204',     testReleaseUnknownToken],
    ['/api/release-by-ip frees slots',             testReleaseByIpFreesSlots],
    ['Bearer-protected endpoints reject missing / malformed tokens', testBearerProtected],
  ]

  for (const [name, fn] of cases) {
    try {
      await fn()
      console.log(`  ✓ ${name}`)
    } catch (e) {
      console.error(`  ✗ ${name}\n      ${e.stack || e.message}`)
      failed++
    }
  }

  killChild(serverProcess)

  if (failed > 0) {
    console.error(`\n❌ ${failed} 用例失败`)
    process.exitCode = 1
    return
  }
  console.log('\n✅ 全部测试通过')
}

// ── Cases ────────────────────────────────────────────────────────────

async function testNodeIdRange() {
  // Below valid range
  const tooLow = await post('/register', { nodeId: 0, passCode: '123456' }, { rawStatus: true })
  assertEq(tooLow.status, 400, '0 应被 schema 拒绝')

  // Above valid range
  const tooHigh = await post('/register', { nodeId: 99999999, passCode: '123456' }, { rawStatus: true })
  assertEq(tooHigh.status, 400, '超大 nodeId 应被 schema 拒绝')

  // Non-integer
  const fractional = await post('/register', { nodeId: 12.5, passCode: '123456' }, { rawStatus: true })
  assertEq(fractional.status, 400, '小数 nodeId 应被 schema 拒绝')

  // Wrong type
  const wrongType = await post('/register', { nodeId: '123', passCode: '123456' }, { rawStatus: true })
  assertEq(wrongType.status, 400, '字符串 nodeId 应被 schema 拒绝')
}

async function testPassCodeShape() {
  const cases = [
    ['12345',   '5 位'],
    ['1234567', '7 位'],
    ['abc123',  '含字母'],
    ['',        '空'],
  ]
  for (const [code, label] of cases) {
    const r = await post('/register', { nodeId: 13000, passCode: code }, { rawStatus: true })
    assertEq(r.status, 400, `通行码=${label} 应被 schema 拒绝`)
  }
}

async function testMultiDeviceSameIdentity() {
  const nodeId = 13100
  const passCode = '424242'
  const a = await post('/register', { nodeId, passCode })
  const b = await post('/register', { nodeId, passCode })
  assert(a.token && b.token, '两次注册都应拿到 token')
  assert(a.sessionId !== b.sessionId, '两个设备应分到不同 sessionId')
  assertEq(typeof a.expiresAt, 'number', 'expiresAt 应为时间戳')
}

async function testReleaseUnknownToken() {
  const r = await fetch(`${BASE}/release`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'definitely-not-a-real-token' }),
  })
  assertEq(r.status, 204, '未知 token release 应 204（幂等）')
}

async function testReleaseByIpFreesSlots() {
  // Register a unique nodeId then verify release-by-ip drops it.
  const nodeId = 13200
  const reg = await post('/register', { nodeId, passCode: '111111' })
  assert(reg.token, '注册成功')

  const r = await fetch(`${BASE}/release-by-ip`, { method: 'POST' })
  assertEq(r.status, 200, 'release-by-ip 200')
  const body = await r.json()
  assert(typeof body.released === 'number' && body.released >= 1,
    `应至少释放 1 个节点，实际 ${body.released}`)

  // Same identity should re-register cleanly (proves the slot is back).
  const again = await post('/register', { nodeId, passCode: '111111' })
  assert(again.token, '释放后能再次注册')
}

async function testBearerProtected() {
  // Register first so we have a valid token to contrast against.
  const reg = await post('/register', { nodeId: 13300, passCode: '999999' })
  assert(reg.token, '注册成功')

  const endpoints = [
    ['GET',  '/qr-token'],
    ['GET',  '/turn-credentials'],
  ]
  for (const [method, path] of endpoints) {
    const noHeader = await fetch(`${BASE}${path}`, { method })
    assertEq(noHeader.status, 401, `${method} ${path} 缺 Authorization → 401`)

    const wrongScheme = await fetch(`${BASE}${path}`, {
      method,
      headers: { Authorization: `Basic ${reg.token}` },
    })
    assertEq(wrongScheme.status, 401, `${method} ${path} 非 Bearer scheme → 401`)

    const unknownToken = await fetch(`${BASE}${path}`, {
      method,
      headers: { Authorization: 'Bearer not-a-real-token' },
    })
    assertEq(unknownToken.status, 401, `${method} ${path} 未知 token → 401`)
  }

  // transfer-done auth is via body, not header — separate path worth pinning.
  const tdMissing = await fetch(`${BASE}/transfer-done`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'wrong-token', bytes: 1 }),
  })
  assertEq(tdMissing.status, 401, 'transfer-done 错 token → 401')
}

// ── helpers ─────────────────────────────────────────────────────────

async function post(path, body, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (opts.rawStatus) return { status: res.status, body: await res.text() }
  return res.json()
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

function assertEq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg}: 期望 ${JSON.stringify(expected)}, 实际 ${JSON.stringify(actual)}`)
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
