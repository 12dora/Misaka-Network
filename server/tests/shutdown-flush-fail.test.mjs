#!/usr/bin/env node
/**
 * Shutdown must exit non-zero when the strict security flush rejects.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runTest, killChild, spawn, TEST_INSTANCE_NONCE } from './_harness.mjs'

runTest(main, { timeoutMs: 30_000 })

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'misaka-shutdown-fail-'))
  // Make the persist dir read-only after the server has created its files —
  // first boot write succeeds, then we lock the dir before SIGTERM so the
  // final durable flush fails.
  const port = 0
  const proc = spawn(process.execPath, ['dist/index.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      PORT: String(port),
      TURN_AUTO_ENABLED: 'false',
      TURN_PERSIST_DIR: dir,
      TURN_PERSIST_INTERVAL_SEC: '60',
      SHUTDOWN_TIMEOUT_MS: '8000',
      TEST_INSTANCE_NONCE,
      SERVER_SECRET: '11'.repeat(32),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let log = ''
  let listenPort = null
  const onData = (buf) => {
    const t = buf.toString()
    log += t
    const m = t.match(/MISAKA_LISTEN_PORT=(\d+)/)
    if (m) listenPort = Number(m[1])
  }
  proc.stdout.on('data', onData)
  proc.stderr.on('data', onData)

  try {
    const deadline = Date.now() + 15_000
    while (!listenPort && Date.now() < deadline) {
      if (proc.exitCode !== null) throw new Error(`exited early: ${log}`)
      await new Promise(r => setTimeout(r, 40))
    }
    if (!listenPort) throw new Error('no listen port')

    // Seed a register so there is dirty lock/session state.
    await fetch(`http://127.0.0.1:${listenPort}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId: 19552, passCode: '195952' }),
    })

    // Remove write permission from the persist dir so durable rename/fsync fails.
    chmodSync(dir, 0o555)

    const exitPromise = new Promise(resolve => {
      proc.once('exit', (code, signal) => resolve({ code, signal }))
    })
    proc.kill('SIGTERM')
    const exit = await Promise.race([
      exitPromise,
      new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 10_000)),
    ])
    assert.equal('timeout' in exit, false, 'must exit')
    assert.notEqual(exit.code, 0, `flush failure must exit non-zero, got code=${exit.code} signal=${exit.signal}`)
    console.log('✅ shutdown flush-failure exits non-zero')
  } finally {
    try { chmodSync(dir, 0o755) } catch { /* */ }
    await killChild(proc)
    rmSync(dir, { recursive: true, force: true })
  }
}
