#!/usr/bin/env node
/**
 * SECURITY-009 + SECURITY-017.
 *
 * SECURITY-009: `index.ts` called `httpServer.listen()` while
 * `loadPersistedLocks()` and `loadTurnState()` were still in flight. Between
 * bind and load the process served requests against EMPTY security state:
 * persisted locks/freezes were not in force, the persisted TURN kill switch was
 * off, and any reservation made in that window was overwritten the moment the
 * snapshot replaced the state object. On top of that, a state file the server
 * could not read was silently treated as "fresh install" — i.e. TURN issuance
 * failed OPEN with no knowledge of the month's spend.
 *
 * Fix: await + validate both snapshots BEFORE binding; fail CLOSED on TURN
 * issuance when the TURN snapshot could not be loaded; and split liveness
 * (/api/health) from readiness (/api/ready) so the degraded state is visible.
 *
 * SECURITY-017: /api/turn-status answered every unauthenticated caller with the
 * monthly byte spend, the configured limit and threshold, the kill-switch state
 * and the raw Cloudflare error string. Public callers now get coarse
 * availability only; the detailed view sits behind TURN_OPERATOR_TOKEN and
 * reports stable error codes instead of provider diagnostics.
 *
 * Usage: node tests/startup-readiness.test.mjs
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runTest, killChild } from './_harness.mjs'

runTest(main, { timeoutMs: 90_000 })

const STUB = new URL('./turn-fetch-stub.mjs', import.meta.url).pathname
const CWD = new URL('..', import.meta.url).pathname

function wait(ms) { return new Promise(r => setTimeout(r, ms)) }

async function waitForHealth(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`)
      if (res.ok) return
    } catch { /* not up yet */ }
    await wait(100)
  }
  throw new Error(`server on :${port} did not become healthy`)
}

