// TEST-006: this file used to re-implement the "ideal" receive ordering by
// hand (call receiveChunk, then call writeChunkToOPFS, then check a latch it
// set itself). That proves nothing about production: if the real handler in
// `store/network.ts` delivered before the write, or took the wrong branch, the
// hand-written sequence still passed.
//
// It now drives the REAL orchestration end to end — the store's DataChannel
// `onmessage`, the real `lib/transfer` engine, a real (in-memory) OPFS backend —
// and asserts the contract that matters:
//
//   * the OPFS write for the LAST chunk is delayed, and delivery (the file
//     chat card + the completed transfer card) must NOT appear until that
//     write has resolved;
//   * the delivered bytes are byte-exact;
//   * a resumed transfer is delivered FROM OPFS, not from an IDB assemble.
//
// BUG-017 is what makes this achievable: the durable write now happens inside
// `receiveChunk`, BEFORE the resume bitmap is set and persisted.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── fake signaling socket ──────────────────────────────────────────────
class StubWS {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  readyState = 0
  onopen: (() => void) | null = null
  onclose: ((ev: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  close = vi.fn(() => { this.readyState = StubWS.CLOSED })
  send = vi.fn()
  constructor(_url: string) { sockets.push(this) }
  open() { this.readyState = StubWS.OPEN; this.onopen?.() }
  deliver(msg: unknown) { this.onmessage?.({ data: JSON.stringify(msg) }) }
}
let sockets: StubWS[] = []

// ── fake peer connection / data channels ───────────────────────────────
interface FakeDc {
  label: string
  readyState: RTCDataChannelState
  binaryType: BinaryType
  bufferedAmount: number
  bufferedAmountLowThreshold: number
  onclose: ((e: Event) => void) | null
  onmessage: ((e: MessageEvent) => void) | null
  close: () => void
  send: ReturnType<typeof vi.fn>
  addEventListener: (t: string, h: (e: Event) => void) => void
  removeEventListener: (t: string, h: (e: Event) => void) => void
  sentJson: () => Array<Record<string, unknown>>
}

const dcs: FakeDc[] = []

function makeFakeDc(label = 'misaka'): FakeDc {
  const listeners: Record<string, Array<(e: Event) => void>> = {}
  const dc: FakeDc = {
    label,
    readyState: 'open',
    binaryType: 'arraybuffer',
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    onclose: null,
    onmessage: null,
    close: () => { dc.readyState = 'closed'; dc.onclose?.(new Event('close')) },
    send: vi.fn(),
    addEventListener: (t, h) => { (listeners[t] ??= []).push(h) },
    removeEventListener: (t, h) => { listeners[t] = (listeners[t] ?? []).filter(x => x !== h) },
    sentJson: () => dc.send.mock.calls
      .map(c => c[0])
      .filter((p): p is string => typeof p === 'string')
      .map(p => { try { return JSON.parse(p) } catch { return {} } }),
  }
  dcs.push(dc)
  return dc
}

function makeFakePc() {
  return {
    connectionState: 'connected' as RTCPeerConnectionState,
    iceConnectionState: 'connected' as RTCIceConnectionState,
    signalingState: 'stable' as RTCSignalingState,
    iceGatheringState: 'new' as RTCIceGatheringState,
    localDescription: null,
    onicecandidate: null,
    oniceconnectionstatechange: null,
    ondatachannel: null,
    createOffer: vi.fn(async () => ({ type: 'offer', sdp: 'x' })),
    setLocalDescription: async () => {},
    close: vi.fn(),
  }
}

vi.mock('@/lib/webrtc', () => ({
  createPeerConnection: () => makeFakePc(),
  createDataChannel: (_pc: unknown, label = 'misaka') => makeFakeDc(label),
  createOffer: vi.fn(async () => ({ type: 'offer', sdp: 'local-offer' })),
  createAnswer: vi.fn(async () => ({ type: 'answer', sdp: 'a' })),
  applyAnswer: vi.fn(async () => {}),
  addIceCandidate: vi.fn(async () => {}),
  getSelectedChannelType: vi.fn(async () => 'direct'),
  getSelectedIcePath: vi.fn(async () => null),
  ensureAutoTurnReady: vi.fn(async () => {}),
  applyIceConfigToAll: vi.fn(() => []),
  whenSignalingStable: vi.fn(async () => {}),
  endOfCandidatesFor: vi.fn(() => ({ candidate: '', sdpMid: '0', sdpMLineIndex: 0 })),
  installIceErrorListener: vi.fn(),
  isRelayAllowed: vi.fn(() => true),
}))

// Pass-through "crypto": byte-exactness of the delivered file is the point,
// and Workers don't exist in jsdom.
vi.mock('@/lib/crypto', () => ({
  generateECDHKeyPair: vi.fn(async () => {}),
  getMyPublicKey: vi.fn(async () => 'pub'),
  setPeerPublicKey: vi.fn(async () => {}),
  resetCrypto: vi.fn(),
  hasAESKey: vi.fn(() => true),
  encryptChunk: vi.fn(async (data: ArrayBuffer) => ({ iv: new Uint8Array(12), encrypted: data })),
  decryptChunk: vi.fn(async (_iv: Uint8Array, encrypted: ArrayBuffer) => encrypted),
  decryptChunkFrame: vi.fn(async (
    _peer: string, frame: ArrayBuffer, _ivOff: number, _ivLen: number,
    cipherOffset: number, cipherLength: number,
  ) => frame.slice(cipherOffset, cipherOffset + cipherLength)),
  makeChunkIv: vi.fn((prefix: Uint8Array, index: number) => {
    const iv = new Uint8Array(12)
    iv.set(prefix.subarray(0, 8), 0)
    new DataView(iv.buffer).setUint32(8, index >>> 0, false)
    return iv
  }),
  randomIvPrefix: vi.fn(() => new Uint8Array(8)),
  deriveTransferIvPrefix: vi.fn(async (prefix: Uint8Array) => prefix.subarray(0, 8)),
  chunkAad: vi.fn(() => new Uint8Array(0)),
}))

// In-memory IndexedDB stand-in shared by the whole file.
const records = new Map<string, any>()
const idbChunks = new Map<string, Map<number, ArrayBuffer>>()
vi.mock('@/lib/db', () => ({
  saveTransfer: vi.fn(async (rec: any) => { records.set(rec.transferId, rec) }),
  updateTransfer: vi.fn(async (id: string, patch: any) => {
    const cur = records.get(id)
    if (cur) records.set(id, { ...cur, ...patch })
  }),
  getTransfer: vi.fn(async (id: string) => records.get(id) ?? null),
  getActiveTransfers: vi.fn(async () => [...records.values()].filter(r => r.status === 'active')),
  deleteTransfer: vi.fn(async (id: string) => { records.delete(id) }),
  saveChunk: vi.fn(async (id: string, idx: number, data: ArrayBuffer) => {
    let m = idbChunks.get(id); if (!m) { m = new Map(); idbChunks.set(id, m) }
    m.set(idx, data)
  }),
  getChunk: vi.fn(async (id: string, idx: number) => idbChunks.get(id)?.get(idx) ?? null),
  deleteChunks: vi.fn(async (id: string) => { idbChunks.delete(id) }),
  getSavedChunkIndexes: vi.fn(async (id: string) =>
    [...(idbChunks.get(id)?.keys() ?? [])].sort((a, b) => a - b)),
  pruneTerminalTransfers: vi.fn(async () => 0),
  isTerminalStatus: vi.fn(() => false),
}))

vi.mock('@/lib/nat', () => ({
  detectNatType: vi.fn(async () => ({ type: 'unknown' })),
  onNatTypeChange: vi.fn(() => () => {}),
  getDetectedNatType: vi.fn(() => null),
  invalidateDetectedNatType: vi.fn(),
}))
vi.mock('@/lib/sound', () => ({ playSound: vi.fn() }))
vi.mock('@/lib/notify', () => ({ notifyIncomingFile: vi.fn() }))
vi.mock('@/lib/turn', () => ({
  refreshAutoTurn: vi.fn(async () => []),
  clearAutoTurn: vi.fn(),
  onTurnConfigChange: vi.fn(() => () => {}),
  fetchTurnStatus: vi.fn(async () => null),
  getAutoTurnState: vi.fn(() => null),
  loadTurnSettings: vi.fn(() => ({ servers: [], enabled: false, forceRelay: false })),
}))

// ── in-memory OPFS with a controllable write latch ─────────────────────
interface OpfsFile { bytes: Uint8Array }
const opfsFiles = new Map<string, OpfsFile>()
/** Resolvers for writes we deliberately hold open. */
let heldWrites: Array<() => void> = []
/** Predicate deciding which writes are held. */
let holdWrite: (position: number, length: number) => boolean = () => false

function installFakeOPFS() {
  const makeWritable = (name: string) => ({
    async write(chunk: { type: string; position: number; data: Uint8Array }) {
      const file = opfsFiles.get(name) ?? { bytes: new Uint8Array(0) }
      opfsFiles.set(name, file)
      const end = chunk.position + chunk.data.byteLength
      if (file.bytes.byteLength < end) {
        const grown = new Uint8Array(end)
        grown.set(file.bytes)
        file.bytes = grown
      }
      if (holdWrite(chunk.position, chunk.data.byteLength)) {
        await new Promise<void>(resolve => { heldWrites.push(resolve) })
      }
      file.bytes.set(chunk.data, chunk.position)
    },
    async close() {},
    async seek() {},
    async truncate() {},
  })
  const makeFileHandle = (name: string) => ({
    kind: 'file',
    name,
    createWritable: vi.fn(async () => makeWritable(name)),
    getFile: vi.fn(async () => {
      const f = opfsFiles.get(name) ?? { bytes: new Uint8Array(0) }
      return new File([f.bytes.buffer.slice(f.bytes.byteOffset, f.bytes.byteOffset + f.bytes.byteLength) as ArrayBuffer], name)
    }),
  })
  const dir = {
    getDirectoryHandle: vi.fn(async () => dir),
    getFileHandle: vi.fn(async (name: string) => makeFileHandle(name)),
    removeEntry: vi.fn(async (name: string) => { opfsFiles.delete(name) }),
    [Symbol.asyncIterator]: async function* () { /* empty */ },
  }
  ;(navigator as any).storage = { getDirectory: vi.fn(async () => dir) }
}

// ── harness ────────────────────────────────────────────────────────────
const PEER = 'peer-1'
let origStorage: unknown
let origCreateURL: unknown
// The terminal completion API deletes the OPFS entry once the File exists
// (BUG-018), so byte-exactness is asserted against the delivered artefact.
let deliveredBlobs: Blob[] = []

async function freshStore() {
  vi.resetModules()
  sockets = []
  dcs.length = 0
  records.clear()
  idbChunks.clear()
  opfsFiles.clear()
  heldWrites = []
  holdWrite = () => false
  sessionStorage.clear()
  ;(globalThis as unknown as { WebSocket: typeof StubWS }).WebSocket = StubWS
  installFakeOPFS()
  const mod = await import('../../src/store/network')
  const transfer = await import('../../src/lib/transfer')
  mod.useNetworkStore.getState().init('tok')
  const sock = sockets[sockets.length - 1]
  sock.open()
  sock.deliver({ t: 'WELCOME', sessionId: 'me', myNodeId: 1, sessionExpiresAt: Date.now() + 1e6 })
  sock.deliver({
    t: 'PEER_JOINED',
    peer: { sessionId: PEER, nodeId: 7, joinedAt: Date.now() },
    shouldInitiate: true,
  })
  await settle()
  const primary = dcs.find(d => d.label === 'misaka')!
  return { store: mod.useNetworkStore, releaseDownloadArtifact: mod.releaseDownloadArtifact, primary, transfer }
}

async function settle(rounds = 12) {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
  await new Promise(r => setTimeout(r, 0))
}

beforeEach(() => {
  origStorage = (navigator as any).storage
  origCreateURL = (URL as any).createObjectURL
  deliveredBlobs = []
  ;(URL as any).createObjectURL = vi.fn((b: Blob) => { deliveredBlobs.push(b); return 'blob:stub' })
  ;(URL as any).revokeObjectURL = vi.fn()
})

afterEach(() => {
  if (origStorage === undefined) delete (navigator as any).storage
  else (navigator as any).storage = origStorage
  ;(URL as any).createObjectURL = origCreateURL
})

const CHUNKS = 3

function buildPayload(chunkSize: number) {
  const chunks: Uint8Array[] = []
  for (let i = 0; i < CHUNKS; i++) {
    const b = new Uint8Array(chunkSize)
    for (let j = 0; j < chunkSize; j++) b[j] = (i * 37 + j) & 0xff
    chunks.push(b)
  }
  const whole = new Uint8Array(chunkSize * CHUNKS)
  chunks.forEach((c, i) => whole.set(c, i * chunkSize))
  return { chunks, whole }
}

describe('TEST-006: production receive orchestration must not deliver before the disk write lands', () => {
  it('holds delivery until the LAST OPFS write resolves, then delivers byte-exact', async () => {
    const { store, releaseDownloadArtifact, primary, transfer } = await freshStore()
    const { chunks, whole } = buildPayload(transfer.CHUNK_SIZE)
    const meta = {
      type: 'meta', transferId: 'opfs-order', shortId: 11,
      fileName: 'ordered.bin', fileSize: whole.byteLength, fileHash: '',
      totalChunks: CHUNKS, mime: 'application/octet-stream', v: 2,
    }

    primary.onmessage!({ data: JSON.stringify(meta) } as MessageEvent)
    await settle()

    // The store must have committed OPFS and ACKed `transfer-ready` BEFORE any
    // payload — that is BUG-011's contract, and this test depends on it.
    const card = store.getState().transfers.find(t => t.id === 'opfs-order')
    expect(card?.storageMode).toBe('opfs')
    expect(primary.sentJson()).toContainEqual(
      expect.objectContaining({ type: 'transfer-ready', transferId: 'opfs-order' }),
    )

    // Hold the LAST chunk's write open.
    const lastOffset = (CHUNKS - 1) * transfer.CHUNK_SIZE
    holdWrite = (position) => position === lastOffset

    for (let i = 0; i < CHUNKS; i++) {
      const frame = transfer.encodeChunkFrame(11, i, new Uint8Array(12), chunks[i].buffer.slice(0) as ArrayBuffer)
      void primary.onmessage!({ data: frame } as MessageEvent)
      await settle()
    }

    // The final write is parked. Delivery MUST NOT have happened: no file card
    // in chat, transfer not completed. This is the exact ordering the old
    // hand-rolled test only simulated.
    expect(heldWrites.length).toBe(1)
    const chatBefore = store.getState().chatMessages[PEER] ?? []
    expect(chatBefore.some(m => m.type === 'file')).toBe(false)
    expect(store.getState().transfers.find(t => t.id === 'opfs-order')?.status)
      .not.toBe('completed')

    // Release the write → delivery may now proceed.
    heldWrites.forEach(r => r())
    heldWrites = []
    await settle(40)

    const chatAfter = store.getState().chatMessages[PEER] ?? []
    const fileCard = chatAfter.find(m => m.type === 'file')
    expect(fileCard).toBeTruthy()
    expect(fileCard!.fileSize).toBe(whole.byteLength)
    expect(store.getState().transfers.find(t => t.id === 'opfs-order')?.status).toBe('completed')

    // Byte-exact: the delivered artefact is precisely what was sent.
    expect(deliveredBlobs.length).toBeGreaterThan(0)
    const delivered = new Uint8Array(await deliveredBlobs[deliveredBlobs.length - 1].arrayBuffer())
    expect(Array.from(delivered)).toEqual(Array.from(whole))

    // The lazy OPFS-backed File must remain readable until the user-facing URL
    // is released; deleting it during finalize cancels real browser downloads.
    expect(opfsFiles.has('opfs-order-ordered.bin')).toBe(true)
    await releaseDownloadArtifact(fileCard!.downloadUrl!)
    await settle()
    expect(opfsFiles.has('opfs-order-ordered.bin')).toBe(false)
    expect(records.get('opfs-order')?.status).toBe('completed')

    // BUG-016: the receiver ACKed a durable write so the sender may say "saved".
    expect(primary.sentJson()).toContainEqual(
      expect.objectContaining({ type: 'transfer-done', transferId: 'opfs-order', bytes: whole.byteLength }),
    )
  })

  it('a resumed transfer is delivered FROM OPFS, not re-assembled from IndexedDB', async () => {
    const { store, primary, transfer } = await freshStore()
    const { chunks, whole } = buildPayload(transfer.CHUNK_SIZE)
    const id = 'opfs-resume'
    const fileName = 'resumed.bin'

    // Simulate the pre-reload state: chunks 0..1 already on disk in OPFS and
    // recorded in the resume bitmap. NOTHING is in IndexedDB — an OPFS receive
    // never writes there, which is exactly why the old `opfsWrittenCount` gate
    // fell through to the IDB assemble and threw "Missing chunk 0".
    const preloaded = new Uint8Array(whole.byteLength)
    preloaded.set(chunks[0], 0)
    preloaded.set(chunks[1], transfer.CHUNK_SIZE)
    opfsFiles.set(`${id}-${fileName}`, { bytes: preloaded })
    const bitmap = new Uint8Array(1)
    bitmap[0] = 0b011
    records.set(id, {
      transferId: id, direction: 'recv', peerNodeId: 7, peerSessionId: PEER, epoch: 0,
      fileName, fileSize: whole.byteLength, fileHash: '', totalChunks: CHUNKS,
      receivedChunks: [], receivedBitmap: bitmap.buffer.slice(0),
      status: 'active', createdAt: 0, updatedAt: 0,
    })

    primary.onmessage!({ data: JSON.stringify({
      type: 'meta', transferId: id, shortId: 22, fileName,
      fileSize: whole.byteLength, fileHash: '', totalChunks: CHUNKS,
      mime: 'application/octet-stream', v: 2,
    }) } as MessageEvent)
    await settle()

    // Only the missing chunk is re-shipped.
    const frame = transfer.encodeChunkFrame(22, 2, new Uint8Array(12), chunks[2].buffer.slice(0) as ArrayBuffer)
    void primary.onmessage!({ data: frame } as MessageEvent)
    await settle(40)

    const fileCard = (store.getState().chatMessages[PEER] ?? []).find(m => m.type === 'file')
    expect(fileCard).toBeTruthy()
    // The delivered artefact is the full file even though IndexedDB never held
    // a single chunk of it.
    expect(fileCard!.fileSize).toBe(whole.byteLength)
    expect(idbChunks.get(id)).toBeUndefined()
    expect(store.getState().transfers.find(t => t.id === id)?.status).toBe('completed')
  })
})
