#!/usr/bin/env node
/**
 * Tier1 P1 — TURN deny must bind a restart-stable principal, not sessionId.
 * With default TURN_IP_BAN_STRIKES=3, a single abuse only writes principal:/cid:
 * deny; after re-issue with a NEW sessionId the same identity must still be
 * banned when we re-register with the same principal.
 */
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runTest } from './_harness.mjs'

const TMP_DIR = mkdtempSync(join(tmpdir(), 'misaka-turn-principal-'))

process.env.TURN_AUTO_ENABLED = 'true'
process.env.TURN_PROVIDER = 'cloudflare'
process.env.TURN_CF_KEY_ID = 'test-key'
process.env.TURN_CF_API_TOKEN = 'test-token'
process.env.TURN_CF_ACCOUNT_TAG = 'test-account'
process.env.TURN_CREDENTIAL_TTL_SEC = '300'
process.env.TURN_PESSIMISTIC_RATE_BPS = '800000'
process.env.TURN_MAX_BYTES_PER_SESSION = '1000'
process.env.TURN_MAX_BYTES_PER_HOUR_PER_IP = '100000000000'
process.env.TURN_MAX_ISSUE_PER_HOUR_PER_IP = '1000'
process.env.TURN_GLOBAL_MONTHLY_BYTES_LIMIT = '100000000000'
process.env.TURN_BAN_DURATION_SEC = '3600'
// DEFAULT strikes = 3 — do NOT set to 1 (that path was already covered and
// hid the sessionId-restart hole).
process.env.TURN_IP_BAN_STRIKES = '3'
process.env.TURN_PERSIST_DIR = TMP_DIR
process.env.TURN_PERSIST_INTERVAL_SEC = '60'
process.env.SERVER_SECRET = '11'.repeat(32)

let revokeMode = 'ok'
let analyticsRows = []
globalThis.fetch = async (url) => {
  const href = String(url)
  if (href.includes('credentials/generate')) {
    return new Response(JSON.stringify({
      iceServers: { urls: ['turn:turn.cloudflare.com:3478'], username: 'u', credential: 'p' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  if (href.includes('/revoke')) {
    return revokeMode === 'ok' ? new Response('{}', { status: 200 }) : new Response('boom', { status: 500 })
  }
  if (href.includes('/graphql')) {
    return new Response(JSON.stringify({
      data: { viewer: { accounts: [{ callsTurnUsageAdaptiveGroups: analyticsRows }] } },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  throw new Error(`unexpected fetch: ${href}`)
}

const { loadTurnState, getTurnState, flushTurnState } = await import('../dist/persist.js')
const turn = await import('../dist/turn.js')
const { deriveTurnPrincipal } = await import('../dist/store.js')

let failed = 0
function assert(cond, msg) {
  if (!cond) { console.error(`  ✗ ${msg}`); failed++ }
  else console.log(`  ✓ ${msg}`)
}

async function main() {
  await loadTurnState()
  turn._resetIpByteLedger()

  const principal = deriveTurnPrincipal(42, 'deadbeefidentityhash')
  console.log('[1] issue with principal, abuse once (strikes=3 → no IP ban)')
  const r1 = await turn.issueCredentials('sess-old', '9.9.9.9', principal)
  assert(r1.ok === true, 'initial issue ok')
  const cid = r1.customIdentifier
  analyticsRows = [{ sum: { egressBytes: 3000, ingressBytes: 2000 }, dimensions: { customIdentifier: cid } }]
  await turn._pollPerIdentifierUsageNow()

  const state = getTurnState()
  assert(!!state.denyList[`principal:${principal}`], 'principal deny written')
  assert(!state.denyList['ip:9.9.9.9'], 'IP not banned after a single strike with default strikes=3')

  await flushTurnState(true)

  // Simulate restart: re-load from disk with a NEW sessionId but SAME principal.
  // We cannot re-import modules cleanly; instead re-check isDenied via a fresh
  // issueCredentials call with a different sessionId and the same principal.
  console.log('[2] new sessionId + same principal must still be SESSION_BANNED')
  const r2 = await turn.issueCredentials('sess-new-after-restart', '9.9.9.9', principal)
  assert(!r2.ok && r2.reason === 'SESSION_BANNED',
    `same principal banned across sessionId change (got ${r2.ok ? 'ok' : r2.reason})`)

  // Different principal on same IP (strikes not reached) may still issue.
  console.log('[3] different principal on same IP still issues (no IP ban yet)')
  const other = await turn.issueCredentials('sess-other', '9.9.9.9', 'otherprincipal000000000000000000')
  assert(other.ok === true, `unrelated principal issues (got ${other.ok ? 'ok' : other.reason})`)

  // Snapshot carries principal key.
  const snap = JSON.parse(readFileSync(join(TMP_DIR, 'turn-state.json'), 'utf8'))
  assert(!!snap.denyList[`principal:${principal}`], 'principal deny survives flush')
  assert(Array.isArray(snap.ipByteLedger), 'ipByteLedger present in snapshot')

  rmSync(TMP_DIR, { recursive: true, force: true })
  if (failed > 0) {
    console.error(`\n❌ ${failed} assertions failed`)
    process.exitCode = 1
    return
  }
  console.log('\n✅ turn principal deny tests passed')
}

runTest(main)
