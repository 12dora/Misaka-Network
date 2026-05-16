#!/usr/bin/env node
/**
 * TURN state lifecycle: deny-list expiry, permanent bans, and month rollover.
 *
 * turn-policy.test.mjs nails down the issuance / gating path during a normal
 * month. This file covers the *transitions* across time and persistence
 * boundaries that you cannot trigger without manipulating state directly:
 *
 *   1. A session-level ban with TURN_BAN_DURATION_SEC > 0 must auto-expire:
 *      pruning on next issueCredentials must remove the entry and the
 *      session must be allowed through.
 *   2. With TURN_BAN_DURATION_SEC = 0, the ban must be permanent
 *      (expiresAt = 0 → never pruned).
 *   3. When the persisted file is from a previous UTC month, loadTurnState
 *      must roll the month: bytesObserved → 0, killSwitchActive → false,
 *      monthKey → current.
 *   4. Deny list entries survive month rollover (bans are not monthly).
 *
 * We stub global fetch the same way turn-policy.test.mjs does — no real CF
 * calls. Tests import the compiled `dist/` so we exercise the same code path
 * production uses; this means `npm run build` must run first
 * (handled by `npm test`).
 *
 * Usage: cd server && npm run build && node tests/turn-lifecycle.test.mjs
 */

import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const TMP_DIR = mkdtempSync(join(tmpdir(), 'misaka-turn-life-'))

// Env must be set BEFORE importing modules under test.
process.env.TURN_AUTO_ENABLED = 'true'
process.env.TURN_PROVIDER = 'cloudflare'
process.env.TURN_CF_KEY_ID = 'test-key'
process.env.TURN_CF_API_TOKEN = 'test-token'
process.env.TURN_CF_ACCOUNT_TAG = 'test-account'
process.env.TURN_CREDENTIAL_TTL_SEC = '300'
process.env.TURN_MAX_BYTES_PER_SESSION = '1000000000'
process.env.TURN_MAX_BYTES_PER_HOUR_PER_IP = '1000000000'
process.env.TURN_MAX_ISSUE_PER_HOUR_PER_IP = '1000'
process.env.TURN_GLOBAL_MONTHLY_BYTES_LIMIT = '1000000000'
process.env.TURN_GLOBAL_THRESHOLD_PCT = '90'
process.env.TURN_PESSIMISTIC_RATE_BPS = '800000'
process.env.TURN_PERSIST_DIR = TMP_DIR
process.env.TURN_PERSIST_INTERVAL_SEC = '60'
// Default ban duration — individual tests override and reload modules.
process.env.TURN_BAN_DURATION_SEC = '60'

