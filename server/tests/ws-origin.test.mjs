#!/usr/bin/env node
/**
 * P0-1: WebSocket upgrade hardening.
 *
 *   (a) An Origin not in ALLOWED_ORIGINS is refused at upgrade with HTTP
 *       403 BAD_ORIGIN — the WS handshake never completes, so a malicious
 *       page can't speak our signaling protocol even if the user has a
 *       valid session token in another tab.
 *   (b) An allow-listed Origin is accepted and the AUTH flow continues.
 *   (c) A non-browser caller (no Origin header) is still accepted — this
 *       preserves the existing behaviour for native / CLI / test clients
 *       which cannot be tricked by a malicious page.
 *   (d) A connected client that never sends AUTH within WS_AUTH_GRACE_MS
 *       is closed with code 4001 AUTH_TIMEOUT — previously such a client
 *       could hold a socket open forever at zero cost.
 *
 * Usage: node tests/ws-origin.test.mjs
 */

import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { WebSocket } from 'ws'
import { runTest, killChild } from './_harness.mjs'

runTest(main, { timeoutMs: 30_000 })

const __dirname = dirname(fileURLToPath(import.meta.url))
const SERVER_DIR = join(__dirname, '..')
const PORT = 18981
const BASE = `http://localhost:${PORT}/api`
const WS_URL = `ws://localhost:${PORT}/ws`
const ALLOWED = 'https://allowed.example.com'

let serverProcess = null

async function main() {
  console.log('[1] 启动测试服务器（ALLOWED_ORIGINS 注入）...')
  serverProcess = startServer()
  await waitForServer()

  let failed = 0
  const cases = [
    ['disallowed Origin → upgrade 403 BAD_ORIGIN',     testDisallowedOrigin],
    ['allowed Origin → handshake succeeds → AUTH ok',  testAllowedOrigin],
    ['missing Origin → handshake succeeds (CLI path)', testMissingOrigin],
    ['no AUTH within grace window → close 4001 AUTH_TIMEOUT', testAuthTimeout],
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

async function testDisallowedOrigin() {
  // The `ws` client sets Origin via the `origin` option.
  const ws = new WebSocket(WS_URL, { origin: 'https://evil.example.com' })
  const result = await new Promise((resolve) => {
    let unexpectedlyOpened = false
    ws.on('open', () => { unexpectedlyOpened = true; ws.close() })
    ws.on('unexpected-response', (_req, res) => {
      resolve({ status: res.statusCode })
    })
    ws.on('error', () => { /* swallow — 403 surfaces as error too */ })
    ws.on('close', () => {
      // If we close without an unexpected-response, fall back to a sentinel.
      if (!unexpectedlyOpened) resolve({ status: null })
    })
    setTimeout(() => resolve({ status: null }), 3000)
  })
  if (result.status !== 403) {
    throw new Error(`期待 403 拒绝 upgrade，实际 ${result.status}`)
  }
}

async function testAllowedOrigin() {
  const reg = await post('/register', { nodeId: 17010, passCode: '111111' })
  if (!reg.token) throw new Error('register 失败')
  const ws = new WebSocket(WS_URL, { origin: ALLOWED })
  await openWS(ws)
  const messages = []
  ws.on('message', raw => { try { messages.push(JSON.parse(raw.toString())) } catch {} })
  ws.send(JSON.stringify({ t: 'AUTH', token: reg.token }))
  const welcome = await waitFor(() => messages.find(m => m.t === 'WELCOME'), 2000)
  if (welcome.sessionId !== reg.sessionId) throw new Error('sessionId 不匹配')
  ws.close()
}

async function testMissingOrigin() {
  const reg = await post('/register', { nodeId: 17011, passCode: '222222' })
  if (!reg.token) throw new Error('register 失败')
  const ws = new WebSocket(WS_URL)   // no Origin
  await openWS(ws)
  const messages = []
  ws.on('message', raw => { try { messages.push(JSON.parse(raw.toString())) } catch {} })
  ws.send(JSON.stringify({ t: 'AUTH', token: reg.token }))
  const welcome = await waitFor(() => messages.find(m => m.t === 'WELCOME'), 2000)
  if (welcome.t !== 'WELCOME') throw new Error('期待 WELCOME')
  ws.close()
}

async function testAuthTimeout() {
  // Use the allowed Origin so the upgrade succeeds; then refuse to send
  // anything. Server's WS_AUTH_GRACE_MS env is set to 800ms for this test.
  const ws = new WebSocket(WS_URL, { origin: ALLOWED })
  await openWS(ws)
  const closure = await waitForClose(ws, 3000)
  if (closure.code !== 4001) throw new Error(`期待 close 4001，实际 ${closure.code}`)
  // Reason buffer should mention AUTH_TIMEOUT (helpful for debugging logs).
  if (!closure.reason.includes('AUTH_TIMEOUT') && !closure.reason.includes('AUTH_REQUIRED')) {
    // Allow either reason string — the close code is the load-bearing part.
    console.warn(`    (reason='${closure.reason}', acceptable)`)
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function openWS(ws) {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
    ws.once('unexpected-response', (_req, res) => reject(new Error(`upgrade rejected ${res.statusCode}`)))
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
    await sleep(50)
  }
  throw new Error(`waitFor 超时 (${ms}ms)`)
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
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
      ALLOWED_ORIGINS: ALLOWED,
      WS_AUTH_GRACE_MS: '800',
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
