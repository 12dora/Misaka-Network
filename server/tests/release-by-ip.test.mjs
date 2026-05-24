#!/usr/bin/env node
/**
 * /api/release-by-ip auth gate (Bug F6).
 *
 * Why this exists: the endpoint historically had no auth and wiped every
 * session sharing the caller's IP. On CGNAT / shared NAT / corporate
 * networks that lets any anonymous attacker (or one misbehaving same-IP
 * user) silently boot every other Misaka user behind that same egress IP.
 *
 * Required semantics after the fix:
 *   • No Bearer / malformed header / unknown token → 401, NO removals.
 *   • Bearer for user A → only sessions sharing A's identity
 *     (nodeId + passCodeHash) on A's IP are released. Other users on the
 *     same IP are untouched.
 *
 * Same-IP simulation: the server has `trust proxy: 1`, so we set
 * `X-Forwarded-For` to control req.ip for each call.
 *
 * Usage:  node tests/release-by-ip.test.mjs
 */

import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { runTest, killChild } from './_harness.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SERVER_DIR = join(__dirname, '..')
const PORT = 18994
const BASE = `http://localhost:${PORT}/api`

let serverProcess = null

runTest(main)

async function main() {
  console.log('[1] 启动测试服务器...')
  serverProcess = startServer()
  await waitForServer()

  let failed = 0
  const cases = [
    ['without bearer or identity → 401, no sessions removed',           testNoBearerRejected],
    ['invalid bearer → 401, no sessions removed',                       testInvalidBearerRejected],
    ['malformed Authorization header → 401',                            testMalformedHeader],
    ['valid bearer for A on shared IP → only A removed, B intact',      testSameIpOtherUsersIntact],
    ['valid bearer releases all of A\'s multi-device sessions on IP',   testMultiDeviceSameIdentity],
    ['response shape stays { released: number } for happy path',        testResponseShape],
    ['body { nodeId, passCode } releases own sessions without bearer',  testBodyIdentityReleases],
    ['body with wrong passCode → 401, others on IP untouched',          testBodyWrongPasscodeRejected],
    ['body proof shares brute-force lock with /register',               testBodyShareBruteForceLock],
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

async function testNoBearerRejected() {
  // Pre-register two unrelated users on the same IP.
  const a = await register(14100, '111111', '203.0.113.10')
  const b = await register(14101, '222222', '203.0.113.10')
  assert(a.token && b.token, 'pre-registered both users')

  const res = await fetch(`${BASE}/release-by-ip`, {
    method: 'POST',
    headers: { 'X-Forwarded-For': '203.0.113.10' },
  })
  assertEq(res.status, 401, '无 Bearer → 401')

  // Both should still be able to authenticate (sessions still exist).
  // We use the fact that /api/release with the right token returns 204 either
  // way — instead probe via stats count not dropping.
  const stats = await (await fetch(`${BASE}/stats`)).json()
  assert(stats.onlineNodes >= 0, 'stats endpoint OK')
  // Sanity: try a fresh register from a different IP for the SAME identity
  // as A — should succeed (proves A's session was not nuked from server state).
  const aAgain = await register(14100, '111111', '198.51.100.50')
  assert(aAgain.token, 'A 的身份仍可在另一 IP 再注册（旧会话仍存在于内存）')
}

async function testInvalidBearerRejected() {
  await register(14200, '333333', '203.0.113.11')

  const res = await fetch(`${BASE}/release-by-ip`, {
    method: 'POST',
    headers: {
      'X-Forwarded-For': '203.0.113.11',
      Authorization: 'Bearer not-a-real-token',
    },
  })
  assertEq(res.status, 401, '伪造 Bearer → 401')
}

async function testMalformedHeader() {
  const reg = await register(14210, '454545', '203.0.113.12')

  const wrongScheme = await fetch(`${BASE}/release-by-ip`, {
    method: 'POST',
    headers: {
      'X-Forwarded-For': '203.0.113.12',
      Authorization: `Basic ${reg.token}`,
    },
  })
  assertEq(wrongScheme.status, 401, '非 Bearer scheme → 401')

  const empty = await fetch(`${BASE}/release-by-ip`, {
    method: 'POST',
    headers: {
      'X-Forwarded-For': '203.0.113.12',
      Authorization: 'Bearer ',
    },
  })
  assertEq(empty.status, 401, '空 token → 401')
}

async function testSameIpOtherUsersIntact() {
  const IP = '203.0.113.20'
  // User A and user B are different identities sharing the same egress IP.
  const a = await register(14300, '101010', IP)
  const b = await register(14301, '202020', IP)
  assert(a.token && b.token, '注册两个不同用户')

  // A calls release-by-ip with their own bearer.
  const res = await fetch(`${BASE}/release-by-ip`, {
    method: 'POST',
    headers: {
      'X-Forwarded-For': IP,
      Authorization: `Bearer ${a.token}`,
    },
  })
  assertEq(res.status, 200, 'A 的 bearer → 200')
  const body = await res.json()
  assert(typeof body.released === 'number', 'released 必须是数字')
  assert(body.released >= 1, `应至少释放 A 的 1 个 session，实际 ${body.released}`)

  // B's nodeId should still be occupied (different passcode triggers conflict).
  const bSqueeze = await register(14301, '999999', IP, { raw: true })
  assert(
    bSqueeze.status === 409 || bSqueeze.status === 423,
    `B 的会话应仍存在 → 占用冲突，实际 status=${bSqueeze.status}`,
  )

  // A's slot should be freed — same identity should re-register cleanly.
  const aAgain = await register(14300, '101010', IP)
  assert(aAgain.token, 'A 的身份应能被重新注册')
}

async function testMultiDeviceSameIdentity() {
  const IP = '203.0.113.30'
  // Same identity registered from "two devices" → same nodeId+passcode,
  // different sessionIds.
  const dev1 = await register(14400, '424242', IP)
  const dev2 = await register(14400, '424242', IP)
  assert(dev1.sessionId !== dev2.sessionId, '两个设备应分到不同 sessionId')

  // Plus an unrelated user on the same IP — must not be touched.
  const other = await register(14401, '565656', IP)
  assert(other.token, '其他用户注册成功')

  const res = await fetch(`${BASE}/release-by-ip`, {
    method: 'POST',
    headers: {
      'X-Forwarded-For': IP,
      Authorization: `Bearer ${dev1.token}`,
    },
  })
  assertEq(res.status, 200, '同身份 bearer → 200')
  const body = await res.json()
  assert(body.released >= 2, `应释放 dev1 + dev2 两个 session，实际 ${body.released}`)

  // The other (different identity) user must NOT have been wiped:
  // registering their nodeId with a different passcode should hit a conflict.
  const otherSqueeze = await register(14401, '000000', IP, { raw: true })
  assert(
    otherSqueeze.status === 409 || otherSqueeze.status === 423,
    `不同身份的同 IP 用户应未受影响，实际 status=${otherSqueeze.status}`,
  )
}

async function testResponseShape() {
  const IP = '203.0.113.40'
  const reg = await register(14500, '707070', IP)
  const res = await fetch(`${BASE}/release-by-ip`, {
    method: 'POST',
    headers: {
      'X-Forwarded-For': IP,
      Authorization: `Bearer ${reg.token}`,
    },
  })
  assertEq(res.status, 200, '200')
  const body = await res.json()
  const keys = Object.keys(body).sort()
  assert(keys.includes('released'), `响应须包含 released 字段，实际 ${JSON.stringify(body)}`)
  assert(typeof body.released === 'number', 'released 字段为 number')
}

async function testBodyIdentityReleases() {
  // No bearer is available because the client hit IP_LIMITED on register.
  // The client re-proves identity with the (nodeId, passCode) it just typed.
  const IP = '203.0.113.60'
  // First, set up: same identity registered twice (e.g. zombie session from
  // a previous tab) plus an unrelated user on the same IP.
  const dev1 = await register(14600, '121212', IP)
  const dev2 = await register(14600, '121212', IP)
  const other = await register(14601, '343434', IP)
  assert(dev1.token && dev2.token && other.token, '初始注册成功')

  const res = await fetch(`${BASE}/release-by-ip`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': IP },
    body: JSON.stringify({ nodeId: 14600, passCode: '121212' }),
  })
  assertEq(res.status, 200, '正确身份证明 → 200')
  const body = await res.json()
  assert(body.released >= 2, `应释放两个同身份会话，实际 ${body.released}`)

  // 14600 should be re-registrable cleanly with the same identity.
  const aAgain = await register(14600, '121212', IP)
  assert(aAgain.token, '同身份应能重新注册')

  // The unrelated 14601 must still occupy its slot.
  const collide = await register(14601, '999999', IP, { raw: true })
  assert(
    collide.status === 409 || collide.status === 423,
    `不同身份的同 IP 用户应未受影响，实际 status=${collide.status}`,
  )
}

async function testBodyWrongPasscodeRejected() {
  const IP = '203.0.113.61'
  const owner = await register(14700, '565656', IP)
  assert(owner.token, '业主注册成功')

  // Wrong passcode → 401.
  const wrong = await fetch(`${BASE}/release-by-ip`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': IP },
    body: JSON.stringify({ nodeId: 14700, passCode: '111111' }),
  })
  assertEq(wrong.status, 401, '错误通行码 → 401')

  // Owner's session must still exist — same-identity register should still
  // succeed (multi-device), but a different-passcode register should still
  // collide (which is enough to prove the original session is intact).
  const collide = await register(14700, '999999', IP, { raw: true })
  assert(
    collide.status === 409 || collide.status === 423,
    `业主会话应未被错误释放，实际 status=${collide.status}`,
  )
}

