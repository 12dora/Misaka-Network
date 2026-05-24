#!/usr/bin/env node
/**
 * P1-7: brute-force locks + node freezes survive a process restart.
 *
 * Without this, an attacker who can trigger a restart (or who just waits
 * for one) gets every lock wiped instantly. We exercise the in-process
 * flush + load cycle directly because re-spawning the server twice would
 * be slow and brittle for what is otherwise a pure read/write contract.
 */

import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { runTest } from './_harness.mjs'

runTest(main, { timeoutMs: 30_000 })

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), 'misaka-persist-locks-'))
  process.env.TURN_PERSIST_DIR = tmp

  try {
    const persist = await import('../dist/persist.js')
    const store = await import('../dist/store.js')

    // Seed an attempt lock and a node freeze.
    const ip = '198.51.100.7'
    const nodeId = 17080
    store.attemptLocks.set(store.attemptKey(ip, nodeId), {
      attempts: 3,
      lockedUntil: Date.now() + 5 * 60_000,
      lastAttemptAt: Date.now(),
    })
    store.nodeFreezes.set(nodeId, {
      recentFailures: [
        { at: Date.now() - 1000, ip: '1.1.1.1' },
        { at: Date.now() -  500, ip: '2.2.2.2' },
      ],
      frozenUntil: Date.now() + 60 * 60_000,
    })

    console.log('[1] flush → auth-locks.json written with version=1')
    await persist.flushPersistedLocks()
    const raw = readFileSync(join(tmp, 'auth-locks.json'), 'utf8')
    const parsed = JSON.parse(raw)
    assert.equal(parsed.version, 1)
    assert.ok(Array.isArray(parsed.attemptLocks))
    assert.ok(Array.isArray(parsed.nodeFreezes))
    assert.equal(parsed.attemptLocks.length, 1)
    assert.equal(parsed.nodeFreezes.length, 1)
    console.log('  ✓ JSON 文件格式正确')

    // Simulate restart: clear the in-memory maps, then load.
    store.attemptLocks.clear()
    store.nodeFreezes.clear()
    assert.equal(store.attemptLocks.size, 0)
    assert.equal(store.nodeFreezes.size, 0)

    console.log('[2] load → maps repopulated')
    await persist.loadPersistedLocks()
    assert.equal(store.attemptLocks.size, 1, '锁应被还原')
    assert.equal(store.nodeFreezes.size, 1, '冻结应被还原')
    const restored = store.attemptLocks.get(store.attemptKey(ip, nodeId))
    assert.ok(restored, 'attemptLock 仍然按相同 key 找得到')
    assert.equal(restored.attempts, 3)
    assert.ok(restored.lockedUntil > Date.now(), 'lockedUntil 仍在未来')
    const restoredFreeze = store.nodeFreezes.get(nodeId)
    assert.ok(restoredFreeze, 'freeze 仍然按 nodeId 找得到')
    assert.equal(restoredFreeze.recentFailures.length, 2)
    assert.ok(restoredFreeze.frozenUntil > Date.now())
    console.log('  ✓ 锁与冻结跨重启保留')

    console.log('\n✅ 全部测试通过')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
