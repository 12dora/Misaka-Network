import { createSHA256 } from 'hash-wasm'
import { computeFileHashInWorker } from './fileHashWorker'
import {
  saveTransfer, updateTransfer, getTransfer, getActiveTransfers,
  saveChunk, getChunk, deleteChunks, getSavedChunkIndexes,
  type TransferRecord,
} from './db'
import { encryptChunk, decryptChunk } from './crypto'
import {
  CHUNK_SIZE, HIGH_WATER_MARK, LOW_WATER_MARK,
  TRANSFER_PROGRESS_INTERVAL_MS, TRANSFER_RECORD_INTERVAL_MS,
  TRANSFER_LANE_COUNT,
} from '@/constants'

export { CHUNK_SIZE }

// ── Protocol types ───────────────────────────────────────────────────

export interface MetaMessage {
  type: 'meta'
  transferId: string
  fileName: string
  fileSize: number
  fileHash: string
  totalChunks: number
  mime: string
}

export interface ChunkHeader {
  type: 'chunk'
  transferId: string
  index: number
  total: number
  checksum: string
}

export interface AckMessage {
  type: 'ack'
  transferId: string
  index: number
}

export interface ResumeRequest {
  type: 'resume'
  transferId: string
  receivedChunks: number[]
}

export type DCProtocolMessage = MetaMessage | ChunkHeader | AckMessage | ResumeRequest | { type: 'ecdh-pub'; pub: string }

// ── Hashing ──────────────────────────────────────────────────────────

export async function computeFileHash(file: File): Promise<string> {
  const workerHash = computeFileHashInWorker(file)
  if (workerHash) {
    try {
      return await workerHash
    } catch {
      // Fall through to the inline path if the worker is unavailable at runtime.
    }
  }

  const hasher = await createSHA256()
  const CHUNK = 4 * 1024 * 1024 // 4MB read chunks
  for (let offset = 0; offset < file.size; offset += CHUNK) {
    const slice = file.slice(offset, offset + CHUNK)
    const buf = await slice.arrayBuffer()
    hasher.update(new Uint8Array(buf))
  }
  return hasher.digest('hex')
}

export async function computeChunkChecksum(data: ArrayBuffer): Promise<string> {
  const hasher = await createSHA256()
  hasher.update(new Uint8Array(data))
  return hasher.digest('hex')
}

export async function verifyFileHash(file: File, expectedHash: string): Promise<boolean> {
  const actual = await computeFileHash(file)
  return actual === expectedHash
}

// ── Send file ────────────────────────────────────────────────────────

export interface SendCallbacks {
  onProgress?: (sent: number, total: number) => void
  onError?: (error: string) => void
}

function shouldFlushProgress(lastAt: number, done: number, total: number) {
  return done === total || performance.now() - lastAt >= TRANSFER_PROGRESS_INTERVAL_MS
}