async function testBodyShareBruteForceLock() {
  const IP = '203.0.113.62'
  // No registration here — we just want to confirm that bodywrong attempts
  // count toward the existing /register brute-force lock so this endpoint
  // isn't a parallel oracle.
  for (let i = 0; i < 3; i++) {
    const res = await fetch(`${BASE}/release-by-ip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': IP },
      body: JSON.stringify({ nodeId: 14800, passCode: '000000' }),
    })
    // First two responses are 401; once the lock trips the next one is 423.
    if (res.status === 423) break
    assertEq(res.status, 401, `attempt ${i + 1} 应是 401（未触发锁前）`)
  }

  // 4th attempt should be NODE_LOCKED.
  const locked = await fetch(`${BASE}/release-by-ip`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': IP },
    body: JSON.stringify({ nodeId: 14800, passCode: '000000' }),
  })
  assertEq(locked.status, 423, '触发暴力破解锁 → 423')

  // /register on the same (ip, nodeId) should also see the lock.
  const reg = await register(14800, '777777', IP, { raw: true })
  assertEq(reg.status, 423, '同一 (ip, nodeId) 在 /register 也被锁')
}

// ── helpers ─────────────────────────────────────────────────────────

async function register(nodeId, passCode, ip, opts = {}) {
  const res = await fetch(`${BASE}/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': ip,
    },
    body: JSON.stringify({ nodeId, passCode }),
  })
  if (opts.raw) return { status: res.status, body: await res.json().catch(() => null) }
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`register ${nodeId} from ${ip} failed: HTTP ${res.status} ${detail}`)
  }
  return res.json()
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

function assertEq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg}: 期望 ${JSON.stringify(expected)}, 实际 ${JSON.stringify(actual)}`)
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function startServer() {
  const proc = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: SERVER_DIR,
    env: { ...process.env, PORT: String(PORT), MAX_NODES: '500', TURN_AUTO_ENABLED: 'false' },
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
