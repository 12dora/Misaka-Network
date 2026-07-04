#!/usr/bin/env node
/**
 * Regression [P2]: issueCredentials read the per-IP issuance-rate and per-IP
 * byte caps synchronously, then `await cfGenerateCredentials()` (which yields
 * the event loop), and only AFTER the await pushed to ipIssuanceHistory / added
 * pessimistic bytes. N concurrent requests from one IP therefore all observed
 * pre-mutation state and all passed the checks — bypassing both caps (TOCTOU).
 *
 * Fix: RESERVE the slot (push issuance record + add pessimistic bytes)
 * synchronously BEFORE the CF round-trip, rolling back on CF failure. With the
 * reservation atomic on the single-threaded loop, concurrent requests see each
 * other's reservations and the cap holds.
 *
 * Usage: node tests/turn-toctou.test.mjs
 */

import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runTest } from './_harness.mjs'

const TMP_DIR = mkdtempSync(join(tmpdir(), 'misaka-turn-toctou-'))

process.env.TURN_AUTO_ENABLED = 'true'
process.env.TURN_PROVIDER = 'cloudflare'
process.env.TURN_CF_KEY_ID = 'test-key'
process.env.TURN_CF_API_TOKEN = 'test-token'
process.env.TURN_CF_ACCOUNT_TAG = 'test-account'
process.env.TURN_CREDENTIAL_TTL_SEC = '300'
process.env.TURN_PESSIMISTIC_RATE_BPS = '800000'          // 30MB/cred
// Rate cap is the one under test: exactly 3 issuances/hour/IP.
process.env.TURN_MAX_ISSUE_PER_HOUR_PER_IP = '3'
// High byte + global caps so only the issuance-rate cap can fire.
process.env.TURN_MAX_BYTES_PER_HOUR_PER_IP = '100000000000'
process.env.TURN_GLOBAL_MONTHLY_BYTES_LIMIT = '100000000000'
process.env.TURN_MAX_BYTES_PER_SESSION = '100000000000'
process.env.TURN_PERSIST_DIR = TMP_DIR
process.env.TURN_PERSIST_INTERVAL_SEC = '1'

const originalFetch = globalThis.fetch
globalThis.fetch = async (url) => {
  if (typeof url === 'string' && url.includes('credentials/generate')) {
    // Delay so ALL concurrent callers run their synchronous prefix (and, with
    // the fix, reserve their slot) before any CF call resolves.
    await new Promise(r => setTimeout(r, 20))
    return new Response(JSON.stringify({
      iceServers: { urls: ['turn:turn.cloudflare.com:3478'], username: 'cf-user', credential: 'cf-pass' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  if (typeof url === 'string' && url.includes('/graphql')) {
    return new Response(JSON.stringify({ data: { viewer: { accounts: [{ callsTurnUsageAdaptiveGroups: [] }] } } }), { status: 200 })
  }
  throw new Error(`unexpected fetch: ${url}`)
}

const { loadTurnState } = await import('../dist/persist.js')
const { issueCredentials } = await import('../dist/turn.js')

let failed = 0
function assert(cond, msg) {
  if (!cond) { console.error(`  ✗ ${msg}`); failed++ } else { console.log(`  ✓ ${msg}`) }
}

async function main() {
  await loadTurnState()

  console.log('[1] 10 concurrent issuances from one IP respect the 3/hour rate cap')
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) => issueCredentials(`sess-${i}`, '7.7.7.7')),
  )
  const okCount = results.filter(r => r.ok).length
  const rateLimited = results.filter(r => !r.ok && r.reason === 'IP_RATE_LIMITED').length

  assert(okCount === 3, `exactly 3 credentials issued (cap), got ${okCount}`)
  assert(rateLimited === 7, `remaining 7 rejected IP_RATE_LIMITED, got ${rateLimited}`)

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
