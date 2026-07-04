#!/usr/bin/env node
/**
 * Regression [P2]: `app.set('trust proxy', 1)` was unconditional, so on a
 * directly internet-facing (zero-config) deployment a client could spoof its
 * source IP via X-Forwarded-For and defeat every per-IP defence (register IP
 * cap, brute-force lock, rate limits, TURN accounting).
 *
 * Fix: trust-proxy is configurable via TRUST_PROXY and defaults to OFF. When
 * off, a spoofed XFF is ignored and all requests from one socket collapse to
 * one IP; when TRUST_PROXY=1 (operator behind exactly one proxy) the XFF hop is
 * honoured again.
 *
 *   - Default (no TRUST_PROXY): 11 registers with 11 DISTINCT spoofed XFFs all
 *     count as ONE IP → the 11th hits IP_LIMITED (MAX_NODES_PER_IP=10).
 *   - TRUST_PROXY=1: the same 11 distinct XFFs are 11 distinct IPs → all succeed.
 *
 * Usage: node tests/trust-proxy.test.mjs
 */

import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { runTest, killChild } from './_harness.mjs'

runTest(main, { timeoutMs: 40_000 })

const __dirname = dirname(fileURLToPath(import.meta.url))
const SERVER_DIR = join(__dirname, '..')

let procs = []

async function main() {
  let failed = 0
  try {
    await testDefaultIgnoresSpoofedXff().then(() => console.log('  ✓ default: spoofed XFF ignored → per-IP cap holds'))
      .catch(e => { console.error(`  ✗ default XFF: ${e.message}`); failed++ })
    await testTrustProxyHonoursXff().then(() => console.log('  ✓ TRUST_PROXY=1: distinct XFF → distinct IPs'))
      .catch(e => { console.error(`  ✗ TRUST_PROXY=1: ${e.message}`); failed++ })
  } finally {
    for (const p of procs) killChild(p)
  }

  if (failed > 0) { console.error(`\n❌ ${failed} 用例失败`); process.exitCode = 1; return }
  console.log('\n✅ 全部测试通过')
}

async function testDefaultIgnoresSpoofedXff() {
  const PORT = 18970
  const proc = startServer(PORT, {})   // TRUST_PROXY unset → default OFF
  procs.push(proc)
  await waitForServer(PORT)

  // 10 registers should succeed; the 11th (distinct spoofed XFF) must be
  // IP_LIMITED because the header is ignored and all collapse to one socket IP.
  let sawLimit = false
  for (let i = 0; i < 11; i++) {
    const r = await postFrom(PORT, '/register', { nodeId: 16000 + i, passCode: '123456' }, `203.0.113.${i}`)
    if (r.error === 'IP_LIMITED') { sawLimit = true; break }
  }
  if (!sawLimit) throw new Error('spoofed XFF bypassed MAX_NODES_PER_IP (trust-proxy default should be OFF)')
}

async function testTrustProxyHonoursXff() {
  const PORT = 18971
  const proc = startServer(PORT, { TRUST_PROXY: '1' })
  procs.push(proc)
  await waitForServer(PORT)

  // With one trusted proxy hop, 11 distinct XFFs are 11 distinct IPs → all pass.
  for (let i = 0; i < 11; i++) {
    const r = await postFrom(PORT, '/register', { nodeId: 16100 + i, passCode: '123456' }, `198.51.100.${i}`)
    if (!r.token) throw new Error(`register ${i} should succeed with distinct trusted XFF, got ${JSON.stringify(r)}`)
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

async function postFrom(port, path, body, ip) {
  const res = await fetch(`http://localhost:${port}/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify(body),
  })
  return res.json()
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function startServer(port, extraEnv) {
  const proc = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: SERVER_DIR,
    env: { ...process.env, PORT: String(port), MAX_NODES: '500', TURN_AUTO_ENABLED: 'false', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  proc.stderr.on('data', (d) => {
    const s = d.toString()
    if (!s.includes('ExperimentalWarning')) process.stderr.write(d)
  })
  return proc
}

async function waitForServer(port) {
  for (let i = 0; i < 25; i++) {
    try {
      const res = await fetch(`http://localhost:${port}/api/health`)
      if (res.ok) return
    } catch { /* not ready */ }
    await sleep(300)
  }
  throw new Error(`服务器 ${port} 启动超时`)
}
