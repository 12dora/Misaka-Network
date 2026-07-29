/**
 * transfer/flow-control.ts — buffer wait/drain helpers, pause/cancel signals, deadline.
 * Cleanup owner: transferSignals → clearTransferSignal / registry.forgetTransfer.
 */
import { HIGH_WATER_MARK, LOW_WATER_MARK } from '@/constants'

// ── Flow control ─────────────────────────────────────────────────────

// P2-11: was a 200 ms setTimeout polling loop — woke the event loop
// every 200 ms during long pauses and added up to 200 ms latency to
// resume. Now: pause stores a `notifyResume` resolver on the signal;
// `resumeTransfer` calls it directly. Zero polling, zero latency.
export function waitWhilePaused(transferId: string): Promise<void> {
  const s = transferSignals.get(transferId)
  if (!s || !s.paused) return Promise.resolve()
  return new Promise<void>(resolve => {
    // Chain any prior notifier so multiple awaiters all wake up. In
    // practice there's only ever one waiter (the lane prep loop) but
    // we don't bake that assumption into the signal shape.
    const prior = s.notifyResume
    s.notifyResume = () => {
      prior?.()
      resolve()
    }
  })
}

/**
 * Park until the channel's send buffer drains below the low-water mark.
 *
 * BUG-015: this used to install the waiter on `dc.onbufferedamountlow`, a
 * SINGLE-SLOT property. Two concurrent transfers over the same peer (two
 * files, or two lanes of the same file above the high-water mark) both wrote
 * that slot: the second waiter overwrote the first, and the first waiter's
 * `cleanup()` then nulled the second one out. Whichever promise lost the race
 * never resolved, `Promise.allSettled` over the lanes never settled, and the
 * send hung with the UI parked at N%.
 *
 * Now every waiter owns an independent `addEventListener` registration and
 * removes exactly its own handlers, so N concurrent waiters on one channel all
 * wake on the same `bufferedamountlow` event.
 */
/** Default max wait for a half-open channel that never fires bufferedamountlow. */
export const WAIT_FOR_BUFFER_TIMEOUT_MS = 30_000

export class BufferWaitTimeoutError extends Error {
  constructor() {
    super('DataChannel backpressure wait timed out')
    this.name = 'BufferWaitTimeoutError'
  }
}

