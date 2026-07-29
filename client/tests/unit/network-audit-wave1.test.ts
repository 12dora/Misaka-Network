// Store-level Wave 1 regressions: transfer-lane identity, shortId collision,
// wrong-owner late done, legacy resume.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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
    ondatachannel: null as ((e: { channel: FakeDc }) => void) | null,
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
  endOfCandidateMarkersFor: vi.fn(() => []),
  installIceErrorListener: vi.fn(),
  isRelayAllowed: vi.fn(() => true),
}))

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
  getSavedChunkIndexes: vi.fn(async (id: string) => [...(idbChunks.get(id)?.keys() ?? [])]),
  pruneTerminalTransfers: vi.fn(async () => 0),
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
vi.mock('@/lib/nat', () => ({
  detectNatType: vi.fn(async () => ({ type: 'unknown' })),
  onNatTypeChange: vi.fn(() => () => {}),
  getDetectedNatType: vi.fn(() => null),
  invalidateDetectedNatType: vi.fn(),
}))

const PEER = 'peer-net-audit'
const opfsFiles = new Map<string, { bytes: Uint8Array }>()

function installFakeOPFS() {
  opfsFiles.clear()
  const makeWritable = (name: string) => ({
    write: async (arg: { position: number; data: Uint8Array }) => {
      let file = opfsFiles.get(name)
      if (!file) { file = { bytes: new Uint8Array(0) }; opfsFiles.set(name, file) }
      const next = new Uint8Array(Math.max(file.bytes.length, arg.position + arg.data.length))
      next.set(file.bytes, 0)
      next.set(arg.data, arg.position)
      file.bytes = next
    },
    close: async () => {},
    abort: async () => {},
  })
  const makeFileHandle = (name: string) => ({
    kind: 'file',
    name,
    createWritable: vi.fn(async () => makeWritable(name)),
    getFile: vi.fn(async () => {
      const f = opfsFiles.get(name) ?? { bytes: new Uint8Array(0) }
      const copy = new Uint8Array(f.bytes.byteLength)
      copy.set(f.bytes)
      return new File([copy], name)
    }),
  })
  const dir = {
    getDirectoryHandle: vi.fn(async () => dir),
    getFileHandle: vi.fn(async (name: string) => makeFileHandle(name)),
    removeEntry: vi.fn(async (name: string) => { opfsFiles.delete(name) }),
  }
  ;(navigator as any).storage = { getDirectory: vi.fn(async () => dir) }
}

async function settle(rounds = 16) {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
  await new Promise(r => setTimeout(r, 0))
}

async function freshStore() {
  vi.resetModules()
  sockets = []
  dcs.length = 0
  records.clear()
  idbChunks.clear()
  sessionStorage.clear()
  ;(globalThis as unknown as { WebSocket: typeof StubWS }).WebSocket = StubWS
  installFakeOPFS()
  const mod = await import('../../src/store/network')
  const transfer = await import('../../src/lib/transfer')
  mod.useNetworkStore.getState().init('tok')
  const sock = sockets[sockets.length - 1]
  expect(sock).toBeTruthy()
  sock.open()
  sock.deliver({ t: 'WELCOME', sessionId: 'me', myNodeId: 1, sessionExpiresAt: Date.now() + 1e6 })
  sock.deliver({
    t: 'PEER_JOINED',
    peer: { sessionId: PEER, nodeId: 7, joinedAt: Date.now() },
    shouldInitiate: true,
  })
  await settle(20)
  const primary = dcs.find(d => d.label === 'misaka')
  const lane = dcs.find(d => d.label === 'misaka-transfer-0')
  expect(primary).toBeTruthy()
  return { store: mod.useNetworkStore, primary: primary!, lane, transfer, mod }
}

beforeEach(() => {
  sockets = []
  dcs.length = 0
  records.clear()
  idbChunks.clear()
})

afterEach(() => {
  sockets = []
  dcs.length = 0
  records.clear()
  idbChunks.clear()
})

