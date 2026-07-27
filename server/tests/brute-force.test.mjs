#!/usr/bin/env node
/**
 * 通行码暴力穷举集成测试
 *
 * 启动信令服务器，验证：
 * 1. 3 次错误通行码 → 锁定 5 分钟
 * 2. 锁定期间正确通行码也拒绝
 * 3. 注册 API 速率限制
 * 4. 单 IP 最多 10 个节点
 * 5. Bug F7: 锁定追踪 attempter（IP+nodeId），不再连累 owner
 *    — 攻击者从 IP A 暴力穷举不会把 IP B 的合法 owner 锁出
 *    — 合法 owner 注册成功后清除自己的 attempter 计数
 *
 * Usage: cd server && node tests/brute-force.test.mjs
 */

import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { runTest, killChild, spawn } from './_harness.mjs'

runTest(main)

const __dirname = dirname(fileURLToPath(import.meta.url))
const SERVER_DIR = join(__dirname, '..')
const BASE = 'http://localhost:18999/api'

let serverProcess = null

async function main() {
  // ── Start server ─────────────────────────────────────────────────
  console.log('[1/8] 启动测试服务器...')
  serverProcess = startServer()
  await waitForServer()

  try {
    await testBruteForceLock()
    await testAttackerCannotLockOwnerOnDifferentIp()
    await testSuccessfulRegisterClearsAttemptCounter()
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
  console.log('[2/8] 通行码暴力穷举锁定测试（同 IP 下）...')

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

  // Locked: correct passcode from the SAME attempter (same IP, same nodeId)
  // should also be rejected. The lock is keyed to the attempter so the
  // server can't tell whether the lock duration is a defensive 5-minute
  // window against the same source IP or just a guess that happened to be
  // right; the safe choice is "reject for the whole window".
  const locked = await post('/register', { nodeId, passCode: correctCode })
  assertEq(locked.error, 'NODE_LOCKED', '锁定期间正确通行码也拒绝（同 IP）')
  console.log('   ✓ 锁定期间正确通行码 → NODE_LOCKED (同 IP)')
}

// ── Test 2 (F7): attacker can't lock the owner on a different IP ────
//
// This is the core invariant the F7 fix protects. Before the fix the failed
// attempts were counted against the owner's session, so any anonymous IP
// could lock the legitimate owner out of their own nodeId in under a
// minute. After the fix the counter follows the attacker's (IP, nodeId)
// pair only.

async function testAttackerCannotLockOwnerOnDifferentIp() {
  console.log('[3/8] F7: 攻击者 IP 不应锁住合法 owner 的不同 IP ...')

  const nodeId = 10100
  const correctCode = '777777'
  const ATTACKER_IP = '198.51.100.7'
  const OWNER_IP    = '203.0.113.42'

  // Pre-register the owner on OWNER_IP so the nodeId is occupied. (If the
  // bug were present, the attack below would lock this very session.)
  const ownerPre = await postFrom('/register', { nodeId, passCode: correctCode }, OWNER_IP)
  assert(ownerPre.token, 'owner 预先注册成功')

  // Bombard from ATTACKER_IP with wrong passcodes — far more than 3 to
  // make sure cumulative count would have wrecked the owner under the
  // old semantics.
  let attackerLocked = false
  for (let i = 0; i < 25; i++) {
    const guess = String(i).padStart(6, '0')
    if (guess === correctCode) continue
    const r = await postFrom('/register', { nodeId, passCode: guess }, ATTACKER_IP)
    if (r.error === 'NODE_LOCKED') {
      attackerLocked = true
      // Once we see lock from this attempter we've proven the lock applied
      // to the attacker — no need to keep hammering.
      break
    }
  }
  assert(attackerLocked, '攻击者 IP 自己应被锁定')
  console.log('   ✓ 攻击者 IP 自身被锁定')

  // Owner on a DIFFERENT IP, with the CORRECT passcode, must still get a
  // working multi-device session — this is the legitimate "phone joins the
  // cluster after PC" path.
  const ownerAfter = await postFrom('/register', { nodeId, passCode: correctCode }, OWNER_IP)
  assert(ownerAfter.token, `合法 owner 应能正常注册，实际响应 ${JSON.stringify(ownerAfter)}`)
  assert(ownerAfter.sessionId !== ownerPre.sessionId, 'owner 应分到新的 sessionId')
  console.log('   ✓ 合法 owner 在 IP B 上仍能注册成功')
}

// ── Test 3 (F7): success clears the per-attempter counter ──────────

async function testSuccessfulRegisterClearsAttemptCounter() {
  console.log('[4/8] F7: 注册成功后应清除 (IP,nodeId) 失败计数 ...')

  const nodeId = 10200
  const correctCode = '654321'
  const SHARED_IP = '198.51.100.50'

  // First register an OWNER from a *different* IP so the nodeId is taken.
  const ownerIp = '203.0.113.99'
  const owner = await postFrom('/register', { nodeId, passCode: correctCode }, ownerIp)
  assert(owner.token, 'owner registered on its own IP')

  // From SHARED_IP, type the wrong code twice — should be under the
  // 3-strike threshold so the attempter is not yet locked.
  for (let i = 0; i < 2; i++) {
    const r = await postFrom('/register', { nodeId, passCode: '000000' }, SHARED_IP)
    assertEq(r.error, 'NODE_OCCUPIED', `第 ${i + 1} 次错误未越线`)
  }

  // Now register correctly from SHARED_IP — this IS the owner's identity
  // (matching nodeId+passcode), so it should succeed AND wipe the prior
  // failure count for (SHARED_IP, nodeId).
  const ok = await postFrom('/register', { nodeId, passCode: correctCode }, SHARED_IP)
  assert(ok.token, '正确通行码注册成功')

  // A SUBSEQUENT wrong attempt from SHARED_IP should reset to "1 failure",
  // not "3 failures → locked". We test this by issuing one wrong attempt
  // and asserting the response is still NODE_OCCUPIED with remaining >=
  // MAX_ATTEMPTS - 1.
  const after = await postFrom('/register', { nodeId, passCode: '999999' }, SHARED_IP)
  assertEq(after.error, 'NODE_OCCUPIED', '失败计数应已被清零，新一次错误不应直接锁定')
  assert(after.remaining === undefined || after.remaining >= 1,
    `remaining 应至少为 1，实际 ${after.remaining}`)
  console.log('   ✓ 注册成功后失败计数被重置')
}

// ── Test 4: API rate limit ───────────────────────────────────────

async function testRateLimit() {
  console.log('[6/8] API 速率限制测试...')

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

// ── Test 5: IP node limit ────────────────────────────────────────

async function testIpNodeLimit() {
  console.log('[5/8] 单 IP 节点数限制测试...')

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

// Issue a request that the server sees as coming from a specific IP.
// Requires `app.set('trust proxy', 1)` on the server (set in index.ts).
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
  const proc = spawn('node', ['dist/index.js'], {
    cwd: SERVER_DIR,
    // TRUST_PROXY=1: this test simulates distinct client IPs via X-Forwarded-For
    // (postFrom); the server only honours XFF when it trusts a proxy hop.
    env: { ...process.env, PORT: '18999', MAX_NODES: '200', TRUST_PROXY: '1', TURN_AUTO_ENABLED: 'false' },
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