export async function sendFile(
  dc: RTCDataChannel,
  file: File,
  transferId: string,
  peerNodeId: number,
  peerSessionId: string,
  existingRecord?: TransferRecord, // for resume
  callbacks?: SendCallbacks,
  peerReceivedChunks?: number[], // actual chunks the receiver reports having
): Promise<void> {
  const fileHash = existingRecord?.fileHash ?? await computeFileHash(file)
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE)

  const record: TransferRecord = existingRecord ?? {
    transferId,
    direction: 'send',
    peerNodeId,
    fileName: file.name,
    fileSize: file.size,
    fileHash,
    totalChunks,
    receivedChunks: [],
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  await saveTransfer(record)

  // Build skip set from peer's actual bitmap (preferred), fall back to local record
  let skipSet: Set<number>
  if (peerReceivedChunks && peerReceivedChunks.length > 0) {
    skipSet = new Set(peerReceivedChunks)
  } else if (existingRecord) {
    const savedIndexes = await getSavedChunkIndexes(transferId)
    skipSet = new Set(savedIndexes)
  } else {
    skipSet = new Set()
  }

  // Send metadata (skip if resuming — peer already has it)
  if (!peerReceivedChunks && !existingRecord) {
    dc.send(JSON.stringify({
      type: 'meta',
      transferId,
      fileName: file.name,
      fileSize: file.size,
      fileHash,
      totalChunks,
      mime: file.type || 'application/octet-stream',
    } satisfies MetaMessage))
  }

  let sent = skipSet.size
  callbacks?.onProgress?.(sent, totalChunks)
  const sentChunkIndexes = new Set(record.receivedChunks)
  let lastProgressAt = performance.now()
  let lastRecordAt = performance.now()
  let recordDirty = false

  for (let i = 0; i < totalChunks; i++) {
    if (skipSet.has(i)) continue

    // Check pause/cancel signals
    const signal = transferSignals.get(transferId)
    if (signal?.cancelled) {
      await updateTransfer(transferId, { status: 'failed' })
      return
    }
    if (signal?.paused) {
      await updateTransfer(transferId, { status: 'paused' })
      await waitWhilePaused(transferId)
      const s2 = transferSignals.get(transferId)
      if (s2?.cancelled) {
        await updateTransfer(transferId, { status: 'failed' })
        return
      }
      await updateTransfer(transferId, { status: 'active' })
    }

    const start = i * CHUNK_SIZE
    const end = Math.min(start + CHUNK_SIZE, file.size)
    const raw = await file.slice(start, end).arrayBuffer()

    // Encrypt
    const { iv, encrypted } = await encryptChunk(raw, peerSessionId)

    // Send header as text
    dc.send(JSON.stringify({
      type: 'chunk',
      transferId,
      index: i,
      total: totalChunks,
      checksum: '',
    } satisfies ChunkHeader))

    // Pack iv + encrypted into one binary message
    const packet = new Uint8Array(12 + encrypted.byteLength)
    packet.set(iv, 0)
    packet.set(new Uint8Array(encrypted), 12)

    // Flow control: wait if buffer is full
    await waitForBuffer(dc)
    dc.send(packet.buffer)

    sent++
    if (shouldFlushProgress(lastProgressAt, sent, totalChunks)) {
      callbacks?.onProgress?.(sent, totalChunks)
      lastProgressAt = performance.now()
    }

    // Track which chunks we've sent this session. The receiver's resume bitmap
    // is still authoritative, so avoid writing every outgoing chunk body to IDB.
    sentChunkIndexes.add(i)
    recordDirty = true
    if (performance.now() - lastRecordAt >= TRANSFER_RECORD_INTERVAL_MS || sent === totalChunks) {
      record.receivedChunks = Array.from(sentChunkIndexes).sort((a, b) => a - b)
      await updateTransfer(transferId, { receivedChunks: record.receivedChunks })
      recordDirty = false
      lastRecordAt = performance.now()
    }
  }

  if (recordDirty) {
    record.receivedChunks = Array.from(sentChunkIndexes).sort((a, b) => a - b)
    await updateTransfer(transferId, { receivedChunks: record.receivedChunks })
  }
  await updateTransfer(transferId, { status: 'completed' })
}

