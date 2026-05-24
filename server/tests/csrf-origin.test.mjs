#!/usr/bin/env node
/**
 * P0-4: /api/register and other state-changing routes refuse cross-origin
 * requests.
 *
 * Browsers always attach an Origin header on cross-site fetch. If a request
 * carries an Origin that isn't on our ALLOWED_ORIGINS list, we return 403
 * BAD_ORIGIN — even if the body and token are valid — because the request
 * is by definition CSRF: another page initiated it on the user's behalf.
 *
 * Requests with no Origin header at all (native clients, curl, server-to-
 * server) keep working as before — those callers can't be tricked by a
 * malicious page.
 *
 * Usage: node tests/csrf-origin.test.mjs
 */

import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { runTest, killChild } from './_harness.mjs'

runTest(main, { timeoutMs: 30_000 })

const __dirname = dirname(fileURLToPath(import.meta.url))
const SERVER_DIR = join(__dirname, '..')
const PORT = 18979
const BASE = `http://localhost:${PORT}/api`
const ALLOWED = 'https://allowed.example.com'

let serverProcess = null

async function main() {
  console.log('[1] 启动测试服务器（ALLOWED_ORIGINS 注入）...')
  serverProcess = startServer()
  await waitForServer()

  let failed = 0
  const cases = [
    ['register w/ disallowed Origin → 403 BAD_ORIGIN', testRegisterBadOrigin],
    ['register w/ allowed Origin → 200',               testRegisterAllowedOrigin],
    ['register w/o Origin header → 200',               testRegisterNoOrigin],
    ['register w/ disallowed Referer → 403',           testRegisterBadReferer],
    ['qr-redeem w/ disallowed Origin → 403',           testQrRedeemBadOrigin],
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

async function testRegisterBadOrigin() {
  const res = await fetch(`${BASE}/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': 'https://evil.example.com',
    },
    body: JSON.stringify({ nodeId: 17050, passCode: '111111' }),
  })
  if (res.status !== 403) throw new Error(`期待 403，实际 ${res.status}`)
  const body = await res.json()
  if (body.error !== 'BAD_ORIGIN') throw new Error(`期待 error=BAD_ORIGIN，实际 ${body.error}`)
}

async function testRegisterAllowedOrigin() {
  const res = await fetch(`${BASE}/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': ALLOWED,
    },
    body: JSON.stringify({ nodeId: 17051, passCode: '222222' }),
  })
  if (res.status !== 200) throw new Error(`期待 200，实际 ${res.status}`)
}

async function testRegisterNoOrigin() {
  // node fetch doesn't set Origin by default — exactly the curl/CLI case.
  const res = await fetch(`${BASE}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodeId: 17052, passCode: '333333' }),
  })
  if (res.status !== 200) throw new Error(`期待 200，实际 ${res.status}`)
}

async function testRegisterBadReferer() {
  // Some browsers (and proxies) strip Origin but keep Referer. We treat
  // Referer as a fallback origin source for state-changing routes.
  const res = await fetch(`${BASE}/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Referer': 'https://evil.example.com/some/path',
    },
    body: JSON.stringify({ nodeId: 17053, passCode: '444444' }),
  })
  if (res.status !== 403) throw new Error(`期待 403 (Referer)，实际 ${res.status}`)
}

async function testQrRedeemBadOrigin() {
  const res = await fetch(`${BASE}/qr-redeem`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': 'https://evil.example.com',
    },
    body: JSON.stringify({ qrToken: 'anything', myNodeId: 1, myPassCode: '111111' }),
  })
  if (res.status !== 403) throw new Error(`期待 403，实际 ${res.status}`)
}

// ── Helpers ──────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function startServer() {
  const proc = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(PORT),
      MAX_NODES: '200',
      TURN_AUTO_ENABLED: 'false',
      ALLOWED_ORIGINS: ALLOWED,
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
