#!/usr/bin/env node
/**
 * BUG-024: TURN analytics used fixed 1,000 / 10,000 result limits with no
 * pagination and no truncation check.
 *
 *   - The abuse poll asked for at most 1,000 customIdentifier rows. Above that
 *     cardinality an arbitrary subset of sessions simply escaped the per-session
 *     byte cap.
 *   - The monthly total was computed by SUMMING the rows of a 10,000-row query.
 *     Past 10,000 identifiers in a month the total silently under-reports, so
 *     the 1 TB kill switch may never trip — the exact failure mode the switch
 *     exists to prevent.
 *
 * Fix: an authoritative aggregate query (no dimensions → one summed row) for the
 * global total, cursor pagination for the per-identifier query, and an explicit
 * degraded/fail-safe state when pagination is truncated.
 *
 * Usage: node tests/turn-analytics-pagination.test.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runTest } from './_harness.mjs'

const TMP_DIR = mkdtempSync(join(tmpdir(), 'misaka-turn-pages-'))

process.env.TURN_AUTO_ENABLED = 'true'
process.env.TURN_PROVIDER = 'cloudflare'
process.env.TURN_CF_KEY_ID = 'test-key'
process.env.TURN_CF_API_TOKEN = 'test-token'
process.env.TURN_CF_ACCOUNT_TAG = 'test-account'
process.env.TURN_CREDENTIAL_TTL_SEC = '300'
process.env.TURN_PESSIMISTIC_RATE_BPS = '800000'
process.env.TURN_MAX_BYTES_PER_SESSION = '100000000000'
process.env.TURN_MAX_BYTES_PER_HOUR_PER_IP = '100000000000'
process.env.TURN_MAX_ISSUE_PER_HOUR_PER_IP = '1000'
process.env.TURN_GLOBAL_MONTHLY_BYTES_LIMIT = '100000000000'
process.env.TURN_GLOBAL_THRESHOLD_PCT = '90'
// Small paging window so the test can exercise the cursor loop cheaply.
process.env.TURN_ANALYTICS_PAGE_LIMIT = '10'
process.env.TURN_ANALYTICS_MAX_PAGES = '3'
process.env.TURN_PERSIST_DIR = TMP_DIR
process.env.TURN_PERSIST_INTERVAL_SEC = '60'

const CIDS = (n) => Array.from({ length: n }, (_, i) => `cid-${String(i).padStart(3, '0')}`)

let population = CIDS(25)
let bytesPerCid = 1
let aggregateMode = 'ok'
let aggregateTotal = 987_654_321
const pagedQueries = []
const aggregateQueries = []

const originalFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  const href = String(url)
  if (href.includes('/graphql')) {
    const body = JSON.parse(String(init?.body ?? '{}'))
    const query = String(body.query ?? '')
    if (!query.includes('dimensions')) {
      // Authoritative aggregate: no dimensions → Cloudflare collapses every row
      // into one sum, which is exactly what the monthly kill switch needs.
      aggregateQueries.push(query)
      if (aggregateMode === 'fail') {
        return new Response(JSON.stringify({ errors: [{ message: 'aggregate unavailable' }] }), { status: 200 })
      }
      return new Response(JSON.stringify({
        data: { viewer: { accounts: [{ callsTurnUsageAdaptiveGroups: [{ sum: { egressBytes: aggregateTotal, ingressBytes: 0 } }] }] } },
      }), { status: 200 })
    }
    pagedQueries.push(query)
    const limit = Number(/limit:\s*(\d+)/.exec(query)?.[1] ?? 0)
    const cursor = /customIdentifier_gt:\s*"([^"]*)"/.exec(query)?.[1] ?? null
    const startIdx = cursor === null ? 0 : population.findIndex(c => c > cursor)
    const slice = startIdx < 0 ? [] : population.slice(startIdx, startIdx + limit)
    return new Response(JSON.stringify({
      data: { viewer: { accounts: [{ callsTurnUsageAdaptiveGroups: slice.map(cid => ({
        sum: { egressBytes: bytesPerCid, ingressBytes: 0 },
        dimensions: { customIdentifier: cid },
      })) }] } },
    }), { status: 200 })
  }
  if (href.includes('credentials/generate')) {
    return new Response(JSON.stringify({
      iceServers: { urls: ['turn:turn.cloudflare.com:3478'], username: 'u', credential: 'p' },
    }), { status: 200 })
  }
  if (href.includes('/revoke')) return new Response('{}', { status: 200 })
  throw new Error(`unexpected fetch: ${href}`)
}

const { loadTurnState, getTurnState } = await import('../dist/persist.js')
const turn = await import('../dist/turn.js')

let failed = 0
function assert(cond, msg) {
  if (!cond) { console.error(`  ✗ ${msg}`); failed++ } else { console.log(`  ✓ ${msg}`) }
}

function seedCredential(state, cid) {
  state.activeCredentials[cid] = {
    sessionId: `s-${cid}`,
    customIdentifier: cid,
    ip: '10.10.10.10',
    issuedAt: Date.now(),
    expiresAt: Date.now() + 300_000,
    pessimisticBytes: 0,
    reservationId: `res-${cid}`,
  }
}

async function main() {
  await loadTurnState()
  turn._resetIpByteLedger()
  const state = getTurnState()

  console.log('[1] 逐 identifier 查询按游标分页，覆盖超过单页上限的人口')
  // cid-023 sits on the THIRD page. With the old fixed single-page query it was
  // invisible and its usage was never observed.
  seedCredential(state, 'cid-002')
  seedCredential(state, 'cid-023')
  population = CIDS(25)
  bytesPerCid = 4242
  pagedQueries.length = 0
  await turn._pollPerIdentifierUsageNow()
  assert(pagedQueries.length === 3, `发出 3 页查询（25 条 / 每页 10）实际 ${pagedQueries.length}`)
  assert(pagedQueries[1].includes('customIdentifier_gt'), '第二页带上了游标')
  assert(state.activeCredentials['cid-002'].cfActualBytes === 4242, '第一页的凭据被观测到')
  assert(state.activeCredentials['cid-023'].cfActualBytes === 4242, '第三页的凭据同样被观测到（旧实现会漏掉）')
  assert(state.monthlyUsage.analyticsTruncated !== true, '未截断 → 不进入 degraded')

  console.log('[2] 月度总量来自权威 aggregate，而不是逐行求和')
  aggregateMode = 'ok'
  aggregateTotal = 987_654_321
  aggregateQueries.length = 0
  await turn.syncTurnUsageNow()
  assert(aggregateQueries.length === 1, '发出了一次 aggregate 查询')
  assert(!aggregateQueries[0].includes('dimensions'), 'aggregate 查询不带 dimensions（服务端聚合）')
  assert(state.monthlyUsage.cfBytesObserved === 987_654_321,
    `月度字节取自 aggregate（实际 ${state.monthlyUsage.cfBytesObserved}）`)
  assert(state.monthlyUsage.analyticsTruncated !== true, 'aggregate 成功 → 非 degraded')

  console.log('[3] 分页被 MAX_PAGES 截断 → 明确进入 degraded 状态')
  population = CIDS(100)
  pagedQueries.length = 0
  await turn._pollPerIdentifierUsageNow()
  assert(pagedQueries.length === 3, `最多查询 MAX_PAGES=3 页（实际 ${pagedQueries.length}）`)
  assert(state.monthlyUsage.analyticsTruncated === true, '截断被显式记录为 analyticsTruncated')
  const opStatus = turn.getOperatorTurnStatus()
  assert(opStatus.degraded === true, 'operator 状态报告 degraded=true')
  assert(opStatus.degradedReason === 'ANALYTICS_TRUNCATED', 'degraded 原因是稳定错误码')

  console.log('[4] aggregate 不可用时回退到分页求和，并保持 fail-safe')
  state.monthlyUsage.killSwitchActive = true
  state.monthlyUsage.killSwitchTriggeredAt = Date.now()
  state.monthlyUsage.pessimisticBytesObserved = 12_345
  state.monthlyUsage.bytesObserved = 12_345
  aggregateMode = 'fail'
  population = CIDS(100)
  bytesPerCid = 1
  await turn.syncTurnUsageNow()
  assert(state.monthlyUsage.analyticsTruncated === true, '回退求和被截断 → 仍是 degraded')
  assert(state.monthlyUsage.killSwitchActive === true,
    'fail-safe：数据不完整时不会用不可信的总量清除 kill switch')
  assert(state.monthlyUsage.pessimisticBytesObserved === 12_345,
    'fail-safe：数据不完整时不把悲观估计向下对账')
  assert(typeof state.monthlyUsage.lastCfSyncErrorCode === 'string' && state.monthlyUsage.lastCfSyncErrorCode.length > 0,
    '同步错误映射为稳定错误码')

  if (failed > 0) {
    console.error(`\n❌ ${failed} assertion(s) failed`)
    process.exitCode = 1
    return
  }
  console.log('\n✅ 全部测试通过')
}

runTest(async () => {
  try {
    await main()
  } finally {
    globalThis.fetch = originalFetch
    rmSync(TMP_DIR, { recursive: true, force: true })
  }
}, { timeoutMs: 30_000 })