export async function sendFileParallel(
  dcs: RTCDataChannel[],
  file: File,
  transferId: string,
  peerNodeId: number,
  peerSessionId: string,
  existingRecord?: TransferRecord,
  callbacks?: SendCallbacks,
  peerReceivedChunks?: number[],
): Promise<void> {
  const lanes = dcs.filter(dc => dc.readyState === 'open').slice(0, TRANSFER_LANE_COUNT)
  if (lanes.length <= 1) {
    await sendFile(lanes[0] ?? dcs[0], file, transferId, peerNodeId, peerSessionId, existingRecord, callbacks, peerReceivedChunks)
    return
  }

  const fileHash = existingRecord?.fileHash ?? await computeFileHash(file)
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE)
  const record: TransferRecord = existingRecord ?? {
    transferId,
    direction: 'send',
    peerNodeId,
    fileName: file.name,
    fileSize: file.size,
    fileHash,
    totalChunks,
    receivedChunks: [],
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  await saveTransfer(record)

  const skipSet = new Set(peerReceivedChunks ?? (existingRecord ? await getSavedChunkIndexes(transferId) : []))
  const sentChunkIndexes = new Set(record.receivedChunks)
  let sent = skipSet.size
  let nextChunk = 0
  let cancelled = false
  let lastProgressAt = performance.now()
  let lastRecordAt = performance.now()
  let recordDirty = false

  const meta = JSON.stringify({
    type: 'meta',
    transferId,
    fileName: file.name,
    fileSize: file.size,
    fileHash,
    totalChunks,
    mime: file.type || 'application/octet-stream',
  } satisfies MetaMessage)

  if (!peerReceivedChunks && !existingRecord) {
    for (const lane of lanes) lane.send(meta)
  }

  callbacks?.onProgress?.(sent, totalChunks)

  function nextIndex(): number | null {
    while (nextChunk < totalChunks) {
      const idx = nextChunk++
      if (!skipSet.has(idx)) return idx
    }
    return null
  }

  async function flushRecord(force = false) {
    if (!recordDirty && !force) return
    if (!force && performance.now() - lastRecordAt < TRANSFER_RECORD_INTERVAL_MS) return
    record.receivedChunks = Array.from(sentChunkIndexes).sort((a, b) => a - b)
    await updateTransfer(transferId, { receivedChunks: record.receivedChunks })
    recordDirty = false
    lastRecordAt = performance.now()
  }

  async function laneLoop(dc: RTCDataChannel) {
    while (!cancelled) {
      const signal = transferSignals.get(transferId)
      if (signal?.cancelled) {
        cancelled = true
        await updateTransfer(transferId, { status: 'failed' })
        return
      }
      if (signal?.paused) {
        await updateTransfer(transferId, { status: 'paused' })
        await waitWhilePaused(transferId)
        const s2 = transferSignals.get(transferId)
        if (s2?.cancelled) {
          cancelled = true
          await updateTransfer(transferId, { status: 'failed' })
          return
        }
        await updateTransfer(transferId, { status: 'active' })
      }

      const i = nextIndex()
      if (i === null) return

      const start = i * CHUNK_SIZE
      const end = Math.min(start + CHUNK_SIZE, file.size)
      const raw = await file.slice(start, end).arrayBuffer()
      const { iv, encrypted } = await encryptChunk(raw, peerSessionId)

      await waitForBuffer(dc)
      dc.send(JSON.stringify({
        type: 'chunk',
        transferId,
        index: i,
        total: totalChunks,
        checksum: '',
      } satisfies ChunkHeader))

      const packet = new Uint8Array(12 + encrypted.byteLength)
      packet.set(iv, 0)
      packet.set(new Uint8Array(encrypted), 12)
      dc.send(packet.buffer)

      sent++
      sentChunkIndexes.add(i)
      recordDirty = true
      if (shouldFlushProgress(lastProgressAt, sent, totalChunks)) {
        callbacks?.onProgress?.(sent, totalChunks)
        lastProgressAt = performance.now()
      }
      await flushRecord(sent === totalChunks)
    }
  }

  await Promise.all(lanes.map(lane => laneLoop(lane)))
  await flushRecord(true)
  if (!cancelled) await updateTransfer(transferId, { status: 'completed' })
}

// ── Receive file ─────────────────────────────────────────────────────

export interface ReceiveCallbacks {
  onMeta?: (meta: MetaMessage) => void
  onProgress?: (received: number, total: number) => void
  onError?: (error: string) => void
}

type ReceiveSession = {
  transferId: string
  fileName: string
  fileSize: number
  fileHash: string
  totalChunks: number
  mime: string
  received: Set<number>
  lastRecordAt: number
  storageMode: 'pending' | 'stream' | 'indexeddb'
  direction: 'recv'
}

const receiveSessions = new Map<string, ReceiveSession>()

export function getReceiveSession(transferId: string): ReceiveSession | undefined {
  return receiveSessions.get(transferId)
}

export async function handleMetaMessage(msg: MetaMessage, peerNodeId: number): Promise<ReceiveSession> {
  const existing = receiveSessions.get(msg.transferId)
  if (existing) return existing

  const session: ReceiveSession = {
    transferId: msg.transferId,
    fileName: msg.fileName,
    fileSize: msg.fileSize,
    fileHash: msg.fileHash,
    totalChunks: msg.totalChunks,
    mime: msg.mime,
    received: new Set(),
    lastRecordAt: performance.now(),
    storageMode: 'pending',
    direction: 'recv',
  }
  receiveSessions.set(msg.transferId, session)

  // Persist
  await saveTransfer({
    transferId: msg.transferId,
    direction: 'recv',
    peerNodeId,
    fileName: msg.fileName,
    fileSize: msg.fileSize,
    fileHash: msg.fileHash,
    totalChunks: msg.totalChunks,
    receivedChunks: [],
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })

  return session
}

