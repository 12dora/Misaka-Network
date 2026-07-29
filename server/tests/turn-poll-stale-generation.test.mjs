#!/usr/bin/env node
/**
 * Out-of-order TURN global polls: a slow generation A must never clear a kill
 * switch that a fresher generation B engaged (or otherwise overwrite B).
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runTest } from './_harness.mjs'

const TMP_DIR = mkdtempSync(join(tmpdir(), 'misaka-turn-stale-'))

process.env.TURN_AUTO_ENABLED = 'true'
process.env.TURN_PROVIDER = 'cloudflare'
process.env.TURN_CF_KEY_ID = 'test-key'
process.env.TURN_CF_API_TOKEN = 'test-token'
process.env.TURN_CF_ACCOUNT_TAG = 'test-account'
process.env.TURN_CREDENTIAL_TTL_SEC = '300'
process.env.TURN_PESSIMISTIC_RATE_BPS = '8000000'
process.env.TURN_GLOBAL_MONTHLY_BYTES_LIMIT = '500000000'
process.env.TURN_GLOBAL_THRESHOLD_PCT = '90'
process.env.TURN_MAX_BYTES_PER_HOUR_PER_IP = '100000000000'
process.env.TURN_MAX_ISSUE_PER_HOUR_PER_IP = '1000'
process.env.TURN_MAX_BYTES_PER_SESSION = '100000000000'
process.env.TURN_REVOKE_ALL_ON_KILL = 'false'
process.env.TURN_PERSIST_DIR = TMP_DIR
process.env.TURN_PERSIST_INTERVAL_SEC = '60'
process.env.SERVER_SECRET = '11'.repeat(32)

let aggregateCalls = 0
let releaseSlowA = null
const originalFetch = globalThis.fetch

globalThis.fetch = async (url, init) => {
  const href = String(url)
  if (href.includes('credentials/generate')) {
    return new Response(JSON.stringify({
      iceServers: { urls: ['turn:turn.cloudflare.com:3478'], username: 'u', credential: 'p' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  if (href.includes('/revoke')) return new Response('{}', { status: 200 })
  if (href.includes('/graphql')) {
    // Distinguish generations by call order: A is slow + returns 0; B is fast + returns high.
    aggregateCalls++
    const call = aggregateCalls
    if (call === 1) {
      // Slow poll A — hold until the test releases it, then report low bytes.
      await new Promise(resolve => { releaseSlowA = resolve })
      return new Response(JSON.stringify({
        data: { viewer: { accounts: [{ callsTurnUsageAdaptiveGroups: [
          { sum: { egressBytes: 0, ingressBytes: 0 } },
        ] }] } },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    // Fast poll B — authoritative high usage that must keep/trip kill switch.
    return new Response(JSON.stringify({
      data: { viewer: { accounts: [{ callsTurnUsageAdaptiveGroups: [
        { sum: { egressBytes: 900_000_000, ingressBytes: 0 } },
      ] }] } },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  throw new Error(`unexpected fetch: ${href}`)
}

runTest(async () => {
  try {
    await main()
  } finally {
    globalThis.fetch = originalFetch
    rmSync(TMP_DIR, { recursive: true, force: true })
  }
})

async function main() {
  const { loadTurnState, getTurnState } = await import('../dist/persist.js')
  const turn = await import('../dist/turn.js')
  await loadTurnState()

  // Seed kill-switch ON so a stale low-byte poll would clear it if applied.
  const state = getTurnState()
  state.monthlyUsage.killSwitchActive = true
  state.monthlyUsage.killSwitchTriggeredAt = Date.now()
  state.monthlyUsage.bytesObserved = 900_000_000
  state.monthlyUsage.cfBytesObserved = 900_000_000
  state.monthlyUsage.pessimisticBytesObserved = 0

  turn._setGlobalPollGenerationForTest(0)
  // Start slow A at generation 1 (does not complete until releaseSlowA).
  const genA = 1
  turn._setGlobalPollGenerationForTest(genA)
  const slowA = turn._pollGlobalUsageForTest(genA)

  // Wait until A's fetch is parked.
  const parked = await waitFor(() => releaseSlowA !== null, 3000)
  assert.ok(parked, 'slow poll A must park on GraphQL')

  // Bump generation and run fast B to completion with high usage.
  const genB = 2
  turn._setGlobalPollGenerationForTest(genB)
  await turn._pollGlobalUsageForTest(genB)

  assert.equal(getTurnState().monthlyUsage.killSwitchActive, true, 'B must leave kill switch engaged')
  assert.ok(getTurnState().monthlyUsage.cfBytesObserved >= 900_000_000, 'B applied high CF total')

  // Complete A — must be discarded as stale, must NOT clear kill switch.
  releaseSlowA()
  await slowA

  assert.equal(
    getTurnState().monthlyUsage.killSwitchActive,
    true,
    'stale poll A must not clear kill switch after B',
  )
  assert.ok(
    getTurnState().monthlyUsage.cfBytesObserved >= 900_000_000,
    'stale A must not overwrite B\'s CF total with 0',
  )

  console.log('✅ out-of-order TURN poll generation tests passed')
}

function waitFor(fn, ms) {
  const deadline = Date.now() + ms
  return new Promise(resolve => {
    const tick = () => {
      if (fn()) return resolve(true)
      if (Date.now() > deadline) return resolve(false)
      setTimeout(tick, 20)
    }
    tick()
  })
}
