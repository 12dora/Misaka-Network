#!/usr/bin/env node
/**
 * Regression [P1]: the global kill switch was driven by
 * `bytesObserved = max(cfBytesObserved, pessimisticBytesObserved)`, where
 * pessimisticBytesObserved was bumped +pessimisticBytes on EVERY issuance and
 * never decremented within the month. Since most WebRTC sessions go P2P and
 * relay ~0 bytes, pessimistic grew as (issuances × per-cred estimate) and
 * tripped the 90%-of-1TB threshold after only a few thousand credential fetches
 * regardless of real traffic — permanently disabling TURN for all users until
 * the calendar month rolled over.
 *
 * Fix: on each authoritative CF sync (pollGlobalUsage / syncTurnUsageNow),
 * reconcile pessimisticBytesObserved DOWN to the sum over still-active
 * credentials, and CLEAR the kill switch when effective bytes fall back below
 * the threshold.
 *
 * Usage: node tests/turn-killswitch-reconcile.test.mjs
 */

import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runTest } from './_harness.mjs'

const TMP_DIR = mkdtempSync(join(tmpdir(), 'misaka-turn-ks-'))

// Env BEFORE importing modules under test.
process.env.TURN_AUTO_ENABLED = 'true'
process.env.TURN_PROVIDER = 'cloudflare'
process.env.TURN_CF_KEY_ID = 'test-key'
process.env.TURN_CF_API_TOKEN = 'test-token'
process.env.TURN_CF_ACCOUNT_TAG = 'test-account'
process.env.TURN_CREDENTIAL_TTL_SEC = '300'
// 300MB pessimistic per credential: (8_000_000 / 8) * 300 = 300_000_000.
process.env.TURN_PESSIMISTIC_RATE_BPS = '8000000'
// Global limit 500MB, threshold 90% = 450MB → the 2nd issuance (600MB
// pessimistic) trips it.
process.env.TURN_GLOBAL_MONTHLY_BYTES_LIMIT = '500000000'
process.env.TURN_GLOBAL_THRESHOLD_PCT = '90'
// High per-IP caps so they don't interfere (we use distinct IPs anyway).
process.env.TURN_MAX_BYTES_PER_HOUR_PER_IP = '100000000000'
process.env.TURN_MAX_ISSUE_PER_HOUR_PER_IP = '100'
process.env.TURN_MAX_BYTES_PER_SESSION = '100000000000'
process.env.TURN_PERSIST_DIR = TMP_DIR
process.env.TURN_PERSIST_INTERVAL_SEC = '1'

const originalFetch = globalThis.fetch
globalThis.fetch = async (url) => {
  if (typeof url === 'string' && url.includes('credentials/generate')) {
    return new Response(JSON.stringify({
      iceServers: { urls: ['turn:turn.cloudflare.com:3478'], username: 'cf-user', credential: 'cf-pass' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  if (typeof url === 'string' && url.includes('revoke')) return new Response('{}', { status: 200 })
  if (typeof url === 'string' && url.includes('/graphql')) {
    // CF Analytics reports ~0 real relayed bytes (the common P2P case).
    return new Response(JSON.stringify({
      data: { viewer: { accounts: [{ callsTurnUsageAdaptiveGroups: [] }] } },
    }), { status: 200 })
  }
  throw new Error(`unexpected fetch: ${url}`)
}

const { loadTurnState, getTurnState } = await import('../dist/persist.js')
const { issueCredentials, syncTurnUsageNow } = await import('../dist/turn.js')

let failed = 0
function assert(cond, msg) {
  if (!cond) { console.error(`  ✗ ${msg}`); failed++ } else { console.log(`  ✓ ${msg}`) }
}

async function main() {
  await loadTurnState()

  console.log('[1] Pessimistic accumulation trips the kill switch')
  const r1 = await issueCredentials('s-1', '10.0.0.1')
  const r2 = await issueCredentials('s-2', '10.0.0.2')
  assert(r1.ok && r2.ok, 'both issuances succeed')
  assert(getTurnState().monthlyUsage.pessimisticBytesObserved === 600_000_000, 'pessimistic = 2 × 300MB')
  assert(getTurnState().monthlyUsage.killSwitchActive === true, 'kill switch tripped by pessimistic over-count')

  console.log('[2] A further issuance is refused while the switch is active')
  const r3 = await issueCredentials('s-3', '10.0.0.3')
  assert(!r3.ok && r3.reason === 'GLOBAL_QUOTA_EXCEEDED', 'GLOBAL_QUOTA_EXCEEDED while active')

  console.log('[3] CF sync reconciles pessimistic down + clears the kill switch')
  // Simulate the two credentials having expired (their TTL elapsed). The next
  // reconcile must drop them from the pessimistic sum.
  for (const c of Object.values(getTurnState().activeCredentials)) {
    c.expiresAt = Date.now() - 1000
  }
  await syncTurnUsageNow()   // → pollGlobalUsage: CF total ≈ 0, reconcile + clear
  const u = getTurnState().monthlyUsage
  assert(u.pessimisticBytesObserved === 0, 'pessimistic reconciled to active-cred sum (0)')
  assert(u.cfBytesObserved === 0, 'cf bytes reflect real (0) relayed')
  assert(u.bytesObserved === 0, 'effective bytes back to 0')
  assert(u.killSwitchActive === false, 'kill switch CLEARED after authoritative CF sync')

  console.log('[4] Issuance works again after the switch cleared')
  const r4 = await issueCredentials('s-4', '10.0.0.4')
  assert(r4.ok === true, 'issuance succeeds once quota is healthy again')

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
