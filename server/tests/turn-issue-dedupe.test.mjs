#!/usr/bin/env node
/**
 * SECURITY-008: re-signing TURN credentials for the same session overwrote the
 * active quota record.
 *
 * `activeCredentials` is keyed by customIdentifier, which is a deterministic
 * derivation of the sessionId. Six concurrent /api/turn-credentials calls for
 * ONE session therefore each reserved their own issuance-history row and their
 * own pessimistic bytes, then all wrote the SAME key — leaving a single 10-byte
 * accounting entry behind while Cloudflare had handed out six grants. The audit
 * measured exactly this: 6 successes under a 25-byte hourly cap. A failed
 * rollback could then also delete a *successful* sibling's record.
 *
 * Fix: one in-flight issuance task per session plus a cached current credential,
 * and a unique reservationId per issuance so a rollback can only ever remove the
 * instance that failed.
 *
 * Usage: node tests/turn-issue-dedupe.test.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runTest } from './_harness.mjs'

const TMP_DIR = mkdtempSync(join(tmpdir(), 'misaka-turn-dedupe-'))

process.env.TURN_AUTO_ENABLED = 'true'
process.env.TURN_PROVIDER = 'cloudflare'
process.env.TURN_CF_KEY_ID = 'test-key'
process.env.TURN_CF_API_TOKEN = 'test-token'
process.env.TURN_CF_ACCOUNT_TAG = 'test-account'
// (2.7 / 8) * 30 = 10.125 → floor 10 bytes of pessimistic budget per credential.
process.env.TURN_CREDENTIAL_TTL_SEC = '30'
process.env.TURN_PESSIMISTIC_RATE_BPS = '2.7'
// The audit's exact scenario: a 25-byte hourly cap vs 10-byte credentials.
process.env.TURN_MAX_BYTES_PER_HOUR_PER_IP = '25'
process.env.TURN_MAX_ISSUE_PER_HOUR_PER_IP = '100'
process.env.TURN_MAX_BYTES_PER_SESSION = '100000000000'
process.env.TURN_GLOBAL_MONTHLY_BYTES_LIMIT = '100000000000'
process.env.TURN_PERSIST_DIR = TMP_DIR
process.env.TURN_PERSIST_INTERVAL_SEC = '60'

let generateCalls = 0
const originalFetch = globalThis.fetch
globalThis.fetch = async (url) => {
  const href = String(url)
  if (href.includes('credentials/generate')) {
    generateCalls++
    // Yield so every concurrent caller runs its synchronous prefix first.
    await new Promise(r => setTimeout(r, 20))
    return new Response(JSON.stringify({
      iceServers: {
        urls: ['turn:turn.cloudflare.com:3478'],
        username: `cf-user-${generateCalls}`,
        credential: `cf-pass-${generateCalls}`,
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  if (href.includes('/revoke')) return new Response('{}', { status: 200 })
  if (href.includes('/graphql')) {
    return new Response(JSON.stringify({ data: { viewer: { accounts: [{ callsTurnUsageAdaptiveGroups: [] }] } } }), { status: 200 })
  }
  throw new Error(`unexpected fetch: ${href}`)
}

const { loadTurnState, getTurnState } = await import('../dist/persist.js')
const { issueCredentials, _resetIpByteLedger } = await import('../dist/turn.js')

let failed = 0
function assert(cond, msg) {
  if (!cond) { console.error(`  ✗ ${msg}`); failed++ } else { console.log(`  ✓ ${msg}`) }
}

async function main() {
  await loadTurnState()
  _resetIpByteLedger()
  const state = getTurnState()

  console.log('[1] 同一 session 的 6 个并发请求只产生一次签发')
  const results = await Promise.all(
    Array.from({ length: 6 }, () => issueCredentials('sess-A', '1.2.3.4')),
  )
  assert(results.every(r => r.ok), `全部 6 个调用都返回 ok（实际 ${results.filter(r => r.ok).length}）`)
  assert(generateCalls === 1, `只向供应商请求 1 次凭据（实际 ${generateCalls}）`)
  assert(state.ipIssuanceHistory.length === 1,
    `issuance history 只记 1 条（实际 ${state.ipIssuanceHistory.length}）`)
  assert(state.monthlyUsage.pessimisticBytesObserved === 10,
    `pessimistic 只计一次 10 字节（实际 ${state.monthlyUsage.pessimisticBytesObserved}）`)
  assert(Object.keys(state.activeCredentials).length === 1,
    `activeCredentials 只有 1 条（实际 ${Object.keys(state.activeCredentials).length}）`)

  const cids = new Set(results.map(r => r.customIdentifier))
  assert(cids.size === 1, '6 个调用共享同一个 customIdentifier')
  const creds = new Set(results.map(r => r.iceServers[0]?.credential))
  assert(creds.size === 1, '6 个调用返回同一份凭据（缓存的当前凭据）')

  const entry = Object.values(state.activeCredentials)[0]
  assert(typeof entry.reservationId === 'string' && entry.reservationId.length > 0,
    'active entry 带有唯一 reservationId（回滚只作用于同一实例）')

  console.log('[2] 不同 session 的并发请求仍各自受每 IP 字节上限约束')
  // 25-byte cap, 10 bytes already reserved by sess-A. The gate refuses once the
  // running total reaches the cap, so exactly 2 more fit (10 → 20 → 30 ≥ 25).
  const others = await Promise.all(
    Array.from({ length: 6 }, (_, i) => issueCredentials(`sess-B${i}`, '1.2.3.4')),
  )
  const okOthers = others.filter(r => r.ok).length
  const capped = others.filter(r => !r.ok && r.reason === 'IP_BYTES_LIMITED').length
  assert(okOthers === 2, `25 字节上限下只有 2 个新 session 通过（实际 ${okOthers}）`)
  assert(capped === 4, `其余 4 个被 IP_BYTES_LIMITED 拒绝（实际 ${capped}）`)
  assert(state.monthlyUsage.pessimisticBytesObserved === 30,
    `总计 3 份凭据 = 30 字节（实际 ${state.monthlyUsage.pessimisticBytesObserved}）`)

  console.log('[3] 缓存凭据过期后会重新签发')
  const cid = results[0].customIdentifier
  state.activeCredentials[cid].expiresAt = Date.now() - 1000
  const before = generateCalls
  const again = await issueCredentials('sess-A', '9.9.9.9')
  assert(again.ok === true, '过期后重新签发成功')
  assert(generateCalls === before + 1, '过期凭据不会被复用，触发了一次新的供应商调用')

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
})
