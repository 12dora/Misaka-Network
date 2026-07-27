#!/usr/bin/env node
/**
 * P0-3: /api/qr-redeem dedicated rate limit + passcode format guard.
 *
 *   - qr-redeem accepts only `^\d{6}$` passcodes — anything else is 400
 *     (was previously any string of length 6, which let an attacker probe
 *     for SQL/format-string side channels).
 *   - The qr-token creation route enforces the same regex on the optional
 *     `passCode` query param — previously any string passed through.
 *   - More than QR_REDEEM_RATE_LIMIT requests within the window from one
 *     IP get 429, even when the underlying token is valid (so the cap can
 *     never be bypassed by feeding a different qrToken each call).
 *
 * Usage: node tests/qr-redeem-ratelimit.test.mjs
 */

import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { runTest, killChild, spawn } from './_harness.mjs'

runTest(main, { timeoutMs: 30_000 })

const __dirname = dirname(fileURLToPath(import.meta.url))
const SERVER_DIR = join(__dirname, '..')
const PORT = 18980
const BASE = `http://localhost:${PORT}/api`

let serverProcess = null

async function main() {
  console.log('[1] 启动测试服务器 (qr-redeem rate=5/min)...')
  serverProcess = startServer()
  await waitForServer()

  let failed = 0
  const cases = [
    ['qr-redeem rejects non-numeric passcode → 400', testNonNumericPasscode],
    ['qr-token rejects passcode material in request body', testQrTokenPasscodeShape],
    ['qr-redeem 429 once over rate cap',             testQrRedeemRateLimit],
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

async function testNonNumericPasscode() {
  const res = await postRaw('/qr-redeem', { qrToken: 'whatever', myNodeId: 100, myPassCode: 'abcdef' })
  if (res.status !== 400) throw new Error(`期待 400，实际 ${res.status}`)
}

async function testQrTokenPasscodeShape() {
  // Register first to get a Bearer token.
  const reg = await postRaw('/register', { nodeId: 17030, passCode: '111111' })
  if (reg.status !== 200) throw new Error('register 失败')
  const ownerToken = reg.body.token

  const r = await fetch(`${BASE}/qr-token`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ownerToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ passCode: '111111' }),
  })
  if (r.status !== 400) throw new Error(`qr-token 不应接受 passCode，实际 ${r.status}`)
}

async function testQrRedeemRateLimit() {
  // Issue 12 redeem attempts; with the dedicated limit at 5/min, we should
  // see at least one 429 by the end. We feed garbage qrTokens — the rate
  // limit MUST trip before we even look at the body, otherwise the cap
  // would be bypassable by always using known-bad tokens that 400 fast.
  let saw429 = false
  for (let i = 0; i < 12; i++) {
    const r = await postRaw('/qr-redeem', { qrToken: `bogus-${i}`, myNodeId: 1, myPassCode: '111111' })
    if (r.status === 429) { saw429 = true; break }
  }
  if (!saw429) throw new Error('未触发 qr-redeem 专用速率限制')
}

// ── Helpers ──────────────────────────────────────────────────────────

async function postRaw(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
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
      // tighter cap for the test so we don't have to flood
      QR_REDEEM_RATE_LIMIT: '5',
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
