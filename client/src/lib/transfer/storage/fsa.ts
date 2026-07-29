/**
 * transfer/storage/fsa.ts — File System Access API backend; owns writeHandles map.
 * Cleanup owner: cancelStreamWrite / finalizeStreamedFile / registry residual drop.
 * Each backend owns its own handles.
 */
import { CHUNK_SIZE } from '../protocol'
import { WriteQueue, isQuotaExceeded, StorageQuotaExceededError } from './shared'

// ── File System Access API streaming write (Chromium) ──────────────────

export interface FileWriteHandle {
  writable: FileSystemWritableFileStream
  fileHandle: FileSystemFileHandle
  written: Set<number>
  totalChunks: number
  queue: WriteQueue
}

// Cleanup owner: cancelStreamWrite / finalizeStreamedFile / forceResidualTerminalDrop
export const writeHandles = new Map<string, FileWriteHandle>()

export function supportsFileSystemAccess(): boolean {
  return typeof window !== 'undefined' && 'showSaveFilePicker' in window
}

export async function requestWriteHandle(
  transferId: string,
  suggestedName: string,
  totalChunks: number,
): Promise<FileWriteHandle> {
  // Use type assertion for File System Access API (not in all TS libs)
  const ext = suggestedName.split('.').pop() ?? 'bin'
  const fileHandle = await (window as any).showSaveFilePicker({
    suggestedName,
    types: [{ description: suggestedName, accept: { 'application/octet-stream': [`.${ext}`] } }],
  }) as FileSystemFileHandle
  const writable = await fileHandle.createWritable()
  const handle: FileWriteHandle = { writable, fileHandle, written: new Set(), totalChunks, queue: new WriteQueue() }
  writeHandles.set(transferId, handle)
  return handle
}

export function getWriteHandle(transferId: string): FileWriteHandle | undefined {
  return writeHandles.get(transferId)
}

export async function streamChunkToDisk(
  transferId: string,
  index: number,
  data: ArrayBuffer,
): Promise<void> {
  const handle = writeHandles.get(transferId)
  if (!handle) return
  const offset = index * CHUNK_SIZE
  handle.written.add(index)
  // P1-6: same quota-normalising pattern as writeChunkToOPFS.
  const writePromise = handle.writable.write({ type: 'write', position: offset, data: new Uint8Array(data) })
  const tagged = writePromise.catch((err: unknown) => {
    if (isQuotaExceeded(err)) throw new StorageQuotaExceededError(err)
    throw err
  })
  const wait = handle.queue.enqueue(tagged, data.byteLength)
  if (wait) await wait
  await tagged
}

export async function finalizeStreamedFile(
  transferId: string,
  options?: { releaseHandle?: boolean },
): Promise<File> {
  const handle = writeHandles.get(transferId)
  if (!handle) throw new Error('No write handle')

  await handle.queue.drain()
  await handle.writable.close()
  // Keep the map entry (fileHandle) until the terminal DB row is durable so
  // a failed persist can still re-getFile and retry. Callers that opt out of
  // release are responsible for writeHandles.delete after success.
  if (options?.releaseHandle !== false) {
    writeHandles.delete(transferId)
  }

  return handle.fileHandle.getFile()
}

/**
 * Abort an FSA stream write without committing partial content. Prefer
 * `writable.abort()` so cancelling a receive into an existing file cannot
 * truncate/overwrite the user's original data. Falls back to `close()` only
 * where `abort` is provably unsupported. Map entry is removed AFTER the
 * operation settles.
 */
export async function cancelStreamWrite(transferId: string): Promise<void> {
  const handle = writeHandles.get(transferId)
  if (!handle) return
  const writable = handle.writable as FileSystemWritableFileStream & {
    abort?: () => Promise<void>
  }
  try {
    if (typeof writable.abort === 'function') {
      await writable.abort()
    } else {
      // Environments without abort: close still commits — best effort only.
      await writable.close().catch(() => {})
    }
  } catch {
    // Stream may already be closed/aborted.
  } finally {
    writeHandles.delete(transferId)
  }
}
