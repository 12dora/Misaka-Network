#!/usr/bin/env node
/**
 * Regression [P3]: the per-IP hourly byte cap summed only currently-active
 * credentials (<=5-min TTL), so it could never accumulate a full hour — an IP
 * could churn one ~1GB credential per minute for an hour (~60GB) while the
 * "10GB/hour/IP" cap never fired, because at any instant only ~5 minutes of
 * credentials were counted.
 *
 * Fix: fold each credential's CF-confirmed actual bytes into a rolling per-IP
 * hourly ledger as it expires, and enforce the cap against ledger + in-flight
 * pessimistic. Folding CONFIRMED-actual (not the pessimistic estimate) means a
 * P2P session that relayed ~0 bytes contributes 0 and can never false-positive
 * a legitimate user who reconnects frequently.
 *
 * Usage: node tests/turn-ip-hourly-cap.test.mjs
 */

import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runTest } from './_harness.mjs'

const TMP_DIR = mkdtempSync(join(tmpdir(), 'misaka-turn-hourly-'))

process.env.TURN_AUTO_ENABLED = 'true'
process.env.TURN_PROVIDER = 'cloudflare'
process.env.TURN_CF_KEY_ID = 'test-key'
process.env.TURN_CF_API_TOKEN = 'test-token'
process.env.TURN_CF_ACCOUNT_TAG = 'test-account'
process.env.TURN_CREDENTIAL_TTL_SEC = '300'
process.env.TURN_PESSIMISTIC_RATE_BPS = '800000'          // 30MB/cred (small, so in-flight doesn't dominate)
process.env.TURN_MAX_BYTES_PER_HOUR_PER_IP = '500000000'  // 500MB/hour/IP cap under test
process.env.TURN_MAX_ISSUE_PER_HOUR_PER_IP = '100'
process.env.TURN_MAX_BYTES_PER_SESSION = '100000000000'
process.env.TURN_GLOBAL_MONTHLY_BYTES_LIMIT = '100000000000'
process.env.TURN_PERSIST_DIR = TMP_DIR
process.env.TURN_PERSIST_INTERVAL_SEC = '1'

const originalFetch = globalThis.fetch
globalThis.fetch = async (url) => {
  if (typeof url === 'string' && url.includes('credentials/generate')) {
    return new Response(JSON.stringify({
      iceServers: { urls: ['turn:turn.cloudflare.com:3478'], username: 'cf-user', credential: 'cf-pass' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  if (typeof url === 'string' && url.includes('/graphql')) {
    return new Response(JSON.stringify({ data: { viewer: { accounts: [{ callsTurnUsageAdaptiveGroups: [] }] } } }), { status: 200 })
  }
  throw new Error(`unexpected fetch: ${url}`)
}

const { loadTurnState, getTurnState } = await import('../dist/persist.js')
const { issueCredentials, _resetIpByteLedger } = await import('../dist/turn.js')

let failed = 0
function assert(cond, msg) {
  if (!cond) { console.error(`  ✗ ${msg}`); failed++ } else { console.log(`  ✓ ${msg}`) }
}

const MB = 1_000_000

// Issue a credential for `ip`, mark it CF-confirmed at `actualBytes`, and age it
// out so the NEXT issuance's prune folds it into the rolling ledger.
async function issueHeavyThenExpire(sess, ip, actualBytes) {
  const r = await issueCredentials(sess, ip)
  if (!r.ok) return r
  const st = getTurnState()
  const cid = Object.keys(st.activeCredentials).find(k => st.activeCredentials[k].sessionId === sess)
  st.activeCredentials[cid].cfActualBytes = actualBytes
  st.activeCredentials[cid].expiresAt = Date.now() - 1000
  return r
}

async function main() {
  await loadTurnState()
  _resetIpByteLedger()

  console.log('[1] Heavy relayer accumulates across expired credentials → capped')
  // Two 300MB confirmed-actual credentials for the same IP, both aged out.
  await issueHeavyThenExpire('h-1', '9.9.9.9', 300 * MB)
  // Issuing for a DIFFERENT IP triggers pruneActiveCredentials → folds h-1 (300MB) into ledger[9.9.9.9].
  await issueCredentials('other-1', '1.1.1.1')
  await issueHeavyThenExpire('h-2', '9.9.9.9', 300 * MB)
  await issueCredentials('other-2', '2.2.2.2')  // folds h-2 (300MB) → ledger[9.9.9.9] = 600MB

  const capped = await issueCredentials('h-3', '9.9.9.9')
  assert(!capped.ok && capped.reason === 'IP_BYTES_LIMITED',
    `600MB over the hour → IP_BYTES_LIMITED (got ${capped.ok ? 'ok' : capped.reason})`)

  console.log('[2] Frequent P2P reconnects (0 confirmed bytes) are NOT falsely capped')
  // Ten credentials for a fresh IP, each relaying ~0 (P2P), all aged out.
  for (let i = 0; i < 10; i++) {
    await issueHeavyThenExpire(`p2p-${i}`, '8.8.8.8', 0)
    await issueCredentials(`prune-${i}`, `3.3.3.${i}`)  // trigger prune/fold
  }
  const p2pOk = await issueCredentials('p2p-final', '8.8.8.8')
  assert(p2pOk.ok === true, 'P2P IP with ~0 confirmed bytes is never falsely byte-limited')

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
