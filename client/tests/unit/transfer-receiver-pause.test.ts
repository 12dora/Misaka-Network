// TEST-009 + BUG-013: the receiver-side pause used to be tested by asserting
// that paused chunks were DROPPED and never came back — i.e. the test pinned
// irreversible data loss as the expected behaviour, and never went through the
// control plane at all (no paired channel, no store, no final completion).
//
// This rewrite drives the real thing:
//
//   * a real `sendFileParallel` engine on one side and the real store receive
//     orchestration on the other, wired together by a paired DataChannel;
//   * pause is issued through the STORE, travels as `transfer-pause` over the
//     wire, and is applied to the sender through the same exported engine API
//     that `store/network.ts` uses;
//   * chunks already in the SCTP queue when the pause lands are delivered
//     while paused — they must be RECORDED as missing, not silently lost;
//   * resume emits `transfer-repair`, the SAME live send task re-queues exactly
//     those indexes (never a second engine — BUG-014), and the transfer
//     completes BYTE-EXACT;
//   * a cancel tears both sides down.
//
// The two peers are two independent module registries (`vi.resetModules()`
// between imports), so the sender's control signals and the receiver's are not
// the same objects — a message really has to cross the wire to have an effect.

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

// Every JSON payload the RECEIVER put on the wire, in order.
let receiverUplink: Array<Record<string, unknown>> = []

interface FakeDc {
  label: string
  readyState: RTCDataChannelState
  binaryType: BinaryType
  bufferedAmount: number
  bufferedAmountLowThreshold: number
  onclose: ((e: Event) => void) | null
  onmessage: ((e: MessageEvent) => void) | null
  close: () => void
  send: (payload: string | ArrayBuffer) => void
  addEventListener: (t: string, h: (e: Event) => void) => void
  removeEventListener: (t: string, h: (e: Event) => void) => void
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
    send: (payload) => {
      if (typeof payload !== 'string') return
      try { receiverUplink.push(JSON.parse(payload)) } catch { /* not JSON */ }
    },
    addEventListener: (t, h) => { (listeners[t] ??= []).push(h) },
    removeEventListener: (t, h) => { listeners[t] = (listeners[t] ?? []).filter(x => x !== h) },
  }
  dcs.push(dc)
  return dc
}

