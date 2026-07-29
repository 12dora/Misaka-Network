// Round-robin pool of AES-GCM workers. Each worker holds a per-peer
// CryptoKey map; the main thread mirrors derivations into every worker so
// any worker can service any peer. Sized at min(hardwareConcurrency, 4):
// past 4 we stop getting parallelism from the 4 SCTP lanes anyway.
//
// BUG-027: a worker that dies (module load failure, uncaught exception, OOM
// kill) used to stay in the round-robin list forever. Its pending ops were
// rejected, but every Nth subsequent chunk was still dispatched into the
// corpse and never replied — so a transfer that survived the first crash
// hung on the next chunk that happened to land on the dead slot. The pool
// now:
//
//   1. terminates + removes the crashed worker,
//   2. spawns a replacement and re-registers every known peer key into it
//      (a fresh worker has an empty key map — without this, ops routed to
//      the replacement fail with "no key for peer"),
//   3. rejects immediately when no healthy worker is left, instead of
//      queueing work nothing will ever service.
//
// Replacement budget is a consecutive-failure / time-window breaker, NOT a
// page-lifetime cumulative cap — eight independent recovered crashes must
// not permanently degrade the pool.

const POOL_SIZE = Math.max(1, Math.min(4, (typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 2) || 2))

// Consecutive failed replacements within the window trip the breaker.
const MAX_CONSECUTIVE_FAILURES = POOL_SIZE * 2
// After this much healthy service, the consecutive-failure counter resets.
const FAILURE_WINDOW_MS = 60_000

type PendingEntry = { resolve: (buf: ArrayBuffer) => void; reject: (err: Error) => void; worker: Worker }

let workers: Worker[] | null = null
let rrCursor = 0
let nextId = 0
let consecutiveFailures = 0
let lastFailureAt = 0
let breakerOpenUntil = 0
const pending = new Map<number, PendingEntry>()
// Mirror of every peer key we have handed to the pool, so a replacement
// worker can be brought up to date without waiting for a new ECDH round.
const peerKeys = new Map<string, CryptoKey>()

/** Raised when the pool has no worker left that could service an op. */
export class CryptoPoolUnavailableError extends Error {
  constructor(message = 'crypto worker pool unavailable') {
    super(message)
    this.name = 'CryptoPoolUnavailableError'
  }
}

function noteHealthyService() {
  // A successful op proves the pool is productive — reset the consecutive
  // failure counter so long-lived tabs recover from isolated crashes.
  consecutiveFailures = 0
}

function noteReplacementFailure() {
  const now = Date.now()
  if (now - lastFailureAt > FAILURE_WINDOW_MS) {
    consecutiveFailures = 0
  }
  lastFailureAt = now
  consecutiveFailures++
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    breakerOpenUntil = now + FAILURE_WINDOW_MS
    console.warn('[cryptoPool] consecutive failure breaker open — pool is degraded')
  }
}

function breakerIsOpen(): boolean {
  if (breakerOpenUntil === 0) return false
  if (Date.now() >= breakerOpenUntil) {
    breakerOpenUntil = 0
    consecutiveFailures = 0
    return false
  }
  return true
}

function spawnWorker(): Worker {
  const w = new Worker(new URL('../workers/crypto.worker.ts', import.meta.url), { type: 'module' })
  w.onmessage = (e: MessageEvent<{ id: number; ok: boolean; result?: ArrayBuffer; error?: string }>) => {
    const { id, ok, result, error } = e.data
    const entry = pending.get(id)
    if (!entry) return
    pending.delete(id)
    if (ok && result) {
      noteHealthyService()
      entry.resolve(result)
    } else {
      entry.reject(new Error(error ?? 'crypto worker failed'))
    }
  }
  w.onerror = (e: { message?: string }) => {
    console.warn('[cryptoPool] worker error', e?.message)
    handleWorkerCrash(w, e?.message)
  }
  return w
}

/**
 * Evict a dead worker, settle everything that was dispatched to it, and try
 * to bring a replacement online. Exposed only through `onerror`; callers
 * never need to reason about worker identity.
 */
function handleWorkerCrash(dead: Worker, message?: string) {
  // 1. Settle this worker's in-flight ops. A hard error produces no reply, so
  //    without this every awaiting encryptChunk/decryptChunk hangs forever.
  for (const [id, entry] of pending) {
    if (entry.worker === dead) {
      pending.delete(id)
      entry.reject(new Error(`crypto worker crashed: ${message ?? 'unknown error'}`))
    }
  }

  // 2. Remove it from the rotation — this is the actual BUG-027 fix. Nothing
  //    may be dispatched into a corpse again.
  if (workers) {
    const idx = workers.indexOf(dead)
    if (idx >= 0) workers.splice(idx, 1)
  }
  try { dead.terminate() } catch { /* already gone */ }

  // 3. Replace it and re-seed the peer keys, so throughput (and correctness
  //    for peers whose keys only lived in the dead worker) recovers.
  //
  // Each crash counts toward the consecutive-failure breaker. Only a later
  // healthy op (noteHealthyService) resets the counter — a successful spawn
  // of a worker that immediately crashes again must still trip the breaker.
  noteReplacementFailure()
  if (breakerIsOpen()) {
    console.warn('[cryptoPool] replacement skipped — breaker open')
    return
  }
  try {
    const fresh = spawnWorker()
    for (const [peerSessionId, aesKey] of peerKeys) {
      fresh.postMessage({ type: 'set-key', peerSessionId, aesKey })
    }
    ;(workers ??= []).push(fresh)
  } catch (err) {
    console.warn('[cryptoPool] failed to replace crashed worker', err)
  }
}

