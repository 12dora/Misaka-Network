#!/usr/bin/env node
/**
 * P1-5: per-nodeId GLOBAL freeze defends against the IP-rotation attack.
 *
 * The per-(IP, nodeId) lock from F7 stops a single IP after 3 wrong tries,
 * but an attacker with a residential proxy pool can simply rotate IPs and
 * never hit that limit. The global freeze counts failures against a nodeId
 * across all IPs in a rolling window. Once the threshold is reached the
 * nodeId itself is frozen — every register attempt (from any IP, even with
 * the correct passcode) is rejected for the freeze duration.
 *
 * Owner sessions already established stay connected — this only gates new
 * registrations.
 */

import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { runTest, killChild, spawn } from './_harness.mjs'

runTest(main, { timeoutMs: 30_000 })

const __dirname = dirname(fileURLToPath(import.meta.url))
const SERVER_DIR = join(__dirname, '..')
const PORT = 18978
const BASE = `http://localhost:${PORT}/api`

let serverProcess = null

async function main() {
  console.log('[1] 启动测试服务器 (NODE_FREEZE_THRESHOLD=8)...')
  serverProcess = startServer()
  await waitForServer()

  let failed = 0
  const cases = [
    ['IP rotation across N IPs trips nodeId freeze', testFreezeTrips],
    ['even correct passcode rejected during freeze', testFreezeBlocksOwnerNewRegister],
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

const NODE_ID = 17070
const CORRECT = '424242'

async function testFreezeTrips() {
  // Owner registers first from their own IP so the nodeId is occupied.
  const ownerIp = '203.0.113.10'
  const owner = await postFrom('/register', { nodeId: NODE_ID, passCode: CORRECT }, ownerIp)
  if (!owner.token) throw new Error('owner 注册失败: ' + JSON.stringify(owner))

  // Exact boundary: threshold is 8. Freeze is engaged when the 8th failure is
  // recorded, but the response for that request is still NODE_OCCUPIED (freeze
  // is checked at the start of the next request). So:
  //   attempts 1..8 → not NODE_FROZEN
  //   attempt 9     → NODE_FROZEN
  //   attempt 10    → still NODE_FROZEN
  // A "eventually frozen" assertion would still pass if the threshold were
  // silently lowered to 1.
  const THRESHOLD = 8
  for (let i = 0; i < THRESHOLD; i++) {
    const ip = `198.51.100.${100 + i}`
    const r = await postFrom('/register', { nodeId: NODE_ID, passCode: '000000' }, ip)
    if (r.error === 'NODE_LOCKED' && r.reason === 'NODE_FROZEN') {
      throw new Error(`attempt ${i + 1}/${THRESHOLD} must not return NODE_FROZEN yet, got ${JSON.stringify(r)}`)
    }
    if (r.error !== 'NODE_OCCUPIED' && !(r.error === 'NODE_LOCKED' && r.reason === 'WRONG_PASSCODE')) {
      throw new Error(`attempt ${i + 1} expected NODE_OCCUPIED, got ${JSON.stringify(r)}`)
    }
  }
  const trip = await postFrom('/register', { nodeId: NODE_ID, passCode: '000000' }, '198.51.100.200')
  if (trip.error !== 'NODE_LOCKED' || trip.reason !== 'NODE_FROZEN') {
    throw new Error(`attempt ${THRESHOLD + 1} must be NODE_FROZEN, got ${JSON.stringify(trip)}`)
  }
  const again = await postFrom('/register', { nodeId: NODE_ID, passCode: '000000' }, '198.51.100.201')
  if (again.error !== 'NODE_LOCKED' || again.reason !== 'NODE_FROZEN') {
    throw new Error(`attempt ${THRESHOLD + 2} must still be NODE_FROZEN, got ${JSON.stringify(again)}`)
  }
}

async function testFreezeBlocksOwnerNewRegister() {
  // From a brand-new IP (so we don't hit the per-(IP, nodeId) lock yet),
  // try the CORRECT passcode. It must still be rejected because the
  // nodeId itself is frozen.
  const r = await postFrom('/register', { nodeId: NODE_ID, passCode: CORRECT }, '203.0.113.99')
  if (r.error !== 'NODE_LOCKED' || r.reason !== 'NODE_FROZEN') {
    throw new Error(`期待 NODE_FROZEN 拒绝正确通行码新注册，实际 ${JSON.stringify(r)}`)
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

async function postFrom(path, body, ip) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': ip,
    },
    body: JSON.stringify(body),
  })
  return res.json()
}

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
      MAX_NODES: '200',
      TURN_AUTO_ENABLED: 'false',
      NODE_FREEZE_THRESHOLD: '8',
      NODE_FREEZE_WINDOW_MS: '60000',
      NODE_FREEZE_DURATION_MS: '60000',
      // Bump per-IP cap so rotated IPs all behave naturally.
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