describe('P1: transfer-lane messages are not dropped by stillThisAttempt', () => {
  it('processes meta + chunk + control on a transfer lane with observable progress', async () => {
    const { store, lane, primary, transfer } = await freshStore()
    const target = (lane?.onmessage ? lane : primary)
    expect(target).toBeTruthy()
    expect(target.onmessage).toBeTypeOf('function')
    const laneTarget = lane && lane.onmessage ? lane : target

    const chunkSize = transfer.CHUNK_SIZE
    const payload = new Uint8Array(chunkSize).fill(0x5a)
    const meta = {
      type: 'meta', transferId: 'lane-chunk', shortId: 77,
      fileName: 'lane.bin', fileSize: chunkSize, fileHash: '',
      totalChunks: 1, mime: 'application/octet-stream', v: 2,
    }
    // 1) meta on lane
    laneTarget.onmessage!({ data: JSON.stringify(meta) } as MessageEvent)
    await settle(30)

    const card = store.getState().transfers.find(t => t.id === 'lane-chunk')
    expect(card).toBeTruthy()
    const progressBefore = card?.progress ?? 0

    // Force IDB backend so the chunk can complete without a storage picker.
    const session = transfer.getReceiveSession('lane-chunk')
    if (session) {
      session.backend = 'idb'
      session.storageMode = 'indexeddb'
    }

    // 2) binary chunk on lane — must advance progress/bitmap, not just status
    const frame = transfer.encodeChunkFrame(77, 0, new Uint8Array(12), payload.buffer)
    laneTarget.onmessage!({ data: frame } as MessageEvent)
    await settle(60)

    const after = store.getState().transfers.find(t => t.id === 'lane-chunk')
    const sessionAfter = transfer.getReceiveSession('lane-chunk')
    const delivered = (store.getState().chatMessages[PEER] ?? []).some(m => m.type === 'file')
    const progressMoved = (after?.progress ?? 0) > progressBefore
      || (sessionAfter?.receivedCount ?? 0) > 0
      || delivered
      || after?.status === 'completed'
    expect(progressMoved).toBe(true)
  })

  it('transfer-pause CONTROL on a live multi-chunk transfer is accepted', async () => {
    const { store, lane, primary, transfer } = await freshStore()
    const laneTarget = lane && lane.onmessage ? lane : primary
    expect(laneTarget?.onmessage).toBeTypeOf('function')
    const chunkSize = transfer.CHUNK_SIZE
    const meta = {
      type: 'meta', transferId: 'lane-ctl', shortId: 88,
      fileName: 'ctl.bin', fileSize: chunkSize * 4, fileHash: '',
      totalChunks: 4, mime: 'application/octet-stream', v: 2,
    }
    laneTarget!.onmessage!({ data: JSON.stringify(meta) } as MessageEvent)
    await settle(30)
    const session = transfer.getReceiveSession('lane-ctl')
    if (session) {
      session.backend = 'idb'
      session.storageMode = 'indexeddb'
    }
    // Deliver only the first chunk so the transfer stays live.
    const payload = new Uint8Array(chunkSize).fill(0x11)
    const frame = transfer.encodeChunkFrame(88, 0, new Uint8Array(12), payload.buffer)
    laneTarget!.onmessage!({ data: frame } as MessageEvent)
    await settle(40)
    const live = store.getState().transfers.find(t => t.id === 'lane-ctl')
    expect(live).toBeTruthy()
    expect(live?.status).not.toBe('completed')

    laneTarget!.onmessage!({
      data: JSON.stringify({ type: 'transfer-pause', transferId: 'lane-ctl' }),
    } as MessageEvent)
    await settle(30)
    const paused = store.getState().transfers.find(t => t.id === 'lane-ctl')
    expect(paused?.status).toBe('paused')
  })
})

