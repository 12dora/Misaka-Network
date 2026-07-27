#!/usr/bin/env node
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { killChild, runTest, spawn, waitForTestServer } from './_harness.mjs'

runTest(main)
const here = dirname(fileURLToPath(import.meta.url))
const serverDir = join(here, '..')

async function main() {
  const normal = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  })
  await killChild(normal)
  assert(normal.exitCode !== null || normal.signalCode !== null, 'SIGTERM child exit is confirmed')

  const stubborn = spawn(process.execPath, ['-e', `
    process.on('SIGTERM', () => {})
    process.stdout.write('ready\\n')
    setInterval(() => {}, 1000)
  `], { stdio: ['ignore', 'pipe', 'ignore'] })
  await new Promise(resolve => stubborn.stdout.once('data', resolve))
  await killChild(stubborn)
  assert(stubborn.signalCode === 'SIGKILL', `stubborn child expected SIGKILL, got ${stubborn.signalCode}`)

  // Exact stale-listener regression: an unrelated healthy HTTP process owns
  // the port, the intended server exits EADDRINUSE, and readiness must reject
  // rather than accepting the stale /api/health response.
  const stale = spawn(process.execPath, ['-e', `
    const http = require('node:http')
    const server = http.createServer((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end('{"ok":true}')
    })
    // Match production's unspecified-host listen exactly. Binding only
    // 127.0.0.1 can coexist with an IPv6 wildcard listener on macOS, which
    // turns this into a timeout test instead of the intended EADDRINUSE race.
    server.listen(0, () => process.stdout.write(String(server.address().port) + '\\n'))
  `], { stdio: ['ignore', 'pipe', 'ignore'] })
  const port = Number(await new Promise(resolve => stale.stdout.once('data', data => resolve(data.toString().trim()))))
  const intended = spawn(process.execPath, [join(serverDir, 'dist/index.js')], {
    env: { ...process.env, PORT: String(port), TURN_AUTO_ENABLED: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let rejected = false
  try {
    await waitForTestServer(intended, `http://127.0.0.1:${port}/api/health`, { timeoutMs: 3_000 })
  } catch (error) {
    rejected = /exited before readiness|STALE_TEST_SERVER|EADDRINUSE/.test(String(error))
  } finally {
    await killChild(intended)
    await killChild(stale)
  }
  assert(rejected, 'stale listener must not satisfy readiness for an EADDRINUSE child')

  // Watchdog cleanup regression: the timed-out harness process owns a tracked
  // child. After the parent exits with failure, that child PID must no longer
  // exist — direct process.exit from the watchdog used to orphan it.
  const fixtureDir = mkdtempSync(join(tmpdir(), 'misaka-watchdog-'))
  const pidFile = join(fixtureDir, 'child.pid')
  try {
    const timedOut = spawn(process.execPath, [join(here, 'fixtures/harness-timeout-child.mjs'), pidFile], {
      stdio: 'ignore',
    })
    const timeoutExit = await new Promise(resolve => timedOut.once('exit', resolve))
    assert(timeoutExit === 1, `watchdog fixture expected exit 1, got ${timeoutExit}`)
    assert(existsSync(pidFile), 'watchdog fixture must publish tracked child pid')
    const trackedPid = Number(readFileSync(pidFile, 'utf8'))
    await waitForProcessGone(trackedPid)
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true })
  }

  console.log('✅ harness awaits child cleanup, including watchdog timeout, and rejects stale readiness')
}

function assert(value, message) {
  if (!value) throw new Error(message)
}

async function waitForProcessGone(pid) {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if (error?.code === 'ESRCH') return
      throw error
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`watchdog orphaned tracked child ${pid}`)
}
