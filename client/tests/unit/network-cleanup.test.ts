// Regression for: "局域网两台设备链接后，点击发送消息后即显示重新协商中".
//
// Root cause: cleanupPeerConnection() closes the primary DataChannel before
// the RTCPeerConnection. The onclose handler installed in setupDataChannel
// (network.ts) saw pc.connectionState !== 'closed' (we hadn't reached the
// pc.close() line yet) and called attemptIceRestart(), which flipped the peer
// status to 'reconnecting' — the very banner the user reported seeing the
// moment they tapped "发送".
//
// Any code path that triggered an intentional cleanup (recoverConnections on
// focus/visibility events, ensureConnectedInner finding a stale dc, blockPeer,
// PEER_LEFT) hit the same bug.
//
// The fix: dc.onclose = null before dc.close() (and the same for transfer
// lanes). This test pins that contract down by importing network.ts with
// mocked WebRTC modules, grabbing the actual data-channel instance the store
// hands out, calling cleanup via the public recoverConnections() entry point,
// and asserting the peer's status never flips to 'reconnecting'.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Module-level mock state ────────────────────────────────────────────
// signaling.ts: capture handler registrations so the test can fire
// PEER_JOINED directly into the store.

interface SignalingHandlers {
  message: Array<(msg: unknown) => void>
  connect: Array<() => void>
  disconnect: Array<() => void>
  sent: unknown[]
}

const signalingHandlers: SignalingHandlers = {
  message: [],
  connect: [],
  disconnect: [],
  sent: [],
}

vi.mock('@/lib/signaling', () => ({
  onMessage: (h: (msg: unknown) => void) => { signalingHandlers.message.push(h); return () => {} },
  onConnect: (h: () => void) => { signalingHandlers.connect.push(h); return () => {} },
  onDisconnect: (h: () => void) => { signalingHandlers.disconnect.push(h); return () => {} },
  connect: vi.fn(),
  disconnect: vi.fn(),
  send: (msg: unknown) => { signalingHandlers.sent.push(msg) },
  reconnectNow: vi.fn(),
}))

interface FakeDc {
  label: string
  readyState: RTCDataChannelState
  binaryType: BinaryType
  onclose: ((e: Event) => void) | null
  onmessage: ((e: MessageEvent) => void) | null
  close: () => void
  send: (data: string | ArrayBuffer) => void
  addEventListener: (type: string, handler: (e: Event) => void) => void
  removeEventListener: (type: string, handler: (e: Event) => void) => void
  dispatchEvent: (e: Event) => boolean
}

interface FakePc {
  connectionState: RTCPeerConnectionState
  iceConnectionState: RTCIceConnectionState
  signalingState: RTCSignalingState
  localDescription: { type: string; sdp: string; toJSON: () => unknown } | null
  onicecandidate: ((e: Event) => void) | null
  oniceconnectionstatechange: (() => void) | null
  ondatachannel: ((e: Event) => void) | null
  createOffer: (opts?: unknown) => Promise<{ type: string; sdp: string }>
  setLocalDescription: (desc: unknown) => Promise<void>
  close: () => void
}

// Test-visible registry so we can grab the DC the store actually wired up
// and simulate a stale-channel state from outside.
const created: { pcs: FakePc[]; dcs: FakeDc[] } = { pcs: [], dcs: [] }

function makeFakeDc(label = 'misaka'): FakeDc {
  const listeners: Record<string, Array<(e: Event) => void>> = {}
  const dc: FakeDc = {
    label,
    readyState: 'open',
    binaryType: 'arraybuffer',
    onclose: null,
    onmessage: null,
    close: () => {
      dc.readyState = 'closed'
      if (dc.onclose) dc.onclose(new Event('close'))
      ;(listeners.close ?? []).forEach(h => h(new Event('close')))
    },
    send: () => {},
    addEventListener: (type, handler) => {
      ;(listeners[type] ??= []).push(handler)
    },
    removeEventListener: (type, handler) => {
      listeners[type] = (listeners[type] ?? []).filter(h => h !== handler)
    },
    dispatchEvent: (e: Event) => {
      ;(listeners[e.type] ?? []).forEach(h => h(e))
      return true
    },
  }
  created.dcs.push(dc)
  return dc
}

