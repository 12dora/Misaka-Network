#!/usr/bin/env node
/**
 * TEST-014: a real dist server must notify authenticated sockets, close them
 * with 1001, flush both durable snapshots, and exit promptly on SIGTERM.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { runTest, killChild, spawn } from './_harness.mjs'

runTest(main, { timeoutMs: 30_000 })

const CWD = new URL('..', import.meta.url).pathname
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'misaka-shutdown-'))
  const port = 19500 + Math.floor(Math.random() * 90)
  const proc = spawn(process.execPath, ['dist/index.js'], {
    cwd: CWD,
    env: {
      ...process.env,
      PORT: String(port),
      TURN_AUTO_ENABLED: 'false',
      TURN_PERSIST_DIR: dir,
      TURN_PERSIST_INTERVAL_SEC: '60',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  try {
    await waitForHealth(port)
    const register = await fetch(`http://127.0.0.1:${port}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId: 19551, passCode: '195951' }),
    })
    assert.equal(register.status, 200)
    const session = await register.json()

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const messages = []
    ws.on('message', raw => messages.push(JSON.parse(raw.toString())))
    await new Promise((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    ws.send(JSON.stringify({ t: 'AUTH', token: session.token }))
    await waitFor(() => messages.some(message => message.t === 'WELCOME'))

    const closePromise = new Promise(resolve => {
      ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))
    })
    const exitPromise = new Promise(resolve => {
      proc.once('exit', (code, signal) => resolve({ code, signal }))
    })
    const startedAt = Date.now()
    proc.kill('SIGTERM')

    await waitFor(() => messages.some(message => message.t === 'SERVER_SHUTDOWN'))
    const closure = await closePromise
    assert.deepEqual(closure, { code: 1001, reason: 'SERVER_SHUTDOWN' })
    const exit = await Promise.race([exitPromise, wait(5_000).then(() => ({ timeout: true }))])
    assert.equal('timeout' in exit, false, 'server should exit within shutdown deadline')
    assert.equal(exit.code, 0, `server exit should be clean, signal=${exit.signal}`)
    assert.ok(Date.now() - startedAt < 5_000, 'shutdown should complete promptly')

    for (const filename of ['turn-state.json', 'auth-locks.json']) {
      const path = join(dir, filename)
      assert.equal(existsSync(path), true, `${filename} should be flushed`)
      assert.equal(typeof JSON.parse(readFileSync(path, 'utf8')).version, 'number')
    }
    console.log('✅ SIGTERM 通知、1001 关闭、快照落盘与及时退出均通过')
  } finally {
    await killChild(proc)
    rmSync(dir, { recursive: true, force: true })
  }
}

async function waitForHealth(port) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return
    } catch { /* server is still starting */ }
    await wait(100)
  }
  throw new Error('server did not become healthy')
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return
    await wait(50)
  }
  throw new Error('condition timed out')
}
