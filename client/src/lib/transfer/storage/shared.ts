/**
 * transfer/storage/shared.ts — WriteQueue + quota error helpers shared by backends.
 * Cleanup owner: WriteQueue instances live on backend handles; backends own them.
 */
export function isQuotaExceeded(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { name?: string; code?: number; message?: string }
  if (e.name === 'QuotaExceededError') return true
  if (e.code === 22) return true
  if (typeof e.message === 'string' && e.message.includes('QuotaExceeded')) return true
  return false
}

export class StorageQuotaExceededError extends Error {
  cause?: unknown
  constructor(cause: unknown) {
    super('STORAGE_QUOTA_EXCEEDED')
    this.name = 'StorageQuotaExceededError'
    this.cause = cause
  }
}

const WRITE_BACKPRESSURE_BYTES = 16 * 1024 * 1024  // 16 MB outstanding cap

export class WriteQueue {
  private pending = new Set<Promise<unknown>>()
  private pendingBytes = 0

  /**
   * Enqueue a write. Returns a promise that resolves immediately unless the
   * outstanding-bytes cap has been hit, in which case it waits for one
   * in-flight write to complete (coarse backpressure).
   */
  enqueue(promise: Promise<unknown>, bytes: number): Promise<unknown> | undefined {
    const tracked = promise.catch(err => {
      console.warn('[transfer] disk write failed', err)
    })
    this.pending.add(tracked)
    this.pendingBytes += bytes
    tracked.finally(() => {
      this.pending.delete(tracked)
      this.pendingBytes -= bytes
    })
    if (this.pendingBytes >= WRITE_BACKPRESSURE_BYTES && this.pending.size > 0) {
      return Promise.race(this.pending)
    }
    return undefined
  }

  async drain(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled(this.pending)
    }
  }
}
