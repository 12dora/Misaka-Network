/**
 * transfer/storage/backend.ts — unified prepare/select across FSA / OPFS / IDB.
 * selectWritableBackend proves writability before commit (BUG-012).
 */
import { newBitmap } from '../../chunk-bitmap'
import { supportsFileSystemAccess, requestWriteHandle } from './fsa'
import {
  supportsOPFS, type OPFSReceiveHandle, opfsHandles,
} from './opfs'
import { WriteQueue } from './shared'

export interface PrepareReceiveStorageResult {
  mode: 'fsa' | 'opfs' | 'idb'
}

export async function selectWritableBackend(meta: {
  transferId: string
  fileName: string
  totalChunks: number
  size: number
}): Promise<'fsa' | 'opfs' | 'idb'> {
  // Tier 1: File System Access. `requestWriteHandle` only resolves after
  // `createWritable()` succeeded, so a resolved promise IS the proof.
  if (supportsFileSystemAccess()) {
    try {
      await requestWriteHandle(meta.transferId, meta.fileName, meta.totalChunks)
      return 'fsa'
    } catch (err) {
      // AbortError = user cancelled; NotAllowedError = no gesture / blocked.
      // Either way fall through to the next tier rather than failing the
      // entire transfer.
      const name = (err as { name?: string })?.name
      if (name && name !== 'AbortError' && name !== 'NotAllowedError') {
        console.warn('[transfer] FSA save picker failed', err)
      }
    }
  }

  // Tier 2: OPFS.
  if (supportsOPFS()) {
    let writable: FileSystemWritableFileStream | null = null
    try {
      const root = await navigator.storage.getDirectory()
      const dir = await root.getDirectoryHandle('misaka-transfers', { create: true })
      const probeName = `${meta.transferId}-${meta.fileName}`
      const fileHandle = await dir.getFileHandle(probeName, { create: true })
      // Proof #1: the stream can be opened at all.
      writable = await fileHandle.createWritable({ keepExistingData: true })
      // Proof #2: a real (zero-length, position-0) write is accepted. Some
      // restricted environments hand back a writable whose first `write()`
      // rejects — discovering that at chunk 0 instead of here is what made
      // the OOM guard moot.
      await writable.write({ type: 'write', position: 0, data: new Uint8Array(0) })
      // Reuse the same handle for the real receive path so we don't pay
      // a second `createWritable` (some browsers serialize all writes to
      // a single open writable per file).
      const handle: OPFSReceiveHandle = {
        writable,
        fileHandle,
        written: newBitmap(meta.totalChunks),
        totalChunks: meta.totalChunks,
        fileName: meta.fileName,
        queue: new WriteQueue(),
      }
      opfsHandles.set(meta.transferId, handle)
      return 'opfs'
    } catch (err) {
      // Clean up any partial OPFS state (the probe file may have been
      // created even though createWritable/write failed).
      if (writable) { try { await writable.close() } catch { /* ignored */ } }
      opfsHandles.delete(meta.transferId)
      try {
        const root = await navigator.storage.getDirectory()
        const dir = await root.getDirectoryHandle('misaka-transfers', { create: false })
        await dir.removeEntry(`${meta.transferId}-${meta.fileName}`).catch(() => {})
      } catch { /* ignored */ }
      const name = (err as { name?: string })?.name
      if (name !== 'NotAllowedError') {
        console.warn('[transfer] OPFS probe failed, falling back to IDB', err)
      }
    }
  }

  // Tier 3: IndexedDB.
  return 'idb'
}

/**
 * Legacy entry point: selects and commits a backend without applying the
 * committed-backend size cap. Prefer `prepareReceiveBackend`, which
 * deduplicates concurrent lane metas and enforces BUG-012's cap.
 */
export async function prepareReceiveStorage(meta: {
  transferId: string
  fileName: string
  totalChunks: number
  size: number
}): Promise<PrepareReceiveStorageResult> {
  return { mode: await selectWritableBackend(meta) }
}
