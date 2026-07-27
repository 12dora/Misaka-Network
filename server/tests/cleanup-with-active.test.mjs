#!/usr/bin/env node
/**
 * Cleanup task must purge disconnected sessions even while other users stay
 * online (regression for the "activeCount === 0" gate).
 *
 * Old behaviour: the cleanup interval only ran the session-GC branch when
 * every node was offline, so on a shared egress IP a single long-lived user
 * pinned every other user's zombie session forever — eventually hitting
 * MAX_NODES_PER_IP and locking the IP out.
 *
 * New behaviour: every disconnected session whose lastSeen is older than
 * DISCONNECTED_TTL_MS is purged regardless of total active count.
 *
 * Strategy:
 *   1. Register node A (HTTP only, never opens WS → socket stays null).
 *   2. Register node B and open a WS (B stays online indefinitely).
 *   3. Confirm A still occupies its IP slot initially.
 *   4. Wait past DISCONNECTED_TTL_MS + cleanup tick (we override these via
 *      env so the test runs in seconds, not 12s).
 *   5. Register a different identity at A's nodeId from the same IP — it
 *      should succeed cleanly (no NODE_OCCUPIED), proving A was purged
 *      despite B still being online.
 *
 * Usage:  node tests/cleanup-with-active.test.mjs
 */

import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import WebSocket from 'ws'
import { runTest, killChild, spawn } from './_harness.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SERVER_DIR = join(__dirname, '..')
const PORT = 18996
const BASE = `http://localhost:${PORT}/api`

// Knobs we use to make the test fast — server reads these from env.
const CLEANUP_INTERVAL_MS = 200    // default 2000
const DISCONNECTED_TTL_MS = 500    // default 10000

let serverProcess = null

runTest(main, { timeoutMs: 30_000 })

async function main() {
  console.log('[1] 启动测试服务器（快速 cleanup 间隔）...')
  serverProcess = startServer()
  await waitForServer()

  let failed = 0
  const cases = [
    ['disconnected session purged while another user stays online', testDisconnectedPurgedWithActive],
    ['active session is NOT purged just because it has been idle',  testActiveNotPurged],
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

async function testDisconnectedPurgedWithActive() {
  const IP = '203.0.113.50'

  // A: HTTP-only register, never opens WS → socket = null from t=0.
  const a = await register(15100, '111000', IP)
  // B: opens WS and stays online. We send AUTH and a PING reply tick.
  const b = await register(15101, '222000', IP)
  const bSock = await openAuthed(b.token)

  // Sanity: A is occupying its nodeId — a different-passcode register should
  // collide.
  const collideBefore = await register(15100, '999999', IP, { raw: true })
  assert(
    collideBefore.status === 409 || collideBefore.status === 423,
    `cleanup 前 A 的位置应被占用，status=${collideBefore.status}`,
  )

  // Wait past DISCONNECTED_TTL_MS + 2 cleanup ticks (with 200ms interval,
  // 500ms TTL → 500 + 400 buffer = ~900ms; give 1500ms).
  await sleep(1500)

  // A should be purged. Same identity should re-register cleanly (no
  // conflict, no "remaining attempts" reply).
  const aAgain = await register(15100, '888888', IP)
  assert(aAgain.token && aAgain.sessionId, `A 的 nodeId 应已释放，但 register 失败`)

  bSock.close()
}

async function testActiveNotPurged() {
  const IP = '203.0.113.51'
  const c = await register(15200, '333000', IP)
  const cSock = await openAuthed(c.token)

  // Wait through several cleanup ticks while WS stays open.
  await sleep(1200)

  // C should still be active — a different-passcode register should still
  // collide.
  const collide = await register(15200, '666666', IP, { raw: true })
  assert(
    collide.status === 409 || collide.status === 423,
    `活跃会话被错误清理，status=${collide.status}`,
  )

  cSock.close()
}

// ── helpers ─────────────────────────────────────────────────────────

async function register(nodeId, passCode, ip, opts = {}) {
  const res = await fetch(`${BASE}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify({ nodeId, passCode }),
  })
  if (opts.raw) return { status: res.status, body: await res.json().catch(() => null) }
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`register ${nodeId} failed: HTTP ${res.status} ${detail}`)
  }
  return res.json()
}

function openAuthed(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`)
    let welcomed = false
    const timer = setTimeout(() => {
      if (!welcomed) reject(new Error('WS WELCOME 超时'))
    }, 3000)
    ws.on('open', () => ws.send(JSON.stringify({ t: 'AUTH', token })))
    ws.on('message', (raw) => {
      try {
        const m = JSON.parse(raw.toString())
        if (m.t === 'WELCOME' && !welcomed) {
          welcomed = true
          clearTimeout(timer)
          resolve(ws)
        }
      } catch { /* ignore */ }
    })
    ws.on('error', (err) => { clearTimeout(timer); reject(err) })
  })
}

function assert(cond, msg) { if (!cond) throw new Error(msg) }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function startServer() {
  const proc = spawn('node', ['dist/index.js'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      // Distinct client IPs are simulated via X-Forwarded-For; only honoured
      // when the server trusts a proxy hop.
      TRUST_PROXY: '1',
      PORT: String(PORT),
      MAX_NODES: '500',
      TURN_AUTO_ENABLED: 'false',
      CLEANUP_INTERVAL_MS: String(CLEANUP_INTERVAL_MS),
      DISCONNECTED_TTL_MS: String(DISCONNECTED_TTL_MS),
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
