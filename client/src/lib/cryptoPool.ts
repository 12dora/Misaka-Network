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

const POOL_SIZE = Math.max(1, Math.min(4, (typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 2) || 2))

// A worker module that fails to parse crashes every replacement too. Cap the
// churn so we surface a hard error instead of spawning workers in a loop.
const MAX_REPLACEMENTS = POOL_SIZE * 2

type PendingEntry = { resolve: (buf: ArrayBuffer) => void; reject: (err: Error) => void; worker: Worker }

let workers: Worker[] | null = null
let rrCursor = 0
let nextId = 0
let replacements = 0
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

function spawnWorker(): Worker {
  const w = new Worker(new URL('../workers/crypto.worker.ts', import.meta.url), { type: 'module' })
  w.onmessage = (e: MessageEvent<{ id: number; ok: boolean; result?: ArrayBuffer; error?: string }>) => {
    const { id, ok, result, error } = e.data
    const entry = pending.get(id)
    if (!entry) return
    pending.delete(id)
    if (ok && result) entry.resolve(result)
    else entry.reject(new Error(error ?? 'crypto worker failed'))
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
  if (replacements >= MAX_REPLACEMENTS) {
    console.warn('[cryptoPool] replacement budget exhausted — pool is degraded')
    return
  }
  replacements++
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
    // Every worker crashed and replacement is exhausted — don't silently
    // rebuild a pool that is going to die again on the next op.
    if (replacements >= MAX_REPLACEMENTS) return workers
  }
  const list: Worker[] = workers ?? []
  for (let i = list.length; i < POOL_SIZE; i++) list.push(spawnWorker())
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

function dispatch(op: 'encrypt' | 'decrypt', peerSessionId: string, iv: Uint8Array, data: ArrayBuffer): Promise<ArrayBuffer> {
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
    worker.postMessage({ type: 'op', id, op, peerSessionId, iv, data }, [data])
  })
}

export function encryptInWorker(peerSessionId: string, iv: Uint8Array, data: ArrayBuffer): Promise<ArrayBuffer> {
  return dispatch('encrypt', peerSessionId, iv, data)
}

export function decryptInWorker(peerSessionId: string, iv: Uint8Array, encrypted: ArrayBuffer): Promise<ArrayBuffer> {
  return dispatch('decrypt', peerSessionId, iv, encrypted)
}
