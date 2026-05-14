type HashWorkerRequest = {
  id: string
  file: File
}

type HashWorkerResponse =
  | { id: string; ok: true; hash: string }
  | { id: string; ok: false; error: string }

let worker: Worker | null = null
const pending = new Map<string, { resolve: (hash: string) => void; reject: (err: Error) => void }>()

function getWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null
  if (!worker) {
    worker = new Worker(new URL('../workers/fileHash.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<HashWorkerResponse>) => {
      const waiter = pending.get(event.data.id)
      if (!waiter) return
      pending.delete(event.data.id)
      if (event.data.ok) waiter.resolve(event.data.hash)
      else waiter.reject(new Error(event.data.error))
    }
    worker.onerror = (event) => {
      for (const waiter of pending.values()) waiter.reject(new Error(event.message || 'Hash worker failed'))
      pending.clear()
      worker?.terminate()
      worker = null
    }
  }
  return worker
}

export function computeFileHashInWorker(file: File): Promise<string> | null {
  const hashWorker = getWorker()
  if (!hashWorker) return null
  const id = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    hashWorker.postMessage({ id, file } satisfies HashWorkerRequest)
  })
}
