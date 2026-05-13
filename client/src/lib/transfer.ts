import { createSHA256 } from 'hash-wasm'
import {
  saveTransfer, updateTransfer, getTransfer, getActiveTransfers,
  saveChunk, getChunk, deleteChunks, getSavedChunkIndexes,
  type TransferRecord,
} from './db'
import { encryptChunk, decryptChunk } from './crypto'

export const CHUNK_SIZE = 64 * 1024

const HIGH_WATER_MARK = 16 * 1024 * 1024
const LOW_WATER_MARK = 4 * 1024 * 1024

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

export async function sendFile(
  dc: RTCDataChannel,
  file: File,
  transferId: string,
  peerNodeId: number,
  existingRecord?: TransferRecord, // for resume
  callbacks?: SendCallbacks,
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

  // Send metadata (skip if resuming — peer already has it)
  if (!existingRecord) {
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

  const savedIndexes = existingRecord ? await getSavedChunkIndexes(transferId) : []
  const skipSet = new Set(existingRecord?.receivedChunks ?? savedIndexes)

  let sent = skipSet.size
  callbacks?.onProgress?.(sent, totalChunks)

  for (let i = 0; i < totalChunks; i++) {
    if (skipSet.has(i)) continue

    const start = i * CHUNK_SIZE
    const end = Math.min(start + CHUNK_SIZE, file.size)
    const raw = await file.slice(start, end).arrayBuffer()

    // Encrypt
    const { iv, encrypted } = await encryptChunk(raw)
    const checksum = await computeChunkChecksum(encrypted)

    // Send header as text
    dc.send(JSON.stringify({
      type: 'chunk',
      transferId,
      index: i,
      total: totalChunks,
      checksum,
    } satisfies ChunkHeader))

    // Pack iv + encrypted into one binary message
    const packet = new Uint8Array(12 + encrypted.byteLength)
    packet.set(iv, 0)
    packet.set(new Uint8Array(encrypted), 12)

    // Flow control: wait if buffer is full
    await waitForBuffer(dc)
    dc.send(packet.buffer)

    sent++
    callbacks?.onProgress?.(sent, totalChunks)

    // Persist chunk in IndexedDB
    await saveChunk(transferId, i, encrypted)
    await updateTransfer(transferId, { receivedChunks: [...skipSet, ...range(0, i + 1)].filter(x => skipSet.has(x) || x <= i) })
  }

  await updateTransfer(transferId, { status: 'completed' })
}

// ── Receive file ─────────────────────────────────────────────────────

export interface ReceiveCallbacks {
  onMeta?: (meta: MetaMessage) => void
  onProgress?: (received: number, total: number) => void
  onComplete?: (file: File) => void
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
  direction: 'recv'
}

const receiveSessions = new Map<string, ReceiveSession>()

export function getReceiveSession(transferId: string): ReceiveSession | undefined {
  return receiveSessions.get(transferId)
}

export async function handleMetaMessage(msg: MetaMessage, peerNodeId: number): Promise<ReceiveSession> {
  const session: ReceiveSession = {
    transferId: msg.transferId,
    fileName: msg.fileName,
    fileSize: msg.fileSize,
    fileHash: msg.fileHash,
    totalChunks: msg.totalChunks,
    mime: msg.mime,
    received: new Set(),
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
  callbacks?: ReceiveCallbacks,
) {
  const session = receiveSessions.get(transferId)
  if (!session) return

  // Verify checksum
  const actualChecksum = await computeChunkChecksum(encrypted)
  if (actualChecksum !== header.checksum) {
    callbacks?.onError?.('Chunk checksum mismatch')
    return
  }

  // Decrypt
  const decrypted = await decryptChunk(iv, encrypted)

  // Save to IndexedDB
  await saveChunk(transferId, header.index, decrypted)

  session.received.add(header.index)

  await updateTransfer(transferId, {
    receivedChunks: Array.from(session.received).sort((a, b) => a - b),
    updatedAt: Date.now(),
  })

  callbacks?.onProgress?.(session.received.size, session.totalChunks)

  // Return ACK to sender
  return {
    type: 'ack' as const,
    transferId,
    index: header.index,
  } satisfies AckMessage
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
  const chunks = await getSavedChunkIndexes(transferId)
  return {
    type: 'resume',
    transferId,
    receivedChunks: chunks,
  }
}

// ── Flow control ─────────────────────────────────────────────────────

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

function range(start: number, end: number): number[] {
  const arr: number[] = []
  for (let i = start; i < end; i++) arr.push(i)
  return arr
}

export function createTransferId(): string {
  return crypto.randomUUID()
}

export async function checkForResumableTransfers(): Promise<TransferRecord[]> {
  return getActiveTransfers()
}
