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

export function runTest(main, { timeoutMs = 60_000 } = {}) {
  const watchdog = setTimeout(() => {
    console.error(`\n❌ 测试脚本超时（${timeoutMs}ms 未完成），强制退出`)
    process.exit(1)
  }, timeoutMs)
  // Watchdog must NOT itself hold the loop open — we still want fast
  // success exits. We re-enter via the explicit process.exit() below.
  watchdog.unref?.()

  Promise.resolve()
    .then(() => main())
    .then(() => {
      clearTimeout(watchdog)
      process.exit(process.exitCode ?? 0)
    })
    .catch((err) => {
      clearTimeout(watchdog)
      console.error(`\n❌ 测试脚本未捕获异常: ${err?.stack || err?.message || err}`)
      process.exit(1)
    })
}

export function killChild(proc) {
  if (!proc) return
  try { proc.kill('SIGTERM') } catch { /* already dead */ }
  const t = setTimeout(() => {
    try { proc.kill('SIGKILL') } catch { /* already dead */ }
  }, 3000)
  t.unref?.()
}