export async function receiveChunk(
  transferId: string,
  header: ChunkHeader,
  iv: Uint8Array<ArrayBuffer>,
  encrypted: ArrayBuffer,
  peerSessionId: string,
  callbacks?: ReceiveCallbacks,
): Promise<{ ack: AckMessage; decrypted: ArrayBuffer; storageMode: 'stream' | 'indexeddb' } | undefined> {
  const session = receiveSessions.get(transferId)
  if (!session) return

  // AES-GCM authenticates the encrypted payload. Keep checksum verification
  // only for older senders that still populate it; skipping the duplicate hash
  // removes a hot-path CPU bottleneck on local transfers.
  if (header.checksum) {
    const actualChecksum = await computeChunkChecksum(encrypted)
    if (actualChecksum !== header.checksum) {
      callbacks?.onError?.('Chunk checksum mismatch')
      return
    }
  }

  // Decrypt
  const decrypted = await decryptChunk(iv, encrypted, peerSessionId)

  const hasStreamingTarget = getWriteHandle(transferId) || getOPFSHandle(transferId)
  if (session.storageMode === 'pending') {
    session.storageMode = hasStreamingTarget ? 'stream' : 'indexeddb'
  }
  if (session.storageMode === 'indexeddb') {
    await saveChunk(transferId, header.index, decrypted)
  }

  session.received.add(header.index)

  if (
    performance.now() - session.lastRecordAt >= TRANSFER_RECORD_INTERVAL_MS ||
    session.received.size === session.totalChunks
  ) {
    await updateTransfer(transferId, {
      receivedChunks: Array.from(session.received).sort((a, b) => a - b),
      updatedAt: Date.now(),
    })
    session.lastRecordAt = performance.now()
  }

  callbacks?.onProgress?.(session.received.size, session.totalChunks)

  return {
    ack: { type: 'ack', transferId, index: header.index },
    decrypted,
    storageMode: session.storageMode,
  }
}

export async function assembleFile(transferId: string): Promise<File> {
  const session = receiveSessions.get(transferId)
  if (!session) throw new Error('No receive session')

  const chunks: BlobPart[] = []
  for (let i = 0; i < session.totalChunks; i++) {
    const data = await getChunk(transferId, i)
    if (!data) throw new Error(`Missing chunk ${i}`)
    chunks.push(new Uint8Array(data as ArrayBuffer))
  }

  const blob = new Blob(chunks, { type: session.mime })
  const file = new File([blob], session.fileName, { type: session.mime })

  // Verify hash
  const ok = await verifyFileHash(file, session.fileHash)
  if (!ok) throw new Error('File hash verification failed')

  return file
}

export async function completeReceive(transferId: string): Promise<File> {
  const file = await assembleFile(transferId)
  await deleteChunks(transferId)
  await updateTransfer(transferId, { status: 'completed' })
  receiveSessions.delete(transferId)
  return file
}

export function cancelReceive(transferId: string) {
  receiveSessions.delete(transferId)
  updateTransfer(transferId, { status: 'failed' })
}

// ── Resume ───────────────────────────────────────────────────────────

export async function buildResumeRequest(transferId: string): Promise<ResumeRequest | null> {
  const record = await getTransfer(transferId)
  if (!record || record.status !== 'active') return null
  const chunks = [...new Set([
    ...record.receivedChunks,
    ...await getSavedChunkIndexes(transferId),
  ])].sort((a, b) => a - b)
  return {
    type: 'resume',
    transferId,
    receivedChunks: chunks,
  }
}

// ── Flow control ─────────────────────────────────────────────────────

function waitWhilePaused(transferId: string): Promise<void> {
  return new Promise(resolve => {
    const check = () => {
      const s = transferSignals.get(transferId)
      if (!s || !s.paused) resolve()
      else setTimeout(check, 200)
    }
    check()
  })
}

function waitForBuffer(dc: RTCDataChannel): Promise<void> {
  return new Promise(resolve => {
    if (dc.bufferedAmount <= HIGH_WATER_MARK) {
      resolve()
      return
    }
    dc.bufferedAmountLowThreshold = LOW_WATER_MARK
    dc.onbufferedamountlow = () => {
      dc.onbufferedamountlow = null
      resolve()
    }
  })
}

// ── Helpers ──────────────────────────────────────────────────────────

// ── Transfer control signals ──────────────────────────────────────────

interface TransferSignal {
  paused: boolean
  cancelled: boolean
}

const transferSignals = new Map<string, TransferSignal>()

function getSignal(transferId: string): TransferSignal {
  let s = transferSignals.get(transferId)
  if (!s) {
    s = { paused: false, cancelled: false }
    transferSignals.set(transferId, s)
  }
  return s
}

export function pauseTransfer(transferId: string) {
  getSignal(transferId).paused = true
}