// Stub CF endpoints so issueCredentials never makes a real network call.
globalThis.fetch = async (url) => {
  if (typeof url === 'string' && url.includes('credentials/generate')) {
    return new Response(JSON.stringify({
      iceServers: { urls: ['turn:turn.cloudflare.com:3478'], username: 'u', credential: 'p' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  if (typeof url === 'string' && url.includes('/revoke')) {
    return new Response('{}', { status: 200 })
  }
  if (typeof url === 'string' && url.includes('/graphql')) {
    return new Response(JSON.stringify({
      data: { viewer: { accounts: [{ callsTurnUsageAdaptiveGroups: [] }] } },
    }), { status: 200 })
  }
  throw new Error(`unexpected fetch: ${url}`)
}

const persist = await import('../dist/persist.js')
const turn = await import('../dist/turn.js')

let failed = 0
function expect(cond, msg) {
  if (cond) { console.log(`  ✓ ${msg}`); return }
  console.error(`  ✗ ${msg}`); failed++
}

async function main() {
  await persist.loadTurnState()

  await caseExpiredBanIsPruned()
  await casePermanentBan()
  await caseMonthRolloverResetsState()
  await caseBansSurviveMonthRollover()

  if (failed > 0) {
    console.error(`\n❌ ${failed} 用例失败`)
    process.exit(1)
  }
  console.log('\n✅ 全部测试通过')
}

// ── 1. Expired session ban → pruned on next issueCredentials ────────

async function caseExpiredBanIsPruned() {
  console.log('[1] 过期 deny-list 在下一次 issue 时被清理')
  const state = persist.getTurnState()

  turn.banSession('sess-old', 'simulated-expired')
  expect(!!state.denyList.sessions['sess-old'], 'ban 已写入 deny-list')

  // Simulate the entry having expired in the past.
  state.denyList.sessions['sess-old'].expiresAt = Date.now() - 1000

  const r = await turn.issueCredentials('sess-old', '8.8.8.8')
  expect(r.ok === true, '过期 ban 不再生效，issue 成功')
  expect(!state.denyList.sessions['sess-old'],
    '过期项已被 prune 清出 deny-list')
}

// ── 2. Permanent ban (TURN_BAN_DURATION_SEC=0) cannot be pruned ─────
//
// We can't change TURN_BAN_DURATION_SEC after module import — it's read once
// at config load. Instead, write the state directly with expiresAt=0 (which
// is exactly what banSession() produces when configured permanent) and verify
// pruning leaves it alone.

async function casePermanentBan() {
  console.log('[2] 永久 ban（expiresAt=0）不会被时间清理')
  const state = persist.getTurnState()

  state.denyList.ips['9.9.9.9'] = {
    reason: 'permanent-test',
    bannedAt: Date.now() - 24 * 3600 * 1000,
    expiresAt: 0,
  }

  const r = await turn.issueCredentials('sess-perm', '9.9.9.9')
  expect(r.ok === false && r.reason === 'IP_BANNED',
    '即便过了很久，永久 ban 依然 IP_BANNED')
  expect(!!state.denyList.ips['9.9.9.9'],
    '永久 ban 项仍然存在于 deny-list')
}

// ── 3. Month rollover: persisted file from prior month is reset on load ──

async function caseMonthRolloverResetsState() {
  console.log('[3] 加载上月遗留状态 → 月度计数归零、kill switch 重置')

  // Write a state file claiming we're still in some old month with a
  // tripped kill switch and a fat byte counter. Then re-import persist as
  // a fresh module so loadTurnState reads from disk.
  const previousMonthSnapshot = {
    version: 1,
    monthlyUsage: {
      monthKey: '2000-01',  // an arbitrarily old month
      bytesObserved: 950_000_000,
      cfBytesObserved: 950_000_000,
      pessimisticBytesObserved: 0,
      usageSource: 'cloudflare',
      lastCfSyncAt: Date.now() - 24 * 3600 * 1000,
      killSwitchActive: true,
      killSwitchTriggeredAt: Date.now() - 24 * 3600 * 1000,
    },
    denyList: { sessions: {}, ips: {} },
    activeCredentials: {},
    ipIssuanceHistory: [],
  }
  writeFileSync(
    join(TMP_DIR, 'turn-state.json'),
    JSON.stringify(previousMonthSnapshot),
    'utf8',
  )

  // Force a fresh re-import so loadTurnState reads the new file.
  const persistFresh = await import(`../dist/persist.js?reload=${Date.now()}`)
  await persistFresh.loadTurnState()
  const fresh = persistFresh.getTurnState()

  const nowKey = persistFresh.currentMonthKey()
  expect(fresh.monthlyUsage.monthKey === nowKey,
    `monthKey 滚到当前月 (${nowKey})`)
  expect(fresh.monthlyUsage.bytesObserved === 0,
    '当月字节计数归零')
  expect(fresh.monthlyUsage.killSwitchActive === false,
    'killSwitchActive 在新月份重置为 false')
  expect(fresh.monthlyUsage.killSwitchTriggeredAt === 0,
    'killSwitchTriggeredAt 重置为 0')
}

// ── 4. Bans persist across month rollover ───────────────────────────

async function caseBansSurviveMonthRollover() {
  console.log('[4] deny-list 跨月不被重置（封禁不是月度配额）')

  const snapshotWithBans = {
    version: 1,
    monthlyUsage: {
      monthKey: '2000-01',
      bytesObserved: 0,
      cfBytesObserved: 0,
      pessimisticBytesObserved: 0,
      usageSource: 'pessimistic',
      lastCfSyncAt: 0,
      killSwitchActive: false,
      killSwitchTriggeredAt: 0,
    },
    denyList: {
      sessions: {
        'sess-banned-last-month': {
          reason: 'fraud',
          bannedAt: Date.now() - 30 * 24 * 3600 * 1000,
          expiresAt: 0,  // permanent
        },
      },
      ips: {},
    },
    activeCredentials: {},
    ipIssuanceHistory: [],
  }
  writeFileSync(
    join(TMP_DIR, 'turn-state.json'),
    JSON.stringify(snapshotWithBans),
    'utf8',
  )

  const persistFresh = await import(`../dist/persist.js?reload=${Date.now()}-b`)
  await persistFresh.loadTurnState()
  const fresh = persistFresh.getTurnState()

  expect(!!fresh.denyList.sessions['sess-banned-last-month'],
    '上月留下的永久封禁仍在 deny-list 中')
}

try {
  await main()
} finally {
  rmSync(TMP_DIR, { recursive: true, force: true })
}