function makeFakePc(): FakePc {
  const pc: FakePc = {
    connectionState: 'connected',
    iceConnectionState: 'connected',
    signalingState: 'stable',
    localDescription: null,
    onicecandidate: null,
    oniceconnectionstatechange: null,
    ondatachannel: null,
    createOffer: async () => ({ type: 'offer', sdp: 'fake' }),
    setLocalDescription: async (desc: unknown) => {
      pc.localDescription = { type: 'offer', sdp: 'fake', toJSON: () => desc }
    },
    close: () => { pc.connectionState = 'closed' },
  }
  created.pcs.push(pc)
  return pc
}

vi.mock('@/lib/webrtc', () => ({
  createPeerConnection: () => makeFakePc(),
  createDataChannel: (_pc: FakePc, label = 'misaka') => makeFakeDc(label),
  createOffer: vi.fn(async () => ({ type: 'offer', sdp: 'fake' })),
  createAnswer: vi.fn(async () => ({ type: 'answer', sdp: 'fake' })),
  applyAnswer: vi.fn(async () => {}),
  addIceCandidate: vi.fn(async () => {}),
  getSelectedChannelType: vi.fn(async () => 'direct'),
  getSelectedIcePath: vi.fn(async () => null),
  ensureAutoTurnReady: vi.fn(async () => {}),
  applyIceConfigToAll: vi.fn(),
  // New helpers from B's webrtc.ts that store/network.ts now imports.
  whenSignalingStable: vi.fn(async () => {}),
  endOfCandidatesFor: vi.fn(() => ({ candidate: '', sdpMid: '0', sdpMLineIndex: 0 })),
  installIceErrorListener: vi.fn(),
}))

vi.mock('@/lib/crypto', () => ({
  generateECDHKeyPair: vi.fn(async () => {}),
  getMyPublicKey: vi.fn(async () => 'pubkey'),
  setPeerPublicKey: vi.fn(async () => {}),
  resetCrypto: vi.fn(),
  hasAESKey: vi.fn(() => true),
}))

vi.mock('@/lib/transfer', () => ({
  sendFileParallel: vi.fn(async () => {}),
  handleMetaMessage: vi.fn(async () => {}),
  receiveChunk: vi.fn(async () => null),
  completeReceive: vi.fn(async () => new File([], 'x')),
  cancelReceive: vi.fn(async () => {}),     // C P0-2: now async
  createTransferId: () => 't',
  buildResumeRequest: vi.fn(async () => null),
  pauseTransfer: vi.fn(),
  resumeTransfer: vi.fn(),
  cancelTransfer: vi.fn(),
  streamChunkToDisk: vi.fn(),
  finalizeStreamedFile: vi.fn(),
  cancelStreamWrite: vi.fn(),
  getWriteHandle: () => null,
  writeChunkToOPFS: vi.fn(),
  getOPFSFile: vi.fn(),
  getOPFSHandle: () => null,
  cleanupOPFS: vi.fn(async () => {}),
  decodeChunkFrame: () => null,
  // C's new exports.
  prepareReceiveStorage: vi.fn(async () => ({ mode: 'idb' })),
  opfsWrittenCount: vi.fn(() => 0),
  decodeResumeRequest: vi.fn(() => undefined),
  checkMetaOOMGuard: vi.fn(() => null),
}))

// network.ts imports detectNatType/onNatTypeChange/getDetectedNatType/
// invalidateDetectedNatType from @/lib/nat. Mock to no-ops so init() doesn't
// touch real RTCPeerConnection or scheduling.
vi.mock('@/lib/nat', () => ({
  detectNatType: vi.fn(async () => ({ type: 'unknown' })),
  onNatTypeChange: vi.fn(() => () => {}),
  getDetectedNatType: vi.fn(() => null),
  invalidateDetectedNatType: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  getTransfer: vi.fn(async () => null),
  getActiveTransfers: vi.fn(async () => []),
  deleteChunks: vi.fn(async () => {}),
}))