function startServer(port, dir, extraEnv = {}) {
  return spawn(process.execPath, ['dist/index.js'], {
    cwd: CWD,
    env: {
      ...process.env,
      PORT: String(port),
      TURN_AUTO_ENABLED: 'true',
      TURN_PROVIDER: 'cloudflare',
      TURN_CF_KEY_ID: 'test-key',
      TURN_CF_API_TOKEN: 'test-token',
      TURN_CF_ACCOUNT_TAG: 'test-account',
      TURN_PERSIST_DIR: dir,
      TURN_PERSIST_INTERVAL_SEC: '60',
      TURN_GLOBAL_MONTHLY_BYTES_LIMIT: '1000000000',
      TURN_PESSIMISTIC_RATE_BPS: '800000',
      NODE_OPTIONS: `--import ${STUB}`,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

async function main() {
  await caseCorruptStateFailsClosed()
  await caseStatusSplit()
  console.log('\n✅ 全部测试通过')
}

// ── A. 无法加载的持久状态 → 绑定前完成加载、TURN fail closed ─────────
async function caseCorruptStateFailsClosed() {
  console.log('[A] 持久状态损坏时：先加载再监听，TURN 签发 fail closed')
  const port = 19700 + Math.floor(Math.random() * 200)
  const dir = mkdtempSync(join(tmpdir(), 'misaka-ready-bad-'))

  // A TURN snapshot we cannot trust. The old code logged a warning and carried
  // on with an empty state — i.e. a fresh 0-byte month and no kill switch.
  writeFileSync(join(dir, 'turn-state.json'), JSON.stringify({
    version: 1,
    monthlyUsage: { monthKey: 'not-a-month', bytesObserved: 'lots' },
    activeCredentials: 'not-an-object',
    ipIssuanceHistory: 42,
  }), 'utf8')

  // A perfectly valid lock snapshot: node 18777 is frozen for another hour.
  // Freezes are keyed by nodeId alone, so this is enforceable regardless of how
  // the client IP resolves.
  const frozenNodeId = 18777
  writeFileSync(join(dir, 'auth-locks.json'), JSON.stringify({
    version: 1,
    savedAt: Date.now(),
    attemptLocks: [],
    nodeFreezes: [{ nodeId: frozenNodeId, freeze: { recentFailures: [], frozenUntil: Date.now() + 60 * 60_000 } }],
  }), 'utf8')

  const proc = startServer(port, dir)
  try {
    await waitForHealth(port)

    // 1. The persisted freeze must be in force on the FIRST request served.
    const frozenRes = await fetch(`http://127.0.0.1:${port}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId: frozenNodeId, passCode: '123456' }),
    })
    assert.equal(frozenRes.status, 423, '持久化的 freeze 必须在第一个请求上就生效')
    const frozenBody = await frozenRes.json()
    assert.equal(frozenBody.reason, 'NODE_FROZEN')
    console.log('  ✓ 持久 freeze 在 bind 之前就已加载')

    // 2. Liveness stays green; readiness reports the degradation.
    const readyRes = await fetch(`http://127.0.0.1:${port}/api/ready`)
    const ready = await readyRes.json()
    assert.equal(readyRes.status, 200, '核心状态已加载 → ready')
    assert.equal(ready.ready, true)
    assert.equal(ready.degraded, true, 'TURN 快照不可用 → degraded')
    assert.equal(ready.turnState, 'failed')
    console.log('  ✓ /api/ready 与 /api/health 分离，并报告 degraded')

    // 3. TURN issuance fails CLOSED.
    const regRes = await fetch(`http://127.0.0.1:${port}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId: 18778, passCode: '654321' }),
    })
    assert.equal(regRes.status, 200)
    const session = await regRes.json()

    const turnRes = await fetch(`http://127.0.0.1:${port}/api/turn-credentials`, {
      headers: { Authorization: `Bearer ${session.token}` },
    })
    assert.equal(turnRes.status, 503, 'TURN 状态不可用时不得下发凭据')
    const turnBody = await turnRes.json()
    assert.equal(turnBody.enabled, false)
    assert.equal(turnBody.reason, 'STATE_UNAVAILABLE')
    console.log('  ✓ TURN 签发 fail closed（STATE_UNAVAILABLE）')

    // 4. The public status must show unavailable without leaking why.
    const pub = await (await fetch(`http://127.0.0.1:${port}/api/turn-status`)).json()
    assert.equal(pub.available, false)
    console.log('  ✓ 公共状态显示不可用')
  } finally {
    killChild(proc)
    await wait(300)
    rmSync(dir, { recursive: true, force: true })
  }
}

// ── B. 公共 / operator 状态分离 ──────────────────────────────────────
const DETAILED_ONLY = [
  'monthKey', 'monthlyBytesUsed', 'monthlyBytesEffective', 'monthlyUsageSource',
  'monthlyBytesLimit', 'percentUsed', 'thresholdPct', 'killSwitchActive',
  'killSwitchTriggeredAt', 'lastCfSyncAt', 'activeCredentials', 'lastCfSyncError',
  'lastCfSyncErrorCode', 'denyListSize', 'revokePendingCount',
]

async function caseStatusSplit() {
  console.log('[B] /api/turn-status 公共粗粒度 vs operator 详细')
  const port = 19900 + Math.floor(Math.random() * 90)
  const dir = mkdtempSync(join(tmpdir(), 'misaka-ready-ok-'))
  const OPERATOR_TOKEN = 'operator-secret-0123456789'

  const proc = startServer(port, dir, { TURN_OPERATOR_TOKEN: OPERATOR_TOKEN })
  try {
    await waitForHealth(port)

    const readyRes = await fetch(`http://127.0.0.1:${port}/api/ready`)
    const ready = await readyRes.json()
    assert.equal(readyRes.status, 200)
    assert.equal(ready.ready, true)
    assert.equal(ready.degraded, false)
    assert.equal(ready.turnState, 'ok')
    assert.equal(ready.locksState, 'ok')
    console.log('  ✓ 干净启动 → ready 且非 degraded')

    const pubRes = await fetch(`http://127.0.0.1:${port}/api/turn-status`)
    assert.equal(pubRes.status, 200)
    const pub = await pubRes.json()
    assert.equal(typeof pub.available, 'boolean', '公共响应给出粗粒度可用性')
    assert.equal(pub.detailed, false)
    assert.equal(pub.enabled, true)
    assert.equal(pub.configured, true)
    for (const key of DETAILED_ONLY) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(pub, key), false,
        `公共响应不得包含 ${key}`,
      )
    }
    console.log('  ✓ 未认证调用者拿不到配额/阈值/kill-switch/供应商诊断')

    const badRes = await fetch(`http://127.0.0.1:${port}/api/turn-status`, {
      headers: { Authorization: 'Bearer wrong-token-wrong-token' },
    })
    assert.equal(badRes.status, 401, '错误的 operator token 必须 401')
    console.log('  ✓ 错误 operator token → 401')

    const opRes = await fetch(`http://127.0.0.1:${port}/api/turn-status`, {
      headers: { Authorization: `Bearer ${OPERATOR_TOKEN}` },
    })
    assert.equal(opRes.status, 200)
    const op = await opRes.json()
    assert.equal(op.detailed, true)
    assert.equal(typeof op.monthlyBytesLimit, 'number')
    assert.equal(typeof op.thresholdPct, 'number')
    assert.equal(typeof op.killSwitchActive, 'boolean')
    assert.equal(typeof op.activeCredentials, 'number')
    assert.equal(typeof op.degraded, 'boolean')
    assert.equal(
      Object.prototype.hasOwnProperty.call(op, 'lastCfSyncError'), false,
      'operator 视图也只给稳定错误码，不给供应商原始诊断',
    )
    console.log('  ✓ operator 认证后返回详细计数 + 稳定错误码')
  } finally {
    killChild(proc)
    await wait(300)
    rmSync(dir, { recursive: true, force: true })
  }
}
