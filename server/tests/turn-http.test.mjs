#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const port = 19080 + Math.floor(Math.random() * 1000)
const tmp = mkdtempSync(join(tmpdir(), 'misaka-turn-http-'))

const env = {
  ...process.env,
  PORT: String(port),
  TURN_AUTO_ENABLED: 'true',
  TURN_PROVIDER: 'cloudflare',
  TURN_CF_KEY_ID: 'test-key',
  TURN_CF_API_TOKEN: 'test-token',
  TURN_CF_ACCOUNT_TAG: 'test-account',
  TURN_PERSIST_DIR: tmp,
  TURN_PERSIST_INTERVAL_SEC: '1',
  TURN_GLOBAL_MONTHLY_BYTES_LIMIT: '1000000000',
  TURN_PESSIMISTIC_RATE_BPS: '800000',
  NODE_OPTIONS: `--import ${new URL('./turn-fetch-stub.mjs', import.meta.url).pathname}`,
}

const proc = spawn(process.execPath, ['dist/index.js'], {
  cwd: new URL('..', import.meta.url).pathname,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
})

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitForHealth() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`)
      if (res.ok) return
    } catch {}
    await wait(100)
  }
  throw new Error('server did not become healthy')
}

try {
  await waitForHealth()

  await wait(2300)
  const statusRes = await fetch(`http://127.0.0.1:${port}/api/turn-status`)
  assert.equal(statusRes.status, 200)
  const status = await statusRes.json()
  assert.equal(status.enabled, true)
  assert.equal(status.configured, true)
  assert.equal(status.monthlyUsageSource, 'cloudflare')
  assert.equal(status.monthlyBytesUsed, 5555)
  assert.ok(status.lastCfSyncAt > 0)

  const regRes = await fetch(`http://127.0.0.1:${port}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodeId: 18888, passCode: '123456' }),
  })
  assert.equal(regRes.status, 200)
  const session = await regRes.json()
  assert.ok(session.token)

  const turnRes = await fetch(`http://127.0.0.1:${port}/api/turn-credentials`, {
    headers: { Authorization: `Bearer ${session.token}` },
  })
  assert.equal(turnRes.status, 200)
  const turn = await turnRes.json()
  assert.equal(turn.enabled, true)
  assert.ok(Array.isArray(turn.iceServers))
  assert.ok(turn.iceServers.length >= 1)
  assert.ok(turn.iceServers[0].urls)
  assert.equal(turn.iceServers[0].username, 'stub-user')
  assert.equal(turn.iceServers[0].credential, 'stub-pass')
  assert.equal(Object.prototype.hasOwnProperty.call(turn, 'customIdentifier'), false)
  assert.ok(turn.expiresAt > Date.now())

  console.log('✅ TURN HTTP 自动下发测试通过')
} finally {
  proc.kill('SIGTERM')
  await wait(200)
  rmSync(tmp, { recursive: true, force: true })
}