vi.mock('@/lib/sound', () => ({ playSound: vi.fn() }))
vi.mock('@/lib/notify', () => ({ notifyIncomingFile: vi.fn() }))
vi.mock('@/lib/turn', () => ({
  refreshAutoTurn: vi.fn(async () => []),
  clearAutoTurn: vi.fn(),
  onTurnConfigChange: vi.fn(() => () => {}),
  fetchTurnStatus: vi.fn(async () => ({ available: false })),
  getAutoTurnState: vi.fn(() => null),
  loadTurnSettings: vi.fn(),
}))

// ── Test helpers ───────────────────────────────────────────────────────

async function freshStore() {
  vi.resetModules()
  signalingHandlers.message = []
  signalingHandlers.connect = []
  signalingHandlers.disconnect = []
  signalingHandlers.sent = []
  created.pcs.length = 0
  created.dcs.length = 0
  const mod = await import('../../src/store/network')
  return mod.useNetworkStore
}

function emitWS(msg: unknown) {
  signalingHandlers.message.forEach(h => h(msg))
}

async function settle() {
  // Vitest fake-timer-friendly drain: run any queued timers AND microtasks.
  await vi.runAllTimersAsync()
  // Two extra microtask flushes for chained async/await in initiateWebRTC.
  await Promise.resolve()
  await Promise.resolve()
}

describe('cleanupPeerConnection contract: intentional close must not flip status to "reconnecting"', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('a stale dc forcing recoverConnections() to clean+reinit does NOT show "reconnecting"', async () => {
    const useNetworkStore = await freshStore()
    useNetworkStore.getState().init('test-token')

    emitWS({ t: 'WELCOME', sessionId: 'me', myNodeId: 1, sessionExpiresAt: Date.now() + 1e6 })
    emitWS({
      t: 'PEER_JOINED',
      peer: { sessionId: 'peer-1', nodeId: 99, joinedAt: Date.now() },
      shouldInitiate: true,
    })
    await settle()

    // Sanity: the store created a PC and at least one primary data channel.
    expect(created.pcs.length).toBeGreaterThanOrEqual(1)
    const primary = created.dcs.find(d => d.label === 'misaka')
    expect(primary).toBeDefined()

    // Simulate the user-reported precondition: a stale primary channel sitting
    // in 'closed' state (browser tore it down between focus events, or the
    // peer connection went idle). recoverConnections() will detect this and
    // call cleanupPeerConnection + initiateWebRTC.
    primary!.readyState = 'closed'

    useNetworkStore.getState().recoverConnections()
    await settle()
    // attemptIceRestart's first backoff is 1s; advance well past it in case
    // the bug regresses and somehow re-arms the timer.
    await vi.advanceTimersByTimeAsync(2_000)

    const peer = useNetworkStore.getState().peers.find(p => p.sessionId === 'peer-1')
    expect(peer).toBeDefined()
    expect(peer!.status).not.toBe('reconnecting')
  })

  it('directly closing the dc still triggers a real recovery — fix must not silence true closes', async () => {
    // Guard against over-correcting: if a network drop closes the dc from
    // the remote side, the onclose handler is the SOLE trigger for
    // attemptIceRestart on that path. Make sure it still fires when we did
    // NOT detach it (i.e. the dc closed externally).
    const useNetworkStore = await freshStore()
    useNetworkStore.getState().init('test-token')

    emitWS({ t: 'WELCOME', sessionId: 'me', myNodeId: 1, sessionExpiresAt: Date.now() + 1e6 })
    emitWS({
      t: 'PEER_JOINED',
      peer: { sessionId: 'peer-3', nodeId: 7, joinedAt: Date.now() },
      shouldInitiate: true,
    })
    await settle()

    const primary = created.dcs.find(d => d.label === 'misaka')
    expect(primary).toBeDefined()
    expect(primary!.onclose).toBeTypeOf('function')

    // Externally close the dc — pc still 'connected'. The onclose handler
    // is the production code path for "remote dropped us". After the 1s
    // backoff inside attemptIceRestart, the peer's status flips to
    // 'reconnecting'.
    primary!.close()
    await settle()
    await vi.advanceTimersByTimeAsync(1_500)

    const peer = useNetworkStore.getState().peers.find(p => p.sessionId === 'peer-3')
    expect(peer).toBeDefined()
    expect(peer!.status).toBe('reconnecting')
  })
})
