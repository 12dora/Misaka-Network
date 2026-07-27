#!/usr/bin/env node
/**
 * BUG-022: Cloudflare requests had no deadline and no response-shape check.
 *
 *   - `fetch()` was called with no AbortSignal, so a provider that accepted the
 *     connection and then never finished left the reservation (issuance-history
 *     row + pessimistic bytes) parked forever and the HTTP request hanging.
 *   - A 200 with an unexpected body fell through `normalizeIceServers()` to an
 *     EMPTY array, and the route happily answered `enabled: true, iceServers: []`
 *     while the reservation stayed charged.
 *
 * Fix: an AbortSignal + wall-clock deadline on every provider call, strict
 * validation of the success body, and rollback of the *whole* reservation on
 * every failure path.
 *
 * Usage: node tests/turn-provider-deadline.test.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runTest } from './_harness.mjs'

const TMP_DIR = mkdtempSync(join(tmpdir(), 'misaka-turn-deadline-'))

process.env.TURN_AUTO_ENABLED = 'true'
process.env.TURN_PROVIDER = 'cloudflare'
process.env.TURN_CF_KEY_ID = 'test-key'
process.env.TURN_CF_API_TOKEN = 'test-token'
process.env.TURN_CF_ACCOUNT_TAG = 'test-account'
process.env.TURN_CREDENTIAL_TTL_SEC = '300'
process.env.TURN_PESSIMISTIC_RATE_BPS = '800000'
process.env.TURN_MAX_BYTES_PER_HOUR_PER_IP = '100000000000'
process.env.TURN_MAX_ISSUE_PER_HOUR_PER_IP = '1000'
process.env.TURN_MAX_BYTES_PER_SESSION = '100000000000'
process.env.TURN_GLOBAL_MONTHLY_BYTES_LIMIT = '100000000000'
process.env.TURN_CF_TIMEOUT_MS = '400'
process.env.TURN_PERSIST_DIR = TMP_DIR
process.env.TURN_PERSIST_INTERVAL_SEC = '60'

let mode = 'ok'
let sawSignal = false
const originalFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  const href = String(url)
  if (href.includes('credentials/generate')) {
    if (init?.signal) sawSignal = true
    if (mode === 'hang') {
      // Deliberately ignores the AbortSignal — a proxy or a stalled TLS peer
      // behaves exactly like this, which is why the wall-clock deadline has to
      // exist on top of the signal.
      await new Promise(() => {})
    }
    if (mode === 'malformed') {
      return new Response(JSON.stringify({ result: 'created', id: 'abc' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }
    if (mode === 'empty-urls') {
      return new Response(JSON.stringify({ iceServers: { urls: [], username: 'u', credential: 'p' } }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }
    if (mode === 'no-credential') {
      return new Response(JSON.stringify({ iceServers: { urls: ['turn:turn.cloudflare.com:3478'] } }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }
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

function assertClean(state, label) {
  assert(Object.keys(state.activeCredentials).length === 0, `${label}: activeCredentials 已完全回滚`)
  assert(state.ipIssuanceHistory.length === 0, `${label}: issuance history 已完全回滚`)
  assert(state.monthlyUsage.pessimisticBytesObserved === 0, `${label}: pessimistic 字节已完全回滚`)
}

async function main() {
  await loadTurnState()
  _resetIpByteLedger()
  const state = getTurnState()

  console.log('[1] 供应商挂起 → 在 deadline 内失败并完整回滚')
  mode = 'hang'
  const started = Date.now()
  const hung = await issueCredentials('sess-hang', '1.1.1.1')
  const elapsed = Date.now() - started
  assert(!hung.ok && hung.reason === 'CF_ERROR', `挂起的供应商调用返回 CF_ERROR（实际 ${hung.ok ? 'ok' : hung.reason}）`)
  assert(elapsed < 3000, `在 deadline（400ms）附近失败，实际耗时 ${elapsed}ms`)
  assert(sawSignal === true, 'fetch 收到了 AbortSignal')
  assertClean(state, '挂起')

  console.log('[2] 200 但响应体畸形 → 视为失败，不下发空 iceServers')
  mode = 'malformed'
  const bad = await issueCredentials('sess-bad', '2.2.2.2')
  assert(!bad.ok && bad.reason === 'CF_ERROR', `畸形成功体返回 CF_ERROR（实际 ${bad.ok ? 'ok(iceServers=' + JSON.stringify(bad.iceServers) + ')' : bad.reason}）`)
  assertClean(state, '畸形响应')

  console.log('[3] urls 为空 / 缺少凭据也算畸形')
  mode = 'empty-urls'
  const emptyUrls = await issueCredentials('sess-empty', '3.3.3.3')
  assert(!emptyUrls.ok && emptyUrls.reason === 'CF_ERROR', 'urls 为空 → CF_ERROR')
  assertClean(state, '空 urls')

  mode = 'no-credential'
  const noCred = await issueCredentials('sess-nocred', '4.4.4.4')
  assert(!noCred.ok && noCred.reason === 'CF_ERROR', '缺少 username/credential → CF_ERROR')
  assertClean(state, '缺凭据')

  console.log('[4] 正常响应仍然工作')
  mode = 'ok'
  const good = await issueCredentials('sess-good', '5.5.5.5')
  assert(good.ok === true, '正常响应签发成功')
  assert(good.ok && good.iceServers.length === 1 && good.iceServers[0].credential === 'cf-pass', 'iceServers 正确解析')
  assert(state.ipIssuanceHistory.length === 1, '只有成功的这次留下 issuance 记录')

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
