#!/usr/bin/env node
/**
 * CONFIG-007: numeric security/cost env vars must be validated at startup.
 *
 * Every knob used to go through a bare `parseInt`/`parseFloat`:
 *   • `parseInt('abc')` → NaN, and every subsequent `NaN >= limit` guard is
 *     false, i.e. the control fails OPEN.
 *   • `parseInt('30s')` → 30, silently a thousandth of the intended value.
 *   • `parseInt('0')` for an interval → a timer that reschedules immediately.
 * A deployment could therefore turn off a rate limit, a TURN cost cap or the
 * kill-switch threshold with a typo and get no signal at all.
 *
 * The contract this pins: an invalid value aborts the process at startup and
 * names the offending variable — never a degraded runtime.
 *
 * Usage: node tests/config-validation.test.mjs
 */

import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { runTest, killChild, spawn } from './_harness.mjs'

runTest(main, { timeoutMs: 90_000 })

const __dirname = dirname(fileURLToPath(import.meta.url))
// Overridable so the fix can be demonstrated against a pre-fix checkout.
const SERVER_DIR = process.env.MISAKA_TEST_SERVER_DIR || join(__dirname, '..')
const PORT = 18967

// name → [value, why it is pathological]
const REJECTED = [
  ['RATE_LIMIT_PER_MIN',            'abc',   'NaN 会让每个 count >= limit 判断恒假（fail open）'],
  ['RATE_LIMIT_PER_MIN',            '0',     '0 会拒绝所有请求，属于误配而非策略'],
  ['SESSION_TTL_MS',                '30s',   '部分解析：30 毫秒而不是 30 秒'],
  ['CLEANUP_INTERVAL_MS',           '0',     '零间隔 timer 近似 busy loop'],
  ['TURN_GLOBAL_THRESHOLD_PCT',     '150',   '百分比必须落在 0..100'],
  ['TURN_GLOBAL_MONTHLY_BYTES_LIMIT', '0',   '0 上限让 percentUsed 变成 Infinity/NaN'],
  ['TURN_PERSIST_INTERVAL_SEC',     '0',     '零间隔持久化 timer'],
  ['NODE_FREEZE_THRESHOLD',         '-1',    '负阈值会立即冻结所有 nodeId'],
  ['MAX_NODES',                     '1e3x',  '部分解析'],
  ['WS_AUTH_GRACE_MS',              'NaN',   'NaN grace 让 AUTH 超时不再触发'],
  ['TURN_AUTO_ENABLED',             'maybe', '布尔量只接受 true/false'],
  ['TRUST_PROXY',                   'true',  '布尔 true 允许伪造 XFF；必须用 hop 数或 CIDR'],
]

const procs = []

// Belt and braces: this script spawns a dozen servers, and `runTest`'s
// watchdog exits via process.exit() — which would skip the normal cleanup and
// leave a child holding PORT for the next run. 'exit' handlers still run there.
process.on('exit', () => {
  for (const p of procs) {
    try { p.kill('SIGKILL') } catch { /* already dead */ }
  }
})

async function main() {
  let failed = 0

  console.log('[1] 非法数值必须 fail fast 并指出变量名')
  for (const [name, value, why] of REJECTED) {
    try {
      const { code, stderr } = await runServer({ [name]: value })
      if (code === 0) throw new Error(`进程以 0 退出，说明该值被静默接受（${why}）`)
      if (!stderr.includes(name)) throw new Error(`退出信息未提及变量名 ${name}：${stderr.slice(0, 300)}`)
      console.log(`  ✓ ${name}=${JSON.stringify(value)} → 启动失败并点名`)
    } catch (e) {
      console.error(`  ✗ ${name}=${JSON.stringify(value)}\n      ${e.message}`)
      failed++
    }
  }

  console.log('[2] 合法数值仍然正常启动')
  try {
    const { code, stderr } = await runServer(
      { RATE_LIMIT_PER_MIN: '120', SESSION_TTL_MS: '60000', TURN_GLOBAL_THRESHOLD_PCT: '75.5', MAX_NODES: '0' },
      { expectAlive: true },
    )
    if (code !== null) throw new Error(`合法配置不应退出，实际 code=${code} stderr=${stderr.slice(0, 300)}`)
    console.log('  ✓ 合法配置（含 MAX_NODES=0 的显式“无上限”）正常监听')
  } catch (e) {
    console.error(`  ✗ 合法配置启动\n      ${e.message}`)
    failed++
  }

  console.log('[3] 未设置任何环境变量时，生产人口上限是有限值（SECURITY-014）')
  try {
    const { MAX_NODES } = await import('../dist/config.js')
    if (!Number.isFinite(MAX_NODES)) throw new Error(`默认 MAX_NODES 应为有限值，实际 ${MAX_NODES}`)
    console.log(`  ✓ 默认 MAX_NODES=${MAX_NODES}（有限）`)
  } catch (e) {
    console.error(`  ✗ 默认人口上限\n      ${e.message}`)
    failed++
  }

  for (const p of procs) killChild(p)

  if (failed > 0) {
    console.error(`\n❌ ${failed} 用例失败`)
    process.exitCode = 1
    return
  }
  console.log('\n✅ 全部测试通过')
}

/**
 * Spawn the server with `extraEnv`. Resolves with the exit code (or null if it
 * was still alive when we gave up waiting, which is the success signal for the
 * happy-path case).
 */
function runServer(extraEnv, { expectAlive = false } = {}) {
  return new Promise((resolve) => {
    const proc = spawn('node', ['dist/index.js'], {
      cwd: SERVER_DIR,
      env: {
        ...process.env,
        PORT: String(PORT),
        TURN_AUTO_ENABLED: process.env.TURN_AUTO_ENABLED ?? 'false',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    procs.push(proc)

    let stderr = ''
    let stdout = ''
    proc.stderr.on('data', d => { stderr += d.toString() })
    proc.stdout.on('data', d => { stdout += d.toString() })

    let settled = false
    const done = (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      killChild(proc)
      resolve({ code, stderr: stderr + stdout })
    }

    // A bad config must abort well inside this; a good one must still be up.
    const timer = setTimeout(() => done(null), expectAlive ? 8000 : 15000)
    timer.unref?.()
    proc.on('exit', code => done(code ?? 1))
  })
}
