// Shared test-script lifecycle utilities.
//
// Why this exists: every server test spawns a real signaling server and
// historically relied on the Node event loop draining to exit. That makes
// the test scripts silently hang the moment anything (a new keep-alive
// socket, a forgotten setTimeout, a child stderr pipe still open under
// Linux's slower process teardown) gets added. CI is then stuck until
// the workflow timeout kills the whole job.
//
// `runTest` enforces two invariants so a single misbehaving handle can no
// longer wedge CI:
//   1. After `main` resolves we always call process.exit() with an explicit
//      code — leftover handles can't hold the script open.
//   2. A wall-clock watchdog kills the script with code 1 if `main` itself
//      stalls (network deadlock, server failing to start, etc.) instead of
//      waiting for the CI step timeout (which is measured in minutes).
//
// Call this from every test script's bottom:
//   runTest(main, { timeoutMs: 60_000 })
//
// `killChild` is the matching cleanup helper for the spawned server: it
// SIGTERMs, then forces SIGKILL on an unref'd fallback so the timer itself
// never holds the loop open.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn as nodeSpawn } from 'node:child_process'

export const TEST_INSTANCE_NONCE = process.env.TEST_INSTANCE_NONCE || randomUUID()
process.env.TEST_INSTANCE_NONCE = TEST_INSTANCE_NONCE
process.env.SERVER_SECRET ||= '11'.repeat(32)

// Every localhost API response in an integration script must come from the
// child started by THIS script. A stale process on a fixed port has a
// different (or absent) nonce and is rejected before any assertion can use it.
const nativeFetch = globalThis.fetch.bind(globalThis)
globalThis.fetch = async (input, init) => {
  const response = await nativeFetch(input, init)
  let url
  try {
    url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  } catch {
    return response
  }
  if (
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1')
    && url.pathname.startsWith('/api/')
    && response.headers.get('x-misaka-test-instance') !== TEST_INSTANCE_NONCE
  ) {
    throw new Error(`STALE_TEST_SERVER:${url.host}`)
  }
  return response
}

// Integration scripts spread `process.env` into their dist server children.
// Give every script process its own durable-state sandbox so a lock, freeze,
// kill switch or revoke queue from an earlier test/run can never poison the
// next one. Tests that deliberately choose a persistence fixture set the env
// before importing production modules and continue to override this value.
const ownedPersistDir = process.env.TURN_PERSIST_DIR
  ? null
  : mkdtempSync(join(tmpdir(), 'misaka-test-state-'))
if (ownedPersistDir) process.env.TURN_PERSIST_DIR = ownedPersistDir

const terminatingChildren = new Map()
const registeredChildren = new Set()

/** Drop-in child_process.spawn replacement that registers before returning. */
export function spawn(...args) {
  const proc = nodeSpawn(...args)
  registeredChildren.add(proc)
  proc.once('exit', () => registeredChildren.delete(proc))
  return proc
}

function cleanupOwnedPersistDir() {
  if (ownedPersistDir) rmSync(ownedPersistDir, { recursive: true, force: true })
}

async function waitForRegisteredChildren() {
  await Promise.allSettled(Array.from(registeredChildren, proc => killChild(proc)))
  const pending = Array.from(terminatingChildren.values())
  if (pending.length > 0) await Promise.allSettled(pending)
}

export function runTest(main, { timeoutMs = 60_000 } = {}) {
  let finalization
  let watchdog
  const finalize = (code, err) => {
    if (finalization) return finalization
    clearTimeout(watchdog)
    if (err) console.error(`\n❌ 测试脚本未捕获异常: ${err?.stack || err?.message || err}`)

    // Cleanup itself should finish in milliseconds, but retain an unref'd
    // emergency exit in case a platform-level child-process wait wedges.
    const hardKill = setTimeout(() => {
      console.error('\n❌ 测试清理超时，强制退出')
      process.exit(code)
    }, 5_000)
    hardKill.unref?.()

    finalization = (async () => {
      await waitForRegisteredChildren()
      cleanupOwnedPersistDir()
      clearTimeout(hardKill)
      process.exit(code)
    })()
    return finalization
  }

  watchdog = setTimeout(() => {
    void finalize(1, new Error(`测试脚本超时（${timeoutMs}ms 未完成）`))
  }, timeoutMs)
  // Watchdog must NOT itself hold the loop open — we still want fast
  // success exits. We re-enter via the explicit process.exit() below.
  watchdog.unref?.()

  Promise.resolve()
    .then(() => main())
    .then(() => finalize(process.exitCode ?? 0))
    .catch(err => finalize(1, err))
}

export function killChild(proc) {
  if (!proc) return Promise.resolve()
  const existing = terminatingChildren.get(proc)
  if (existing) return existing

  const termination = new Promise((resolve, reject) => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve()
      return
    }
    let settled = false
    let forceTimer
    let failTimer
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(forceTimer)
      clearTimeout(failTimer)
      resolve()
    }
    proc.once('exit', finish)
    forceTimer = setTimeout(() => {
      try { proc.kill('SIGKILL') } catch { /* already dead */ }
    }, 750)
    failTimer = setTimeout(() => {
      if (settled) return
      settled = true
      proc.removeListener('exit', finish)
      reject(new Error(`child ${proc.pid ?? 'unknown'} did not exit after SIGKILL`))
    }, 3_000)
    try { proc.kill('SIGTERM') } catch { finish() }
  }).finally(() => {
    terminatingChildren.delete(proc)
  })
  terminatingChildren.set(proc, termination)
  return termination
}

/**
 * Readiness helper for new/updated scripts. It races the spawned child exit
 * against nonce-authenticated health rather than polling a port alone.
 */
export async function waitForTestServer(proc, healthUrl, { timeoutMs = 10_000 } = {}) {
  const exited = new Promise((_, reject) => {
    proc.once('exit', (code, signal) => {
      reject(new Error(`server child exited before readiness (code=${code}, signal=${signal})`))
    })
  })
  const ready = (async () => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const response = await fetch(healthUrl)
        if (response.ok) return
      } catch (error) {
        if (proc.exitCode !== null || proc.signalCode !== null) throw error
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error(`server readiness timed out after ${timeoutMs}ms`)
  })()
  return Promise.race([ready, exited])
}
