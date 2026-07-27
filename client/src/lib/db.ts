import { openDB, type IDBPDatabase } from 'idb'

export interface TransferRecord {
  transferId: string
  direction: 'send' | 'recv'
  peerNodeId: number
  /**
   * SECURITY-015: the peer *session* that owns this transfer. `peerNodeId` is
   * a user-chosen identity number shared by every device of one identity, so
   * it can never authorise a control message — a third device in the same
   * identity cluster has the same nodeId. The session id is unique per device
   * and is what `assertTransferOwner` checks resume / pause / cancel / meta
   * against. Optional so records written by pre-v2 builds still load.
   */
  peerSessionId?: string
  /**
   * SECURITY-015: the network epoch the transfer was created in. A record from
   * a previous authenticated session must not be resumable by whoever holds
   * the session id next.
   */
  epoch?: number
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

// ── Terminal retention (QUALITY-001) ─────────────────────────────────
// There is no transfer-history feature: a record whose status is terminal
// (`completed` / `failed` / `failed:unsupported`) has no consumer once its
// card leaves the screen, yet every send and every receive used to leave one
// behind forever. Long-lived installs accumulated tens of thousands of rows,
// which slows `getActiveTransfers()` (a full-store scan) on every reconnect
// and burns origin quota that the *active* transfers need.
//
// The contract is deliberately simple and lives in exactly one place:
//
//   * terminal rows are kept only as a short debugging tail;
//   * the tail is bounded by BOTH age and count — whichever bites first;
//   * `active` / `paused` rows are NEVER pruned (they are resume state).

export const TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1000  // 24 h
export const TERMINAL_RETENTION_MAX = 50                  // newest N kept

const TERMINAL_STATUSES: ReadonlySet<TransferRecord['status']> =
  new Set<TransferRecord['status']>(['completed', 'failed', 'failed:unsupported'])

export function isTerminalStatus(status: TransferRecord['status']): boolean {
  return TERMINAL_STATUSES.has(status)
}

/**
 * Delete terminal transfer records that are older than `maxAgeMs` or that fall
 * outside the newest `maxCount`. Returns the number of rows removed so callers
 * (and tests) can assert the policy actually ran.
 *
 * Safe to call concurrently with live transfers: it only ever touches rows in
 * a terminal state, and it reads `now` once so a row cannot be judged against
 * a moving deadline.
 */
export async function pruneTerminalTransfers(
  { maxAgeMs = TERMINAL_RETENTION_MS, maxCount = TERMINAL_RETENTION_MAX, now = Date.now() }: {
    maxAgeMs?: number
    maxCount?: number
    now?: number
  } = {},
): Promise<number> {
  const db = await getDB()
  const all = await db.getAll('transfers') as TransferRecord[]
  const terminal = all
    .filter(t => isTerminalStatus(t.status))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))  // newest first

  const doomed: string[] = []
  terminal.forEach((record, rank) => {
    const tooOld = now - (record.updatedAt ?? 0) > maxAgeMs
    const tooMany = rank >= maxCount
    if (tooOld || tooMany) doomed.push(record.transferId)
  })
  if (doomed.length === 0) return 0

  const tx = db.transaction('transfers', 'readwrite')
  await Promise.all(doomed.map(id => tx.store.delete(id)))
  await tx.done
  // Chunk rows for a terminal transfer are dead weight too — a completed
  // IDB-mode receive deletes them at delivery, but a *failed* one never did.
  await Promise.all(doomed.map(id => deleteChunks(id).catch(() => {})))
  return doomed.length
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

// P2-12: keys are of the form `${transferId}:${index}`. We bound the
// scan with `IDBKeyRange.bound(${id}:, ${id};)` — `:` is 0x3a and `;`
// is 0x3b, so the half-open range exactly contains every chunk row for
// `transferId` and excludes any prefix-sibling (e.g. `id`+'extra:0').
// On a chunks store with millions of rows across long-lived sessions,
// this turns an O(total) JS-side filter into an O(targetRows) range
// scan handled inside IDB.
function chunkRangeFor(transferId: string): IDBKeyRange {
  return IDBKeyRange.bound(`${transferId}:`, `${transferId};`, false, true)
}

export async function deleteChunks(transferId: string) {
  const db = await getDB()
  // One range-delete is atomic and faster than the prior
  // getAllKeys + filter + per-key delete loop.
  await db.delete('chunks', chunkRangeFor(transferId))
}

export async function getSavedChunkIndexes(transferId: string): Promise<number[]> {
  const db = await getDB()
  const keys = await db.getAllKeys('chunks', chunkRangeFor(transferId))
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
