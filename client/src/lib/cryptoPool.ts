// Round-robin pool of AES-GCM workers. Each worker holds a per-peer
// CryptoKey map; the main thread mirrors derivations into every worker so
// any worker can service any peer. Sized at min(hardwareConcurrency, 4):
// past 4 we stop getting parallelism from the 4 SCTP lanes anyway.

const POOL_SIZE = Math.max(1, Math.min(4, (typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 2) || 2))

type PendingEntry = { resolve: (buf: ArrayBuffer) => void; reject: (err: Error) => void; worker: Worker }

let workers: Worker[] | null = null
let rrCursor = 0
let nextId = 0
const pending = new Map<number, PendingEntry>()

function ensurePool(): Worker[] {
  if (workers) return workers
  const list: Worker[] = []
  for (let i = 0; i < POOL_SIZE; i++) {
    const w = new Worker(new URL('../workers/crypto.worker.ts', import.meta.url), { type: 'module' })
    w.onmessage = (e: MessageEvent<{ id: number; ok: boolean; result?: ArrayBuffer; error?: string }>) => {
      const { id, ok, result, error } = e.data
      const entry = pending.get(id)
      if (!entry) return
      pending.delete(id)
      if (ok && result) entry.resolve(result)
      else entry.reject(new Error(error ?? 'crypto worker failed'))
    }
    w.onerror = (e) => {
      console.warn('[cryptoPool] worker error', e.message)
      // A hard worker error (module load/parse failure, uncaught exception, OOM
      // kill) produces NO `onmessage` reply for ops already dispatched to this
      // worker. Reject their pending promises now — otherwise encryptChunk /
      // decryptChunk await forever and the whole transfer hangs with no error
      // surfaced. Only this worker's entries are settled; other workers are fine.
      for (const [id, entry] of pending) {
        if (entry.worker === w) {
          pending.delete(id)
          entry.reject(new Error(`crypto worker crashed: ${e.message ?? 'unknown error'}`))
        }
      }
    }
    list.push(w)
  }
  workers = list
  return list
}

export function registerPeerKey(peerSessionId: string, aesKey: CryptoKey): void {
  for (const w of ensurePool()) {
    w.postMessage({ type: 'set-key', peerSessionId, aesKey })
  }
}

export function unregisterPeerKey(peerSessionId?: string): void {
  if (!workers) return
  for (const w of workers) {
    w.postMessage({ type: 'drop-key', peerSessionId })
  }
}

function dispatch(op: 'encrypt' | 'decrypt', peerSessionId: string, iv: Uint8Array, data: ArrayBuffer): Promise<ArrayBuffer> {
  const pool = ensurePool()
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