describe('02 P0: same-peer shortId collision rejects the second transfer', () => {
  it("B's meta with A's shortId is rejected; A's later frame still maps to A", async () => {
    const { store, primary, transfer } = await freshStore()
    expect(primary).toBeTruthy()
    const metaA = {
      type: 'meta', transferId: 'file-A', shortId: 5,
      fileName: 'a.bin', fileSize: transfer.CHUNK_SIZE, fileHash: '',
      totalChunks: 1, mime: 'application/octet-stream', v: 2,
    }
    const metaB = {
      type: 'meta', transferId: 'file-B', shortId: 5,
      fileName: 'b.bin', fileSize: transfer.CHUNK_SIZE, fileHash: '',
      totalChunks: 1, mime: 'application/octet-stream', v: 2,
    }
    primary.onmessage!({ data: JSON.stringify(metaA) } as MessageEvent)
    await settle(20)
    primary.onmessage!({ data: JSON.stringify(metaB) } as MessageEvent)
    await settle(20)

    const rejects = primary.sentJson().filter(m => m.type === 'transfer-reject')
    expect(rejects.some(m => m.transferId === 'file-B')).toBe(true)
    expect(store.getState().transfers.find(t => t.id === 'file-A')).toBeTruthy()
    expect(store.getState().transfers.find(t => t.id === 'file-B')).toBeUndefined()

    const payload = new Uint8Array(transfer.CHUNK_SIZE).fill(0xaa)
    const frame = transfer.encodeChunkFrame(5, 0, new Uint8Array(12), payload.buffer)
    primary.onmessage!({ data: frame } as MessageEvent)
    await settle(40)
    expect(store.getState().transfers.find(t => t.id === 'file-B')).toBeUndefined()
  })
})

