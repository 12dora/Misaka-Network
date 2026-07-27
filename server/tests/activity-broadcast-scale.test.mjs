#!/usr/bin/env node
/**
 * SECURITY-014: the activity broadcast must be O(n), and it must have a
 * budget.
 *
 * `broadcast()` answered "is this socket authenticated?" by re-scanning the
 * whole session map for every connected client. One event was therefore
 * O(clients × sessions) — at a few thousand nodes that is tens of millions of
 * comparisons per join/leave/transfer, on the event loop, with no cap on how
 * many events per second could trigger it and (before this change) no cap on
 * the population either.
 *
 * These run against `dist/` directly: the pathology is in a pure function of
 * the process state, so driving it through 30 000 real sockets would only add
 * noise.
 *
 * Cases:
 *   1. The socket→session index is maintained correctly (add / replace /
 *      remove / idempotent remove).
 *   2. Happy path: only authenticated sockets receive an event.
 *   3. Scale: one broadcast over 30 000 authenticated sockets completes in
 *      linear time. The old quadratic scan needs ~4.5×10^8 comparisons here.
 *   4. Budget: an event storm is capped instead of fanning out unbounded.
 *
 * Usage: node tests/activity-broadcast-scale.test.mjs
 */

import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { runTest } from './_harness.mjs'

runTest(main, { timeoutMs: 120_000 })

const __dirname = dirname(fileURLToPath(import.meta.url))
// Overridable so the fix can be demonstrated against a pre-fix checkout.
const DIST = process.env.MISAKA_TEST_SERVER_DIR
  ? join(process.env.MISAKA_TEST_SERVER_DIR, 'dist')
  : join(__dirname, '..', 'dist')

const SCALE = 30_000
// A linear pass over 30 000 sockets is single-digit milliseconds here; the
// quadratic scan is ~4.5×10^8 identity comparisons and lands near a second.
// The budget sits two orders of magnitude above the linear cost so a slow or
// loaded runner still passes, and an order of magnitude below the quadratic
// one so a regression still fails.
const SCALE_BUDGET_MS = 300

