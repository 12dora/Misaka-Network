#!/usr/bin/env node
/**
 * TURN state lifecycle: credential expiry and month rollover.
 *
 * turn-policy.test.mjs nails down the issuance / gating path during a normal
 * month. This file covers the *transitions* across time and persistence
 * boundaries:
 *
 *   1. Expired credentials are pruned on next issueCredentials.
 *   2. When the persisted file is from a previous UTC month, loadTurnState
 *      must roll the month: bytesObserved → 0, killSwitchActive → false,
 *      monthKey → current.
 *   3. Active credentials are cleaned up on expiry.
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

  await caseExpiredCredentialIsPruned()
  await caseMonthRolloverResetsState()

  if (failed > 0) {
    console.error(`\n❌ ${failed} 用例失败`)
    process.exit(1)
  }
  console.log('\n✅ 全部测试通过')
}

// ── 1. Expired credentials → pruned on next issueCredentials ──────────

async function caseExpiredCredentialIsPruned() {
  console.log('[1] 过期凭证在下一次 issue 时被清理')
  const state = persist.getTurnState()

  // Manually insert an expired credential
  state.activeCredentials['misaka-sess-expired'] = {
    sessionId: 'sess-expired',
    customIdentifier: 'misaka-sess-expired',
    ip: '6.6.6.6',
    issuedAt: Date.now() - 3600_000,
    expiresAt: Date.now() - 1000,  // expired 1s ago
    pessimisticBytes: 100,
  }
  expect(Object.keys(state.activeCredentials).length === 1, 'stale credential written to state')

  // Issue a new credential — pruneActiveCredentials runs and cleans up expired ones
  const r = await turn.issueCredentials('sess-fresh', '7.7.7.7')
  expect(r.ok === true, 'fresh issue succeeds')
  expect(!state.activeCredentials['misaka-sess-expired'], '过期凭证已被 prune 清理')
  expect(!!state.activeCredentials[r.customIdentifier], '新凭证已记录')
}

// ── 2. Month rollover: persisted file from prior month is reset on load ──

async function caseMonthRolloverResetsState() {
  console.log('[2] 加载上月遗留状态 → 月度计数归零、kill switch 重置')

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

try {
  await main()
} finally {
  rmSync(TMP_DIR, { recursive: true, force: true })
}
