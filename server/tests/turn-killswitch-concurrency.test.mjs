#!/usr/bin/env node
/**
 * BUG-023: concurrent TURN reservations could blow past the global kill
 * threshold.
 *
 * `evaluateGlobalKillSwitch()` ran only AFTER `await cfGenerateCredentials()`.
 * Every request in a burst therefore reserved its pessimistic bytes, saw the
 * kill switch still off, and called Cloudflare — so N concurrent requests all
 * got credentials no matter how far past the threshold their combined
 * reservation went.
 *
 * Fix: compare the projected usage and trip the switch SYNCHRONOUSLY, between
 * the reservation and the provider call. Policy (deliberate, see turn.ts):
 * at most ONE reservation may cross the threshold — the request that crosses it
 * is honoured, because its bytes are already reserved and refunding them would
 * just let the identical burst repeat — and every later request is refused
 * before any provider call. A provider failure rolls the reservation back but
 * does NOT un-trip the switch; only an authoritative CF sync clears it.
 *
 * Usage: node tests/turn-killswitch-concurrency.test.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runTest } from './_harness.mjs'

const TMP_DIR = mkdtempSync(join(tmpdir(), 'misaka-turn-ksconc-'))

process.env.TURN_AUTO_ENABLED = 'true'
process.env.TURN_PROVIDER = 'cloudflare'
process.env.TURN_CF_KEY_ID = 'test-key'
process.env.TURN_CF_API_TOKEN = 'test-token'
process.env.TURN_CF_ACCOUNT_TAG = 'test-account'
process.env.TURN_CREDENTIAL_TTL_SEC = '300'
// (8_000_000 / 8) * 300 = 300 MB pessimistic per credential.
process.env.TURN_PESSIMISTIC_RATE_BPS = '8000000'
// 500 MB limit × 90% = 450 MB threshold → the 2nd reservation crosses it.
process.env.TURN_GLOBAL_MONTHLY_BYTES_LIMIT = '500000000'
process.env.TURN_GLOBAL_THRESHOLD_PCT = '90'
process.env.TURN_MAX_BYTES_PER_HOUR_PER_IP = '100000000000'
process.env.TURN_MAX_ISSUE_PER_HOUR_PER_IP = '1000'
process.env.TURN_MAX_BYTES_PER_SESSION = '100000000000'
process.env.TURN_REVOKE_ALL_ON_KILL = 'false'
process.env.TURN_PERSIST_DIR = TMP_DIR
process.env.TURN_PERSIST_INTERVAL_SEC = '60'

let generateCalls = 0
const originalFetch = globalThis.fetch
globalThis.fetch = async (url) => {
  const href = String(url)
  if (href.includes('credentials/generate')) {
    generateCalls++
    await new Promise(r => setTimeout(r, 25))
    return new Response(JSON.stringify({
      iceServers: { urls: ['turn:turn.cloudflare.com:3478'], username: 'cf-user', credential: 'cf-pass' },
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

  console.log('[1] 10 个并发 reservation 不能突破全局 kill threshold')
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) => issueCredentials(`burst-${i}`, `10.0.1.${i}`)),
  )
  const ok = results.filter(r => r.ok).length
  const quota = results.filter(r => !r.ok && r.reason === 'GLOBAL_QUOTA_EXCEEDED').length

  assert(ok === 2, `只有 2 个通过（450MB 阈值 + 允许 1 次跨阈值超额），实际 ${ok}`)
  assert(quota === 8, `其余 8 个在调用供应商前就被 GLOBAL_QUOTA_EXCEEDED 拒绝，实际 ${quota}`)
  assert(generateCalls === 2, `供应商只被调用 2 次（拒绝发生在调用之前），实际 ${generateCalls}`)
  assert(state.monthlyUsage.killSwitchActive === true, 'kill switch 已开启')
  assert(state.monthlyUsage.pessimisticBytesObserved === 600_000_000,
    `预占字节封顶在 600MB（阈值 + 1 次超额），实际 ${state.monthlyUsage.pessimisticBytesObserved}`)

  console.log('[2] 开关生效后新的请求一律拒绝')
  const after = await issueCredentials('burst-late', '10.0.2.1')
  assert(!after.ok && after.reason === 'GLOBAL_QUOTA_EXCEEDED', '后续请求继续被拒绝')
  assert(generateCalls === 2, '被拒绝的请求没有产生供应商调用')

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
