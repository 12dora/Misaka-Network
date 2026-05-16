#!/usr/bin/env node
/**
 * 通行码暴力穷举集成测试
 *
 * 启动信令服务器，验证：
 * 1. 3 次错误通行码 → 锁定 5 分钟
 * 2. 锁定期间正确通行码也拒绝
 * 3. 注册 API 速率限制
 * 4. 单 IP 最多 10 个节点
 *
 * Usage: cd server && node tests/brute-force.test.mjs
 */

import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { runTest, killChild } from './_harness.mjs'

runTest(main)

const __dirname = dirname(fileURLToPath(import.meta.url))
const SERVER_DIR = join(__dirname, '..')
const BASE = 'http://localhost:18999/api'

let serverProcess = null

async function main() {
  // ── Start server ─────────────────────────────────────────────────
  console.log('[1/6] 启动测试服务器...')
  serverProcess = startServer()
  await waitForServer()

  try {
    await testBruteForceLock()
    await testIpNodeLimit()  // must run before testRateLimit (which floods IP)
    await testRateLimit()
    console.log('\n✅ 全部测试通过')
  } catch (e) {
    console.error(`\n❌ 测试失败: ${e.message}`)
    process.exitCode = 1
  } finally {
    // ── Cleanup ───────────────────────────────────────────────
    killChild(serverProcess)
  }
}

// ── Test 1: Brute force lock ─────────────────────────────────────

async function testBruteForceLock() {
  console.log('[2/6] 通行码暴力穷举锁定测试...')

  const nodeId = 10032
  const correctCode = '485291'
  const wrongCode1 = '111111'
  const wrongCode2 = '222222'

  // Register node
  const reg = await post('/register', { nodeId, passCode: correctCode })
  assert(reg.token, '注册应返回 token')
  console.log('   ✓ 注册成功')

  // The identity-scoped model removed /verify-passcode. Wrong passcode
  // attempts now happen when another device tries to register an occupied
  // nodeId with a different passcode.
  const a1 = await post('/register', { nodeId, passCode: wrongCode1 })
  assertEq(a1.error, 'NODE_OCCUPIED', '第 1 次错误')
  console.log('   ✓ 第 1 次错误 → NODE_OCCUPIED')

  const a2 = await post('/register', { nodeId, passCode: wrongCode2 })
  assertEq(a2.error, 'NODE_OCCUPIED', '第 2 次错误')
  console.log('   ✓ 第 2 次错误 → NODE_OCCUPIED')

  const a3 = await post('/register', { nodeId, passCode: '333333' })
  assertEq(a3.error, 'NODE_LOCKED', '第 3 次错误应锁定')
  assert(a3.unlockAt > Date.now(), 'unlockAt 应在未来')
  const lockDuration = a3.unlockAt - Date.now()
  assert(lockDuration > 4.5 * 60 * 1000, `锁定时间应 ≈ 5 分钟，实际 ${(lockDuration / 1000).toFixed(0)}s`)
  console.log('   ✓ 第 3 次错误 → NODE_LOCKED (锁定 5 分钟)')

  // Locked: correct passcode should also be rejected
  const locked = await post('/register', { nodeId, passCode: correctCode })
  assertEq(locked.error, 'NODE_LOCKED', '锁定期间正确通行码也拒绝')
  console.log('   ✓ 锁定期间正确通行码 → NODE_LOCKED')
}

// ── Test 2: API rate limit ───────────────────────────────────────

async function testRateLimit() {
  console.log('[4/6] API 速率限制测试...')

  // Register many nodes rapidly to trigger rate limit
  let rateLimited = false
  for (let i = 0; i < 80; i++) {
    const res = await post('/register', { nodeId: 15000 + i, passCode: '123456' })
    if (res.error === 'RATE_LIMITED') {
      rateLimited = true
      break
    }
  }
  assert(rateLimited, '高频请求应触发 RATE_LIMITED')
  console.log('   ✓ 高频请求 → RATE_LIMITED')
}

// ── Test 3: IP node limit ────────────────────────────────────────

async function testIpNodeLimit() {
  console.log('[3/6] 单 IP 节点数限制测试...')

  // Register nodes from same IP until limit (test 1 already registered 1 node, so 9 more = 10 total)
  const baseId = 12000
  for (let i = 0; i < 9; i++) {
    const res = await post('/register', { nodeId: baseId + i, passCode: '123456' })
    assert(res.token, `节点 ${baseId + i} 应注册成功`)
  }

  // 10th additional node (11th total from this IP) should be rejected
  const overflow = await post('/register', { nodeId: baseId + 9, passCode: '123456' })
  assertEq(overflow.error, 'IP_LIMITED', '超过 IP 限制的节点应被拒')
  console.log('   ✓ 第 11 个同 IP 节点 → IP_LIMITED')
}

// ── Helpers ──────────────────────────────────────────────────────

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg}: 期望 ${expected}, 实际 ${actual}`)
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

function startServer() {
  const proc = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: SERVER_DIR,
    env: { ...process.env, PORT: '18999', MAX_NODES: '200' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  proc.stderr.on('data', (d) => {
    const msg = d.toString()
    if (!msg.includes('ExperimentalWarning')) process.stderr.write(d)
  })
  proc.on('error', (err) => {
    console.error(`无法启动服务器: ${err.message}`)
    process.exit(1)
  })

  return proc
}

async function waitForServer() {
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch(`${BASE}/stats`)
      if (res.ok) return
    } catch { /* server not ready */ }
    await sleep(300)
  }
  throw new Error('服务器启动超时')
}
