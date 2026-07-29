#!/usr/bin/env node
/**
 * Ordinary 409 NODE_OCCUPIED (wrong guess, not yet locked) must strict-flush
 * security state before the response. Disk failure → 503, never a budgeted 409.
 *
 * Also covers the post-scrypt concurrent-claim recheck: racing distinct
 * passcodes against a vacant node must charge + flush, never emit uncharged
 * 409 remaining=MAX while durable writes are impossible.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, chmodSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runTest, killChild, spawn, TEST_INSTANCE_NONCE } from './_harness.mjs'

runTest(main, { timeoutMs: 90_000 })

async function main() {
  await testSequentialOccupiedFlush()
  await testConcurrentVacantRaceFlush()
  console.log('✅ 409 NODE_OCCUPIED strict-flush tests passed')
}

async function startServer(dir, extraEnv = {}) {
  const proc = spawn(process.execPath, ['dist/index.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      PORT: '0',
      TURN_AUTO_ENABLED: 'false',
      TURN_PERSIST_DIR: dir,
      TURN_PERSIST_INTERVAL_SEC: '3600',
      TEST_INSTANCE_NONCE,
      SERVER_SECRET: '11'.repeat(32),
      // Keep freeze/lock thresholds out of the way for a single wrong guess.
      NODE_FREEZE_THRESHOLD: '100',
      MAX_ATTEMPTS: '5',
      // Concurrent scrypt races need headroom.
      SCRYPT_MAX_CONCURRENT: '32',
      SCRYPT_MAX_QUEUE: '64',
      RATE_LIMIT_PER_MIN: '10000',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let log = ''
  let port = null
  const onData = (buf) => {
    const t = buf.toString()
    log += t
    const m = t.match(/MISAKA_LISTEN_PORT=(\d+)/)
    if (m) port = Number(m[1])
  }
  proc.stdout.on('data', onData)
  proc.stderr.on('data', onData)

  const deadline = Date.now() + 15_000
  while (!port && Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`exited early: ${log}`)
    await sleep(40)
  }
  if (!port) {
    await killChild(proc)
    throw new Error('no listen port')
  }
  return { proc, port, log: () => log }
}

async function testSequentialOccupiedFlush() {
  const dir = mkdtempSync(join(tmpdir(), 'misaka-409-persist-'))
  const { proc, port } = await startServer(dir)
  const base = `http://127.0.0.1:${port}/api`

  try {
    // Owner occupies the node.
    const owner = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId: 19601, passCode: '424242' }),
    })
    assert.equal(owner.status, 200, `owner register failed: ${owner.status}`)

    // Force a durable write so auth-locks.json exists, then freeze the dir.
    await sleep(100)
    chmodSync(dir, 0o555)

    const wrong = await fetch(`${base}/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '198.51.100.77',
      },
      body: JSON.stringify({ nodeId: 19601, passCode: '000000' }),
    })
    const body = await wrong.json().catch(() => ({}))
    assert.equal(
      wrong.status,
      503,
      `persist failure must yield 503 not budgeted 409, got ${wrong.status} ${JSON.stringify(body)}`,
    )
    assert.equal(body.error, 'PERSIST_FAILED')
    assert.equal(body.remaining, undefined, 'must not leak remaining budget on flush failure')

    // Restore write so we can re-check durability on a healthy path.
    chmodSync(dir, 0o755)

    // Healthy wrong guess must 409 AND leave attempt state on disk.
    const okWrong = await fetch(`${base}/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '198.51.100.78',
      },
      body: JSON.stringify({ nodeId: 19601, passCode: '111111' }),
    })
    const okBody = await okWrong.json()
    assert.equal(okWrong.status, 409, `healthy wrong guess → 409, got ${okWrong.status}`)
    assert.equal(okBody.error, 'NODE_OCCUPIED')
    assert.ok(typeof okBody.remaining === 'number' && okBody.remaining >= 1)

    // auth-locks.json must contain the attempt (crash would not restore budget).
    const locksPath = join(dir, 'auth-locks.json')
    assert.ok(existsSync(locksPath), 'auth-locks.json must exist after 409')
    const locks = JSON.parse(readFileSync(locksPath, 'utf8'))
    const entries = locks.attemptLocks ?? locks.locks ?? []
    // Shape varies; at least some freeze/attempt history must be non-empty.
    const hasAttempts = Array.isArray(entries)
      ? entries.length > 0
      : Object.keys(locks).length > 0
    assert.ok(hasAttempts, `expected persisted attempt state, got ${JSON.stringify(locks).slice(0, 300)}`)
  } finally {
    try { chmodSync(dir, 0o755) } catch { /* */ }
    await killChild(proc)
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Probe that found the uncharged path: N concurrent distinct passcodes on a
 * vacant nodeId with a read-only persist dir. Bug returned 1×200 + (N-1)×409
 * remaining=MAX and never 503. Fixed path must charge losers and 503 on flush
 * failure before any budgeted 409.
 */
