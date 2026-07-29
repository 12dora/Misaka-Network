#!/usr/bin/env node
/**
 * Sequential multi-test runner for c8. Each intended test script is a real
 * child process (they call process.exit via runTest); the parent inherits
 * NODE_V8_COVERAGE so c8 merges every child's coverage into one report.
 *
 * Usage:
 *   node tests/coverage-runner.mjs tests/a.test.mjs tests/b.test.mjs
 */
import { spawnSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverDir = resolve(__dirname, '..')
const files = process.argv.slice(2)

if (files.length === 0) {
  console.error('coverage-runner: pass one or more test file paths')
  process.exit(2)
}

let failed = 0
for (const f of files) {
  const abs = resolve(serverDir, f)
  console.log(`\n── coverage-runner: ${f} ──`)
  const r = spawnSync(process.execPath, [abs], {
    cwd: serverDir,
    env: process.env,
    stdio: 'inherit',
  })
  if (r.status !== 0) {
    console.error(`coverage-runner: ${f} exited ${r.status}`)
    failed = r.status || 1
    break
  }
}

process.exit(failed)
