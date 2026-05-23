import {
  saveTransfer, updateTransfer, getTransfer, getActiveTransfers,
  saveChunk, getChunk, deleteChunks, getSavedChunkIndexes,
  type TransferRecord,
} from './db'
import { encryptChunk, decryptChunk, makeChunkIv, randomIvPrefix } from './crypto'
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
  shortId: number          // compact id embedded in binary chunk frames
  fileName: string
  fileSize: number
  fileHash: string
  totalChunks: number
  mime: string
}

export interface ResumeRequest {
  type: 'resume'
  transferId: string
  receivedChunks: number[]
}

export type DCProtocolMessage = MetaMessage | ResumeRequest | { type: 'ecdh-pub'; pub: string }

// ── Binary chunk frame ──────────────────────────────────────────────
// One SCTP message per chunk. Layout:
//   [0]      tag = 0x01
//   [1..5)   shortId (uint32 BE) — registered by the meta message
//   [5..9)   chunk index (uint32 BE)
//   [9..21)  AES-GCM IV (12 bytes)
//   [21..]   ciphertext (plaintext + 16-byte GCM auth tag)
// Replaces the prior "JSON header + binary body" pair, halving the
// DataChannel message count and removing JSON parse from the hot path.

export const CHUNK_FRAME_TAG = 0x01
const CHUNK_FRAME_HEADER_BYTES = 21

export function encodeChunkFrame(
  shortId: number,
  index: number,
  iv: Uint8Array,
  ciphertext: ArrayBuffer,
): ArrayBuffer {
  const out = new Uint8Array(CHUNK_FRAME_HEADER_BYTES + ciphertext.byteLength)
  const view = new DataView(out.buffer)
  view.setUint8(0, CHUNK_FRAME_TAG)
  view.setUint32(1, shortId >>> 0, false)
  view.setUint32(5, index >>> 0, false)
  out.set(iv, 9)
  out.set(new Uint8Array(ciphertext), CHUNK_FRAME_HEADER_BYTES)
  return out.buffer
}

export interface DecodedChunkFrame {
  shortId: number
  index: number
  iv: Uint8Array<ArrayBuffer>
  ciphertext: ArrayBuffer
}

export function decodeChunkFrame(buf: ArrayBuffer): DecodedChunkFrame | null {
  if (buf.byteLength < CHUNK_FRAME_HEADER_BYTES) return null
  const view = new DataView(buf)
  if (view.getUint8(0) !== CHUNK_FRAME_TAG) return null
  const shortId = view.getUint32(1, false)
  const index = view.getUint32(5, false)
  const iv = new Uint8Array(buf.slice(9, 21)) as Uint8Array<ArrayBuffer>
  const ciphertext = buf.slice(CHUNK_FRAME_HEADER_BYTES)
  return { shortId, index, iv, ciphertext }
}

let shortIdCounter = (Math.random() * 0xffffffff) >>> 0
function nextShortId(): number {
  shortIdCounter = (shortIdCounter + 1) >>> 0
  if (shortIdCounter === 0) shortIdCounter = 1
  return shortIdCounter
}

// Per-chunk AES-GCM auth tags already provide cryptographic integrity for
// every chunk we deliver; computing a whole-file SHA-256 before sending and
// re-reading the assembled file at the receiver to verify it was a redundant
// 2× full-file scan that pegged CPU and delayed send start by several seconds
// on large files. The `fileHash` field in MetaMessage / TransferRecord
// remains for backwards-compat with old persisted records but is no longer
// populated.

// ── Send file ────────────────────────────────────────────────────────

export interface SendCallbacks {
  onProgress?: (sent: number, total: number) => void
  onError?: (error: string) => void
}