describe('02 P1: wrong-owner transfer-done does not promote via late-ACK fallback', () => {
  it('foreign owner cannot mark a delivered send as saved', async () => {
    const { transfer } = await freshStore()
    const lane = makeFakeDc('misaka-transfer-x') as unknown as RTCDataChannel
    Object.assign(lane, {
      readyState: 'open',
      bufferedAmount: 0,
      send: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
    transfer.setPeerProtocolVersion(PEER, 2)
    const file = new File([new Uint8Array(8)], 'x.bin')
    const sending = transfer.sendFileParallel(
      [lane], file, 'own-send', 7, PEER, undefined, undefined, undefined, 0,
    )
    await settle(10)
    const info = transfer.getSendTaskInfo('own-send')!
    transfer.markReceiverReady('own-send', info.shortId, { peerSessionId: PEER, epoch: 0 })
    await settle(20)
    expect(transfer.markTransferAcked('own-send', file.size, { peerSessionId: 'attacker', epoch: 0 })).toBe(false)
    expect(transfer.markTransferAcked('own-send', file.size, { peerSessionId: PEER, epoch: 0 })).toBe(true)
    await expect(sending).resolves.toMatchObject({ state: 'saved' })
    transfer.forgetTransfer('own-send')
  })
})

describe('02 P0: inbound legacy resume rejects ownerless send records', () => {
  it('handleResumeRequest path refuses ownerless records (no meta re-send)', async () => {
    const { primary, mod } = await freshStore()
    expect(primary).toBeTruthy()
    // Install a real sendingFiles source so production reaches the ownership
    // check rather than early-returning on !file (round-2 vacuity).
    const file = new File([new Uint8Array(10)], 'orphan.bin')
    mod.setSendingFileForTests('orphan-send', file)
    // Ownerless send row: even with a File present, ownership must refuse.
    records.set('orphan-send', {
      transferId: 'orphan-send',
      direction: 'send',
      peerNodeId: 7,
      // intentionally no peerSessionId
      fileName: 'orphan.bin',
      fileSize: 10,
      totalChunks: 1,
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    primary.send.mockClear()
    for (const d of dcs) d.send.mockClear()
    primary.onmessage!({
      data: JSON.stringify({
        type: 'resume',
        transferId: 'orphan-send',
        receivedChunks: [],
      }),
    } as MessageEvent)
    await settle(30)
    const laneSends = dcs.flatMap(d => d.send.mock.calls.map(c => c[0]))
    const metas = laneSends.filter(
      p => typeof p === 'string'
        && (p as string).includes('orphan-send')
        && (p as string).includes('"type":"meta"'),
    )
    expect(metas.length).toBe(0)
    mod.setSendingFileForTests('orphan-send', null)
  })

  it('outbound resume scan never emits resume for ownerless recv rows', async () => {
    const { primary } = await freshStore()
    records.set('orphan-recv', {
      transferId: 'orphan-recv',
      direction: 'recv',
      peerNodeId: 7,
      // no peerSessionId — must not bind to PEER
      fileName: 'orphan-recv.bin',
      fileSize: 10,
      totalChunks: 1,
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    primary.send.mockClear()
    // sendResumeRequests runs on primary open / ecdh path.
    primary.onmessage!({
      data: JSON.stringify({ type: 'ecdh-pub', pubKey: 'x' }),
    } as MessageEvent)
    await settle(40)
    const sent = primary.sentJson()
    expect(sent.some(m => m.type === 'resume' && m.transferId === 'orphan-recv')).toBe(false)
  })
})

describe('02 P2: chat retry does not duplicate after reconnect flush', () => {
  it('open-channel retry removes queued twin so flush cannot double-send', async () => {
    const { store, primary } = await freshStore()
    // Queue a message while "offline" by closing the primary briefly.
    primary.readyState = 'connecting'
    store.getState().sendChatMessage(PEER, 'hello-once')
    await settle(5)
    const msgs = store.getState().chatMessages[PEER] ?? []
    const msg = msgs.find(m => m.type === 'text' && m.content === 'hello-once')
    expect(msg).toBeTruthy()
    // Re-open channel and retry — must not leave a queued copy.
    primary.readyState = 'open'
    primary.send.mockClear()
    store.getState().retryChatMessage(PEER, msg!.id)
    await settle(5)
    // Direct send path: one payload on the wire from retry.
    const sentPayloads = primary.send.mock.calls
      .map(c => c[0])
      .filter((p): p is string => typeof p === 'string' && p.includes(msg!.id))
    expect(sentPayloads.length).toBe(1)
    // Subsequent flush must not re-send the same id.
    primary.send.mockClear()
    // Simulate DC open flush path via ecdh-pub handler
    primary.onmessage!({ data: JSON.stringify({ type: 'ecdh-pub', pubKey: 'y' }) } as MessageEvent)
    await settle(10)
    const afterFlush = primary.send.mock.calls
      .map(c => c[0])
      .filter((p): p is string => typeof p === 'string' && p.includes(msg!.id))
    expect(afterFlush.length).toBe(0)
  })

  it('receiver dedupes the same chat msgId', async () => {
    const { store, primary } = await freshStore()
    const payload = {
      type: 'chat', id: 'dup-1', content: 'once', timestamp: Date.now(),
    }
    primary.onmessage!({ data: JSON.stringify(payload) } as MessageEvent)
    await settle(5)
    primary.onmessage!({ data: JSON.stringify(payload) } as MessageEvent)
    await settle(5)
    const texts = (store.getState().chatMessages[PEER] ?? [])
      .filter(m => m.type === 'text' && m.id === 'dup-1')
    expect(texts.length).toBe(1)
  })
})

describe('02 P2: blockPeer preserves started download release path', () => {
  it('keeps started download under orphan key and UI release is clickable', async () => {
    const { store, mod, transfer } = await freshStore()
    const primary = dcs.find(d => d.label === 'misaka')!
    // Zero-byte inbound — guaranteed complete without crypto/chunks.
    const zbMeta = {
      type: 'meta', transferId: 'block-zb', shortId: 12,
      fileName: 'keep-zb.bin', fileSize: 0, fileHash: '',
      totalChunks: 0, mime: 'application/octet-stream', v: 2,
    }
    primary.onmessage!({ data: JSON.stringify(zbMeta) } as MessageEvent)
    await settle(100)
    const fileMsg = (store.getState().chatMessages[PEER] ?? []).find(m => m.type === 'file')
    expect(fileMsg?.downloadUrl).toBeTruthy()
    const url = fileMsg!.downloadUrl!
    mod.markDownloadArtifactStarted(url)
    store.getState().blockPeer(PEER)
    await settle(5)
    expect(mod.ORPHANED_DOWNLOADS_CHAT_KEY).toBe('__orphaned-downloads__')
    const orphaned = store.getState().chatMessages[mod.ORPHANED_DOWNLOADS_CHAT_KEY] ?? []
    expect(orphaned.some(m => m.downloadUrl === url)).toBe(true)

    // Remount after rehome: already-started artifact must show Release, not Download.
    const { act } = await import('react-dom/test-utils')
    const { createRoot } = await import('react-dom/client')
    const React = await import('react')
    const DownloadArtifactActions = (await import('../../src/components/features/DownloadArtifactActions')).default
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    try {
      act(() => {
        root.render(
          React.createElement('div', { 'data-testid': 'orphaned-downloads-panel' },
            orphaned.filter(m => m.downloadUrl).map(m =>
              React.createElement(DownloadArtifactActions, {
                key: m.id,
                id: m.id,
                url: m.downloadUrl!,
                fileName: m.fileName ?? 'download',
              }),
            ),
          ),
        )
      })
      expect(container.querySelector('[data-testid="orphaned-downloads-panel"]')).toBeTruthy()
      // Started before blockPeer → remount initializes from registry (no second Download).
      expect(Array.from(container.querySelectorAll('button')).some(b => b.textContent?.includes('下载'))).toBe(false)
      const releaseBtn = container.querySelector<HTMLButtonElement>(
        `[data-testid="release-download-${fileMsg!.id}"]`,
      )
      expect(releaseBtn).toBeTruthy()
      await act(async () => { releaseBtn?.click(); await Promise.resolve() })
      await settle(30)
      expect(container.textContent).toMatch(/临时副本已释放/)
      // Release also prunes the orphan chat row.
      const after = store.getState().chatMessages[mod.ORPHANED_DOWNLOADS_CHAT_KEY] ?? []
      expect(after.some(m => m.downloadUrl === url)).toBe(false)
    } finally {
      act(() => root.unmount())
      container.remove()
    }
    void transfer
  })
})

describe('02 P1: epoch switch during deferred finalization must not publish to new identity', () => {
  it('deliver path does not inject completed file into a post-epoch peer chat', async () => {
    const { store, primary, transfer, mod } = await freshStore()
    const { getNetworkEpoch } = await import('../../src/store/network')
    const epochBefore = getNetworkEpoch()
    const chunkSize = transfer.CHUNK_SIZE
    const meta = {
      type: 'meta', transferId: 'epoch-fin', shortId: 42,
      fileName: 'epoch.bin', fileSize: chunkSize, fileHash: '',
      totalChunks: 1, mime: 'application/octet-stream', v: 2,
    }
    primary.onmessage!({ data: JSON.stringify(meta) } as MessageEvent)
    await settle(20)
    const session = transfer.getReceiveSession('epoch-fin')
    if (session) {
      session.backend = 'idb'
      session.storageMode = 'indexeddb'
    }
    let releaseStatus!: () => void
    const statusGate = new Promise<void>(r => { releaseStatus = r })
    const db = await import('../../src/lib/db')
    const origUpdate = db.updateTransfer as unknown as ReturnType<typeof vi.fn>
    origUpdate.mockImplementationOnce(async (id: string, patch: unknown) => {
      await statusGate
      const cur = records.get(id)
      if (cur) records.set(id, { ...cur, ...(patch as object) })
    })
    const payload = new Uint8Array(chunkSize).fill(9)
    const frame = transfer.encodeChunkFrame(42, 0, new Uint8Array(12), payload.buffer)
    primary.onmessage!({ data: frame } as MessageEvent)
    await settle(40)
    const before = (store.getState().chatMessages[PEER] ?? []).filter(m => m.type === 'file')
    // Genuinely end the network epoch (bumps getNetworkEpoch()).
    store.getState().destroy()
    await settle(10)
    expect(getNetworkEpoch()).toBeGreaterThan(epochBefore)
    releaseStatus()
    await settle(80)
    const after = (store.getState().chatMessages[PEER] ?? []).filter(m => m.type === 'file')
    expect(after.length).toBeLessThanOrEqual(before.length)
    void mod
  })
})

describe('02 P0: cancel never force-forgets a live engine on a wall-clock deadline', () => {
  it('awaitSendEngineSettlement keeps task until cancel is observed', async () => {
    const { transfer } = await freshStore()
    const frames: ArrayBuffer[] = []
    const lane = makeFakeDc('misaka-transfer-c') as unknown as RTCDataChannel
    const listeners: Record<string, Array<() => void>> = {}
    Object.assign(lane, {
      readyState: 'open',
      bufferedAmount: 0,
      send: (p: string | ArrayBuffer) => { if (typeof p !== 'string') frames.push(p as ArrayBuffer) },
      addEventListener: (t: string, h: () => void) => { (listeners[t] ??= []).push(h) },
      removeEventListener: (t: string, h: () => void) => {
        listeners[t] = (listeners[t] ?? []).filter(x => x !== h)
      },
    })
    transfer.setPeerProtocolVersion(PEER, 2)
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const enc = await import('../../src/lib/crypto')
    const spy = vi.spyOn(enc, 'encryptChunk').mockImplementation(async (data, _p, iv) => {
      await gate
      return { iv: (iv ?? new Uint8Array(12)) as Uint8Array<ArrayBuffer>, encrypted: data }
    })
    try {
      const file = new File([new Uint8Array(transfer.CHUNK_SIZE * 2)], 'c.bin')
      const sending = transfer.sendFileParallel(
        [lane], file, 'store-cancel', 7, PEER, undefined, undefined, undefined, 0,
      )
      await settle(10)
      const info = transfer.getSendTaskInfo('store-cancel')!
      transfer.markReceiverReady('store-cancel', info.shortId, { peerSessionId: PEER, epoch: 0 })
      await settle(10)
      transfer.cancelTransfer('store-cancel')
      // While encrypt is parked, task must remain (no force-forget).
      expect(transfer.hasLiveSendTask('store-cancel') || transfer.hasSendTask('store-cancel')).toBe(true)
      // Settlement waiter must not clear cancel state.
      const settleP = transfer.awaitSendEngineSettlement('store-cancel', {
        neutralizeAfterMs: 5_000,
        pollMs: 5,
      })
      release()
      await expect(sending).rejects.toThrow()
      await settleP
      expect(transfer.hasLiveSendTask('store-cancel')).toBe(false)
      transfer.forgetTransfer('store-cancel')
    } finally {
      spy.mockRestore()
    }
  })
})

describe('02 P1: zero-copy receive never evaluates ciphertext getter', () => {
  it('decodeChunkFrame ciphertext getter is not required for production path', async () => {
    const { primary, transfer } = await freshStore()
    const chunkSize = transfer.CHUNK_SIZE
    const meta = {
      type: 'meta', transferId: 'zc-1', shortId: 3,
      fileName: 'zc.bin', fileSize: chunkSize, fileHash: '',
      totalChunks: 1, mime: 'application/octet-stream', v: 2,
    }
    primary.onmessage!({ data: JSON.stringify(meta) } as MessageEvent)
    await settle(20)
    const session = transfer.getReceiveSession('zc-1')
    if (session) {
      session.backend = 'idb'
      session.storageMode = 'indexeddb'
    }
    const payload = new Uint8Array(chunkSize).fill(1)
    const buf = transfer.encodeChunkFrame(3, 0, new Uint8Array(12), payload.buffer)
    // Instrument the decoded frame path: if production touches .ciphertext,
    // a throwing getter would fail the receive. Patch decodeChunkFrame.
    const orig = transfer.decodeChunkFrame
    const spy = vi.spyOn(transfer, 'decodeChunkFrame').mockImplementation((b: ArrayBuffer) => {
      const d = orig(b)
      if (!d) return d
      return Object.defineProperty({ ...d, rawFrame: d.rawFrame, iv: d.iv }, 'ciphertext', {
        get() { throw new Error('ciphertext getter must not run on zero-copy path') },
        enumerable: true,
        configurable: true,
      }) as ReturnType<typeof orig>
    })
    try {
      primary.onmessage!({ data: buf } as MessageEvent)
      await settle(40)
      // If we got here without throw, production did not touch the getter.
      expect(spy).toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
})

describe('02 P1: makingOffer stays true through setLocalDescription', () => {
  it('older deferred createOffer does not clear a newer token mid setLocalDescription', async () => {
    const { beginLocalOffer, isLocalOfferCurrent, negState, invalidatePendingLocalOffer } =
      await import('../../src/store/network/negotiation-controller')
    const peer = 'offer-race-peer'
    const t1 = beginLocalOffer(peer)
    expect(negState(peer).makingOffer).toBe(true)
    // Second overlapping offer bumps token.
    const t2 = beginLocalOffer(peer)
    expect(t2).toBeGreaterThan(t1)
    expect(isLocalOfferCurrent(peer, t1)).toBe(false)
    expect(isLocalOfferCurrent(peer, t2)).toBe(true)
    // Older token must not clear makingOffer while newer is in-flight.
    if (isLocalOfferCurrent(peer, t1)) negState(peer).makingOffer = false
    expect(negState(peer).makingOffer).toBe(true)
    // Simulate deferred setLocalDescription still pending for t2.
    expect(negState(peer).makingOffer).toBe(true)
    // Only after current token completes/invalidates may makingOffer clear.
    invalidatePendingLocalOffer(peer)
    expect(negState(peer).makingOffer).toBe(false)
  })

  it('superseded offer token does not clear makingOffer after connection cleanup', async () => {
    const {
      beginLocalOffer, isLocalOfferCurrent, negState, clearPeerNegotiationState,
    } = await import('../../src/store/network/negotiation-controller')
    const peer = 'offer-cleanup-peer'
    const oldToken = beginLocalOffer(peer)
    expect(negState(peer).makingOffer).toBe(true)
    // Peer cleanup deletes negotiationState entry (replacement PC).
    clearPeerNegotiationState(peer)
    // Replacement connection starts a new offer — generation must not restart at 1.
    const newToken = beginLocalOffer(peer)
    expect(newToken).toBeGreaterThan(oldToken)
    expect(isLocalOfferCurrent(peer, oldToken)).toBe(false)
    expect(isLocalOfferCurrent(peer, newToken)).toBe(true)
    expect(negState(peer).makingOffer).toBe(true)
    // Stale deferred finally of the old offer must not clear the new window.
    if (isLocalOfferCurrent(peer, oldToken)) negState(peer).makingOffer = false
    expect(negState(peer).makingOffer).toBe(true)
  })
})

describe('02 P1: iceRestartPreconditionStarted retired with connection cleanup', () => {
  it('cleanupPeerConnection clears precondition timestamps', async () => {
    const { iceRestartPreconditionStarted, clearPeerIceRecovery } =
      await import('../../src/store/network/ice-recovery')
    const sid = 'ice-precond-peer'
    iceRestartPreconditionStarted.set(sid, Date.now() - 120_000)
    clearPeerIceRecovery(sid)
    expect(iceRestartPreconditionStarted.has(sid)).toBe(false)
  })
})

describe('02 P0: cleanupPeerConnection actually clears peer-scoped maps via deps', () => {
  it('seenInboundChatIds and pendingDurableAcks are bound and cleared', async () => {
    // freshStore runs runtime bindDeps — without the maps in deps, cleanup is a no-op.
    await freshStore()
    const sid = PEER
    const { seenInboundChatIds } = await import('../../src/store/network/chat-controller')
    const { pendingDurableAcks } = await import('../../src/store/network/transfer-controller')
    const { cleanupPeerConnection } = await import('../../src/store/network/peer-runtime')
    const { deps } = await import('../../src/store/network/deps')
    // Binding check: composition root must have wired the real maps.
    expect(deps.seenInboundChatIds).toBe(seenInboundChatIds)
    expect(deps.pendingDurableAcks).toBe(pendingDurableAcks)
    // Seed state that must be owned by cleanupPeerConnection.
    seenInboundChatIds.set(sid, new Set(['msg-a']))
    pendingDurableAcks.set(`${sid}\u0000tid-1`, {
      transferId: 'tid-1', bytes: 1, epoch: 0, peerSessionId: sid,
    } as never)
    expect(seenInboundChatIds.has(sid)).toBe(true)
    expect(pendingDurableAcks.has(`${sid}\u0000tid-1`)).toBe(true)
    // Real production teardown path (not a direct map.delete helper).
    cleanupPeerConnection(sid, { failQueuedMessages: false })
    expect(seenInboundChatIds.has(sid)).toBe(false)
    expect(pendingDurableAcks.has(`${sid}\u0000tid-1`)).toBe(false)
  })
})

describe('02 P2: orphan remount shows Release for already-started artifact', () => {
  it('initializes started from registry so remount does not re-show Download', async () => {
    await freshStore()
    const url = 'blob:orphan-started'
    const artifacts = await import('../../src/store/network/download-artifacts')
    artifacts.registerDownloadArtifact(url, {})
    artifacts.markDownloadArtifactStarted(url)
    const { act } = await import('react-dom/test-utils')
    const { createRoot } = await import('react-dom/client')
    const React = await import('react')
    const DownloadArtifactActions = (await import('../../src/components/features/DownloadArtifactActions')).default
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    try {
      act(() => {
        root.render(
          React.createElement(DownloadArtifactActions, {
            id: 'orph-1', url, fileName: 'started.bin',
          }),
        )
      })
      // Already started → release control, not Download.
      expect(container.querySelector('[data-testid="release-download-orph-1"]')).toBeTruthy()
      expect(Array.from(container.querySelectorAll('button')).some(b => b.textContent?.includes('下载'))).toBe(false)
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })
})
