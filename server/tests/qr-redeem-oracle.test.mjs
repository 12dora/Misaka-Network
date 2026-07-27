#!/usr/bin/env node
/**
 * Regression [P2]: /api/qr-redeem was a passcode-guessing oracle. A wrong
 * passcode neither consumed the single-use token nor fed any lockout, so the
 * same qrToken could be retried across the full 6-digit keyspace for its 5-min
 * TTL, bounded only by the per-IP rate limit.
 *
 * Fix: a wrong passcode now (a) feeds recordFailedPasscodeAttempt (per-nodeId
 * freeze) and (b) burns the single-use token after MAX_ATTEMPTS wrong guesses.
 * The passcode compare is also timing-safe.
 *
 *   - 3 wrong guesses burn the token → a subsequent CORRECT guess is rejected
 *     as INVALID_QR_TOKEN (not accepted).
 *   - A fresh token + correct passcode still redeems normally.
 *   - A wrong passcode returns 401 (never 200).
 *
 * Usage: node tests/qr-redeem-oracle.test.mjs
 */

import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { runTest, killChild, spawn } from './_harness.mjs'

runTest(main, { timeoutMs: 30_000 })

const __dirname = dirname(fileURLToPath(import.meta.url))
const SERVER_DIR = join(__dirname, '..')
const PORT = 18965
const BASE = `http://localhost:${PORT}/api`

let serverProcess = null

const OWNER_NODE = 17500
const OWNER_PASS = '485291'

async function main() {
  console.log('[1] 启动测试服务器...')
  serverProcess = startServer()
  await waitForServer()

  let failed = 0
  const owner = await post('/register', { nodeId: OWNER_NODE, passCode: OWNER_PASS })
  if (!owner.token) { console.error('  ✗ owner register failed'); process.exitCode = 1; killChild(serverProcess); return }

  const cases = [
    ['wrong passcode returns 401 (never 200)', testWrongIs401],
    ['token burned after MAX_ATTEMPTS wrong guesses', testTokenBurn],
    ['fresh token + correct passcode redeems', testValidRedeem],
  ]
  for (const [name, fn] of cases) {
    try { await fn(owner.token); console.log(`  ✓ ${name}`) }
    catch (e) { console.error(`  ✗ ${name}\n      ${e.stack || e.message}`); failed++ }
  }

  killChild(serverProcess)
  if (failed > 0) { console.error(`\n❌ ${failed} 用例失败`); process.exitCode = 1; return }
  console.log('\n✅ 全部测试通过')
}

async function makeQrToken(ownerToken) {
  const r = await fetch(`${BASE}/qr-token`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ownerToken}` },
  })
  const body = await r.json()
  if (!body.qrToken) throw new Error(`qr-token creation failed: ${JSON.stringify(body)}`)
  return body.qrToken
}

async function testWrongIs401(ownerToken) {
  const qrToken = await makeQrToken(ownerToken)
  const r = await postRaw('/qr-redeem', { qrToken, myNodeId: 1, myPassCode: '000000' })
  if (r.status !== 401) throw new Error(`wrong passcode should be 401, got ${r.status}`)
}

async function testTokenBurn(ownerToken) {
  const qrToken = await makeQrToken(ownerToken)
  // 3 wrong guesses (MAX_ATTEMPTS) — each 401.
  for (let i = 0; i < 3; i++) {
    const wrong = String(100000 + i)   // never equals OWNER_PASS
    const r = await postRaw('/qr-redeem', { qrToken, myNodeId: 1, myPassCode: wrong })
    if (r.status !== 401) throw new Error(`wrong guess ${i} should be 401, got ${r.status}`)
  }
  // The token is now burned: even the CORRECT passcode must be rejected.
  const r = await postRaw('/qr-redeem', { qrToken, myNodeId: 1, myPassCode: OWNER_PASS })
  if (r.status === 200) throw new Error('token was NOT burned — correct passcode still redeemed (oracle open)')
  if (r.body?.error !== 'INVALID_QR_TOKEN') throw new Error(`expected INVALID_QR_TOKEN after burn, got ${r.status} ${JSON.stringify(r.body)}`)
}

async function testValidRedeem(ownerToken) {
  const qrToken = await makeQrToken(ownerToken)
  const r = await postRaw('/qr-redeem', { qrToken, myNodeId: 2, myPassCode: OWNER_PASS })
  if (r.status !== 200) throw new Error(`valid redeem should be 200, got ${r.status} ${JSON.stringify(r.body)}`)
  if (r.body.targetNodeId !== OWNER_NODE) throw new Error(`targetNodeId should be ${OWNER_NODE}, got ${r.body.targetNodeId}`)
}

// ── Helpers ──────────────────────────────────────────────────────────

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  return res.json()
}

async function postRaw(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  let parsed = null
  try { parsed = await res.json() } catch { /* ignore */ }
  return { status: res.status, body: parsed }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function startServer() {
  const proc = spawn('node', ['dist/index.js'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(PORT),
      MAX_NODES: '200',
      TURN_AUTO_ENABLED: 'false',
      QR_REDEEM_RATE_LIMIT: '50',      // room for the guessing attempts
      NODE_FREEZE_THRESHOLD: '50',     // don't freeze during this test
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
    try { const res = await fetch(`${BASE}/health`); if (res.ok) return } catch { /* not ready */ }
    await sleep(300)
  }
  throw new Error('服务器启动超时')
}
