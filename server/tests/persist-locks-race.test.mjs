#!/usr/bin/env node
/**
 * BUG-025: the auth-lock snapshot raced on a shared temporary path.
 *
 * `flushPersistedLocks()` had no in-flight guard and always wrote to
 * `auth-locks.json.tmp`. The periodic flusher and the shutdown flush (or two
 * periodic ticks with a slow disk) therefore both wrote the SAME tmp file and
 * both renamed it: the first rename moved it away, every later rename failed
 * with ENOENT, and whichever writer happened to win left an arbitrary — quite
 * possibly stale — snapshot on disk. The newest lock/freeze was not guaranteed
 * to survive the restart it was supposed to defend against.
 *
 * Fix: a unique temp file per writer plus a serialised in-flight chain, so
 * concurrent flushes never collide and the LAST queued snapshot (taken after
 * the previous write completed) is what lands on disk.
 *
 * Usage: node tests/persist-locks-race.test.mjs
 */

import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { runTest } from './_harness.mjs'

runTest(main, { timeoutMs: 60_000 })

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), 'misaka-locks-race-'))
  process.env.TURN_PERSIST_DIR = tmp

  const originalError = console.error
  const errors = []
  console.error = (...args) => { errors.push(args.join(' ')) }

  try {
    const persist = await import('../dist/persist.js')
    const store = await import('../dist/store.js')

    // A big payload widens the writeFile window so the rename collision is
    // reliably reproduced rather than being a 1-in-N flake.
    for (let i = 0; i < 4000; i++) {
      store.attemptLocks.set(store.attemptKey(`203.0.113.${i % 254}`, 1000 + i), {
        attempts: 3,
        lockedUntil: Date.now() + 5 * 60_000,
        lastAttemptAt: Date.now(),
      })
    }

    console.log('[1] 并发 flush 不产生 tmp 竞态错误')
    const flushes = []
    for (let i = 0; i < 24; i++) flushes.push(persist.flushPersistedLocks())
    // The newest lock is added while the first flushes are still in flight —
    // the LAST queued snapshot must include it.
    const newestNodeId = 19999
    const newestIp = '198.51.100.250'
    store.attemptLocks.set(store.attemptKey(newestIp, newestNodeId), {
      attempts: 3,
      lockedUntil: Date.now() + 42 * 60_000,
      lastAttemptAt: Date.now(),
    })
    flushes.push(persist.flushPersistedLocks())
    await Promise.all(flushes)

    const flushErrors = errors.filter(e => e.includes('flush locks failed'))
    assert.equal(
      flushErrors.length, 0,
      `并发 flush 不应产生写入错误，实际:\n${flushErrors.slice(0, 5).join('\n')}`,
    )
    console.log('  ✓ 24+1 次并发 flush 无 ENOENT/rename 失败')

    console.log('[2] 落盘的是最新快照')
    const raw = readFileSync(join(tmp, 'auth-locks.json'), 'utf8')
    const parsed = JSON.parse(raw)
    assert.equal(parsed.version, 1)
    const newestKey = store.attemptKey(newestIp, newestNodeId)
    const found = parsed.attemptLocks.find(e => e.key === newestKey)
    assert.ok(found, '最新写入的 lock 必须出现在快照中')
    console.log('  ✓ 最后排队的快照包含最新 lock')

    console.log('[3] 没有遗留 .tmp 文件')
    const leftovers = readdirSync(tmp).filter(f => f.endsWith('.tmp'))
    assert.deepEqual(leftovers, [], `不应遗留临时文件: ${leftovers.join(', ')}`)
    console.log('  ✓ 目录干净')

    console.log('[4] 关机前可等待所有在途 flush')
    store.attemptLocks.set(store.attemptKey('198.51.100.251', 19998), {
      attempts: 1, lockedUntil: 0, lastAttemptAt: Date.now(),
    })
    void persist.flushPersistedLocks()
    void persist.flushTurnState(true)
    await persist.awaitPendingFlushes()
    const after = JSON.parse(readFileSync(join(tmp, 'auth-locks.json'), 'utf8'))
    assert.ok(
      after.attemptLocks.some(e => e.key === store.attemptKey('198.51.100.251', 19998)),
      'awaitPendingFlushes 之后最新条目必须已落盘',
    )
    console.log('  ✓ awaitPendingFlushes 覆盖在途写入')

    console.log('\n✅ 全部测试通过')
  } finally {
    console.error = originalError
    rmSync(tmp, { recursive: true, force: true })
  }
}
