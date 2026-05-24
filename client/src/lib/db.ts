import { openDB, type IDBPDatabase } from 'idb'

export interface TransferRecord {
  transferId: string
  direction: 'send' | 'recv'
  peerNodeId: number
  fileName: string
  fileSize: number
  fileHash: string
  totalChunks: number
  /**
   * Legacy persistence format: a sorted, deduped array of every received
   * (or, on the sender side, sent-and-acked) chunk index. Kept on the
   * type for backwards-compatibility with records written by older
   * builds — on read we lazy-migrate into `receivedBitmap` so the hot
   * path never touches this field directly.
   *
   * New writes leave this empty (`[]`) — the source of truth is
   * `receivedBitmap`. Legacy clients reading new records still get an
   * empty array, which is correct (they'll re-receive everything, which
   * is benign because chunks are content-authenticated).
   */
  receivedChunks: number[]
  /**
   * Compact bit-array of received chunk indexes, sized
   * `bitmapByteLength(totalChunks)`. Replaces `receivedChunks` for any
   * non-trivial transfer — a 1 TB transfer goes from ~1 MB JSON-per-tick
   * to ~2 MB binary written once per tick. Optional so legacy records
   * load cleanly.
   */
  receivedBitmap?: ArrayBuffer
  status: 'active' | 'paused' | 'completed' | 'failed' | 'failed:unsupported'
  createdAt: number
  updatedAt: number
}

let dbPromise: Promise<IDBPDatabase> | null = null

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB('misaka-transfers', 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('transfers')) {
          db.createObjectStore('transfers', { keyPath: 'transferId' })
        }
        if (!db.objectStoreNames.contains('chunks')) {
          db.createObjectStore('chunks')
        }
      },
    })
  }
  return dbPromise
}

// ── Transfer records ────────────────────────────────────────────────

export async function saveTransfer(record: TransferRecord) {
  const db = await getDB()
  await db.put('transfers', record)
}

export async function updateTransfer(transferId: string, partial: Partial<TransferRecord>) {
  const db = await getDB()
  const tx = db.transaction('transfers', 'readwrite')
  const existing = await tx.store.get(transferId)
  if (existing) {
    await tx.store.put({ ...existing, ...partial, updatedAt: Date.now() })
  }
  await tx.done
}

export async function getTransfer(transferId: string): Promise<TransferRecord | undefined> {
  const db = await getDB()
  return db.get('transfers', transferId)
}

export async function getActiveTransfers(): Promise<TransferRecord[]> {
  const db = await getDB()
  const all = await db.getAll('transfers')
  return all.filter(t => t.status === 'active' || t.status === 'paused')
}

export async function deleteTransfer(transferId: string) {
  const db = await getDB()
  await db.delete('transfers', transferId)
}

// ── Chunks ───────────────────────────────────────────────────────────

function chunkKey(transferId: string, index: number) {
  return `${transferId}:${index}`
}

export async function saveChunk(transferId: string, index: number, data: ArrayBuffer) {
  const db = await getDB()
  await db.put('chunks', data, chunkKey(transferId, index))
}

export async function getChunk(transferId: string, index: number): Promise<ArrayBuffer | undefined> {
  const db = await getDB()
  return db.get('chunks', chunkKey(transferId, index))
}

export async function deleteChunks(transferId: string) {
  const db = await getDB()
  const tx = db.transaction('chunks', 'readwrite')
  const keys = await tx.store.getAllKeys()
  const prefix = `${transferId}:`
  for (const key of keys) {
    if (typeof key === 'string' && key.startsWith(prefix)) {
      await tx.store.delete(key)
    }
  }
  await tx.done
}

export async function getSavedChunkIndexes(transferId: string): Promise<number[]> {
  const db = await getDB()
  const keys = await db.getAllKeys('chunks')
  const prefix = `${transferId}:`
  const indexes: number[] = []
  for (const key of keys) {
    if (typeof key === 'string' && key.startsWith(prefix)) {
      const idx = parseInt(key.slice(prefix.length), 10)
      if (!isNaN(idx)) indexes.push(idx)
    }
  }
  return indexes.sort((a, b) => a - b)
}