vi.mock('@/lib/webrtc', () => ({
  createPeerConnection: () => ({
    connectionState: 'connected', iceConnectionState: 'connected',
    signalingState: 'stable', iceGatheringState: 'new', localDescription: null,
    onicecandidate: null, oniceconnectionstatechange: null, ondatachannel: null,
    createOffer: vi.fn(async () => ({ type: 'offer', sdp: 'x' })),
    setLocalDescription: async () => {},
    close: vi.fn(),
  }),
  createDataChannel: (_pc: unknown, label = 'misaka') => makeFakeDc(label),
  createOffer: vi.fn(async () => ({ type: 'offer', sdp: 'o' })),
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

// ── harness ────────────────────────────────────────────────────────────
const PEER = 'peer-1'
const TRANSFER_ID = 'pause-repair'
const CHUNKS = 6

type TransferMod = typeof import('../../src/lib/transfer')

async function settle(rounds = 12) {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
  await new Promise(r => setTimeout(r, 0))
}

interface Rig {
  store: typeof import('../../src/store/network')['useNetworkStore']
  receiverPrimary: FakeDc
  sender: TransferMod
  /** Frames the sender handed to SCTP but that have not been delivered yet. */
  wire: ArrayBuffer[]
  /** Deliver everything currently queued on the wire. */
  pump: () => Promise<void>
  /** Route everything the receiver said back into the sender engine. */
  drainUplink: () => void
  lanes: FakeDc[]
  source: Uint8Array
  file: File
}

async function buildRig(): Promise<Rig> {
  vi.resetModules()
  sockets = []
  dcs.length = 0
  receiverUplink = []
  records.clear()
  idbChunks.clear()
  sessionStorage.clear()
  ;(globalThis as unknown as { WebSocket: typeof StubWS }).WebSocket = StubWS

  // ── receiver: the real store ──
  const storeMod = await import('../../src/store/network')
  storeMod.useNetworkStore.getState().init('tok')
  const sock = sockets[sockets.length - 1]
  sock.open()
  sock.deliver({ t: 'WELCOME', sessionId: 'me', myNodeId: 1, sessionExpiresAt: Date.now() + 1e6 })
  sock.deliver({
    t: 'PEER_JOINED',
    peer: { sessionId: PEER, nodeId: 7, joinedAt: Date.now() },
    shouldInitiate: true,
  })
  await settle()
  const receiverPrimary = dcs.find(d => d.label === 'misaka')!

  // ── sender: a SEPARATE module registry, so its transfer signals, owner
  //    records and live-task map are genuinely a different peer's state ──
  vi.resetModules()
  const sender = await import('../../src/lib/transfer') as TransferMod
  sender.setPeerProtocolVersion(PEER, 2)

  const chunkSize = sender.CHUNK_SIZE
  const source = new Uint8Array(chunkSize * CHUNKS)
  for (let i = 0; i < source.length; i++) source[i] = (i * 131 + (i >> 8)) & 0xff
  const file = new File([source], 'paired.bin', { type: 'application/octet-stream' })

  const wire: ArrayBuffer[] = []
  const lanes: FakeDc[] = []
  for (let i = 0; i < 2; i++) {
    const lane = makeFakeDc(`misaka-transfer-${i}`)
    lane.send = (payload: string | ArrayBuffer) => {
      if (typeof payload === 'string') {
        // Control/meta frames are delivered immediately, like SCTP would.
        void receiverPrimary.onmessage?.({ data: payload } as MessageEvent)
      } else {
        wire.push(payload)
      }
    }
    lanes.push(lane)
  }

  const pump = async () => {
    while (wire.length > 0) {
      const frame = wire.shift()!
      await receiverPrimary.onmessage?.({ data: frame } as MessageEvent)
      await settle(4)
    }
    await settle(8)
  }

  // Stand-in for the sender's `store/network.ts` control-plane dispatcher:
  // exactly the exported engine calls that file makes, ownership included.
  const owner = { peerSessionId: PEER, epoch: 0 }
  const drainUplink = () => {
    const pending = receiverUplink
    receiverUplink = []
    for (const msg of pending) {
      switch (msg.type) {
        case 'transfer-ready':
          sender.markReceiverReady(
            String(msg.transferId),
            Number(msg.shortId),
            owner,
          ); break
        case 'transfer-pause':
          sender.applyPeerPause(String(msg.transferId), owner); break
        case 'transfer-resume':
          sender.applyPeerResume(String(msg.transferId), owner); break
        case 'transfer-repair':
          sender.applyRepairRequest(msg as never, owner); break
        case 'transfer-cancel':
          sender.applyPeerCancel(String(msg.transferId), owner); break
        case 'transfer-done':
          sender.markTransferAcked(
            String(msg.transferId),
            Number(msg.bytes),
            owner,
          ); break
        default: break
      }
    }
  }

  return {
    store: storeMod.useNetworkStore,
    receiverPrimary, sender, wire, pump, drainUplink, lanes, source, file,
  }
}

let origCreateURL: unknown
// Every artefact the store handed to the user. `finalizeReceive` deletes the
// IDB chunk rows as part of terminal cleanup (BUG-018), so this is where the
// byte-exact comparison has to read the delivered file from.
let deliveredBlobs: Blob[] = []

beforeEach(() => {
  origCreateURL = (URL as any).createObjectURL
  deliveredBlobs = []
  ;(URL as any).createObjectURL = vi.fn((b: Blob) => { deliveredBlobs.push(b); return 'blob:stub' })
  ;(URL as any).revokeObjectURL = vi.fn()
  // No OPFS / FSA in this rig → the receiver commits the IndexedDB backend,
  // which lets the test read the persisted bytes back chunk by chunk.
  delete (navigator as any).storage
})
afterEach(() => { (URL as any).createObjectURL = origCreateURL })

describe('TEST-009: receiver pause is coherent, repairable and byte-exact', () => {
  it('pauses in flight, repairs the dropped chunks and completes byte-exact', async () => {
    const rig = await buildRig()
    let outcome: Awaited<ReturnType<TransferMod['sendFileParallel']>> | undefined
    let sendError: unknown

    const sending = rig.sender.sendFileParallel(
      rig.lanes as unknown as RTCDataChannel[], rig.file, TRANSFER_ID, 7, PEER,
      undefined, undefined, undefined, 0,
    ).then(r => { outcome = r }).catch(e => { sendError = e })

    // meta crosses immediately; the receiver must commit a backend and ACK
    // `transfer-ready` before the engine ships a single chunk (BUG-011).
    await settle(20)
    expect(receiverUplink.some(m => m.type === 'transfer-ready')).toBe(true)
    expect(rig.wire.length).toBe(0)   // nothing shipped before the ACK
    rig.drainUplink()
    await settle(30)

    // Let the first two chunks land.
    const chunkBytes = rig.source.length / CHUNKS
    for (let i = 0; i < 2 && rig.wire.length > 0; i++) {
      const frame = rig.wire.shift()!
      await rig.receiverPrimary.onmessage?.({ data: frame } as MessageEvent)
      await settle(4)
    }
    const receivedBeforePause = idbChunks.get(TRANSFER_ID)!.size
    expect(receivedBeforePause).toBeGreaterThan(0)

    // ── PAUSE through the store's control plane ──
    rig.store.getState().pauseReceiveTransfer(TRANSFER_ID)
    await settle()
    expect(receiverUplink.some(m => m.type === 'transfer-pause')).toBe(true)
    // Everything already handed to SCTP still arrives. Under the old
    // behaviour these were dropped and forgotten; now they must be RECORDED
    // as missing so the repair can ask for them back.
    const inFlight = rig.wire.length
    expect(inFlight).toBeGreaterThan(0)
    await rig.pump()

    // Coherent stop: not one byte was persisted after the pause took effect.
    expect(idbChunks.get(TRANSFER_ID)!.size).toBe(receivedBeforePause)
    expect(receivedBeforePause).toBeLessThan(CHUNKS)

    rig.drainUplink()   // sender parks
    await settle(20)

    // ── RESUME through the store: emits transfer-resume AND transfer-repair ──
    await rig.store.getState().resumeReceiveTransfer(TRANSFER_ID)
    await settle()
    expect(receiverUplink.some(m => m.type === 'transfer-resume')).toBe(true)
    const repair = receiverUplink.find(m => m.type === 'transfer-repair') as
      { missingRanges: Array<[number, number]> } | undefined
    expect(repair).toBeTruthy()
    expect(repair!.missingRanges.length).toBeGreaterThan(0)

    // BUG-014: applying the repair must reuse the ONE live task.
    expect(rig.sender.hasLiveSendTask(TRANSFER_ID)).toBe(true)
    rig.drainUplink()

    // Drain until the sender finishes (repair rounds included).
    for (let round = 0; round < 40 && outcome === undefined && sendError === undefined; round++) {
      await rig.pump()
      rig.drainUplink()
      await settle(6)
    }
    await sending

    expect(sendError).toBeUndefined()
    // BUG-016: the receiver's durable-write ACK is what promotes the send to
    // `saved`. A pause that lost chunks forever could never get here.
    expect(outcome).toMatchObject({ state: 'saved', acked: true })

    // ── byte-exact ──
    // The terminal completion API deletes the chunk rows once the file exists
    // (BUG-018), so the artefact itself is what we compare.
    expect(deliveredBlobs.length).toBeGreaterThan(0)
    const delivered = new Uint8Array(await deliveredBlobs[deliveredBlobs.length - 1].arrayBuffer())
    expect(delivered.length).toBe(rig.source.length)
    expect(Array.from(delivered)).toEqual(Array.from(rig.source))
    void chunkBytes

    // Receiver-side terminal state.
    expect(rig.store.getState().transfers.find(t => t.id === TRANSFER_ID)?.status).toBe('completed')
    const fileCard = (rig.store.getState().chatMessages[PEER] ?? []).find(m => m.type === 'file')
    expect(fileCard?.fileSize).toBe(rig.source.length)
  }, 30_000)

  it('a cancel mid-transfer tears down BOTH sides', async () => {
    const rig = await buildRig()
    let sendError: unknown
    const sending = rig.sender.sendFileParallel(
      rig.lanes as unknown as RTCDataChannel[], rig.file, TRANSFER_ID, 7, PEER,
      undefined, undefined, undefined, 0,
    ).catch(e => { sendError = e })

    await settle(20)
    rig.drainUplink()
    await settle(30)

    // One chunk lands, then the receiver cancels through the store.
    if (rig.wire.length > 0) {
      await rig.receiverPrimary.onmessage?.({ data: rig.wire.shift()! } as MessageEvent)
      await settle(4)
    }
    rig.store.getState().cancelReceiveTransfer(TRANSFER_ID)
    await settle()

    expect(receiverUplink.some(m => m.type === 'transfer-cancel')).toBe(true)
    rig.drainUplink()

    for (let round = 0; round < 20 && sendError === undefined; round++) {
      await rig.pump()
      rig.drainUplink()
      await settle(6)
    }
    await sending

    // Sender aborted with the dedicated cancellation error, not a fake success.
    expect(sendError).toBeInstanceOf(rig.sender.TransferCancelledError)
    expect(rig.sender.hasLiveSendTask(TRANSFER_ID)).toBe(false)

    // Receiver: card gone, chunk rows reaped, no receive session left.
    expect(rig.store.getState().transfers.find(t => t.id === TRANSFER_ID)).toBeUndefined()
    await settle(10)
    expect(idbChunks.get(TRANSFER_ID)).toBeUndefined()
  }, 30_000)
})
