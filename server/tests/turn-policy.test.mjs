#!/usr/bin/env node
/**
 * TURN abuse-policy unit tests.
 *
 * Stubs `fetch` so no real Cloudflare calls happen. Exercises the gate logic
 * in turn.issueCredentials and the persistence layer.
 *
 * Usage: cd server && node tests/turn-policy.test.mjs
 */

import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runTest } from './_harness.mjs'

const TMP_DIR = mkdtempSync(join(tmpdir(), 'misaka-turn-'))

// Env must be set BEFORE importing modules under test.
process.env.TURN_AUTO_ENABLED = 'true'
process.env.TURN_PROVIDER = 'cloudflare'
process.env.TURN_CF_KEY_ID = 'test-key'
process.env.TURN_CF_API_TOKEN = 'test-token'
process.env.TURN_CF_ACCOUNT_TAG = 'test-account'
process.env.TURN_CREDENTIAL_TTL_SEC = '300'
process.env.TURN_MAX_BYTES_PER_SESSION = '1000000'
// Bytes cap below 1 pessimistic-cred so the *second* issuance for an IP
// trips it: 1 cred = (rate_bps/8) * ttl = (800_000/8) * 300 = 30_000_000 B
process.env.TURN_MAX_BYTES_PER_HOUR_PER_IP = '20000000'   // 20 MB
process.env.TURN_MAX_ISSUE_PER_HOUR_PER_IP = '5'
// Global limit high enough not to fire during normal test flow:
// 5+ credentials at 30 MB pessimistic ≈ 150 MB, well under threshold.
process.env.TURN_GLOBAL_MONTHLY_BYTES_LIMIT = '1000000000'  // 1 GB
process.env.TURN_GLOBAL_THRESHOLD_PCT = '90'
process.env.TURN_PESSIMISTIC_RATE_BPS = '800000'           // 1 Mbps
process.env.TURN_PERSIST_DIR = TMP_DIR
process.env.TURN_PERSIST_INTERVAL_SEC = '1'