async function testConcurrentVacantRaceFlush() {
  const dir = mkdtempSync(join(tmpdir(), 'misaka-409-race-'))
  const { proc, port } = await startServer(dir)
  const base = `http://127.0.0.1:${port}/api`
  const NODE = 19602
  const N = 12

  try {
    // Touch a durable write first so the locks file path is exercised, then
    // freeze the directory before the race (vacant node — no owner).
    const warm = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId: 19999, passCode: '999999' }),
    })
    assert.equal(warm.status, 200, `warm register failed: ${warm.status}`)
    // Wrong guess on warm node forces a locks flush while dir is writable.
    await fetch(`${base}/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '198.51.100.1',
      },
      body: JSON.stringify({ nodeId: 19999, passCode: '000000' }),
    })
    await sleep(80)
    chmodSync(dir, 0o555)

    const codes = Array.from({ length: N }, (_, i) => String(100000 + i).padStart(6, '0'))
    const results = await Promise.all(codes.map((passCode, i) =>
      fetch(`${base}/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Distinct IPs so per-(ip,nodeId) locks do not serialize the race.
          'X-Forwarded-For': `198.51.100.${10 + i}`,
        },
        body: JSON.stringify({ nodeId: NODE, passCode }),
      }).then(async (r) => {
        const body = await r.json().catch(() => ({}))
        return { status: r.status, body }
      }),
    ))

    const byStatus = new Map()
    for (const r of results) {
      byStatus.set(r.status, (byStatus.get(r.status) || 0) + 1)
    }

    // At most one winner may land (in-memory insert needs no flush).
    const wins = results.filter(r => r.status === 200)
    assert.ok(wins.length <= 1, `at most one concurrent winner, got ${wins.length}`)

    // Losers that hit the identity-conflict recheck must NOT emit a budgeted
    // 409 with remaining — flush is impossible, so 503 PERSIST_FAILED.
    const budgeted409 = results.filter(r =>
      r.status === 409
      && r.body?.error === 'NODE_OCCUPIED'
      && typeof r.body?.remaining === 'number',
    )
    assert.equal(
      budgeted409.length,
      0,
      `uncharged/budgeted 409 during read-only race forbidden; statuses=${JSON.stringify([...byStatus])} sample=${JSON.stringify(budgeted409[0])}`,
    )

    // At least one loser must have attempted the recheck path and failed flush.
    // (If all N somehow 200 or 429, the race fixture is broken.)
    const persistFails = results.filter(r => r.status === 503 && r.body?.error === 'PERSIST_FAILED')
    const conflicts = results.filter(r => r.status !== 200)
    assert.ok(conflicts.length >= N - 1, `expected ≥${N - 1} non-winners, got ${conflicts.length}`)
    assert.ok(
      persistFails.length >= 1,
      `concurrent conflict under read-only dir must yield ≥1 PERSIST_FAILED 503, got statuses=${JSON.stringify([...byStatus])}`,
    )
    for (const r of persistFails) {
      assert.equal(r.body.remaining, undefined, '503 must not leak remaining')
    }
  } finally {
    try { chmodSync(dir, 0o755) } catch { /* */ }
    await killChild(proc)
    rmSync(dir, { recursive: true, force: true })
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
