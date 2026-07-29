// Sliding-window rate limiter.
//
// Each key keeps a ring of request timestamps. A request is admitted when the
// number of timestamps inside [now - windowMs, now] is strictly less than
// `limit`. Unlike a fixed window (which used to allow ~2× at the boundary),
// this never grants a full extra budget just because the wall clock rolled
// over. Used for every security-sensitive HTTP budget (api / qr-redeem /
// transfer-done / report).

const windows = new Map<string, number[]>()

export function checkRateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now()
  const cutoff = now - windowMs
  let stamps = windows.get(key)
  if (!stamps) {
    windows.set(key, [now])
    return true
  }
  // Drop entries outside the window in place.
  let write = 0
  for (let i = 0; i < stamps.length; i++) {
    if (stamps[i] > cutoff) stamps[write++] = stamps[i]
  }
  stamps.length = write
  if (stamps.length >= limit) {
    windows.set(key, stamps)
    return false
  }
  stamps.push(now)
  windows.set(key, stamps)
  return true
}

export function cleanupRateLimitWindows() {
  const now = Date.now()
  for (const [key, stamps] of windows) {
    // Keep a 2-minute idle grace so a quiet key does not linger forever but a
    // bursty key is not recreated every tick.
    if (stamps.length === 0 || now - stamps[stamps.length - 1] > 120_000) {
      windows.delete(key)
    }
  }
}

/** Test hook — current stamp count inside the window (or 0). */
export function _rateLimitCountForTest(key: string, windowMs: number): number {
  const stamps = windows.get(key)
  if (!stamps) return 0
  const cutoff = Date.now() - windowMs
  return stamps.filter(t => t > cutoff).length
}

/** Test hook — wipe all windows. */
export function _resetRateLimitsForTest(): void {
  windows.clear()
}