// Stub global fetch for CF endpoints
const originalFetch = globalThis.fetch
globalThis.fetch = async (url, _init) => {
  if (typeof url === 'string' && url.includes('credentials/generate')) {
    return new Response(JSON.stringify({
      iceServers: {
        urls: ['turn:turn.cloudflare.com:3478'],
        username: 'cf-user',
        credential: 'cf-pass',
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  if (typeof url === 'string' && url.includes('revoke')) {
    return new Response('{}', { status: 200 })
  }
  if (typeof url === 'string' && url.includes('/graphql')) {
    return new Response(JSON.stringify({
      data: { viewer: { accounts: [{ callsTurnUsageAdaptiveGroups: [] }] } },
    }), { status: 200 })
  }
  throw new Error(`unexpected fetch: ${url}`)
}

const { loadTurnState, getTurnState, flushTurnState } = await import('../dist/persist.js')
const { issueCredentials, getTurnStatus } = await import('../dist/turn.js')

let failed = 0
function assert(cond, msg) {
  if (!cond) { console.error(`  ✗ ${msg}`); failed++ }
  else       { console.log(`  ✓ ${msg}`) }
}

async function main() {
  await loadTurnState()

  console.log('[1] Successful issuance')
  const r1 = await issueCredentials('sess-A', '1.1.1.1')
  assert(r1.ok === true, 'returns ok=true')
  // customIdentifier is now a one-way derivation (sha256 over sessionId +
  // SERVER_SECRET, truncated to 16 hex chars). We assert the shape but not
  // the legacy `misaka-${sessionId}` form, since that form leaked sessionId
  // to CF logs (see P2-11).
  assert(r1.ok && typeof r1.customIdentifier === 'string' && /^[0-9a-f]{16}$/.test(r1.customIdentifier),
    'customIdentifier is opaque 16-hex derivation (not the legacy misaka-${sessionId} form)')
  assert(r1.ok && Array.isArray(r1.iceServers) && r1.iceServers.length > 0, 'iceServers populated')
  assert(Object.keys(getTurnState().activeCredentials).length === 1, 'activeCredentials has 1 entry')
  assert(getTurnState().monthlyUsage.bytesObserved > 0, 'monthly bytes incremented (pessimistic)')

  console.log('[2] Per-IP byte cap (pessimistic)')
  // IP 3.3.3.3: 1 issuance adds 30 MB (under 40 MB cap), 2nd would push to 60 MB
  const r2a = await issueCredentials('sess-B', '3.3.3.3')
  assert(r2a.ok === true, 'first issue under cap succeeds')
  const r2b = await issueCredentials('sess-C', '3.3.3.3')
  assert(!r2b.ok && r2b.reason === 'IP_BYTES_LIMITED', 'IP_BYTES_LIMITED on 2nd cred over cap')

  console.log('[3] Per-IP issuance rate cap')
  // IP 4.4.4.4: rate cap = 5 issuances/hour. But byte cap is 40 MB → only 1 succeeds
  // before byte cap kicks in. So rate-cap test needs a fresh IP and bypass byte cap.
  // We bypass by manually injecting issuance history rows under the byte limit.
  const ip = '4.4.4.4'
  for (let i = 0; i < 5; i++) {
    getTurnState().ipIssuanceHistory.push({ ip, issuedAt: Date.now() })
  }
  // No active credentials for this IP → byte cap not triggered; rate cap should fire.
  const r3 = await issueCredentials('sess-D', ip)
  assert(!r3.ok && r3.reason === 'IP_RATE_LIMITED', 'IP_RATE_LIMITED at cap')

  console.log('[4] Global kill switch')
  // Manually set both fields so subsequent issuances are rejected upfront
  // (evaluateGlobalKillSwitch normally runs *after* an issue succeeds, so
  // the flag flip happens on the credential that pushes over the line).
  getTurnState().monthlyUsage.bytesObserved = 950_000_000   // 95% of 1 GB
  getTurnState().monthlyUsage.killSwitchActive = true
  getTurnState().monthlyUsage.killSwitchTriggeredAt = Date.now()
  const r4 = await issueCredentials('sess-E', '5.5.5.5')
  assert(!r4.ok && r4.reason === 'GLOBAL_QUOTA_EXCEEDED', 'GLOBAL_QUOTA_EXCEEDED while kill switch active')
  assert(getTurnState().monthlyUsage.killSwitchActive, 'killSwitchActive flag set')

  console.log('[5] Status endpoint payload (no secrets)')
  const status = getTurnStatus()
  assert(status.killSwitchActive === true, 'status reports killSwitchActive=true')
  assert(typeof status.percentUsed === 'number' && status.percentUsed > 90, 'percentUsed > 90')
  const json = JSON.stringify(status)
  assert(!json.includes('test-token') && !json.includes('cf-pass'), 'status carries no secrets')

  console.log('[6] Persistence: flush + retain month tally')
  await flushTurnState(true)
  const raw = readFileSync(join(TMP_DIR, 'turn-state.json'), 'utf8')
  const persisted = JSON.parse(raw)
  assert(persisted.version === 1, 'snapshot has version=1')
  assert(persisted.monthlyUsage.killSwitchActive === true, 'kill switch state persisted')
  assert(persisted.monthlyUsage.monthKey.match(/^\d{4}-\d{2}$/), 'monthKey YYYY-MM format')

  if (failed > 0) {
    console.error(`\n❌ ${failed} assertion(s) failed`)
    process.exitCode = 1
    return
  }
  console.log('\n✅ 全部测试通过')
}

// CLAUDE.md "test-script lifecycle": every server test script must wrap its
// entry point with runTest so cleanup (open handles, stray timers) cannot
// silently wedge CI. The previous try/finally + raw `process.exit(1)` on
// crash bypassed that guard.
runTest(async () => {
  try {
    await main()
  } finally {
    globalThis.fetch = originalFetch
    rmSync(TMP_DIR, { recursive: true, force: true })
  }
})