export function waitForBuffer(
  dc: RTCDataChannel,
  opts?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<void> {
  return new Promise((resolve, reject) => {
    // If the channel is already closing/closed, or below the watermark, resolve
    // immediately — the caller re-checks readyState right after and re-queues.
    if (dc.readyState !== 'open' || dc.bufferedAmount <= HIGH_WATER_MARK) {
      resolve()
      return
    }
    if (opts?.signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    let settled = false
    // NO-PROGRESS deadline: renewed whenever bufferedAmount decreases so a
    // healthy slow link is not killed by a hard wall-clock budget.
    const noProgressMs = opts?.timeoutMs ?? WAIT_FOR_BUFFER_TIMEOUT_MS
    let lastAmount = dc.bufferedAmount
    let deadline = Date.now() + noProgressMs
    // A channel that closes while parked above HIGH_WATER_MARK never fires
    // `bufferedamountlow`, so without also listening for close/error this promise
    // would hang forever and wedge the whole send (Promise.allSettled never
    // resolves). Settle on channel death too; laneLoop's next readyState check
    // then re-queues the chunk and exits the lane.
    //
    // A half-open channel that stays `open` without ever making progress is
    // the other hang — the no-progress poll below unblocks the lane.
    const cleanup = () => {
      dc.removeEventListener('bufferedamountlow', onLow)
      dc.removeEventListener('close', onDead)
      dc.removeEventListener('error', onDead)
      clearInterval(poll)
      opts?.signal?.removeEventListener('abort', onAbort)
    }
    const settleOk = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }
    const settleErr = (err: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(err)
    }
    const onLow = () => settleOk()
    const onDead = () => settleOk()
    const onAbort = () => settleErr(new DOMException('Aborted', 'AbortError'))
    const poll = setInterval(() => {
      if (settled) return
      if (dc.readyState !== 'open' || dc.bufferedAmount <= HIGH_WATER_MARK) {
        settleOk()
        return
      }
      if (dc.bufferedAmount < lastAmount) {
        lastAmount = dc.bufferedAmount
        deadline = Date.now() + noProgressMs
      } else if (Date.now() >= deadline) {
        settleErr(new BufferWaitTimeoutError())
      }
    }, 50)
    // Threshold is a channel-wide property, not a per-waiter one — writing the
    // same value from several waiters is idempotent and safe.
    dc.bufferedAmountLowThreshold = LOW_WATER_MARK
    dc.addEventListener('bufferedamountlow', onLow)
    dc.addEventListener('close', onDead)
    dc.addEventListener('error', onDead)
    opts?.signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// ── Transfer control signals ──────────────────────────────────────────

export interface TransferSignal {
  paused: boolean
  cancelled: boolean
  // P2-11: replaces the prior 200 ms polling loop in `waitWhilePaused`.
  // Set when the lane parks itself; cleared+invoked from `resumeTransfer`
  // and `cancelTransfer` to wake the waiter immediately. May be undefined
  // when nobody is waiting.
  notifyResume?: () => void
  /** Aborts in-flight waitForBuffer so cancel/neutralise is not stuck 30s. */
  bufferAbort?: AbortController
}

// Cleanup owner: clearTransferSignal / registry.forgetTransfer / resetTransferModuleState
export const transferSignals = new Map<string, TransferSignal>()

export function getSignal(transferId: string): TransferSignal {
  let s = transferSignals.get(transferId)
  if (!s) {
    s = { paused: false, cancelled: false }
    transferSignals.set(transferId, s)
  }
  return s
}

/** Abort any parked backpressure wait for this transfer (cancel / neutralise). */
export function abortBufferWaits(transferId: string): void {
  const s = transferSignals.get(transferId)
  if (!s?.bufferAbort) return
  try { s.bufferAbort.abort() } catch { /* ignore */ }
  s.bufferAbort = undefined
}

export function pauseTransfer(transferId: string) {
  getSignal(transferId).paused = true
}

export function resumeTransfer(transferId: string) {
  const s = getSignal(transferId)
  s.paused = false
  // P2-11: wake the pause-waiter immediately rather than waiting up to
  // 200 ms for the next polling tick.
  const notify = s.notifyResume
  s.notifyResume = undefined
  notify?.()
}

export function cancelTransfer(transferId: string) {
  const s = getSignal(transferId)
  s.cancelled = true
  s.paused = false // unblock any waiting
  // P2-11: also fire the wake so any awaiter sees cancelled === true.
  const notify = s.notifyResume
  s.notifyResume = undefined
  notify?.()
  // Unblock waitForBuffer so cancel during backpressure is not a 30s hang.
  abortBufferWaits(transferId)
  // Do NOT delete the signal here. The send loop only learns of cancellation
  // by reading transferSignals.get(id).cancelled on its NEXT async checkSignals;
  // deleting synchronously (no yield point) meant every subsequent read saw
  // `undefined` → the loop never aborted, transmitted the whole remaining file,
  // and reported a false success. Cleanup happens once the owner observes the
  // cancel: sendFileParallel (send) / cancelReceive+completeReceive (receive).
}

// Thrown by sendFileParallel when the transfer was cancelled mid-flight, so the
// caller can distinguish a user/peer abort from a genuine transmission failure.
export class TransferCancelledError extends Error {
  constructor() {
    super('传输已取消')
    this.name = 'TransferCancelledError'
  }
}

// Drop a transfer's control signal. Called by the owning path once the transfer
// is fully torn down (send completion/abort, receive completion/cancel) so the
// map doesn't leak an entry per transfer.
export function clearTransferSignal(transferId: string) {
  transferSignals.delete(transferId)
}

