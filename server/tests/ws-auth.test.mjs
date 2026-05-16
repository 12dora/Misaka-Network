#!/usr/bin/env node
/**
 * WebSocket auth path — 4001 (AUTH_REQUIRED) / 4002 (INVALID_TOKEN).
 *
 * Why this exists: the client treats close codes 4001 and 4002 as the signal
 * to call onAuthInvalid → drop the cached session → reconnect (see
 * client/src/lib/signaling.ts and store/auth.ts). If the server ever returns a
 * different code, the client silently loops on a dead token forever — which
 * is exactly the regression class CONTRIBUTING is trying to prevent.
 *
 * We exercise the three auth-time paths:
 *   1. Non-AUTH first message while unauthenticated → close 4001.
 *   2. AUTH with a token the server doesn't recognise → close 4002.
 *   3. AUTH with a valid token → WELCOME, no close.
 *
 * Usage: node tests/ws-auth.test.mjs
 */

import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { WebSocket } from 'ws'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SERVER_DIR = join(__dirname, '..')
const PORT = 18993
const BASE = `http://localhost:${PORT}/api`
const WS_URL = `ws://localhost:${PORT}/ws`

let serverProcess = null

async function main() {
  console.log('[1] 启动测试服务器...')
  serverProcess = startServer()
  await waitForServer()

  let failed = 0
  const cases = [
    ['non-AUTH first message → close 4001 AUTH_REQUIRED', testAuthRequired],
    ['unknown token → close 4002 INVALID_TOKEN',          testInvalidToken],
    ['valid token → WELCOME, no close',                   testValidAuth],
    ['malformed JSON before AUTH does not crash session', testMalformedBeforeAuth],
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

  if (serverProcess) {
    serverProcess.kill('SIGTERM')
    setTimeout(() => { if (serverProcess) serverProcess.kill('SIGKILL') }, 3000)
  }

  if (failed > 0) {
    console.error(`\n❌ ${failed} 用例失败`)
    process.exit(1)
  }
  console.log('\n✅ 全部测试通过')
}

// ── Cases ─────────────────────────────────────────────────────────────

async function testAuthRequired() {
  const ws = await openWS()
  // Send anything that isn't AUTH first.
  ws.send(JSON.stringify({ t: 'PING' }))
  const closure = await waitForClose(ws, 2000)
  assertEq(closure.code, 4001, '关闭码应为 4001')
}

async function testInvalidToken() {
  const ws = await openWS()
  ws.send(JSON.stringify({ t: 'AUTH', token: 'definitely-not-a-real-token' }))
  const closure = await waitForClose(ws, 2000)
  assertEq(closure.code, 4002, '关闭码应为 4002')
}

async function testValidAuth() {
  // Register first to obtain a token.
  const reg = await post('/register', { nodeId: 14010, passCode: '424242' })
  if (!reg.token) throw new Error('register 失败')

  const ws = await openWS()
  const closedPromise = waitForClose(ws, 1500).catch(() => null) // expect no close
  const messages = []
  ws.on('message', raw => {
    try { messages.push(JSON.parse(raw.toString())) } catch { /* ignore */ }
  })

  ws.send(JSON.stringify({ t: 'AUTH', token: reg.token }))

  // Wait either for a WELCOME or for the no-close window to elapse.
  const welcome = await waitFor(() => messages.find(m => m.t === 'WELCOME'), 1500)
  assertEq(welcome.sessionId, reg.sessionId, 'WELCOME sessionId 应与 register 一致')

  // Make sure no premature close happened.
  const racedClose = await Promise.race([
    closedPromise,
    new Promise(resolve => setTimeout(() => resolve(null), 200)),
  ])
  if (racedClose) throw new Error(`Auth 成功后不应关闭，却收到 close code=${racedClose.code}`)

  ws.close()
}

async function testMalformedBeforeAuth() {
  // The server's schema parser swallows invalid JSON silently. That should
  // NOT kick us off the socket — only an attempt to send a non-AUTH typed
  // message should trigger 4001. So: send garbage, then a real AUTH, expect
  // WELCOME.
  const reg = await post('/register', { nodeId: 14011, passCode: '101010' })
  const ws = await openWS()
  const messages = []
  ws.on('message', raw => {
    try { messages.push(JSON.parse(raw.toString())) } catch { /* ignore */ }
  })

  ws.send('not-json-at-all')
  ws.send(JSON.stringify({ t: 'WHO_KNOWS' }))
  // Now do real AUTH.
  ws.send(JSON.stringify({ t: 'AUTH', token: reg.token }))

  const welcome = await waitFor(() => messages.find(m => m.t === 'WELCOME'), 1500)
  assertEq(welcome.t, 'WELCOME', '畸形消息不应阻止后续 AUTH')
  ws.close()
}

// ── Helpers ───────────────────────────────────────────────────────────

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

function assertEq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg}: 期望 ${expected}, 实际 ${actual}`)
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

main()
