#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
import { runTest, spawn } from '../_harness.mjs'

const pidFile = process.argv[2]
if (!pidFile) throw new Error('pid file argument required')

runTest(async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  })
  writeFileSync(pidFile, String(child.pid))
  await new Promise(() => {})
}, { timeoutMs: 100 })
