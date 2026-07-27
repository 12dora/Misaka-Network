#!/usr/bin/env node
/**
 * SECURITY-001: the advertised session/token TTL must actually be stored and
 * enforced.
 *
 * Before the fix `/api/register` returned `expiresAt = now + SESSION_TTL_MS`
 * but nothing persisted it: `NodeSession` had no expiry field, the token
 * resolver never compared anything, the cleanup sweep only looked at
 * disconnected-and-idle sessions, and the WS WELCOME frame invented a fresh
 * `Date.now() + 30min` on every connect. A token was therefore valid for the
 * lifetime of the process — HTTP, WS, QR, TURN and release permissions all
 * outlived the published deadline.
 *
 * What this pins:
 *   1. Happy path — a fresh token works on a bearer route, and the advertised
 *      expiresAt matches the configured TTL.
 *   2. Once the deadline passes, the SAME token is rejected (401) on the same
 *      bearer route.
 *   3. WELCOME reports the STORED deadline, not a freshly minted one.
 *   4. A live WS whose session expires is closed with 4002 (the code the
 *      client already maps to onAuthInvalid → clear session → re-register).
 *   5. Expiry actually frees server state: the nodeId can be claimed by a
 *      DIFFERENT identity afterwards.
 *   6. Edge — AUTH with an already-expired token is refused with 4002.
 *
 * Usage: node tests/session-expiry.test.mjs
 */

import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { WebSocket } from 'ws'
import { runTest, killChild } from './_harness.mjs'

runTest(main, { timeoutMs: 60_000 })

const __dirname = dirname(fileURLToPath(import.meta.url))
// Overridable so the fix can be demonstrated against a pre-fix checkout.
const SERVER_DIR = process.env.MISAKA_TEST_SERVER_DIR || join(__dirname, '..')
const PORT = 18960
const BASE = `http://localhost:${PORT}/api`
const WS_URL = `ws://localhost:${PORT}/ws`

// Short enough to test, long enough to survive a slow WS handshake.
const TTL_MS = 3000

let serverProcess = null

async function main() {
  console.log('[1] 启动测试服务器 (SESSION_TTL_MS=%d)...', TTL_MS)
  serverProcess = startServer()
  await waitForServer()

  let failed = 0
  const cases = [
    ['fresh token works on a bearer route + advertised TTL matches config', testFreshTokenWorks],
    ['expired token is rejected on the same bearer route',                  testExpiredTokenRejected],
    ['WELCOME reports the stored deadline, not now+30min',                  testWelcomeUsesStoredExpiry],
    ['live WS is closed 4002 when its session expires',                     testLiveSocketClosedOnExpiry],
    ['expired session frees its nodeId for a different identity',           testExpiryFreesNodeId],
    ['AUTH with an already-expired token → 4002',                           testAuthWithExpiredToken],
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

// ── Cases ─────────────────────────────────────────────────────────────

async function testFreshTokenWorks() {
  const before = Date.now()
  const reg = await register(15010, '111222')
  assert(reg.token, 'register 应成功')

  const skew = Math.abs(reg.expiresAt - (before + TTL_MS))
  assert(skew < 1500, `expiresAt 应约等于 now+TTL，实际偏差 ${skew}ms`)

  const res = await fetch(`${BASE}/qr-token`, { headers: { Authorization: `Bearer ${reg.token}` } })
  assertEq(res.status, 200, '新 token 应可用')
}

async function testExpiredTokenRejected() {
  const reg = await register(15011, '333444')
  await sleep(TTL_MS + 400)

  const res = await fetch(`${BASE}/qr-token`, { headers: { Authorization: `Bearer ${reg.token}` } })
  assertEq(res.status, 401, '过期 token 在受保护路由上必须 401')

  // Same for the TURN issuance path — it resolves through the same helper.
  const turn = await fetch(`${BASE}/turn-credentials`, { headers: { Authorization: `Bearer ${reg.token}` } })
  assertEq(turn.status, 401, '过期 token 不得再申请 TURN 凭据')
}

async function testWelcomeUsesStoredExpiry() {
  const reg = await register(15012, '555666')
  const ws = await openWS()
  const messages = []
  ws.on('message', raw => { try { messages.push(JSON.parse(raw.toString())) } catch { /* ignore */ } })
  ws.send(JSON.stringify({ t: 'AUTH', token: reg.token }))

  const welcome = await waitFor(() => messages.find(m => m.t === 'WELCOME'), 2000)
  assertEq(welcome.sessionExpiresAt, reg.expiresAt, 'WELCOME.sessionExpiresAt 必须是注册时存储的绝对到期时间')
  ws.close()
}

async function testLiveSocketClosedOnExpiry() {
  const reg = await register(15013, '777888')
  const ws = await openWS()
  const messages = []
  ws.on('message', raw => { try { messages.push(JSON.parse(raw.toString())) } catch { /* ignore */ } })
  ws.send(JSON.stringify({ t: 'AUTH', token: reg.token }))
  await waitFor(() => messages.find(m => m.t === 'WELCOME'), 2000)

  // Stay connected past the deadline; the cleanup sweep must tear us down.
  const closure = await waitForClose(ws, TTL_MS + 4000)
  assertEq(closure.code, 4002, '过期后服务端应以 4002 关闭连接（客户端据此重新注册）')
}

async function testExpiryFreesNodeId() {
  const NODE = 15014
  const reg = await register(NODE, '121314')
  assert(reg.token, '初次注册成功')

  // While alive, a different passcode on the same nodeId must conflict.
  const busy = await registerRaw(NODE, '999999')
  assert(busy.status === 409 || busy.status === 423, `存活期间应冲突，实际 ${busy.status}`)

  await sleep(TTL_MS + 900)   // deadline + at least one cleanup tick

  const taken = await registerRaw(NODE, '999999')
  assertEq(taken.status, 200, '过期会话必须从内存中清除，nodeId 可被新身份占用')
}

async function testAuthWithExpiredToken() {
  const reg = await register(15015, '151617')
  await sleep(TTL_MS + 400)

  const ws = await openWS()
  ws.send(JSON.stringify({ t: 'AUTH', token: reg.token }))
  const closure = await waitForClose(ws, 3000)
  assertEq(closure.code, 4002, '用过期 token AUTH 应得到 4002')
}

// ── Helpers ───────────────────────────────────────────────────────────

async function register(nodeId, passCode) {
  const res = await fetch(`${BASE}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodeId, passCode }),
  })
  if (!res.ok) throw new Error(`register ${nodeId} 失败: HTTP ${res.status}`)
  return res.json()
}

async function registerRaw(nodeId, passCode) {
  const res = await fetch(`${BASE}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodeId, passCode }),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
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

function assert(cond, msg) { if (!cond) throw new Error(msg) }
function assertEq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg}: 期望 ${JSON.stringify(expected)}, 实际 ${JSON.stringify(actual)}`)
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function startServer() {
  const proc = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(PORT),
      MAX_NODES: '200',
      TURN_AUTO_ENABLED: 'false',
      SESSION_TTL_MS: String(TTL_MS),
      CLEANUP_INTERVAL_MS: '200',
      // Deliberately LONG: the idle-after-disconnect sweep must not be able to
      // masquerade as expiry enforcement. Everything asserted below has to be
      // caused by the TTL alone.
      DISCONNECTED_TTL_MS: '60000',
      RATE_LIMIT_PER_MIN: '100000',
    },
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