function shouldFlushProgress(lastAt: number, done: number, total: number) {
  return done === total || performance.now() - lastAt >= TRANSFER_PROGRESS_INTERVAL_MS
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
  const activeLanes = lanes.length > 0 ? lanes : (dcs[0] ? [dcs[0]] : [])
  if (activeLanes.length === 0) throw new Error('No open DataChannel lane available')

  const fileHash = existingRecord?.fileHash ?? ''
  // Zero-byte files: math.ceil(0/CHUNK_SIZE) = 0 → no chunks ever sent, so the
  // receiver's `received === total` completion gate (which only fires from
  // receiveChunk) never trips. Use 1 as the synthetic chunk count for empty
  // files; the meta message is enough on its own and the receiver detects the
  // empty case to deliver immediately.
  const totalChunks = file.size === 0 ? 0 : Math.ceil(file.size / CHUNK_SIZE)
  const shortId = nextShortId()
  // 8-byte random prefix; combined with the 4-byte chunk index it yields a
  // unique 12-byte IV per chunk without an RNG syscall in the hot loop.
  const ivPrefix = randomIvPrefix()
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

  // Meta is always (re)sent so the receiver can register the new shortId for
  // this connection — cheap and avoids a separate "remap" message on resume.
  const meta = JSON.stringify({
    type: 'meta',
    transferId,
    shortId,
    fileName: file.name,
    fileSize: file.size,
    fileHash,
    totalChunks,
    mime: file.type || 'application/octet-stream',
  } satisfies MetaMessage)
  for (const lane of activeLanes) lane.send(meta)

  // Zero-byte files complete the moment meta has been sent — no chunks
  // follow. Synthesize the (1,1) tick so the UI doesn't render NaN%.
  if (file.size === 0) {
    callbacks?.onProgress?.(1, 1)
    await updateTransfer(transferId, { status: 'completed' })
    return
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

  // Pause/cancel check shared by the prefetcher and the send loop.
  // Returns true if the caller should abort the lane (cancelled).
  async function checkSignals(): Promise<boolean> {
    const signal = transferSignals.get(transferId)
    if (signal?.cancelled) {
      cancelled = true
      await updateTransfer(transferId, { status: 'failed' })
      return true
    }
    if (signal?.paused) {
      await updateTransfer(transferId, { status: 'paused' })
      await waitWhilePaused(transferId)
      const s2 = transferSignals.get(transferId)
      if (s2?.cancelled) {
        cancelled = true
        await updateTransfer(transferId, { status: 'failed' })
        return true
      }
      await updateTransfer(transferId, { status: 'active' })
    }
    return false
  }

  // Read + encrypt the next chunk for a lane. Returns null when the queue is
  // drained (or the transfer was cancelled mid-prep). Runs on its own
  // microtask so the previous chunk's dc.send can overlap with disk I/O and
  // AES-GCM — this is the core of the lane-level pipeline.
  async function prepareNext(): Promise<{ i: number; iv: Uint8Array; encrypted: ArrayBuffer } | null> {
    if (cancelled) return null
    if (await checkSignals()) return null
    const i = nextIndex()
    if (i === null) return null
    const start = i * CHUNK_SIZE
    const end = Math.min(start + CHUNK_SIZE, file.size)
    const raw = await file.slice(start, end).arrayBuffer()
    const { iv, encrypted } = await encryptChunk(raw, peerSessionId, makeChunkIv(ivPrefix, i))
    return { i, iv, encrypted }
  }

  async function laneLoop(dc: RTCDataChannel) {
    // Kick off the first chunk; from then on each iteration starts the next
    // chunk's prepare before awaiting the current chunk's send.
    let prepared = await prepareNext()
    while (prepared && !cancelled) {
      // If this lane has closed under us (NAT/firewall reset a single SCTP
      // stream), don't take the chunk off the queue with a doomed send.
      // Put it back so a healthy lane can pick it up.
      if (dc.readyState !== 'open') {
        skipSet.delete(prepared.i)
        nextChunk = Math.min(nextChunk, prepared.i)
        return
      }
      const current = prepared
      // Start preparing the next chunk in the background; we'll await it at
      // the top of the next iteration. dc.send / waitForBuffer below now
      // runs in parallel with the next disk read + AES-GCM encrypt.
      const upcoming = prepareNext()

      const packet = encodeChunkFrame(shortId, current.i, current.iv, current.encrypted)
      try {
        await waitForBuffer(dc)
        if (cancelled) return
        if (dc.readyState !== 'open') throw new Error('lane closed')
        dc.send(packet)
      } catch (laneErr) {
        // Don't abort the whole transfer for a single bad lane — re-queue
        // this index and exit this lane. Healthy lanes pick up the slack.
        console.warn('[transfer] lane send failed, re-queueing chunk', current.i, laneErr)
        skipSet.delete(current.i)
        nextChunk = Math.min(nextChunk, current.i)
        // Drain the upcoming so the encrypted bytes aren't lost — also
        // re-queue it.
        const orphan = await upcoming.catch(() => null)
        if (orphan) {
          skipSet.delete(orphan.i)
          nextChunk = Math.min(nextChunk, orphan.i)
        }
        return
      }

      sent++
      sentChunkIndexes.add(current.i)
      recordDirty = true
      if (shouldFlushProgress(lastProgressAt, sent, totalChunks)) {
        callbacks?.onProgress?.(sent, totalChunks)
        lastProgressAt = performance.now()
      }
      await flushRecord(sent === totalChunks)

      prepared = await upcoming
    }
  }

  // Use allSettled: one lane's hard failure now triggers a re-queue + lane
  // exit (see laneLoop above), but the OTHER lanes must keep draining.
  await Promise.allSettled(activeLanes.map(lane => laneLoop(lane)))
  // If we exited with anything still un-sent (because all lanes died),
  // fail loudly. The success path already updates status='completed' below.
  if (!cancelled && sent < totalChunks) {
    throw new Error(`传输中断：${totalChunks - sent} 个分片未送达`)
  }
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
  lastProgressAt: number   // throttle React store updates — 4000 setState/GB otherwise
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

  // CRITICAL: register the session SYNCHRONOUSLY before any await. The
  // DataChannel's onmessage queues meta + chunks back-to-back; if we await
  // any I/O before set()ing receiveSessions, the very next message (a
  // chunk for the same transfer on the same lane) reaches receiveChunk
  // BEFORE the session exists and gets silently dropped. Symptom: the
  // transfer card appears on the recipient but progress stays at 0%
  // forever even though the sender finished. (Hit during the folder e2e
  // test — race introduced when this function gained an `await getTransfer`
  // for resume restoration.)
  const session: ReceiveSession = {
    transferId: msg.transferId,
    fileName: msg.fileName,
    fileSize: msg.fileSize,
    fileHash: msg.fileHash,
    totalChunks: msg.totalChunks,
    mime: msg.mime,
    received: new Set(),
    lastRecordAt: performance.now(),
    lastProgressAt: 0,
    storageMode: 'pending',
    direction: 'recv',
  }
  receiveSessions.set(msg.transferId, session)

  // Resume-aware: if a TransferRecord already exists from a prior session
  // (page reload mid-transfer), restore the bitmap so subsequent chunk
  // arrivals can still hit the `received === total` completion gate.
  // Chunks that race ahead of this restoration just add their indexes to
  // session.received normally — duplicate adds on a Set are a no-op.
  try {
    const prior = await getTransfer(msg.transferId)
    if (prior && prior.direction === 'recv') {
      const saved = await getSavedChunkIndexes(msg.transferId)
      for (const idx of prior.receivedChunks) session.received.add(idx)
      for (const idx of saved) session.received.add(idx)
    }
  } catch { /* fresh transfer */ }

  // Persist (with whatever we just restored — keeps the record in sync if
  // the prior shutdown happened between a chunk save and the next interval
  // flush).
  await saveTransfer({
    transferId: msg.transferId,
    direction: 'recv',
    peerNodeId,
    fileName: msg.fileName,
    fileSize: msg.fileSize,
    fileHash: msg.fileHash,
    totalChunks: msg.totalChunks,
    receivedChunks: Array.from(session.received).sort((a, b) => a - b),
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })

  return session
}

export async function receiveChunk(
  transferId: string,
  index: number,
  iv: Uint8Array<ArrayBuffer>,
  encrypted: ArrayBuffer,
  peerSessionId: string,
  callbacks?: ReceiveCallbacks,
): Promise<{ decrypted: ArrayBuffer; storageMode: 'stream' | 'indexeddb' } | undefined> {
  const session = receiveSessions.get(transferId)
  if (!session) return

  // AES-GCM authenticates the encrypted payload — no separate per-chunk
  // checksum is needed (and the sender no longer ships one).
  const decrypted = await decryptChunk(iv, encrypted, peerSessionId)

  const hasStreamingTarget = getWriteHandle(transferId) || getOPFSHandle(transferId)
  if (session.storageMode === 'pending') {
    session.storageMode = hasStreamingTarget ? 'stream' : 'indexeddb'
  }
  if (session.storageMode === 'indexeddb') {
    await saveChunk(transferId, index, decrypted)
  }

  session.received.add(index)

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

  // Throttle progress callbacks the same way the sender does. Without this
  // the receiver fires setState ~4000×/GB, drowning the main thread in React
  // re-renders. Always emit the final tick so the "received === total"
  // delivery hook in network.ts still runs.
  const done = session.received.size === session.totalChunks
  if (done || performance.now() - session.lastProgressAt >= TRANSFER_PROGRESS_INTERVAL_MS) {
    callbacks?.onProgress?.(session.received.size, session.totalChunks)
    session.lastProgressAt = performance.now()
  }

  return { decrypted, storageMode: session.storageMode }
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
  // AES-GCM auth tags on each chunk are the integrity check — any tampered
  // or truncated chunk would have failed decrypt above. No need to re-read
  // the whole file through SHA-256.
  return new File([blob], session.fileName, { type: session.mime })
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
  // Without this, cancelled IndexedDB-fallback transfers leak their partial
  // chunks forever — multi-GB orphans accumulate across many cancellations
  // and silently consume the user's storage quota.
  deleteChunks(transferId).catch(() => {})
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

// ── Async write queue (fire-and-forget + backpressure) ────────────────
// FileSystemWritableFileStream serializes writes internally, so awaiting
// each chunk in the receive hot path gates throughput on disk latency.
// Fire writes without awaiting per chunk; cap outstanding bytes so the
// in-process queue can't grow without bound on slow disks.

const WRITE_BACKPRESSURE_BYTES = 16 * 1024 * 1024  // 16 MB outstanding cap

class WriteQueue {
  private pending = new Set<Promise<unknown>>()
  private pendingBytes = 0

  /**
   * Enqueue a write. Returns a promise that resolves immediately unless the
   * outstanding-bytes cap has been hit, in which case it waits for one
   * in-flight write to complete (coarse backpressure).
   */
  enqueue(promise: Promise<unknown>, bytes: number): Promise<unknown> | undefined {
    const tracked = promise.catch(err => {
      console.warn('[transfer] disk write failed', err)
    })
    this.pending.add(tracked)
    this.pendingBytes += bytes
    tracked.finally(() => {
      this.pending.delete(tracked)
      this.pendingBytes -= bytes
    })
    if (this.pendingBytes >= WRITE_BACKPRESSURE_BYTES && this.pending.size > 0) {
      return Promise.race(this.pending)
    }
    return undefined
  }

  async drain(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled(this.pending)
    }
  }
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
  queue: WriteQueue
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
  // Keep existing data so a page-refresh mid-transfer doesn't truncate the
  // already-written bytes. The resume bitmap (built from IndexedDB) tells the
  // sender which chunk indexes are still missing; sparse writes here fill
  // exactly those.
  const writable = await fileHandle.createWritable({ keepExistingData: true })
  const handle: OPFSReceiveHandle = { writable, fileHandle, written: new Set(), totalChunks, fileName, queue: new WriteQueue() }
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
  handle.written.add(index)
  const wait = handle.queue.enqueue(
    handle.writable.write({ type: 'write', position: offset, data: new Uint8Array(data) }),
    data.byteLength,
  )
  if (wait) await wait
}

export async function getOPFSFile(transferId: string): Promise<File> {
  const handle = opfsHandles.get(transferId)
  if (!handle) throw new Error('No OPFS handle')
  await handle.queue.drain()
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
  queue: WriteQueue
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
  const wait = handle.queue.enqueue(
    handle.writable.write({ type: 'write', position: offset, data: new Uint8Array(data) }),
    data.byteLength,
  )
  if (wait) await wait
}

export async function finalizeStreamedFile(transferId: string): Promise<File> {
  const handle = writeHandles.get(transferId)
  if (!handle) throw new Error('No write handle')

  await handle.queue.drain()
  await handle.writable.close()
  writeHandles.delete(transferId)

  return handle.fileHandle.getFile()
}

export function cancelStreamWrite(transferId: string) {
  const handle = writeHandles.get(transferId)
  if (handle) {
    handle.writable.close().catch(() => {})
    writeHandles.delete(transferId)
  }
}
