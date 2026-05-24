#!/usr/bin/env node
/**
 * P2-10: ACTIVITY frames are only delivered to authenticated WS sessions.
 *
 * Before this fix any WS that completed the HTTP upgrade — even one that
 * had never sent AUTH — was a recipient of join/leave/transfer broadcasts.
 * That was a free side channel for measuring network membership at zero
 * authentication cost.
 *
 * Test plan: open two sockets — A is anonymous (never AUTHs), B is fully
 * authenticated. Trigger a register from a third client (which produces a
 * `join` ACTIVITY). Only B should see it.
 */

import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { WebSocket } from 'ws'
import { runTest, killChild } from './_harness.mjs'

runTest(main, { timeoutMs: 30_000 })

const __dirname = dirname(fileURLToPath(import.meta.url))
const SERVER_DIR = join(__dirname, '..')
const PORT = 18976
const BASE = `http://localhost:${PORT}/api`
const WS_URL = `ws://localhost:${PORT}/ws`

let serverProcess = null

async function main() {
  console.log('[1] 启动测试服务器 (WS_AUTH_GRACE_MS 调长以便观察)...')
  serverProcess = startServer()
  await waitForServer()

  let failed = 0
  try {
    await testAnonymousDoesNotReceiveActivity()
    console.log('  ✓ 匿名 WS 不收到 ACTIVITY 帧；已认证 WS 正常收到')
  } catch (e) {
    console.error(`  ✗ ${e.stack || e.message}`)
    failed++
  }

  killChild(serverProcess)

  if (failed > 0) {
    console.error(`\n❌ ${failed} 用例失败`)
    process.exitCode = 1
    return
  }
  console.log('\n✅ 全部测试通过')
}

async function testAnonymousDoesNotReceiveActivity() {
  // Anonymous WS — opens then sits silent.
  const anonMessages = []
  const anon = new WebSocket(WS_URL)
  await new Promise((resolve, reject) => {
    anon.once('open', resolve)
    anon.once('error', reject)
  })
  anon.on('message', raw => { try { anonMessages.push(JSON.parse(raw.toString())) } catch {} })

  // Authenticated WS.
  const regAuth = await post('/register', { nodeId: 17100, passCode: '111111' })
  if (!regAuth.token) throw new Error('register 失败')
  const authedMessages = []
  const authed = new WebSocket(WS_URL)
  await new Promise((resolve, reject) => {
    authed.once('open', resolve)
    authed.once('error', reject)
  })
  authed.on('message', raw => { try { authedMessages.push(JSON.parse(raw.toString())) } catch {} })
  authed.send(JSON.stringify({ t: 'AUTH', token: regAuth.token }))
  await waitFor(() => authedMessages.find(m => m.t === 'WELCOME'), 2000)

  // Trigger an ACTIVITY broadcast: register a third node → server broadcasts `join`.
  const baseline = authedMessages.length
  const trigger = await post('/register', { nodeId: 17101, passCode: '222222' })
  if (!trigger.token) throw new Error('trigger register 失败')

  // Authed should see ACTIVITY within 1s.
  const ev = await waitFor(() => authedMessages.slice(baseline).find(m => m.t === 'ACTIVITY' && m.event?.type === 'join'), 2000)
  if (!ev) throw new Error('已认证 WS 应收到 ACTIVITY{join}')

  // Anonymous must NOT have received any ACTIVITY (we wait a small window
  // to give a broken implementation the chance to leak).
  await sleep(500)
  const leak = anonMessages.find(m => m.t === 'ACTIVITY')
  if (leak) {
    throw new Error('匿名 WS 不应收到 ACTIVITY，实际收到 ' + JSON.stringify(leak))
  }

  anon.close()
  authed.close()
}

// ── Helpers ──────────────────────────────────────────────────────────

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
      // Give the anonymous WS enough time to stay open through the assertion.
      WS_AUTH_GRACE_MS: '10000',
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