async function main() {
  const store = await import(`${DIST}/store.js`)
  const activity = await import(`${DIST}/activity.js`)
  const config = await import(`${DIST}/config.js`)

  let failed = 0
  const cases = [
    ['socket→session index add / replace / remove', () => testIndexMaintenance(store)],
    ['only authenticated sockets receive events',   () => testOnlyAuthenticated(store, activity)],
    ['one broadcast over 30k sockets is linear',    () => testScale(store, activity)],
    ['event storms are capped by a budget',         () => testBudget(store, activity, config)],
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

  if (failed > 0) {
    console.error(`\n❌ ${failed} 用例失败`)
    process.exitCode = 1
    return
  }
  console.log('\n✅ 全部测试通过')
}

// ── Cases ─────────────────────────────────────────────────────────────

function testIndexMaintenance(store) {
  const { markSocketAuthenticated, unmarkSocket, isSocketAuthenticated, authenticatedSocketCount } = store
  reset(store)

  const a = fakeSocket()
  const b = fakeSocket()
  assertEq(authenticatedSocketCount(), 0, '初始为空')

  markSocketAuthenticated(a, 'sess-a')
  markSocketAuthenticated(b, 'sess-b')
  assertEq(authenticatedSocketCount(), 2, '两个已认证 socket')
  assertEq(isSocketAuthenticated(a), true, 'a 已认证')

  // Re-marking the same socket (reconnect races) must not double-count.
  markSocketAuthenticated(a, 'sess-a')
  assertEq(authenticatedSocketCount(), 2, '重复标记不应重复计数')

  unmarkSocket(a)
  assertEq(isSocketAuthenticated(a), false, 'a 已移除')
  assertEq(authenticatedSocketCount(), 1, '计数递减')

  // Edge: removing twice (supersede path + late 'close' both call it).
  unmarkSocket(a)
  assertEq(authenticatedSocketCount(), 1, '重复移除必须幂等')

  unmarkSocket(b)
  assertEq(authenticatedSocketCount(), 0, '全部移除')
}

function testOnlyAuthenticated(store, activity) {
  reset(store)
  const authed = fakeSocket()
  const anonymous = fakeSocket()
  addSession(store, 'sess-1', authed)
  markAuthed(store, authed, 'sess-1')

  activity.setWSS({ clients: new Set([authed, anonymous]) })
  activity.broadcast({ type: 'join', nodeId: 1, message: 'hello' })

  assertEq(authed.sent.length, 1, '已认证 socket 应收到事件')
  assertEq(anonymous.sent.length, 0, '未认证 socket 不得收到事件')

  const parsed = JSON.parse(authed.sent[0])
  assertEq(parsed.t, 'ACTIVITY', '帧类型不变')
  assertEq(parsed.event.nodeId, 1, '事件内容不变')
}

async function testScale(store, activity) {
  reset(store)
  await sleep(1100)   // let the per-second broadcast budget roll over

  const sockets = []
  for (let i = 0; i < SCALE; i++) {
    const ws = fakeSocket()
    sockets.push(ws)
    addSession(store, `sess-${i}`, ws)
    markAuthed(store, ws, `sess-${i}`)
  }
  activity.setWSS({ clients: new Set(sockets) })

  const startedAt = Date.now()
  activity.broadcast({ type: 'transfer', nodeId: 7, message: 'scale' })
  const elapsed = Date.now() - startedAt

  assertEq(sockets[0].sent.length, 1, '第一个 socket 应收到事件')
  assertEq(sockets[SCALE - 1].sent.length, 1, '最后一个 socket 也应收到事件')
  assert(
    elapsed < SCALE_BUDGET_MS,
    `${SCALE} 个 socket 的一次广播耗时 ${elapsed}ms（上限 ${SCALE_BUDGET_MS}ms）—— 说明仍是每个 socket 再扫一遍 session 的 O(n²)`,
  )
  console.log(`      (${SCALE} sockets → ${elapsed}ms)`)
}

async function testBudget(store, activity, config) {
  reset(store)
  await sleep(1100)

  const ws = fakeSocket()
  addSession(store, 'sess-budget', ws)
  markAuthed(store, ws, 'sess-budget')
  activity.setWSS({ clients: new Set([ws]) })

  const storm = 200
  for (let i = 0; i < storm; i++) {
    activity.broadcast({ type: 'join', nodeId: i, message: `storm ${i}` })
  }

  const cap = config.ACTIVITY_MAX_PER_SEC
  assert(Number.isFinite(cap) && cap > 0, '必须存在每秒广播预算')
  assert(
    ws.sent.length <= cap * 2,
    `${storm} 条事件的风暴扇出了 ${ws.sent.length} 次（预算 ${cap}/秒）—— 广播频率没有上限`,
  )
  assert(ws.sent.length > 0, '预算内的事件仍应送达')
}

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Publish a socket as authenticated. The index is itself part of the fix, so
 * this degrades to a no-op when it is absent — that keeps the scale and budget
 * cases measuring real behaviour (the pre-fix implementation derives
 * membership from `nodes`) instead of failing on a missing export.
 */
function markAuthed(store, ws, sessionId) {
  if (typeof store.markSocketAuthenticated === 'function') {
    store.markSocketAuthenticated(ws, sessionId)
  }
}

function fakeSocket() {
  return {
    readyState: 1,        // WebSocket.OPEN
    bufferedAmount: 0,
    sent: [],
    send(payload) { this.sent.push(payload) },
    close() { /* not exercised here */ },
    terminate() { /* not exercised here */ },
  }
}

/**
 * Sessions only need enough shape for the membership question. The pre-fix
 * implementation resolved it by walking `nodes` looking for `s.socket === ws`,
 * so the socket back-reference has to be there for the comparison to be fair.
 */
function addSession(store, sessionId, socket) {
  store.nodes.set(sessionId, {
    sessionId,
    nodeId: 1,
    passCodeHash: 'x',
    token: sessionId,
    socket,
    lastSeen: Date.now(),
    channelId: null,
    blockedIds: new Set(),
    failedAttempts: 0,
    lockedUntil: 0,
    joinedAt: Date.now(),
    expiresAt: Date.now() + 3600_000,
    ip: '127.0.0.1',
  })
}

function reset(store) {
  for (const [, s] of store.nodes) {
    if (s.socket && store.unmarkSocket) store.unmarkSocket(s.socket)
  }
  store.nodes.clear()
}

function assert(cond, msg) { if (!cond) throw new Error(msg) }
function assertEq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg}: 期望 ${JSON.stringify(expected)}, 实际 ${JSON.stringify(actual)}`)
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
