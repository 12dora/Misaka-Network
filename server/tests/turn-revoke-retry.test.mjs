#!/usr/bin/env node
/**
 * P1-6: when CF revoke fails, the credential stays in activeCredentials
 * with revokePending=true so the background retry loop can drain it.
 *
 * Setup: load persist+turn modules in-process, stub global fetch so the
 * CF revoke call returns 500 the first time and 200 the second. We then:
 *   1. seed an activeCredential by hand (over-quota relative to per-session
 *      cap) so the abuse poller would normally try to revoke it on the
 *      next analytics tick;
 *   2. call _retryPendingRevokesNow() once — it should observe the 500
 *      and bump revokeAttempts + leave the entry in place;
 *   3. call it again — this time the stub returns 200 and the entry is
 *      removed.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { runTest } from './_harness.mjs'

runTest(main, { timeoutMs: 30_000 })

async function main() {
  // Stub fetch BEFORE importing turn.js so the module sees our shim.
  const calls = []
  globalThis.fetch = async (url, init) => {
    const href = String(url)
    calls.push({ url: href, method: init?.method })
    if (href.includes('/revoke')) {
      // First call fails, every subsequent one succeeds.
      const callIdx = calls.filter(c => c.url.includes('/revoke')).length
      if (callIdx === 1) {
        return new Response('boom', { status: 500 })
      }
      return new Response('{}', { status: 200 })
    }
    // Any other request — not expected in this test.
    return new Response('{}', { status: 200 })
  }

  const tmp = mkdtempSync(join(tmpdir(), 'misaka-revoke-retry-'))
  process.env.TURN_PERSIST_DIR = tmp
  process.env.TURN_AUTO_ENABLED = 'true'
  process.env.TURN_PROVIDER = 'cloudflare'
  process.env.TURN_CF_KEY_ID = 'test-key'
  process.env.TURN_CF_API_TOKEN = 'test-token'
  process.env.TURN_CF_ACCOUNT_TAG = 'test-acct'
  // Tiny per-session cap so the abuse path treats our seeded credential
  // as over-quota the moment analytics report any bytes for it.
  process.env.TURN_MAX_BYTES_PER_SESSION = '1'

  try {
    const persist = await import('../dist/persist.js')
    const turn = await import('../dist/turn.js')

    await persist.loadTurnState()
    const state = persist.getTurnState()

    const cid = 'abcd1234abcd1234'
    state.activeCredentials[cid] = {
      sessionId: 'sess-X',
      customIdentifier: cid,
      ip: '9.9.9.9',
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      pessimisticBytes: 0,
      revokePending: true,   // mark as pending so retry picks it up
    }

    console.log('[1] first retry: CF returns 500 → entry remains, attempts incremented')
    await turn._retryPendingRevokesNow()
    assert.ok(state.activeCredentials[cid], '失败 revoke 不应丢弃记录')
    assert.equal(state.activeCredentials[cid].revokePending, true)
    assert.ok((state.activeCredentials[cid].revokeAttempts ?? 0) >= 1)
    console.log('  ✓ revoke 失败后 entry 保留并标记 attempts=' + state.activeCredentials[cid].revokeAttempts)

    console.log('[2] second retry: CF returns 200 → entry removed')
    await turn._retryPendingRevokesNow()
    assert.equal(state.activeCredentials[cid], undefined, '成功 revoke 后应清掉')
    console.log('  ✓ 重试成功后 entry 被清掉')

    console.log('\n✅ 全部测试通过')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
