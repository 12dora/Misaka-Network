#!/usr/bin/env node
/**
 * SECURITY-010: revocation lost usage, bans were never enforced, and
 * kill-switch revoke failures were never retried.
 *
 *   - The abuse path deleted the credential on a successful revoke, and the
 *     credential carried the ONLY record of its CF-confirmed bytes. Those bytes
 *     never reached the per-IP rolling ledger, so an abuser could be revoked and
 *     immediately re-sign without their hourly cap ever moving.
 *   - `TURN_BAN_DURATION_SEC` was configured but read by nobody — nothing was
 *     ever denied.
 *   - `revokeAllActive()` (global kill switch) ignored the boolean result, so a
 *     failed revoke dropped out of the world entirely: no retry, no record.
 *
 * Fix: a durable local state machine — SETTLE the usage first, then persist the
 * IP/session denial, then revoke; delete only on success, otherwise mark
 * `revokePending` so the existing retry loop drains it. The audit explicitly
 * does not require a single atomic transaction across the external provider.
 *
 * Usage: node tests/turn-deny-state-machine.test.mjs
 */

import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runTest } from './_harness.mjs'

const TMP_DIR = mkdtempSync(join(tmpdir(), 'misaka-turn-deny-'))

process.env.TURN_AUTO_ENABLED = 'true'
process.env.TURN_PROVIDER = 'cloudflare'
process.env.TURN_CF_KEY_ID = 'test-key'
process.env.TURN_CF_API_TOKEN = 'test-token'
process.env.TURN_CF_ACCOUNT_TAG = 'test-account'
process.env.TURN_CREDENTIAL_TTL_SEC = '300'
process.env.TURN_PESSIMISTIC_RATE_BPS = '800000'
process.env.TURN_MAX_BYTES_PER_SESSION = '1000'          // tiny cap → 5000 bytes is abuse
process.env.TURN_MAX_BYTES_PER_HOUR_PER_IP = '100000000000'
process.env.TURN_MAX_ISSUE_PER_HOUR_PER_IP = '1000'
process.env.TURN_GLOBAL_MONTHLY_BYTES_LIMIT = '100000000000'
process.env.TURN_BAN_DURATION_SEC = '3600'
process.env.TURN_IP_BAN_STRIKES = '1'                    // deny the IP on the first abusive session
process.env.TURN_PERSIST_DIR = TMP_DIR
process.env.TURN_PERSIST_INTERVAL_SEC = '60'

let revokeMode = 'fail'
let analyticsRows = []
const revokeCalls = []
const originalFetch = globalThis.fetch
globalThis.fetch = async (url) => {
  const href = String(url)
  if (href.includes('credentials/generate')) {
    return new Response(JSON.stringify({
      iceServers: { urls: ['turn:turn.cloudflare.com:3478'], username: 'cf-user', credential: 'cf-pass' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  if (href.includes('/revoke')) {
    revokeCalls.push(href)
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

let failed = 0
function assert(cond, msg) {
  if (!cond) { console.error(`  ✗ ${msg}`); failed++ } else { console.log(`  ✓ ${msg}`) }
}

async function main() {
  await loadTurnState()
  turn._resetIpByteLedger()
  const state = getTurnState()

  console.log('[1] 超额 session 被发现：先折算用量，再持久化 deny，最后才 revoke')
  const abuser = await turn.issueCredentials('sess-abuse', '5.5.5.5')
  assert(abuser.ok === true, '初次签发成功')
  const cid = abuser.customIdentifier
  analyticsRows = [{ sum: { egressBytes: 3000, ingressBytes: 2000 }, dimensions: { customIdentifier: cid } }]

  revokeMode = 'fail'
  await turn._pollPerIdentifierUsageNow()

  assert(turn._ipLedgerBytesForTest('5.5.5.5') === 5000,
    `用量在 revoke 之前已折算进每 IP 账本（实际 ${turn._ipLedgerBytesForTest('5.5.5.5')}）`)
  assert(state.activeCredentials[cid]?.usageSettled === true, 'entry 标记 usageSettled')
  assert(state.activeCredentials[cid]?.revokePending === true, 'revoke 失败 → revokePending=true，进入重试队列')
  assert((state.activeCredentials[cid]?.revokeAttempts ?? 0) >= 1, 'revokeAttempts 已累加')

  console.log('[2] deny 状态被持久化并生效')
  assert(!!state.denyList[`cid:${cid}`], 'session 级 deny 已写入 state')
  assert(!!state.denyList['ip:5.5.5.5'], 'IP 级 deny 已写入 state')
  assert(state.denyList[`cid:${cid}`].until > Date.now(), 'deny 有未来的到期时间')

  const resign = await turn.issueCredentials('sess-abuse', '5.5.5.5')
  assert(!resign.ok && (resign.reason === 'SESSION_BANNED' || resign.reason === 'IP_BANNED'),
    `被撤销的 session 无法立刻重签（实际 ${resign.ok ? 'ok' : resign.reason}）`)
  const otherSession = await turn.issueCredentials('sess-neighbour', '5.5.5.5')
  assert(!otherSession.ok && otherSession.reason === 'IP_BANNED',
    `同一 IP 的其他 session 也被 IP deny 拦下（实际 ${otherSession.ok ? 'ok' : otherSession.reason}）`)
  const unrelated = await turn.issueCredentials('sess-clean', '6.6.6.6')
  assert(unrelated.ok === true, '无关 IP 不受影响')

  await flushTurnState(true)
  const persisted = JSON.parse(readFileSync(join(TMP_DIR, 'turn-state.json'), 'utf8'))
  assert(!!persisted.denyList && !!persisted.denyList['ip:5.5.5.5'], 'deny 列表写入快照，可跨重启生效')

  console.log('[3] 重试成功后清除 entry，且用量不会被重复计入')
  revokeMode = 'ok'
  await turn._retryPendingRevokesNow()
  assert(state.activeCredentials[cid] === undefined, 'revoke 成功后 entry 被清除')
  assert(turn._ipLedgerBytesForTest('5.5.5.5') === 5000, '用量没有被重复折算')

  console.log('[4] kill-switch 批量撤销失败也进入重试队列')
  const victim = await turn.issueCredentials('sess-kill', '7.7.7.7')
  assert(victim.ok === true, '为 kill-switch 场景签发一份凭据')
  revokeMode = 'fail'
  await turn._revokeAllActiveNow()
  const victimEntry = state.activeCredentials[victim.customIdentifier]
  assert(!!victimEntry, 'kill-switch 撤销失败不丢记录')
  assert(victimEntry?.revokePending === true, '失败的 kill-switch 撤销标记 revokePending，由重试循环兜底')

  revokeMode = 'ok'
  await turn._retryPendingRevokesNow()
  assert(state.activeCredentials[victim.customIdentifier] === undefined, '重试成功后清除')

  console.log('[5] 过期的 revokePending 记录在删除前也会折算用量')
  const cidStale = 'ffffffffffffffff'
  state.activeCredentials[cidStale] = {
    sessionId: 'sess-stale',
    customIdentifier: cidStale,
    ip: '8.8.4.4',
    issuedAt: Date.now() - 600_000,
    expiresAt: Date.now() - 1000,
    pessimisticBytes: 0,
    cfActualBytes: 777,
    revokePending: true,
  }
  await turn._retryPendingRevokesNow()
  assert(state.activeCredentials[cidStale] === undefined, '过期记录被清理')
  assert(turn._ipLedgerBytesForTest('8.8.4.4') === 777, '清理前用量已折算进账本')

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