function ensurePool(): Worker[] {
  if (workers && workers.length > 0) return workers
  if (workers && workers.length === 0) {
    // Every worker crashed and the breaker is open — don't silently rebuild
    // a pool that is going to die again on the next op.
    if (breakerIsOpen()) return workers
  }
  const list: Worker[] = workers ?? []
  for (let i = list.length; i < POOL_SIZE; i++) {
    try {
      list.push(spawnWorker())
    } catch (err) {
      noteReplacementFailure()
      console.warn('[cryptoPool] failed to spawn worker', err)
      break
    }
  }
  workers = list
  return list
}

export function registerPeerKey(peerSessionId: string, aesKey: CryptoKey): void {
  peerKeys.set(peerSessionId, aesKey)
  for (const w of ensurePool()) {
    w.postMessage({ type: 'set-key', peerSessionId, aesKey })
  }
}

export function unregisterPeerKey(peerSessionId?: string): void {
  if (peerSessionId) peerKeys.delete(peerSessionId)
  else peerKeys.clear()
  if (!workers) return
  for (const w of workers) {
    w.postMessage({ type: 'drop-key', peerSessionId })
  }
}

/** Number of workers currently able to service an op. Test/diagnostic hook. */
export function healthyWorkerCount(): number {
  return workers?.length ?? 0
}

/** Test hook: reset breaker + replacement counters. */
export function __resetCryptoPoolBudgetForTests() {
  consecutiveFailures = 0
  lastFailureAt = 0
  breakerOpenUntil = 0
}

export interface CryptoOpOptions {
  additionalData?: Uint8Array
  /** Full-frame decrypt: byte offset of the ciphertext inside `data`. */
  cipherOffset?: number
  cipherLength?: number
  ivOffset?: number
  ivLength?: number
}

function dispatch(
  op: 'encrypt' | 'decrypt',
  peerSessionId: string,
  iv: Uint8Array,
  data: ArrayBuffer,
  options?: CryptoOpOptions,
): Promise<ArrayBuffer> {
  const pool = ensurePool()
  if (pool.length === 0) {
    // Reject immediately rather than parking a promise no worker will ever
    // answer — the transfer surfaces a real error instead of hanging.
    return Promise.reject(new CryptoPoolUnavailableError(
      '加密工作线程全部崩溃，请刷新页面后重试',
    ))
  }
  const worker = pool[rrCursor++ % pool.length]
  const id = ++nextId
  return new Promise<ArrayBuffer>((resolve, reject) => {
    pending.set(id, { resolve, reject, worker })
    // `data` is transferred (zero copy); caller must not touch it after this.
    const msg: Record<string, unknown> = {
      type: 'op', id, op, peerSessionId, iv, data,
    }
    if (options?.additionalData && options.additionalData.byteLength > 0) {
      msg.additionalData = options.additionalData
    }
    if (typeof options?.cipherOffset === 'number') {
      msg.cipherOffset = options.cipherOffset
      msg.cipherLength = options.cipherLength
      msg.ivOffset = options.ivOffset
      msg.ivLength = options.ivLength
    }
    worker.postMessage(msg, [data])
  })
}

export function encryptInWorker(
  peerSessionId: string,
  iv: Uint8Array,
  data: ArrayBuffer,
  additionalData?: Uint8Array,
): Promise<ArrayBuffer> {
  return dispatch('encrypt', peerSessionId, iv, data, { additionalData })
}

export function decryptInWorker(
  peerSessionId: string,
  iv: Uint8Array,
  encrypted: ArrayBuffer,
  additionalData?: Uint8Array,
): Promise<ArrayBuffer> {
  return dispatch('decrypt', peerSessionId, iv, encrypted, { additionalData })
}

/** Decrypt a whole chunk frame buffer without a main-thread ciphertext copy. */
export function decryptFrameInWorker(
  peerSessionId: string,
  frame: ArrayBuffer,
  ivOffset: number,
  ivLength: number,
  cipherOffset: number,
  cipherLength: number,
  additionalData?: Uint8Array,
): Promise<ArrayBuffer> {
  // Dummy iv view for the message shape; the worker uses offsets into frame.
  const iv = new Uint8Array(frame, ivOffset, ivLength)
  return dispatch('decrypt', peerSessionId, iv, frame, {
    additionalData,
    cipherOffset,
    cipherLength,
    ivOffset,
    ivLength,
  })
}