export function resumeTransfer(transferId: string) {
  getSignal(transferId).paused = false
}

export function cancelTransfer(transferId: string) {
  const s = getSignal(transferId)
  s.cancelled = true
  s.paused = false // unblock any waiting
  transferSignals.delete(transferId)
}

export function humanizeError(error: Error | string, channelType?: string): string {
  const msg = typeof error === 'string' ? error : error.message
  if (msg.includes('超时') || msg.includes('timeout')) {
    if (channelType === 'stun') return '连接超时 — 尝试在设置中开启 TURN 中继以穿越防火墙'
    return '连接超时 — 请检查网络或稍后重试'
  }
  if (msg.includes('加密') || msg.includes('AES') || msg.includes('key')) return '加密协商失败，请重新连接后重试'
  if (msg.includes('checksum')) return '数据校验失败，文件可能已损坏'
  if (msg.includes('DataChannel')) return '数据信道断开 — 尝试更换信道类型'
  return msg || '传输失败，请检查网络连接后重试'
}

export function createTransferId(): string {
  return crypto.randomUUID()
}

export async function checkForResumableTransfers(): Promise<TransferRecord[]> {
  return getActiveTransfers()
}

// ── OPFS disk-backed receive (all modern browsers) ────────────────────
// Uses navigator.storage.getDirectory() to write chunks to disk as they
// arrive, avoiding the all-in-memory Blob assembly. Available in Chrome
// 86+, Safari 15.2+, Firefox 111+. Falls back to IndexedDB + Blob for
// very old browsers.

export interface OPFSReceiveHandle {
  writable: FileSystemWritableFileStream
  fileHandle: FileSystemFileHandle
  written: Set<number>
  totalChunks: number
  fileName: string
}

const opfsHandles = new Map<string, OPFSReceiveHandle>()

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
  const writable = await fileHandle.createWritable({ keepExistingData: false })
  const handle: OPFSReceiveHandle = { writable, fileHandle, written: new Set(), totalChunks, fileName }
  opfsHandles.set(transferId, handle)
  return handle
}

export function getOPFSHandle(transferId: string): OPFSReceiveHandle | undefined {
  return opfsHandles.get(transferId)
}

export async function writeChunkToOPFS(
  transferId: string,
  index: number,
  data: ArrayBuffer,
): Promise<void> {
  const handle = opfsHandles.get(transferId)
  if (!handle) return
  const offset = index * CHUNK_SIZE
  await handle.writable.write({ type: 'write', position: offset, data: new Uint8Array(data) })
  handle.written.add(index)
}

export async function getOPFSFile(transferId: string): Promise<File> {
  const handle = opfsHandles.get(transferId)
  if (!handle) throw new Error('No OPFS handle')
  await handle.writable.close()
  const file = await handle.fileHandle.getFile()
  opfsHandles.delete(transferId)
  return file
}

export async function cleanupOPFS(transferId: string) {
  const handle = opfsHandles.get(transferId)
  if (handle) {
    handle.writable.close().catch(() => {})
    opfsHandles.delete(transferId)
  }
  try {
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle('misaka-transfers', { create: false })
    // Find and remove the OPFS file for this transfer
    for await (const [name] of dir as any) {
      if (name.startsWith(transferId)) {
        await dir.removeEntry(name).catch(() => {})
      }
    }
  } catch { /* directory may not exist */ }
}

// ── File System Access API streaming write (Chromium) ──────────────────

export interface FileWriteHandle {
  writable: FileSystemWritableFileStream
  fileHandle: FileSystemFileHandle
  written: Set<number>
  totalChunks: number
}

const writeHandles = new Map<string, FileWriteHandle>()

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
  const handle: FileWriteHandle = { writable, fileHandle, written: new Set(), totalChunks }
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
  await handle.writable.write({ type: 'write', position: offset, data: new Uint8Array(data) })
  handle.written.add(index)
}

export async function finalizeStreamedFile(transferId: string): Promise<File> {
  const handle = writeHandles.get(transferId)
  if (!handle) throw new Error('No write handle')

  await handle.writable.close()
  writeHandles.delete(transferId)

  // Return a File from the saved handle for hash verification
  const file = await handle.fileHandle.getFile()
  return file
}

export function cancelStreamWrite(transferId: string) {
  const handle = writeHandles.get(transferId)
  if (handle) {
    handle.writable.close().catch(() => {})
    writeHandles.delete(transferId)
  }
}
