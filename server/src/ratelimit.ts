// Simple in-memory sliding-window rate limiter
const windows = new Map<string, { count: number; resetAt: number }>()

export function checkRateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now()
  const w = windows.get(key)
  if (!w || now > w.resetAt) {
    windows.set(key, { count: 1, resetAt: now + windowMs })
    return true
  }
  if (w.count >= limit) return false
  w.count++
  return true
}

export function cleanupRateLimitWindows() {
  const now = Date.now()
  for (const [key, w] of windows) {
    if (now > w.resetAt) windows.delete(key)
  }
}
