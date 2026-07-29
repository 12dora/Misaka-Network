/**
 * transfer/storage/opfs.ts — OPFS backend; owns opfsHandles map.
 * Cleanup owner: cleanupOPFS / removeOPFSEntry / registry.forgetTransfer (handle map only).
 * Each backend owns its own handles — that is the point of this split.
 */
import { CHUNK_SIZE } from '../protocol'
import { newBitmap, bitmapSet, bitmapPopcount } from '../../chunk-bitmap'
import { WriteQueue, isQuotaExceeded, StorageQuotaExceededError } from './shared'

// ── OPFS disk-backed receive (all modern browsers) ────────────────────
// Uses navigator.storage.getDirectory() to write chunks to disk as they
// arrive, avoiding the all-in-memory Blob assembly. Available in Chrome
// 86+, Safari 15.2+, Firefox 111+. Falls back to IndexedDB + Blob for
// very old browsers.

export interface OPFSReceiveHandle {
  writable: FileSystemWritableFileStream
  fileHandle: FileSystemFileHandle
  // P1-7: was `Set<number>` (~50 B per chunk → ~800 MB for a 1 TB
  // transfer). Now a fixed-size bitmap sized at handle creation. We keep
  // the field name `written` to minimise call-site churn; helpers
  // `bitmapSet` / `bitmapHas` handle the bit math.
  written: Uint8Array<ArrayBuffer>
  totalChunks: number
  fileName: string
  queue: WriteQueue
}

// Cleanup owner: cleanupOPFS / getOPFSFile(release) / finalizeReceive (map entry) / forceResidualTerminalDrop
export const opfsHandles = new Map<string, OPFSReceiveHandle>()

export function supportsOPFS(): boolean {
  return typeof navigator !== 'undefined' && 'storage' in navigator && 'getDirectory' in navigator.storage
}

export async function createOPFSReceiveFile(
  transferId: string,
  fileName: string,
  totalChunks: number,
): Promise<OPFSReceiveHandle> {
  const root = await navigator.storage.getDirectory()
  const dir = await root.getDirectoryHandle('misaka-transfers', { create: true })
  const fileHandle = await dir.getFileHandle(`${transferId}-${fileName}`, { create: true })
  // Keep existing data so a page-refresh mid-transfer doesn't truncate the
  // already-written bytes. The resume bitmap (built from IndexedDB) tells the
  // sender which chunk indexes are still missing; sparse writes here fill
  // exactly those.
  const writable = await fileHandle.createWritable({ keepExistingData: true })
  const handle: OPFSReceiveHandle = {
    writable,
    fileHandle,
    written: newBitmap(totalChunks),
    totalChunks,
    fileName,
    queue: new WriteQueue(),
  }
  opfsHandles.set(transferId, handle)
  return handle
}

export function getOPFSHandle(transferId: string): OPFSReceiveHandle | undefined {
  return opfsHandles.get(transferId)
}

/** Popcount over the OPFS handle's `written` bitmap. Use this in place of
 *  `opfsHandle.written.size` after the bitmap migration (P1-7); the field
 *  is now a Uint8Array, not a Set. Returns 0 when the handle isn't known. */
export function opfsWrittenCount(transferId: string): number {
  const handle = opfsHandles.get(transferId)
  if (!handle) return 0
  return bitmapPopcount(handle.written)
}

export async function writeChunkToOPFS(
  transferId: string,
  index: number,
  data: ArrayBuffer,
): Promise<void> {
  const handle = opfsHandles.get(transferId)
  if (!handle) return
  const offset = index * CHUNK_SIZE
  bitmapSet(handle.written, index)
  // P1-6: kick off the write with a quota-normalising wrapper so callers
  // see one error string regardless of which storage backend ran out.
  const writePromise = handle.writable.write({ type: 'write', position: offset, data: new Uint8Array(data) })
  const tagged = writePromise.catch((err: unknown) => {
    if (isQuotaExceeded(err)) throw new StorageQuotaExceededError(err)
    throw err
  })
  const wait = handle.queue.enqueue(tagged, data.byteLength)
  // Always await the tagged write so a synchronous quota error reaches
  // the caller instead of being swallowed by the WriteQueue's logging
  // catch. The backpressure await (`wait`) still applies when set.
  if (wait) await wait
  await tagged
}

export async function getOPFSFile(
  transferId: string,
  options?: { releaseHandle?: boolean },
): Promise<File> {
  const handle = opfsHandles.get(transferId)
  if (!handle) throw new Error('No OPFS handle')
  await handle.queue.drain()
  await handle.writable.close()
  const file = await handle.fileHandle.getFile()
  // Default release for legacy callers; finalizeReceive keeps the handle
  // until the terminal row is durable.
  if (options?.releaseHandle !== false) {
    opfsHandles.delete(transferId)
  }
  return file
}

/**
 * Delete exactly one OPFS entry by its known name. Split out of `cleanupOPFS`
 * because the terminal completion path (BUG-018) has already released the
 * handle by the time it needs to remove the file, and `cleanupOPFS` could only
 * ever recover the name FROM that handle.
 */
export async function removeOPFSEntry(transferId: string, fileName: string) {
  try {
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle('misaka-transfers', { create: false })
    await dir.removeEntry(`${transferId}-${fileName}`).catch(() => {})
  } catch { /* directory may not exist */ }
}

export async function cleanupOPFS(transferId: string) {
  const handle = opfsHandles.get(transferId)
  const fileName = handle?.fileName
  if (handle) {
    // Drain queued writes BEFORE closing — otherwise pending write promises
    // reject with "stream closed" and the OPFS directory entry can briefly
    // re-appear after `removeEntry` because a late write recreated it.
    await handle.queue.drain().catch(() => {})
    await handle.writable.close().catch(() => {})
    opfsHandles.delete(transferId)
  }
  // P1-8: only remove the EXACT entry this transfer owns. Previously we
  // walked the directory and matched `name.startsWith(transferId)`,
  // which could wipe unrelated files when one transferId was a prefix
  // of another (UUID collisions, or any two IDs that happened to share
  // a prefix). With the in-memory handle we already know the file name;
  // use it directly.
  if (!fileName) return
  try {
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle('misaka-transfers', { create: false })
    await dir.removeEntry(`${transferId}-${fileName}`).catch(() => {})
  } catch { /* directory may not exist */ }
}
