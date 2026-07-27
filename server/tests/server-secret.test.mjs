#!/usr/bin/env node
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runTest, spawn } from './_harness.mjs'

runTest(main)
const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..')

async function main() {
  const missing = await evaluate(undefined)
  assert.notEqual(missing.code, 0)
  assert.match(missing.stderr, /SERVER_SECRET.*缺失/)

  for (const weak of ['short', 'ab'.repeat(31), 'zz'.repeat(32)]) {
    const result = await evaluate(weak)
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /SERVER_SECRET.*64.*十六进制/)
  }

  const keyA = 'a1'.repeat(32)
  const keyB = 'b2'.repeat(32)
  const first = await evaluate(keyA)
  const stable = await evaluate(keyA)
  const rotated = await evaluate(keyB)
  assert.equal(first.code, 0, first.stderr)
  assert.equal(stable.code, 0, stable.stderr)
  assert.equal(rotated.code, 0, rotated.stderr)
  assert.deepEqual(first.value, stable.value, 'same key must preserve identity derivations')
  assert.notEqual(first.value.identity, rotated.value.identity, 'rotated key invalidates passcode identity')
  assert.notEqual(first.value.customId, rotated.value.customId, 'rotated key invalidates TURN custom id')

  console.log('✅ SERVER_SECRET missing/weak rejection and stable/rotated HMAC behavior passed')
}

function evaluate(secret) {
  return new Promise(resolve => {
    const env = { ...process.env, NODE_ENV: 'production', TURN_AUTO_ENABLED: 'false' }
    if (secret === undefined) delete env.SERVER_SECRET
    else env.SERVER_SECRET = secret
    const proc = spawn(process.execPath, [
      '--input-type=module',
      '-e',
      `const m = await import('./dist/store.js');
       console.log(JSON.stringify({
         identity: m.hashPassCodeIdentity('123456'),
         customId: m.deriveCustomIdentifier('session-1')
       }))`,
    ], { cwd: serverDir, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', data => { stdout += data })
    proc.stderr.on('data', data => { stderr += data })
    proc.once('exit', code => {
      resolve({
        code,
        stderr,
        value: code === 0 ? JSON.parse(stdout.trim()) : undefined,
      })
    })
  })
}
