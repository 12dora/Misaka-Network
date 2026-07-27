// Negotiation-lifecycle regressions in store/network.ts:
//
//   BUG-004  a recovery-driven initiate must not build a PeerConnection (and
//            burn an offer that `send()` silently drops) before signaling is
//            authenticated AND joined to the cluster channel.
//   BUG-005  two entry points racing on the same peer must not each create a
//            PeerConnection — one of them ends up orphaned, never cleaned up,
//            competing with the live one over the same offer/answer slot.
//   BUG-006  per-peer negotiation must be serialized, and a rejected async
//            signaling handler must be caught rather than escaping.
//   BUG-007  a delayed ICE restart must verify the peer, the epoch and the
//            exact PeerConnection identity after every await.
//   BUG-009  a TURN/policy change on a live connection must migrate the
//            selected ICE path, not just call setConfiguration().
//   UX-COPY-003  auth / signaling / peer-transport / transfer are four
//            separate states; the store must not fold them into one.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── signaling mock ─────────────────────────────────────────────────────
interface SignalingHandlers {
  message: Array<(msg: unknown) => void>
  connect: Array<() => void>
  disconnect: Array<() => void>
  sessionEnd: Array<() => void>
  sent: Array<Record<string, unknown>>
}

const signalingHandlers: SignalingHandlers = {
  message: [], connect: [], disconnect: [], sessionEnd: [], sent: [],
}

vi.mock('@/lib/signaling', () => ({
  onMessage: (h: (msg: unknown) => void) => { signalingHandlers.message.push(h); return () => {} },
  onConnect: (h: () => void) => { signalingHandlers.connect.push(h); return () => {} },
  onDisconnect: (h: () => void) => { signalingHandlers.disconnect.push(h); return () => {} },
  onSessionEnd: (h: () => void) => { signalingHandlers.sessionEnd.push(h); return () => {} },
  connect: vi.fn(),
  disconnect: vi.fn(),
  endSession: vi.fn(),
  send: (msg: Record<string, unknown>) => { signalingHandlers.sent.push(msg) },
  reconnectNow: vi.fn(),
  isConnected: () => true,
}))

// ── webrtc mock ────────────────────────────────────────────────────────
interface FakeDc {
  label: string
  readyState: RTCDataChannelState
  binaryType: BinaryType
  onclose: ((e: Event) => void) | null
  onmessage: ((e: MessageEvent) => void) | null
  close: () => void
  send: ReturnType<typeof vi.fn>
  addEventListener: (t: string, h: (e: Event) => void) => void
  removeEventListener: (t: string, h: (e: Event) => void) => void
}

interface FakePc {
  connectionState: RTCPeerConnectionState
  iceConnectionState: RTCIceConnectionState
  signalingState: RTCSignalingState
  iceGatheringState: RTCIceGatheringState
  localDescription: { type: string; sdp: string; toJSON: () => unknown } | null
  remoteDescription: { type: string; sdp: string } | null
  onicecandidate: ((e: Event) => void) | null
  oniceconnectionstatechange: (() => void) | null
  ondatachannel: ((e: Event) => void) | null
  createOffer: ReturnType<typeof vi.fn>
  addIceCandidate: (candidate: unknown) => Promise<void>
  setLocalDescription: (d: unknown) => Promise<void>
  setConfiguration: ReturnType<typeof vi.fn>
  close: () => void
}

const created: { pcs: FakePc[]; dcs: FakeDc[] } = { pcs: [], dcs: [] }
const iceApplicationLog: string[] = []
const nativeAddedIceCandidates: RTCIceCandidateInit[] = []

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
      dc.onclose?.(new Event('close'))
      ;(listeners.close ?? []).forEach(h => h(new Event('close')))
    },
    send: vi.fn(),
    addEventListener: (t, h) => { (listeners[t] ??= []).push(h) },
    removeEventListener: (t, h) => { listeners[t] = (listeners[t] ?? []).filter(x => x !== h) },
  }
  created.dcs.push(dc)
  return dc
}

function makeFakePc(): FakePc {
  const pc: FakePc = {
    connectionState: 'connected',
    iceConnectionState: 'connected',
    signalingState: 'stable',
    iceGatheringState: 'new',
    localDescription: null,
    remoteDescription: null,
    onicecandidate: null,
    oniceconnectionstatechange: null,
    ondatachannel: null,
    createOffer: vi.fn(async () => ({ type: 'offer', sdp: 'restart' })),
    addIceCandidate: async (candidate: unknown) => {
      nativeAddedIceCandidates.push(candidate as RTCIceCandidateInit)
      iceApplicationLog.push(
        (candidate as { candidate?: string }).candidate === '' ? 'eoc' : 'native-candidate',
      )
    },
    setLocalDescription: async (desc: unknown) => {
      pc.localDescription = { type: 'offer', sdp: 'restart', toJSON: () => desc }
    },
    setConfiguration: vi.fn(),
    close: () => { pc.connectionState = 'closed' },
  }
  created.pcs.push(pc)
  return pc
}

// Gate that `ensureAutoTurnReady()` parks on, so a test can hold an initiate
// mid-flight and race a second entry point against it.
let turnGate: { promise: Promise<void>; release: () => void }
let ensureAutoTurnReadyImpl: () => Promise<void>
function resetTurnGate(open = true) {
  let release!: () => void
  const promise = new Promise<void>(r => { release = r })
  turnGate = { promise, release }
  ensureAutoTurnReadyImpl = () => turnGate.promise
  if (open) release()
}

// Answer creation order log, so the serialization test can assert that a
// second offer for the same peer never interleaves with the first.
const answerLog: string[] = []
let answerDelayMs = 0
let createAnswerImpl: (pc: unknown, offer: { sdp?: string }) => Promise<unknown> = async (_pc, offer) => {
  answerLog.push(`start:${offer.sdp}`)
  if (answerDelayMs > 0) await new Promise(r => setTimeout(r, answerDelayMs))
  answerLog.push(`end:${offer.sdp}`)
  return { type: 'answer', sdp: `answer-${offer.sdp}` }
}

let createOfferImpl: (pc: unknown) => Promise<unknown> = async () => ({
  type: 'offer',
  sdp: 'local-offer',
})
let applyAnswerImpl: (pc: unknown, answer: unknown) => Promise<void> = async () => {}
let generateECDHKeyPairImpl: (peerSessionId: string) => Promise<void> = async () => {}
let addIceCandidateImpl: (pc: unknown, candidate: unknown) => Promise<void> = async () => {}
const appliedAnswers: Array<{ pc: unknown; answer: unknown }> = []
const addedIceCandidates: Array<{ pc: unknown; candidate: unknown }> = []
let applyIceConfigResult: unknown[] = []
let hasAESKeyResult = true
let selectedIcePathImpl: (pc: unknown) => Promise<unknown> = async () => ({
  channelType: 'direct',
  pathText: 'host/udp → host/udp',
})
let getMyPublicKeyImpl: (peerSessionId: string) => Promise<string> = async () => 'pubkey'

vi.mock('@/lib/webrtc', () => ({
  createPeerConnection: () => makeFakePc(),
  createDataChannel: (_pc: unknown, label = 'misaka') => makeFakeDc(label),
  createOffer: (pc: unknown) => createOfferImpl(pc),
  createAnswer: (pc: unknown, offer: { sdp?: string }) => createAnswerImpl(pc, offer),
  applyAnswer: async (pc: unknown, answer: unknown) => {
    appliedAnswers.push({ pc, answer })
    await applyAnswerImpl(pc, answer)
  },
  addIceCandidate: vi.fn(async (pc: unknown, candidate: unknown) => {
    addedIceCandidates.push({ pc, candidate })
    iceApplicationLog.push((candidate as { candidate?: string }).candidate ?? 'candidate')
    await addIceCandidateImpl(pc, candidate)
  }),
  getSelectedChannelType: vi.fn(async () => 'direct'),
  getSelectedIcePath: (pc: unknown) => selectedIcePathImpl(pc),
  ensureAutoTurnReady: vi.fn(() => ensureAutoTurnReadyImpl()),
  applyIceConfigToAll: vi.fn(() => applyIceConfigResult),
  whenSignalingStable: vi.fn(async () => {}),
  endOfCandidateMarkersFor: vi.fn((pc: FakePc) => {
    const markers: RTCIceCandidateInit[] = []
    let index = -1
    let current: RTCIceCandidateInit | null = null
    for (const line of pc.localDescription?.sdp.split(/\r?\n/) ?? []) {
      if (line.startsWith('m=')) {
        index++
        current = { candidate: '', sdpMid: null, sdpMLineIndex: index }
        markers.push(current)
      } else if (line.startsWith('a=mid:') && current) {
        current.sdpMid = line.slice('a=mid:'.length)
      }
    }
    return markers.length > 0
      ? markers
      : [{ candidate: '', sdpMid: '0', sdpMLineIndex: 0 }]
  }),
  endOfCandidatesFor: vi.fn((_pc: unknown, locator?: RTCIceCandidateInit) => (
    locator ?? { candidate: '', sdpMid: '0', sdpMLineIndex: 0 }
  )),
  installIceErrorListener: vi.fn(),
  isRelayAllowed: vi.fn(() => true),
  hasUsableTurnServer: vi.fn(() => true),
}))

vi.mock('@/lib/crypto', () => ({
  generateECDHKeyPair: (peerSessionId: string) => generateECDHKeyPairImpl(peerSessionId),
  getMyPublicKey: (peerSessionId: string) => getMyPublicKeyImpl(peerSessionId),
  setPeerPublicKey: vi.fn(async () => {}),
  resetCrypto: vi.fn(),
  hasAESKey: vi.fn(() => hasAESKeyResult),
}))

vi.mock('@/lib/transfer', () => ({
  sendFileParallel: vi.fn(async () => {}),
  handleMetaMessage: vi.fn(async () => {}),
  receiveChunk: vi.fn(async () => null),
  completeReceive: vi.fn(async () => new File([], 'x')),
  cancelReceive: vi.fn(async () => {}),
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
  decodeResumeRequest: vi.fn(() => undefined),
  checkMetaOOMGuard: vi.fn(() => null),
  prepareReceiveStorage: vi.fn(async () => ({ mode: 'idb' })),
  opfsWrittenCount: vi.fn(() => 0),
  getReceiveSession: vi.fn(() => null),
  clearTransferSignal: vi.fn(),
  resetTransferModuleState: vi.fn(),
  TransferCancelledError: class TransferCancelledError extends Error {},
}))

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
  pruneTerminalTransfers: vi.fn(async () => {}),
}))

vi.mock('@/lib/sound', () => ({ playSound: vi.fn() }))
vi.mock('@/lib/notify', () => ({ notifyIncomingFile: vi.fn() }))

const turnConfigListeners: Array<() => void> = []
vi.mock('@/lib/turn', () => ({
  refreshAutoTurn: vi.fn(async () => []),
  clearAutoTurn: vi.fn(),
  onTurnConfigChange: (fn: () => void) => { turnConfigListeners.push(fn); return () => {} },
  fetchTurnStatus: vi.fn(async () => null),
  getAutoTurnState: vi.fn(() => null),
  loadTurnSettings: vi.fn(() => ({ servers: [], enabled: false, forceRelay: false })),
}))

// ── harness ────────────────────────────────────────────────────────────

type NetworkModule = typeof import('../../src/store/network')

async function freshStore(): Promise<NetworkModule> {
  vi.resetModules()
  signalingHandlers.message = []
  signalingHandlers.connect = []
  signalingHandlers.disconnect = []
  signalingHandlers.sessionEnd = []
  signalingHandlers.sent = []
  turnConfigListeners.length = 0
  created.pcs.length = 0
  created.dcs.length = 0
  answerLog.length = 0
  answerDelayMs = 0
  createOfferImpl = async () => ({ type: 'offer', sdp: 'local-offer' })
  applyAnswerImpl = async () => {}
  generateECDHKeyPairImpl = async () => {}
  addIceCandidateImpl = async () => {}
  appliedAnswers.length = 0
  addedIceCandidates.length = 0
  nativeAddedIceCandidates.length = 0
  iceApplicationLog.length = 0
  applyIceConfigResult = []
  hasAESKeyResult = true
  selectedIcePathImpl = async () => ({
    channelType: 'direct',
    pathText: 'host/udp → host/udp',
  })
  getMyPublicKeyImpl = async () => 'pubkey'
  resetTurnGate()
  return await import('../../src/store/network')
}

function emitWS(msg: unknown) {
  signalingHandlers.message.forEach(h => h(msg))
}

function welcome(sessionId = 'me') {
  emitWS({ t: 'WELCOME', sessionId, myNodeId: 1, sessionExpiresAt: Date.now() + 1e6 })
}

function peerJoined(sessionId = 'peer-1', shouldInitiate = true) {
  emitWS({ t: 'PEER_JOINED', peer: { sessionId, nodeId: 99, joinedAt: Date.now() }, shouldInitiate })
}

async function settle() {
  await vi.runAllTimersAsync()
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

// Drains the microtask queue WITHOUT firing any pending timers (unlike
// `settle()`), for tests that need to hold future watchdogs/timeouts armed
// while still letting an already-triggered promise chain (e.g. a rejected
// mock) fully propagate through several `await` hops.
async function flushMicrotasks(ticks = 20) {
  for (let i = 0; i < ticks; i++) await Promise.resolve()
}

function sdpFrames() {
  return signalingHandlers.sent.filter(m => m.t === 'SIGNAL_SDP')
}

function livePcs() {
  return created.pcs.filter(pc => pc.connectionState !== 'closed')
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

// ── BUG-004 ────────────────────────────────────────────────────────────

describe('BUG-004: no offer before signaling is authenticated + joined', () => {
  it('does not build a PeerConnection while WELCOME is still outstanding', async () => {
    const { useNetworkStore } = await freshStore()
    useNetworkStore.getState().init('tok')

    // A peer we already know about (from a previous epoch's radar) plus a
    // recovery sweep — the classic "slow network foreground resume" shape.
    useNetworkStore.setState({
      peers: [{ sessionId: 'peer-1', nodeId: 99, status: 'offline', channelType: 'direct', joinedAt: Date.now() }],
    })
    useNetworkStore.getState().recoverConnections()
    await settle()

    expect(created.pcs.length).toBe(0)
    expect(sdpFrames()).toEqual([])
    // The peer is not left claiming to be connecting forever.
    expect(useNetworkStore.getState().peers[0].status).not.toBe('online')
  })

  it('completes the parked initiate as soon as WELCOME + JOIN land', async () => {
    const { useNetworkStore } = await freshStore()
    useNetworkStore.getState().init('tok')

    useNetworkStore.setState({
      peers: [{ sessionId: 'peer-1', nodeId: 99, status: 'offline', channelType: 'direct', joinedAt: Date.now() }],
    })
    void useNetworkStore.getState().reconnectPeer('peer-1')
    await vi.advanceTimersByTimeAsync(20)
    expect(created.pcs.length).toBe(0)

    welcome()
    await settle()

    expect(created.pcs.length).toBe(1)
    expect(sdpFrames().length).toBe(1)
    expect(signalingHandlers.sent.some(m => m.t === 'JOIN_CLUSTER')).toBe(true)
  })
})

// ── BUG-005 ────────────────────────────────────────────────────────────

describe('BUG-005: concurrent initiation must not leak a second PeerConnection', () => {
  it('two entry points racing on one peer leave exactly one live PC', async () => {
    const { useNetworkStore } = await freshStore()
    resetTurnGate(false)   // hold every initiate at the auto-TURN barrier
    useNetworkStore.getState().init('tok')
    welcome()
    peerJoined('peer-1', true)
    await vi.advanceTimersByTimeAsync(1)

    // Second entry point (the "立即重连此节点" button) fires while the first
    // initiate is still parked on ensureAutoTurnReady().
    void useNetworkStore.getState().reconnectPeer('peer-1')
    await vi.advanceTimersByTimeAsync(1)

    turnGate.release()
    await settle()

    expect(livePcs().length).toBe(1)
    // …and the surviving PC is the one the store actually routes through.
    expect(created.dcs.filter(d => d.label === 'misaka' && d.readyState === 'open').length).toBe(1)
  })

  it('a second call while an initiate is in flight reuses it instead of duplicating', async () => {
    const { useNetworkStore } = await freshStore()
    resetTurnGate(false)
    useNetworkStore.getState().init('tok')
    welcome()
    peerJoined('peer-1', true)
    await vi.advanceTimersByTimeAsync(1)

    // recoverConnections() sees no PC yet and would previously start a second
    // initiate for the same peer.
    useNetworkStore.getState().recoverConnections()
    await vi.advanceTimersByTimeAsync(1)
    turnGate.release()
    await settle()

    expect(livePcs().length).toBe(1)
  })
})

// ── BUG-006 ────────────────────────────────────────────────────────────

describe('BUG-006: signaling handlers are serialized per peer and never leak rejections', () => {
  it('replaces a wedged remote generation when an offline peer sends a fresh offer', async () => {
    const { useNetworkStore } = await freshStore()
    hasAESKeyResult = false
    useNetworkStore.getState().init('tok')
    welcome('z-session')
    peerJoined('a-session', true)
    await vi.advanceTimersByTimeAsync(1)

    const stale = created.pcs[0]
    useNetworkStore.setState(s => ({
      peers: s.peers.map(peer => ({ ...peer, status: 'offline' as const })),
    }))
    emitWS({
      t: 'SIGNAL_SDP',
      fromSessionId: 'a-session',
      fromNodeId: 7,
      sdp: { type: 'offer', sdp: 'fresh-generation' },
    })
    await settle()

    expect(stale.connectionState).toBe('closed')
    expect(livePcs()).toHaveLength(1)
    expect(created.pcs).toHaveLength(2)
  })

  it('two offers from the same peer are answered one at a time', async () => {
    const { useNetworkStore } = await freshStore()
    useNetworkStore.getState().init('tok')
    welcome()
    answerDelayMs = 50

    emitWS({ t: 'SIGNAL_SDP', fromSessionId: 'peer-1', fromNodeId: 7, sdp: { type: 'offer', sdp: 'A' } })
    emitWS({ t: 'SIGNAL_SDP', fromSessionId: 'peer-1', fromNodeId: 7, sdp: { type: 'offer', sdp: 'B' } })
    await settle()

    // Interleaved processing would read start:A, start:B, end:A, end:B.
    expect(answerLog).toEqual(['start:A', 'end:A', 'start:B', 'end:B'])
  })

  it('a rejecting SDP handler is caught, not surfaced as an unhandled rejection', async () => {
    const { useNetworkStore } = await freshStore()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const unhandled: unknown[] = []
    const onUnhandled = (e: PromiseRejectionEvent) => { unhandled.push(e.reason); e.preventDefault?.() }
    window.addEventListener('unhandledrejection', onUnhandled)

    useNetworkStore.getState().init('tok')
    welcome()
    createAnswerImpl = async () => { throw new Error('malformed SDP') }

    emitWS({ t: 'SIGNAL_SDP', fromSessionId: 'peer-1', fromNodeId: 7, sdp: { type: 'offer', sdp: 'A' } })
    await settle()
    // Later traffic for the same peer must still be processed.
    createAnswerImpl = async (_pc, offer) => {
      answerLog.push(`end:${offer.sdp}`)
      return { type: 'answer', sdp: 'ok' }
    }
    emitWS({ t: 'SIGNAL_SDP', fromSessionId: 'peer-1', fromNodeId: 7, sdp: { type: 'offer', sdp: 'C' } })
    await settle()

    expect(unhandled).toEqual([])
    expect(answerLog).toContain('end:C')

    window.removeEventListener('unhandledrejection', onUnhandled)
    warn.mockRestore()
  })
})

describe('signaling queue incarnation', () => {
  it('drops an old answer and ICE frame queued behind a replaced negotiation', async () => {
    const { useNetworkStore, getPendingSignalingQueueCount } = await freshStore()
    const blocker = deferred<unknown>()
    useNetworkStore.getState().init('tok')
    welcome()
    peerJoined('peer-1', true)
    await settle()

    const oldPc = created.pcs[0]
    createAnswerImpl = async () => blocker.promise
    emitWS({
      t: 'SIGNAL_SDP',
      fromSessionId: 'peer-1',
      fromNodeId: 7,
      sdp: { type: 'offer', sdp: 'queue-blocker' },
    })
    for (let i = 0; i < 10; i++) await Promise.resolve()

    emitWS({
      t: 'SIGNAL_SDP',
      fromSessionId: 'peer-1',
      fromNodeId: 7,
      sdp: { type: 'answer', sdp: 'old-queued-answer' },
    })
    emitWS({
      t: 'SIGNAL_ICE',
      fromSessionId: 'peer-1',
      candidate: { candidate: 'old-queued-candidate' },
    })

    await useNetworkStore.getState().reconnectPeer('peer-1')
    const replacementPc = created.pcs.at(-1)!
    replacementPc.signalingState = 'have-local-offer'
    replacementPc.remoteDescription = { type: 'offer', sdp: 'replacement-remote' }
    appliedAnswers.length = 0
    addedIceCandidates.length = 0

    blocker.resolve({ type: 'answer', sdp: 'obsolete-blocker-answer' })
    for (let i = 0; i < 20; i++) await Promise.resolve()

    expect(oldPc.connectionState).toBe('closed')
    expect(appliedAnswers).toEqual([])
    expect(addedIceCandidates).toEqual([])
    expect(replacementPc.signalingState).toBe('have-local-offer')
    expect(getPendingSignalingQueueCount()).toBe(0)
  })

  it('binds a queued answer to the local offer token on the same PC', async () => {
    const { useNetworkStore, getPendingSignalingQueueCount } = await freshStore()
    const blocker = deferred<void>()
    useNetworkStore.getState().init('tok')
    welcome()
    peerJoined('peer-1', true)
    await settle()

    const pc = created.pcs[0]
    pc.remoteDescription = { type: 'offer', sdp: 'existing-remote' }
    addIceCandidateImpl = async (_pc, candidate) => {
      if ((candidate as { candidate?: string }).candidate === 'queue-blocker') {
        await blocker.promise
      }
    }
    emitWS({
      t: 'SIGNAL_ICE',
      fromSessionId: 'peer-1',
      candidate: { candidate: 'queue-blocker' },
    })
    for (let i = 0; i < 10; i++) await Promise.resolve()
    emitWS({
      t: 'SIGNAL_SDP',
      fromSessionId: 'peer-1',
      fromNodeId: 7,
      sdp: { type: 'answer', sdp: 'answer-for-prior-offer' },
    })
    emitWS({
      t: 'SIGNAL_ICE',
      fromSessionId: 'peer-1',
      candidate: { candidate: 'candidate-for-prior-offer' },
    })

    applyIceConfigResult = [pc]
    turnConfigListeners.forEach(listener => listener())
    await vi.advanceTimersByTimeAsync(301)
    pc.signalingState = 'have-local-offer'
    appliedAnswers.length = 0
    addedIceCandidates.length = 0

    blocker.resolve()
    for (let i = 0; i < 20; i++) await Promise.resolve()

    expect(appliedAnswers).toEqual([])
    expect(addedIceCandidates).toEqual([])
    expect(getPendingSignalingQueueCount()).toBe(0)
  })

  it('keeps valid queued ICE in the same negotiation incarnation', async () => {
    const { useNetworkStore, getPendingSignalingQueueCount } = await freshStore()
    const blocker = deferred<unknown>()
    useNetworkStore.getState().init('tok')
    welcome()
    peerJoined('peer-1', true)
    await settle()

    const pc = created.pcs[0]
    pc.remoteDescription = { type: 'offer', sdp: 'same-incarnation' }
    createAnswerImpl = async () => blocker.promise
    emitWS({
      t: 'SIGNAL_SDP',
      fromSessionId: 'peer-1',
      fromNodeId: 7,
      sdp: { type: 'offer', sdp: 'same-incarnation-offer' },
    })
    for (let i = 0; i < 10; i++) await Promise.resolve()
    emitWS({
      t: 'SIGNAL_ICE',
      fromSessionId: 'peer-1',
      candidate: { candidate: 'same-incarnation-candidate' },
    })

    blocker.resolve({ type: 'answer', sdp: 'same-incarnation-answer' })
    for (let i = 0; i < 20; i++) await Promise.resolve()

    expect(addedIceCandidates).toEqual([{
      pc,
      candidate: { candidate: 'same-incarnation-candidate' },
    }])
    expect(getPendingSignalingQueueCount()).toBe(0)
  })

  it('preserves no-PC ICE buffered before an offer in the same incarnation', async () => {
    const { useNetworkStore, getPendingSignalingQueueCount } = await freshStore()
    useNetworkStore.getState().init('tok')
    welcome()
    peerJoined('peer-1', false)

    emitWS({
      t: 'SIGNAL_ICE',
      fromSessionId: 'peer-1',
      candidate: { candidate: 'pre-offer-candidate' },
    })
    emitWS({
      t: 'SIGNAL_SDP',
      fromSessionId: 'peer-1',
      fromNodeId: 7,
      sdp: { type: 'offer', sdp: 'same-incarnation-offer' },
    })
    for (let i = 0; i < 30; i++) await Promise.resolve()

    expect(created.pcs).toHaveLength(1)
    expect(addedIceCandidates).toEqual([{
      pc: created.pcs[0],
      candidate: { candidate: 'pre-offer-candidate' },
    }])
    expect(getPendingSignalingQueueCount()).toBe(0)
  })

  it('keeps pre-offer ICE and EOC parked across local fallback until matching remote SDP', async () => {
    const { useNetworkStore, getPendingRemoteIceCount } = await freshStore()
    useNetworkStore.getState().init('tok')
    welcome()
    peerJoined('peer-1', false)

    emitWS({
      t: 'SIGNAL_ICE',
      fromSessionId: 'peer-1',
      candidate: {
        candidate: 'pre-offer-candidate',
        usernameFragment: 'remote-ufrag',
      },
    })
    emitWS({
      t: 'SIGNAL_ICE_END',
      fromSessionId: 'peer-1',
    })
    for (let i = 0; i < 10; i++) await Promise.resolve()

    await vi.advanceTimersByTimeAsync(7_000)
    for (let i = 0; i < 10; i++) await Promise.resolve()

    const fallbackPc = created.pcs[0]
    expect(fallbackPc).toBeDefined()
    expect(fallbackPc.remoteDescription).toBeNull()
    expect(iceApplicationLog).toEqual([])

    fallbackPc.signalingState = 'have-local-offer'
    applyAnswerImpl = async (pc, answer) => {
      ;(pc as FakePc).remoteDescription = answer as FakePc['remoteDescription']
    }
    emitWS({
      t: 'SIGNAL_SDP',
      fromSessionId: 'peer-1',
      fromNodeId: 7,
      sdp: {
        type: 'answer',
        sdp: 'v=0\r\na=ice-ufrag:remote-ufrag\r\n',
      },
    })
    for (let i = 0; i < 20; i++) await Promise.resolve()

    expect(iceApplicationLog).toEqual(['pre-offer-candidate', 'eoc'])
    expect(addedIceCandidates).toEqual([{
      pc: fallbackPc,
      candidate: {
        candidate: 'pre-offer-candidate',
        usernameFragment: 'remote-ufrag',
      },
    }])
    expect(getPendingRemoteIceCount()).toBe(0)
  })

  it('preserves an explicit ICE-ufrag mismatch for its later matching offer', async () => {
    const { useNetworkStore, getPendingRemoteIceCount } = await freshStore()
    useNetworkStore.getState().init('tok')
    welcome()
    peerJoined('peer-1', false)
    createAnswerImpl = async (pc, offer) => {
      ;(pc as FakePc).remoteDescription = offer as FakePc['remoteDescription']
      return { type: 'answer', sdp: 'answer' }
    }

    emitWS({
      t: 'SIGNAL_ICE',
      fromSessionId: 'peer-1',
      candidate: { candidate: 'old-candidate', usernameFragment: 'old-ufrag' },
    })
    emitWS({ t: 'SIGNAL_ICE_END', fromSessionId: 'peer-1' })
    emitWS({
      t: 'SIGNAL_SDP',
      fromSessionId: 'peer-1',
      fromNodeId: 7,
      sdp: { type: 'offer', sdp: 'v=0\r\na=ice-ufrag:new-ufrag\r\n' },
    })
    for (let i = 0; i < 30; i++) await Promise.resolve()

    expect(iceApplicationLog).toEqual([])
    expect(getPendingRemoteIceCount()).toBe(1)

    emitWS({
      t: 'SIGNAL_SDP',
      fromSessionId: 'peer-1',
      fromNodeId: 7,
      sdp: { type: 'offer', sdp: 'v=0\r\na=ice-ufrag:old-ufrag\r\n' },
    })
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect(iceApplicationLog).toEqual(['old-candidate', 'eoc'])
    expect(getPendingRemoteIceCount()).toBe(0)
  })

  it('discards pre-offer ICE when cleanup invalidates its signaling incarnation', async () => {
    const { useNetworkStore, getPendingRemoteIceCount } = await freshStore()
    useNetworkStore.getState().init('tok')
    welcome()
    peerJoined('peer-1', false)

    emitWS({
      t: 'SIGNAL_ICE',
      fromSessionId: 'peer-1',
      candidate: { candidate: 'invalidated-candidate' },
    })
    emitWS({ t: 'SIGNAL_ICE_END', fromSessionId: 'peer-1' })
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(getPendingRemoteIceCount()).toBe(1)

    await useNetworkStore.getState().reconnectPeer('peer-1')
    expect(getPendingRemoteIceCount()).toBe(0)
    expect(iceApplicationLog).toEqual([])
  })

  it('applies ICE and EOC immediately after a normal inbound offer', async () => {
    const { useNetworkStore, getPendingRemoteIceCount } = await freshStore()
    useNetworkStore.getState().init('tok')
    welcome()
    peerJoined('peer-1', false)
    createAnswerImpl = async (pc, offer) => {
      ;(pc as FakePc).remoteDescription = offer as FakePc['remoteDescription']
      return { type: 'answer', sdp: 'answer' }
    }

    emitWS({
      t: 'SIGNAL_SDP',
      fromSessionId: 'peer-1',
      fromNodeId: 7,
      sdp: { type: 'offer', sdp: 'v=0\r\na=ice-ufrag:normal\r\n' },
    })
    for (let i = 0; i < 20; i++) await Promise.resolve()
    const pc = created.pcs[0]

    emitWS({
      t: 'SIGNAL_ICE',
      fromSessionId: 'peer-1',
      candidate: { candidate: 'normal-candidate', usernameFragment: 'normal' },
    })
    emitWS({ t: 'SIGNAL_ICE_END', fromSessionId: 'peer-1' })
    for (let i = 0; i < 20; i++) await Promise.resolve()

    expect(iceApplicationLog).toEqual(['normal-candidate', 'eoc'])
    expect(addedIceCandidates).toEqual([{
      pc,
      candidate: { candidate: 'normal-candidate', usernameFragment: 'normal' },
    }])
    expect(getPendingRemoteIceCount()).toBe(0)
  })

  it('buffers established-PC restart ICE until the matching ufrag SDP is installed', async () => {
    const { useNetworkStore, getPendingRemoteIceCount } = await freshStore()
    useNetworkStore.getState().init('tok')
    welcome()
    peerJoined('peer-1', true)
    await settle()

    const pc = created.pcs[0]
    pc.signalingState = 'stable'
    pc.remoteDescription = { type: 'answer', sdp: 'v=0\r\na=ice-ufrag:old\r\n' }
    createAnswerImpl = async (target, offer) => {
      ;(target as FakePc).remoteDescription = offer as FakePc['remoteDescription']
      return { type: 'answer', sdp: 'restart-answer' }
    }
    addedIceCandidates.length = 0
    iceApplicationLog.length = 0

    emitWS({
      t: 'SIGNAL_ICE',
      fromSessionId: 'peer-1',
      candidate: { candidate: 'restart-candidate', usernameFragment: 'new' },
    })
    emitWS({ t: 'SIGNAL_ICE_END', fromSessionId: 'peer-1' })
    for (let i = 0; i < 20; i++) await Promise.resolve()

    expect(iceApplicationLog).toEqual([])
    expect(getPendingRemoteIceCount()).toBe(1)

    emitWS({
      t: 'SIGNAL_SDP',
      fromSessionId: 'peer-1',
      fromNodeId: 7,
      sdp: { type: 'offer', sdp: 'v=0\r\na=ice-ufrag:new\r\n' },
    })
    for (let i = 0; i < 30; i++) await Promise.resolve()

    expect(iceApplicationLog).toEqual(['restart-candidate', 'eoc'])
    expect(addedIceCandidates).toEqual([{
      pc,
      candidate: { candidate: 'restart-candidate', usernameFragment: 'new' },
    }])
    expect(getPendingRemoteIceCount()).toBe(0)
  })

  it('keeps current-generation ICE immediate while a restart ufrag group is pending', async () => {
    const { useNetworkStore, getPendingRemoteIceCount } = await freshStore()
    useNetworkStore.getState().init('tok')
    welcome()
    peerJoined('peer-1', true)
    await settle()

    const pc = created.pcs[0]
    pc.signalingState = 'stable'
    pc.remoteDescription = { type: 'answer', sdp: 'v=0\r\na=ice-ufrag:old\r\n' }
    createAnswerImpl = async (target, offer) => {
      ;(target as FakePc).remoteDescription = offer as FakePc['remoteDescription']
      return { type: 'answer', sdp: 'restart-answer' }
    }
    addedIceCandidates.length = 0
    iceApplicationLog.length = 0

    emitWS({
      t: 'SIGNAL_ICE',
      fromSessionId: 'peer-1',
      candidate: { candidate: 'pending-new', usernameFragment: 'new' },
    })
    emitWS({
      t: 'SIGNAL_ICE',
      fromSessionId: 'peer-1',
      candidate: { candidate: 'still-current', usernameFragment: 'old' },
    })
    emitWS({ t: 'SIGNAL_ICE_END', fromSessionId: 'peer-1' })
    for (let i = 0; i < 20; i++) await Promise.resolve()

    expect(iceApplicationLog).toEqual(['still-current'])
    expect(getPendingRemoteIceCount()).toBe(1)

    emitWS({
      t: 'SIGNAL_SDP',
      fromSessionId: 'peer-1',
      fromNodeId: 7,
      sdp: { type: 'offer', sdp: 'v=0\r\na=ice-ufrag:new\r\n' },
    })
    for (let i = 0; i < 30; i++) await Promise.resolve()

    expect(iceApplicationLog).toEqual(['still-current', 'pending-new', 'eoc'])
    expect(getPendingRemoteIceCount()).toBe(0)
  })

  it('drains explicit ufrag A and B groups only on their matching SDP', async () => {
    const { useNetworkStore, getPendingRemoteIceCount } = await freshStore()
    useNetworkStore.getState().init('tok')
    welcome()
    peerJoined('peer-1', false)
    createAnswerImpl = async (pc, offer) => {
      ;(pc as FakePc).remoteDescription = offer as FakePc['remoteDescription']
      return { type: 'answer', sdp: 'answer' }
    }

    emitWS({
      t: 'SIGNAL_ICE',
      fromSessionId: 'peer-1',
      candidate: { candidate: 'candidate-A', usernameFragment: 'A' },
    })
    emitWS({ t: 'SIGNAL_ICE_END', fromSessionId: 'peer-1' })
    emitWS({
      t: 'SIGNAL_ICE',
      fromSessionId: 'peer-1',
      candidate: { candidate: 'candidate-B', usernameFragment: 'B' },
    })
    emitWS({ t: 'SIGNAL_ICE_END', fromSessionId: 'peer-1' })
    emitWS({
      t: 'SIGNAL_SDP',
      fromSessionId: 'peer-1',
      fromNodeId: 7,
      sdp: { type: 'offer', sdp: 'v=0\r\na=ice-ufrag:A\r\n' },
    })
    for (let i = 0; i < 30; i++) await Promise.resolve()

    expect(iceApplicationLog).toEqual(['candidate-A', 'eoc'])
    expect(getPendingRemoteIceCount()).toBe(1)

    emitWS({
      t: 'SIGNAL_SDP',
      fromSessionId: 'peer-1',
      fromNodeId: 7,
      sdp: { type: 'offer', sdp: 'v=0\r\na=ice-ufrag:B\r\n' },
    })
    for (let i = 0; i < 30; i++) await Promise.resolve()

    expect(iceApplicationLog).toEqual(['candidate-A', 'eoc', 'candidate-B', 'eoc'])
    expect(getPendingRemoteIceCount()).toBe(0)
  })

  it('keeps a receipt-time reservation for future ICE queued behind an earlier SDP', async () => {
    const { useNetworkStore, getPendingRemoteIceCount } = await freshStore()
    const answerA = deferred<unknown>()
    useNetworkStore.getState().init('tok')
    welcome()
    peerJoined('peer-1', false)
    createAnswerImpl = async (pc, offer) => {
      if (offer.sdp?.includes('ice-ufrag:A')) {
        const answer = await answerA.promise
        ;(pc as FakePc).remoteDescription = offer as FakePc['remoteDescription']
        return answer
      }
      ;(pc as FakePc).remoteDescription = offer as FakePc['remoteDescription']
      return { type: 'answer', sdp: 'answer-B' }
    }

    emitWS({
      t: 'SIGNAL_ICE',
      fromSessionId: 'peer-1',
      candidate: { candidate: 'candidate-A', usernameFragment: 'A' },
    })
    emitWS({
      t: 'SIGNAL_SDP',
      fromSessionId: 'peer-1',
      fromNodeId: 7,
      sdp: { type: 'offer', sdp: 'v=0\r\na=ice-ufrag:A\r\n' },
    })
    for (let i = 0; i < 20; i++) await Promise.resolve()

    emitWS({
      t: 'SIGNAL_ICE',
      fromSessionId: 'peer-1',
      candidate: { candidate: 'candidate-B', usernameFragment: 'B' },
    })
    emitWS({ t: 'SIGNAL_ICE_END', fromSessionId: 'peer-1' })
    answerA.resolve({ type: 'answer', sdp: 'answer-A' })
    for (let i = 0; i < 50; i++) await Promise.resolve()

    expect(iceApplicationLog).toEqual(['candidate-A'])
    expect(getPendingRemoteIceCount()).toBe(1)

    emitWS({
      t: 'SIGNAL_SDP',
      fromSessionId: 'peer-1',
      fromNodeId: 7,
      sdp: { type: 'offer', sdp: 'v=0\r\na=ice-ufrag:B\r\n' },
    })
    for (let i = 0; i < 50; i++) await Promise.resolve()

    expect(iceApplicationLog).toEqual(['candidate-A', 'candidate-B', 'eoc'])
    expect(getPendingRemoteIceCount()).toBe(0)
  })

  it('does not let a detached cleanup tail release a reused replacement reservation', async () => {
    const {
      useNetworkStore,
      getPendingRemoteIceCount,
      getPendingRemoteIceReservationCount,
    } = await freshStore()
    const oldGate = deferred<unknown>()
    const replacementGate = deferred<unknown>()
    useNetworkStore.getState().init('tok')
    welcome()
    peerJoined('peer-1', false)
    createAnswerImpl = async (pc, offer) => {
      if (offer.sdp === 'old-blocker') await oldGate.promise
      if (offer.sdp === 'replacement-blocker') await replacementGate.promise
      ;(pc as FakePc).remoteDescription = offer as FakePc['remoteDescription']
      return { type: 'answer', sdp: `answer-${offer.sdp}` }
    }

    emitWS({
      t: 'SIGNAL_SDP',
      fromSessionId: 'peer-1',
      fromNodeId: 7,
      sdp: { type: 'offer', sdp: 'old-blocker' },
    })
    for (let i = 0; i < 20; i++) await Promise.resolve()
    emitWS({
      t: 'SIGNAL_ICE',
      fromSessionId: 'peer-1',
      candidate: { candidate: 'old-candidate', usernameFragment: 'old' },
    })
    emitWS({ t: 'SIGNAL_ICE_END', fromSessionId: 'peer-1' })

    await useNetworkStore.getState().reconnectPeer('peer-1')
    emitWS({
      t: 'SIGNAL_SDP',
      fromSessionId: 'peer-1',
      fromNodeId: 7,
      sdp: { type: 'offer', sdp: 'replacement-blocker' },
    })
    for (let i = 0; i < 20; i++) await Promise.resolve()
    emitWS({
      t: 'SIGNAL_ICE',
      fromSessionId: 'peer-1',
      candidate: { candidate: 'replacement-candidate', usernameFragment: 'replacement' },
    })
    emitWS({ t: 'SIGNAL_ICE_END', fromSessionId: 'peer-1' })

    oldGate.resolve({ type: 'answer', sdp: 'obsolete' })
    for (let i = 0; i < 30; i++) await Promise.resolve()
    expect(getPendingRemoteIceReservationCount()).toBe(2)

    replacementGate.resolve({ type: 'answer', sdp: 'replacement-blocker-answer' })
    for (let i = 0; i < 50; i++) await Promise.resolve()
    expect(getPendingRemoteIceReservationCount()).toBe(0)
    expect(getPendingRemoteIceCount()).toBe(1)

    emitWS({
      t: 'SIGNAL_SDP',
      fromSessionId: 'peer-1',
      fromNodeId: 7,
      sdp: { type: 'offer', sdp: 'v=0\r\na=ice-ufrag:replacement\r\n' },
    })
    for (let i = 0; i < 50; i++) await Promise.resolve()

    expect(iceApplicationLog).toEqual(['replacement-candidate', 'eoc'])
    expect(getPendingRemoteIceCount()).toBe(0)
    expect(getPendingRemoteIceReservationCount()).toBe(0)
  })

  it('does not let a detached prior-epoch tail release a reused reservation', async () => {
    const {
      useNetworkStore,
      getPendingRemoteIceCount,
      getPendingRemoteIceReservationCount,
    } = await freshStore()
    const oldEpochGate = deferred<unknown>()
    const newEpochGate = deferred<unknown>()
    useNetworkStore.getState().init('tok')
    welcome()
    peerJoined('peer-1', false)
    createAnswerImpl = async (pc, offer) => {
      if (offer.sdp === 'old-epoch-blocker') await oldEpochGate.promise
      if (offer.sdp === 'new-epoch-blocker') await newEpochGate.promise
      ;(pc as FakePc).remoteDescription = offer as FakePc['remoteDescription']
      return { type: 'answer', sdp: `answer-${offer.sdp}` }
    }

    emitWS({
      t: 'SIGNAL_SDP',
      fromSessionId: 'peer-1',
      fromNodeId: 7,
      sdp: { type: 'offer', sdp: 'old-epoch-blocker' },
    })
    for (let i = 0; i < 20; i++) await Promise.resolve()
    emitWS({
      t: 'SIGNAL_ICE',
      fromSessionId: 'peer-1',
      candidate: { candidate: 'old-epoch-candidate', usernameFragment: 'old-epoch' },
    })
    emitWS({ t: 'SIGNAL_ICE_END', fromSessionId: 'peer-1' })

    welcome('next-epoch-session')
    peerJoined('peer-1', false)
    emitWS({
      t: 'SIGNAL_SDP',
      fromSessionId: 'peer-1',
      fromNodeId: 7,
      sdp: { type: 'offer', sdp: 'new-epoch-blocker' },
    })
    for (let i = 0; i < 20; i++) await Promise.resolve()
    emitWS({
      t: 'SIGNAL_ICE',
      fromSessionId: 'peer-1',
      candidate: { candidate: 'new-epoch-candidate', usernameFragment: 'new-epoch' },
    })
    emitWS({ t: 'SIGNAL_ICE_END', fromSessionId: 'peer-1' })

    oldEpochGate.resolve({ type: 'answer', sdp: 'obsolete-epoch' })
    for (let i = 0; i < 30; i++) await Promise.resolve()
    expect(getPendingRemoteIceReservationCount()).toBe(2)

    newEpochGate.resolve({ type: 'answer', sdp: 'new-epoch-blocker-answer' })
    for (let i = 0; i < 50; i++) await Promise.resolve()
    expect(getPendingRemoteIceReservationCount()).toBe(0)

    emitWS({
      t: 'SIGNAL_SDP',
      fromSessionId: 'peer-1',
      fromNodeId: 7,
      sdp: { type: 'offer', sdp: 'v=0\r\na=ice-ufrag:new-epoch\r\n' },
    })
    for (let i = 0; i < 50; i++) await Promise.resolve()

    expect(iceApplicationLog).toEqual(['new-epoch-candidate', 'eoc'])
    expect(getPendingRemoteIceCount()).toBe(0)
    expect(getPendingRemoteIceReservationCount()).toBe(0)
  })

  it('keeps ufrag-absent ICE and EOC inside their receipt negotiation group', async () => {
    const { useNetworkStore, getPendingRemoteIceCount } = await freshStore()
    useNetworkStore.getState().init('tok')
    welcome()
    peerJoined('peer-1', false)
    createAnswerImpl = async (pc, offer) => {
      ;(pc as FakePc).remoteDescription = offer as FakePc['remoteDescription']
      return { type: 'answer', sdp: 'answer' }
    }

    emitWS({
      t: 'SIGNAL_ICE',
      fromSessionId: 'peer-1',
      candidate: { candidate: 'explicit-B', usernameFragment: 'B' },
    })
    emitWS({
      t: 'SIGNAL_ICE',
      fromSessionId: 'peer-1',
      candidate: { candidate: 'absent-after-B' },
    })
    emitWS({ t: 'SIGNAL_ICE_END', fromSessionId: 'peer-1' })
    emitWS({
      t: 'SIGNAL_SDP',
      fromSessionId: 'peer-1',
      fromNodeId: 7,
      sdp: { type: 'offer', sdp: 'v=0\r\na=ice-ufrag:A\r\n' },
    })
    for (let i = 0; i < 30; i++) await Promise.resolve()

    expect(iceApplicationLog).toEqual([])
    expect(getPendingRemoteIceCount()).toBe(1)

    emitWS({
      t: 'SIGNAL_SDP',
      fromSessionId: 'peer-1',
      fromNodeId: 7,
      sdp: { type: 'offer', sdp: 'v=0\r\na=ice-ufrag:B\r\n' },
    })
    for (let i = 0; i < 30; i++) await Promise.resolve()

    expect(iceApplicationLog).toEqual(['explicit-B', 'absent-after-B', 'eoc'])
    expect(getPendingRemoteIceCount()).toBe(0)
  })

  it('matches candidates against media-specific SDP ufrags', async () => {
    const { useNetworkStore, getPendingRemoteIceCount } = await freshStore()
    useNetworkStore.getState().init('tok')
    welcome()
    peerJoined('peer-1', false)
    createAnswerImpl = async (pc, offer) => {
      ;(pc as FakePc).remoteDescription = offer as FakePc['remoteDescription']
      return { type: 'answer', sdp: 'answer' }
    }

    emitWS({
      t: 'SIGNAL_ICE',
      fromSessionId: 'peer-1',
      candidate: {
        candidate: 'audio-candidate',
        usernameFragment: 'audio-u',
        sdpMid: 'audio',
        sdpMLineIndex: 0,
      },
    })
    emitWS({
      t: 'SIGNAL_ICE',
      fromSessionId: 'peer-1',
      candidate: {
        candidate: 'video-candidate',
        usernameFragment: 'video-u',
        sdpMid: 'video',
        sdpMLineIndex: 1,
      },
    })
    emitWS({ t: 'SIGNAL_ICE_END', fromSessionId: 'peer-1' })
    emitWS({
      t: 'SIGNAL_SDP',
      fromSessionId: 'peer-1',
      fromNodeId: 7,
      sdp: {
        type: 'offer',
        sdp: [
          'v=0',
          'm=audio 9 UDP/TLS/RTP/SAVPF 111',
          'a=mid:audio',
          'a=ice-ufrag:audio-u',
          'm=video 9 UDP/TLS/RTP/SAVPF 96',
          'a=mid:video',
          'a=ice-ufrag:video-u',
          '',
        ].join('\r\n'),
      },
    })
    for (let i = 0; i < 40; i++) await Promise.resolve()

    expect(iceApplicationLog).toEqual(['audio-candidate', 'video-candidate', 'eoc'])
    expect(getPendingRemoteIceCount()).toBe(0)
  })

  it('does not globally match a shared ufrag when the candidate locator is absent', async () => {
    const { useNetworkStore, getPendingRemoteIceCount } = await freshStore()
    useNetworkStore.getState().init('tok')
    welcome()
    peerJoined('peer-1', true)
    await settle()

    const pc = created.pcs[0]
    pc.signalingState = 'stable'
    pc.remoteDescription = {
      type: 'answer',
      sdp: [
        'v=0',
        'a=ice-ufrag:shared',
        'm=audio 9 UDP/TLS/RTP/SAVPF 111',
        'a=mid:audio',
        '',
      ].join('\r\n'),
    }
    createAnswerImpl = async (target, offer) => {
      ;(target as FakePc).remoteDescription = offer as FakePc['remoteDescription']
      return { type: 'answer', sdp: 'answer' }
    }
    iceApplicationLog.length = 0

    emitWS({
      t: 'SIGNAL_ICE',
      fromSessionId: 'peer-1',
      candidate: {
        candidate: 'future-video',
        usernameFragment: 'shared',
        sdpMid: 'video',
        sdpMLineIndex: 1,
      },
    })
    for (let i = 0; i < 20; i++) await Promise.resolve()

    expect(iceApplicationLog).toEqual([])
    expect(getPendingRemoteIceCount()).toBe(1)

    emitWS({
      t: 'SIGNAL_SDP',
      fromSessionId: 'peer-1',
      fromNodeId: 7,
      sdp: {
        type: 'offer',
        sdp: [
          'v=0',
          'a=ice-ufrag:shared',
          'm=audio 9 UDP/TLS/RTP/SAVPF 111',
          'a=mid:audio',
          'm=video 9 UDP/TLS/RTP/SAVPF 96',
          'a=mid:video',
          '',
        ].join('\r\n'),
      },
    })
    for (let i = 0; i < 40; i++) await Promise.resolve()

    expect(iceApplicationLog).toEqual(['future-video'])
    expect(getPendingRemoteIceCount()).toBe(0)
  })

  it('keeps absent-ufrag future media in its explicit group until the locator exists', async () => {
    const { useNetworkStore, getPendingRemoteIceCount } = await freshStore()
    useNetworkStore.getState().init('tok')
    welcome()
    peerJoined('peer-1', false)
    createAnswerImpl = async (pc, offer) => {
      ;(pc as FakePc).remoteDescription = offer as FakePc['remoteDescription']
      return { type: 'answer', sdp: 'answer' }
    }

    emitWS({
      t: 'SIGNAL_ICE',
      fromSessionId: 'peer-1',
      candidate: {
        candidate: 'explicit-video-B',
        usernameFragment: 'B',
        sdpMid: 'video',
        sdpMLineIndex: 1,
      },
    })
    emitWS({
      t: 'SIGNAL_ICE',
      fromSessionId: 'peer-1',
      candidate: {
        candidate: 'absent-video-B',
        sdpMid: 'video',
        sdpMLineIndex: 1,
      },
    })
    emitWS({ t: 'SIGNAL_ICE_END', fromSessionId: 'peer-1' })
    emitWS({
      t: 'SIGNAL_SDP',
      fromSessionId: 'peer-1',
      fromNodeId: 7,
      sdp: {
        type: 'offer',
        sdp: [
          'v=0',
          'a=ice-ufrag:B',
          'm=audio 9 UDP/TLS/RTP/SAVPF 111',
          'a=mid:audio',
          '',
        ].join('\r\n'),
      },
    })
    for (let i = 0; i < 50; i++) await Promise.resolve()

    expect(iceApplicationLog).toEqual([])
    expect(getPendingRemoteIceCount()).toBe(1)

    emitWS({
      t: 'SIGNAL_SDP',
      fromSessionId: 'peer-1',
      fromNodeId: 7,
      sdp: {
        type: 'offer',
        sdp: [
          'v=0',
          'a=ice-ufrag:B',
          'm=audio 9 UDP/TLS/RTP/SAVPF 111',
          'a=mid:audio',
          'm=video 9 UDP/TLS/RTP/SAVPF 96',
          'a=mid:video',
          '',
        ].join('\r\n'),
      },
    })
    for (let i = 0; i < 50; i++) await Promise.resolve()

    expect(iceApplicationLog).toEqual(['explicit-video-B', 'absent-video-B', 'eoc'])
    expect(getPendingRemoteIceCount()).toBe(0)
  })

  it('does not apply EOC before an established future-media candidate becomes compatible', async () => {
    const { useNetworkStore, getPendingRemoteIceCount } = await freshStore()
    useNetworkStore.getState().init('tok')
    welcome()
    peerJoined('peer-1', true)
    await settle()

    const pc = created.pcs[0]
    pc.signalingState = 'stable'
    pc.remoteDescription = {
      type: 'answer',
      sdp: [
        'v=0',
        'a=ice-ufrag:B',
        'm=audio 9 UDP/TLS/RTP/SAVPF 111',
        'a=mid:audio',
        '',
      ].join('\r\n'),
    }
    createAnswerImpl = async (target, offer) => {
      ;(target as FakePc).remoteDescription = offer as FakePc['remoteDescription']
      return { type: 'answer', sdp: 'answer' }
    }
    iceApplicationLog.length = 0

    emitWS({
      t: 'SIGNAL_ICE',
      fromSessionId: 'peer-1',
      candidate: {
        candidate: 'established-future-video',
        usernameFragment: 'B',
        sdpMid: 'video',
        sdpMLineIndex: 1,
      },
    })
    emitWS({ t: 'SIGNAL_ICE_END', fromSessionId: 'peer-1' })
    for (let i = 0; i < 30; i++) await Promise.resolve()

    expect(iceApplicationLog).toEqual([])
    expect(getPendingRemoteIceCount()).toBe(1)

    emitWS({
      t: 'SIGNAL_SDP',
      fromSessionId: 'peer-1',
      fromNodeId: 7,
      sdp: {
        type: 'offer',
        sdp: [
          'v=0',
          'a=ice-ufrag:B',
          'm=audio 9 UDP/TLS/RTP/SAVPF 111',
          'a=mid:audio',
          'm=video 9 UDP/TLS/RTP/SAVPF 96',
          'a=mid:video',
          '',
        ].join('\r\n'),
      },
    })
    for (let i = 0; i < 50; i++) await Promise.resolve()

    expect(iceApplicationLog).toEqual(['established-future-video', 'eoc'])
    expect(getPendingRemoteIceCount()).toBe(0)
  })

  it('holds duplicate EOC behind mixed current and future candidates and emits it once', async () => {
    const { useNetworkStore, getPendingRemoteIceCount } = await freshStore()
    useNetworkStore.getState().init('tok')
    welcome()
    peerJoined('peer-1', true)
    await settle()

    const pc = created.pcs[0]
    pc.signalingState = 'stable'
    pc.remoteDescription = {
      type: 'answer',
      sdp: [
        'v=0',
        'a=ice-ufrag:B',
        'm=audio 9 UDP/TLS/RTP/SAVPF 111',
        'a=mid:audio',
        '',
      ].join('\r\n'),
    }
    createAnswerImpl = async (target, offer) => {
      ;(target as FakePc).remoteDescription = offer as FakePc['remoteDescription']
      return { type: 'answer', sdp: 'answer' }
    }
    iceApplicationLog.length = 0

    emitWS({
      t: 'SIGNAL_ICE',
      fromSessionId: 'peer-1',
      candidate: {
        candidate: 'mixed-future-video',
        usernameFragment: 'B',
        sdpMid: 'video',
        sdpMLineIndex: 1,
      },
    })
    emitWS({
      t: 'SIGNAL_ICE',
      fromSessionId: 'peer-1',
      candidate: {
        candidate: 'mixed-current-audio',
        sdpMid: 'audio',
        sdpMLineIndex: 0,
      },
    })
    emitWS({ t: 'SIGNAL_ICE_END', fromSessionId: 'peer-1' })
    emitWS({ t: 'SIGNAL_ICE_END', fromSessionId: 'peer-1' })
    for (let i = 0; i < 40; i++) await Promise.resolve()

    expect(iceApplicationLog).toEqual(['mixed-current-audio'])
    expect(getPendingRemoteIceCount()).toBe(1)

    emitWS({
      t: 'SIGNAL_SDP',
      fromSessionId: 'peer-1',
      fromNodeId: 7,
      sdp: {
        type: 'offer',
        sdp: [
          'v=0',
          'a=ice-ufrag:B',
          'm=audio 9 UDP/TLS/RTP/SAVPF 111',
          'a=mid:audio',
          'm=video 9 UDP/TLS/RTP/SAVPF 96',
          'a=mid:video',
          '',
        ].join('\r\n'),
      },
    })
    for (let i = 0; i < 50; i++) await Promise.resolve()

    expect(iceApplicationLog).toEqual([
      'mixed-current-audio',
      'mixed-future-video',
      'eoc',
    ])
    expect(getPendingRemoteIceCount()).toBe(0)
  })

  it('preserves a future-video EOC locator until that media description is installed', async () => {
    const { useNetworkStore } = await freshStore()
    useNetworkStore.getState().init('tok')
    welcome()
    peerJoined('peer-1', true)
    await settle()

    const pc = created.pcs[0]
    pc.remoteDescription = {
      type: 'answer',
      sdp: [
        'v=0',
        'a=ice-ufrag:B',
        'm=audio 9 UDP/TLS/RTP/SAVPF 111',
        'a=mid:audio',
        '',
      ].join('\r\n'),
    }
    createAnswerImpl = async (target, offer) => {
      ;(target as FakePc).remoteDescription = offer as FakePc['remoteDescription']
      return { type: 'answer', sdp: 'answer' }
    }

    emitWS({
      t: 'SIGNAL_ICE',
      fromSessionId: 'peer-1',
      candidate: {
        candidate: 'future-video-with-eoc',
        usernameFragment: 'B',
        sdpMid: 'video',
        sdpMLineIndex: 1,
      },
    })
    emitWS({
      t: 'SIGNAL_ICE_END',
      fromSessionId: 'peer-1',
      candidate: { candidate: '', sdpMid: 'video', sdpMLineIndex: 1 },
    })
    for (let i = 0; i < 30; i++) await Promise.resolve()
    expect(nativeAddedIceCandidates).toEqual([])

    emitWS({
      t: 'SIGNAL_SDP',
      fromSessionId: 'peer-1',
      fromNodeId: 7,
      sdp: {
        type: 'offer',
        sdp: [
          'v=0',
          'a=ice-ufrag:B',
          'm=audio 9 UDP/TLS/RTP/SAVPF 111',
          'a=mid:audio',
          'm=video 9 UDP/TLS/RTP/SAVPF 96',
          'a=mid:video',
          '',
        ].join('\r\n'),
      },
    })
    for (let i = 0; i < 50; i++) await Promise.resolve()

    expect(iceApplicationLog).toEqual(['future-video-with-eoc', 'eoc'])
    expect(nativeAddedIceCandidates).toEqual([
      { candidate: '', sdpMid: 'video', sdpMLineIndex: 1 },
    ])
  })

  it('applies candidate(s) then one correctly located EOC for each BUNDLE media section', async () => {
    const { useNetworkStore } = await freshStore()
    useNetworkStore.getState().init('tok')
    welcome()
    peerJoined('peer-1', false)
    createAnswerImpl = async (target, offer) => {
      ;(target as FakePc).remoteDescription = offer as FakePc['remoteDescription']
      return { type: 'answer', sdp: 'answer' }
    }

    for (const [candidate, sdpMid, sdpMLineIndex] of [
      ['bundle-audio', 'audio', 0],
      ['bundle-video', 'video', 1],
    ] as const) {
      emitWS({
        t: 'SIGNAL_ICE',
        fromSessionId: 'peer-1',
        candidate: { candidate, usernameFragment: 'B', sdpMid, sdpMLineIndex },
      })
    }
    emitWS({
      t: 'SIGNAL_ICE_END',
      fromSessionId: 'peer-1',
      candidate: { candidate: '', sdpMid: 'audio', sdpMLineIndex: 0 },
    })
    emitWS({
      t: 'SIGNAL_ICE_END',
      fromSessionId: 'peer-1',
      candidate: { candidate: '', sdpMid: 'video', sdpMLineIndex: 1 },
    })
    emitWS({
      t: 'SIGNAL_SDP',
      fromSessionId: 'peer-1',
      fromNodeId: 7,
      sdp: {
        type: 'offer',
        sdp: [
          'v=0',
          'a=group:BUNDLE audio video',
          'a=ice-ufrag:B',
          'm=audio 9 UDP/TLS/RTP/SAVPF 111',
          'a=mid:audio',
          'm=video 9 UDP/TLS/RTP/SAVPF 96',
          'a=mid:video',
          '',
        ].join('\r\n'),
      },
    })
    for (let i = 0; i < 60; i++) await Promise.resolve()

    expect(iceApplicationLog).toEqual(['bundle-audio', 'bundle-video', 'eoc', 'eoc'])
    expect(nativeAddedIceCandidates).toEqual([
      { candidate: '', sdpMid: 'audio', sdpMLineIndex: 0 },
      { candidate: '', sdpMid: 'video', sdpMLineIndex: 1 },
    ])
  })

  it('keeps audio/A and video/B EOC markers in their own ICE-generation groups', async () => {
    const { useNetworkStore } = await freshStore()
    useNetworkStore.getState().init('tok')
    welcome()
    peerJoined('peer-1', false)
    createAnswerImpl = async (target, offer) => {
      ;(target as FakePc).remoteDescription = offer as FakePc['remoteDescription']
      return { type: 'answer', sdp: 'answer' }
    }

    emitWS({
      t: 'SIGNAL_ICE',
      fromSessionId: 'peer-1',
      candidate: {
        candidate: 'audio-A',
        usernameFragment: 'A',
        sdpMid: 'audio',
        sdpMLineIndex: 0,
      },
    })
    emitWS({
      t: 'SIGNAL_ICE',
      fromSessionId: 'peer-1',
      candidate: {
        candidate: 'video-B',
        usernameFragment: 'B',
        sdpMid: 'video',
        sdpMLineIndex: 1,
      },
    })
    emitWS({
      t: 'SIGNAL_ICE_END',
      fromSessionId: 'peer-1',
      candidate: {
        candidate: '',
        usernameFragment: 'A',
        sdpMid: 'audio',
        sdpMLineIndex: 0,
      },
    })
    emitWS({
      t: 'SIGNAL_ICE_END',
      fromSessionId: 'peer-1',
      candidate: {
        candidate: '',
        usernameFragment: 'B',
        sdpMid: 'video',
        sdpMLineIndex: 1,
      },
    })
    emitWS({
      t: 'SIGNAL_SDP',
      fromSessionId: 'peer-1',
      fromNodeId: 7,
      sdp: {
        type: 'offer',
        sdp: [
          'v=0',
          'm=audio 9 UDP/TLS/RTP/SAVPF 111',
          'a=mid:audio',
          'a=ice-ufrag:A',
          'm=video 9 UDP/TLS/RTP/SAVPF 96',
          'a=mid:video',
          'a=ice-ufrag:B',
          '',
        ].join('\r\n'),
      },
    })
    for (let i = 0; i < 60; i++) await Promise.resolve()

    expect(iceApplicationLog).toEqual(['audio-A', 'eoc', 'video-B', 'eoc'])
    expect(nativeAddedIceCandidates).toEqual([
      {
        candidate: '',
        usernameFragment: 'A',
        sdpMid: 'audio',
        sdpMLineIndex: 0,
      },
      {
        candidate: '',
        usernameFragment: 'B',
        sdpMid: 'video',
        sdpMLineIndex: 1,
      },
    ])
  })

  it('buffers a candidate-less restart EOC until its new ufrag is installed', async () => {
    const { useNetworkStore, getPendingRemoteIceCount } = await freshStore()
    useNetworkStore.getState().init('tok')
    welcome()
    peerJoined('peer-1', true)
    await settle()

    const pc = created.pcs[0]
    pc.remoteDescription = {
      type: 'answer',
      sdp: [
        'v=0',
        'm=audio 9 UDP/TLS/RTP/SAVPF 111',
        'a=mid:audio',
        'a=ice-ufrag:A',
        '',
      ].join('\r\n'),
    }
    createAnswerImpl = async (target, offer) => {
      ;(target as FakePc).remoteDescription = offer as FakePc['remoteDescription']
      return { type: 'answer', sdp: 'answer' }
    }

    emitWS({
      t: 'SIGNAL_ICE_END',
      fromSessionId: 'peer-1',
      candidate: {
        candidate: '',
        usernameFragment: 'B',
        sdpMid: 'audio',
        sdpMLineIndex: 0,
      },
    })
    for (let i = 0; i < 30; i++) await Promise.resolve()
    expect(nativeAddedIceCandidates).toEqual([])
    expect(getPendingRemoteIceCount()).toBe(1)

    emitWS({
      t: 'SIGNAL_SDP',
      fromSessionId: 'peer-1',
      fromNodeId: 7,
      sdp: {
        type: 'offer',
        sdp: [
          'v=0',
          'm=audio 9 UDP/TLS/RTP/SAVPF 111',
          'a=mid:audio',
          'a=ice-ufrag:B',
          '',
        ].join('\r\n'),
      },
    })
    for (let i = 0; i < 50; i++) await Promise.resolve()

    expect(nativeAddedIceCandidates).toEqual([{
      candidate: '',
      usernameFragment: 'B',
      sdpMid: 'audio',
      sdpMLineIndex: 0,
    }])
    expect(getPendingRemoteIceCount()).toBe(0)
  })

  it('reconciles mid/index aliases to one EOC and rejects conflicting BUNDLE locators', async () => {
    const { useNetworkStore } = await freshStore()
    useNetworkStore.getState().init('tok')
    welcome()
    peerJoined('peer-1', false)
    createAnswerImpl = async (target, offer) => {
      ;(target as FakePc).remoteDescription = offer as FakePc['remoteDescription']
      return { type: 'answer', sdp: 'answer' }
    }

    for (const candidate of [
      { candidate: '', usernameFragment: 'B', sdpMid: 'audio' },
      { candidate: '', usernameFragment: 'B', sdpMLineIndex: 0 },
      { candidate: '', usernameFragment: 'B', sdpMid: 'audio', sdpMLineIndex: 0 },
      // Under BUNDLE this has the same ufrag, but its mid and index identify
      // different media sections and must never be accepted.
      { candidate: '', usernameFragment: 'B', sdpMid: 'audio', sdpMLineIndex: 1 },
    ]) {
      emitWS({ t: 'SIGNAL_ICE_END', fromSessionId: 'peer-1', candidate })
    }
    emitWS({
      t: 'SIGNAL_SDP',
      fromSessionId: 'peer-1',
      fromNodeId: 7,
      sdp: {
        type: 'offer',
        sdp: [
          'v=0',
          'a=group:BUNDLE audio video',
          'a=ice-ufrag:B',
          'm=audio 9 UDP/TLS/RTP/SAVPF 111',
          'a=mid:audio',
          'm=video 9 UDP/TLS/RTP/SAVPF 96',
          'a=mid:video',
          '',
        ].join('\r\n'),
      },
    })
    for (let i = 0; i < 60; i++) await Promise.resolve()

    expect(nativeAddedIceCandidates).toEqual([{
      candidate: '',
      usernameFragment: 'B',
      sdpMid: 'audio',
      sdpMLineIndex: 0,
    }])
  })

  it('rejects conflicting absent-ufrag locators but accepts locator-less same-group ICE', async () => {
    const { useNetworkStore, getPendingRemoteIceCount } = await freshStore()
    useNetworkStore.getState().init('tok')
    welcome()
    peerJoined('peer-1', false)
    createAnswerImpl = async (pc, offer) => {
      ;(pc as FakePc).remoteDescription = offer as FakePc['remoteDescription']
      return { type: 'answer', sdp: 'answer' }
    }

    emitWS({
      t: 'SIGNAL_ICE',
      fromSessionId: 'peer-1',
      candidate: {
        candidate: 'explicit-video',
        usernameFragment: 'B',
        sdpMid: 'video',
        sdpMLineIndex: 1,
      },
    })
    emitWS({
      t: 'SIGNAL_ICE',
      fromSessionId: 'peer-1',
      candidate: { candidate: 'locator-less-same-group' },
    })
    emitWS({
      t: 'SIGNAL_ICE',
      fromSessionId: 'peer-1',
      candidate: {
        candidate: 'conflicting-locators',
        sdpMid: 'video',
        sdpMLineIndex: 0,
      },
    })
    emitWS({ t: 'SIGNAL_ICE_END', fromSessionId: 'peer-1' })
    emitWS({
      t: 'SIGNAL_SDP',
      fromSessionId: 'peer-1',
      fromNodeId: 7,
      sdp: {
        type: 'offer',
        sdp: [
          'v=0',
          'm=audio 9 UDP/TLS/RTP/SAVPF 111',
          'a=mid:audio',
          'a=ice-ufrag:A',
          'm=video 9 UDP/TLS/RTP/SAVPF 96',
          'a=mid:video',
          'a=ice-ufrag:B',
          '',
        ].join('\r\n'),
      },
    })
    for (let i = 0; i < 50; i++) await Promise.resolve()

    expect(iceApplicationLog).toEqual(['explicit-video', 'locator-less-same-group'])
    expect(getPendingRemoteIceCount()).toBe(1)

    emitWS({
      t: 'SIGNAL_SDP',
      fromSessionId: 'peer-1',
      fromNodeId: 7,
      sdp: {
        type: 'offer',
        sdp: [
          'v=0',
          'm=video 9 UDP/TLS/RTP/SAVPF 96',
          'a=mid:video',
          'a=ice-ufrag:B',
          '',
        ].join('\r\n'),
      },
    })
    for (let i = 0; i < 50; i++) await Promise.resolve()

    expect(iceApplicationLog).toEqual([
      'explicit-video',
      'locator-less-same-group',
      'conflicting-locators',
      'eoc',
    ])
    expect(getPendingRemoteIceCount()).toBe(0)
  })

  it('rebinds matching remote-offer ICE after a polite glare rollback', async () => {
    const { useNetworkStore, getPendingRemoteIceCount } = await freshStore()
    useNetworkStore.getState().init('tok')
    welcome('a-session')
    peerJoined('z-session', true)
    await settle()

    const pc = created.pcs[0]
    pc.remoteDescription = { type: 'answer', sdp: 'v=0\r\na=ice-ufrag:old\r\n' }
    pc.signalingState = 'stable'
    pc.setLocalDescription = async (description: unknown) => {
      const desc = description as { type?: string; sdp?: string }
      if (desc.type === 'rollback') {
        pc.signalingState = 'stable'
        pc.localDescription = null
        return
      }
      pc.signalingState = 'have-local-offer'
      pc.localDescription = {
        type: desc.type ?? 'offer',
        sdp: desc.sdp ?? 'restart',
        toJSON: () => description,
      }
    }
    createAnswerImpl = async (target, offer) => {
      ;(target as FakePc).remoteDescription = offer as FakePc['remoteDescription']
      ;(target as FakePc).signalingState = 'stable'
      return { type: 'answer', sdp: 'glare-answer' }
    }
    iceApplicationLog.length = 0

    emitWS({
      t: 'SIGNAL_ICE',
      fromSessionId: 'z-session',
      candidate: { candidate: 'glare-candidate', usernameFragment: 'glare' },
    })
    emitWS({ t: 'SIGNAL_ICE_END', fromSessionId: 'z-session' })
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect(getPendingRemoteIceCount()).toBe(1)

    applyIceConfigResult = [pc]
    turnConfigListeners.forEach(listener => listener())
    await vi.advanceTimersByTimeAsync(301)
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect(pc.signalingState).toBe('have-local-offer')

    emitWS({
      t: 'SIGNAL_SDP',
      fromSessionId: 'z-session',
      fromNodeId: 7,
      sdp: { type: 'offer', sdp: 'v=0\r\na=ice-ufrag:glare\r\n' },
    })
    for (let i = 0; i < 50; i++) await Promise.resolve()

    expect(iceApplicationLog).toEqual(['glare-candidate', 'eoc'])
    expect(getPendingRemoteIceCount()).toBe(0)
  })

  it('rejects new pending ICE overflow while preserving the oldest accepted data', async () => {
    const {
      useNetworkStore,
      getPendingRemoteIceCount,
      getPendingRemoteIceCandidateCount,
      getPendingRemoteIceOverflowState,
      getPendingSignalingQueueCount,
    } = await freshStore()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    useNetworkStore.getState().init('tok')
    welcome()
    peerJoined('peer-1', false)
    createAnswerImpl = async (pc, offer) => {
      ;(pc as FakePc).remoteDescription = offer as FakePc['remoteDescription']
      return { type: 'answer', sdp: 'answer' }
    }

    for (let i = 0; i < 9; i++) {
      emitWS({
        t: 'SIGNAL_ICE',
        fromSessionId: 'peer-1',
        candidate: { candidate: `candidate-${i}`, usernameFragment: `ufrag-${i}` },
      })
    }
    for (let i = 0; i < 30; i++) await Promise.resolve()

    expect(getPendingRemoteIceCount()).toBe(8)
    for (let i = 0; i < 256; i++) {
      emitWS({
        t: 'SIGNAL_ICE',
        fromSessionId: 'peer-1',
        candidate: { candidate: `overflow-${i}`, usernameFragment: 'ufrag-0' },
      })
    }
    for (let i = 0; i < 2_000 && getPendingSignalingQueueCount() > 0; i++) {
      await Promise.resolve()
    }
    expect(getPendingSignalingQueueCount()).toBe(0)
    expect(getPendingRemoteIceCandidateCount()).toBe(263)
    expect(getPendingRemoteIceOverflowState('peer-1')).toMatchObject({
      groupDrops: 1,
      candidateDrops: 1,
    })

    emitWS({
      t: 'SIGNAL_SDP',
      fromSessionId: 'peer-1',
      fromNodeId: 7,
      sdp: { type: 'offer', sdp: 'v=0\r\na=ice-ufrag:ufrag-0\r\n' },
    })
    for (let i = 0; i < 2_000 && getPendingSignalingQueueCount() > 0; i++) {
      await Promise.resolve()
    }
    expect(iceApplicationLog).toContain('candidate-0')
    expect(iceApplicationLog).toContain('overflow-254')
    expect(iceApplicationLog).not.toContain('candidate-8')
    expect(iceApplicationLog).not.toContain('overflow-255')

    useNetworkStore.getState().destroy()
    expect(getPendingRemoteIceCount()).toBe(0)
    expect(getPendingRemoteIceCandidateCount()).toBe(0)
    expect(getPendingRemoteIceOverflowState('peer-1')).toBeNull()
    expect(warn).toHaveBeenCalledWith(
      '[net] pending remote ICE overflow',
      'peer-1',
      expect.objectContaining({ kind: 'group' }),
    )
    warn.mockRestore()
  })
})

describe('media-scoped outbound end-of-candidates', () => {
  it('signals one located EOC marker for each local m-line', async () => {
    const { useNetworkStore } = await freshStore()
    useNetworkStore.getState().init('tok')
    welcome()
    peerJoined('peer-1', true)
    await settle()

    const pc = created.pcs[0]
    pc.localDescription = {
      type: 'offer',
      sdp: [
        'v=0',
        'a=group:BUNDLE audio video',
        'm=audio 9 UDP/TLS/RTP/SAVPF 111',
        'a=mid:audio',
        'm=video 9 UDP/TLS/RTP/SAVPF 96',
        'a=mid:video',
        '',
      ].join('\r\n'),
      toJSON: () => ({}),
    }
    signalingHandlers.sent.length = 0

    pc.onicecandidate?.({ candidate: null } as never)

    expect(signalingHandlers.sent).toEqual([
      {
        t: 'SIGNAL_ICE_END',
        targetSessionId: 'peer-1',
        candidate: { candidate: '', sdpMid: 'audio', sdpMLineIndex: 0 },
      },
      {
        t: 'SIGNAL_ICE_END',
        targetSessionId: 'peer-1',
        candidate: { candidate: '', sdpMid: 'video', sdpMLineIndex: 1 },
      },
    ])
  })
})

describe('stale negotiation attempt identity', () => {
  it('ignores answerer datachannel and ICE callbacks after its PC is replaced', async () => {
    const { useNetworkStore } = await freshStore()
    useNetworkStore.getState().init('tok')
    welcome()
    peerJoined('peer-1', false)
    emitWS({
      t: 'SIGNAL_SDP',
      fromSessionId: 'peer-1',
      fromNodeId: 7,
      sdp: { type: 'offer', sdp: 'answerer-origin' },
    })
    await settle()

    const stalePc = created.pcs[0]
    await useNetworkStore.getState().reconnectPeer('peer-1')
    const currentPrimary = created.dcs.filter(dc => dc.label === 'misaka').at(-1)!
    currentPrimary.send.mockClear()
    signalingHandlers.sent.length = 0

    const stalePrimary = makeFakeDc('misaka')
    stalePc.ondatachannel?.({ channel: stalePrimary } as never)
    stalePc.onicecandidate?.({
      candidate: { toJSON: () => ({ candidate: 'stale-answerer-candidate' }) },
    } as never)
    stalePc.onicecandidate?.({ candidate: null } as never)
    useNetworkStore.getState().sendChatMessage('peer-1', 'current channel only')

    expect(stalePrimary.send).not.toHaveBeenCalled()
    expect(currentPrimary.send).toHaveBeenCalledWith(expect.stringContaining('current channel only'))
    expect(signalingHandlers.sent).toEqual([])
  })

  it('ignores offerer ICE callbacks after its PC is replaced', async () => {
    const { useNetworkStore } = await freshStore()
    useNetworkStore.getState().init('tok')
    welcome()
    peerJoined('peer-1', true)
    await settle()

    const stalePc = created.pcs[0]
    await useNetworkStore.getState().reconnectPeer('peer-1')
    signalingHandlers.sent.length = 0

    stalePc.onicecandidate?.({
      candidate: { toJSON: () => ({ candidate: 'stale-offerer-candidate' }) },
    } as never)
    stalePc.onicecandidate?.({ candidate: null } as never)

    expect(signalingHandlers.sent).toEqual([])
  })

  it('drops an outbound offer whose key generation resumes after replacement', async () => {
    const { useNetworkStore } = await freshStore()
    const oldKeyGate = deferred<void>()
    let keyCalls = 0
    generateECDHKeyPairImpl = async () => {
      keyCalls++
      if (keyCalls === 1) await oldKeyGate.promise
    }
    useNetworkStore.getState().init('tok')
    welcome()
    peerJoined('peer-1', true)
    for (let i = 0; i < 5; i++) await Promise.resolve()
    expect(created.pcs).toHaveLength(1)

    const replacement = useNetworkStore.getState().reconnectPeer('peer-1')
    for (let i = 0; i < 5; i++) await Promise.resolve()
    await replacement
    const currentFrames = [...sdpFrames()]

    oldKeyGate.resolve()
    for (let i = 0; i < 10; i++) await Promise.resolve()

    expect(created.pcs[0].connectionState).toBe('closed')
    expect(sdpFrames()).toEqual(currentFrames)
    expect(currentFrames).toHaveLength(1)
  })

  it('drops an outbound offer created after its PC is replaced', async () => {
    const { useNetworkStore } = await freshStore()
    const oldOfferGate = deferred<unknown>()
    let offerCalls = 0
    createOfferImpl = async () => {
      offerCalls++
      if (offerCalls === 1) return oldOfferGate.promise
      return { type: 'offer', sdp: 'replacement-offer' }
    }
    useNetworkStore.getState().init('tok')
    welcome()
    peerJoined('peer-1', true)
    for (let i = 0; i < 10; i++) await Promise.resolve()

    const replacement = useNetworkStore.getState().reconnectPeer('peer-1')
    for (let i = 0; i < 10; i++) await Promise.resolve()
    await replacement
    oldOfferGate.resolve({ type: 'offer', sdp: 'stale-offer' })
    for (let i = 0; i < 10; i++) await Promise.resolve()

    expect(sdpFrames().map(frame => (frame.sdp as { sdp?: string }).sdp))
      .toEqual(['replacement-offer'])
  })

  it('does not send an answer created after the answerer PC is replaced', async () => {
    const { useNetworkStore } = await freshStore()
    const oldAnswerGate = deferred<unknown>()
    createAnswerImpl = async () => oldAnswerGate.promise
    useNetworkStore.getState().init('tok')
    welcome()
    peerJoined('peer-1', false)
    emitWS({
      t: 'SIGNAL_SDP',
      fromSessionId: 'peer-1',
      fromNodeId: 7,
      sdp: { type: 'offer', sdp: 'delayed-answer' },
    })
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(created.pcs).toHaveLength(1)

    createAnswerImpl = async () => ({ type: 'answer', sdp: 'replacement-answer' })
    await useNetworkStore.getState().reconnectPeer('peer-1')
    oldAnswerGate.resolve({ type: 'answer', sdp: 'stale-answer' })
    for (let i = 0; i < 10; i++) await Promise.resolve()

    expect(sdpFrames().some(frame => (frame.sdp as { sdp?: string }).sdp === 'stale-answer'))
      .toBe(false)
  })

  it('does not let a stale reconnect rejection mark a newer attempt offline', async () => {
    const { useNetworkStore } = await freshStore()
    const staleOfferGate = deferred<unknown>()
    let offerCalls = 0
    createOfferImpl = async () => {
      offerCalls++
      if (offerCalls === 1) return staleOfferGate.promise
      return { type: 'offer', sdp: 'new-success' }
    }
    useNetworkStore.getState().init('tok')
    welcome()
    useNetworkStore.setState({
      peers: [{
        sessionId: 'peer-1',
        nodeId: 99,
        status: 'offline',
        channelType: 'direct',
        joinedAt: Date.now(),
      }],
    })

    const staleReconnect = useNetworkStore.getState().reconnectPeer('peer-1')
    for (let i = 0; i < 10; i++) await Promise.resolve()
    await useNetworkStore.getState().reconnectPeer('peer-1')
    useNetworkStore.setState(s => ({
      peers: s.peers.map(peer => ({ ...peer, status: 'online' as const })),
    }))

    staleOfferGate.reject(new Error('stale reconnect failed'))
    await staleReconnect

    expect(useNetworkStore.getState().peers[0].status).toBe('online')
  })
})

// ── BUG-007 ────────────────────────────────────────────────────────────

describe('BUG-007: a delayed ICE restart must not act on a replaced connection', () => {
  it('drops delayed ICE stats from a PeerConnection replaced during the await', async () => {
    const { useNetworkStore } = await freshStore()
    useNetworkStore.getState().init('tok')
    welcome()
    peerJoined('peer-1', true)
    await vi.advanceTimersByTimeAsync(1)

    let releaseStats!: (value: unknown) => void
    selectedIcePathImpl = () => new Promise(resolve => { releaseStats = resolve })
    const stale = created.pcs[0]
    stale.iceConnectionState = 'connected'
    stale.oniceconnectionstatechange?.()
    await Promise.resolve()

    await useNetworkStore.getState().reconnectPeer('peer-1')
    useNetworkStore.setState(s => ({
      peers: s.peers.map(peer => ({
        ...peer,
        status: 'connecting' as const,
        icePath: undefined,
        icePathMeasuredAt: undefined,
      })),
      connectedPeers: new Set(),
    }))

    releaseStats({ channelType: 'relay', pathText: 'stale relay path' })
    for (let i = 0; i < 5; i++) await Promise.resolve()

    expect(stale.connectionState).toBe('closed')
    expect(useNetworkStore.getState().peers[0].status).toBe('connecting')
    expect(useNetworkStore.getState().peers[0].icePath).toBeUndefined()
    expect(useNetworkStore.getState().connectedPeers.has('peer-1')).toBe(false)
  })

  it('drops the restart when the peer was removed during the backoff', async () => {
    const { useNetworkStore } = await freshStore()
    useNetworkStore.getState().init('tok')
    welcome()
    peerJoined('peer-1', true)
    await settle()

    const pc = created.pcs[0]
    const sdpBefore = sdpFrames().length

    // ICE fails → attemptIceRestart schedules itself behind a backoff delay.
    pc.iceConnectionState = 'failed'
    pc.oniceconnectionstatechange?.()

    // …and the peer is blocked (removed from the roster + torn down) while
    // we're waiting out the backoff.
    useNetworkStore.getState().blockPeer('peer-1')
    await settle()

    // No restart offer for a peer that is gone, and no resurrection of the
    // peer row into 'reconnecting'.
    expect(sdpFrames().length).toBe(sdpBefore)
    expect(useNetworkStore.getState().peers.find(p => p.sessionId === 'peer-1')).toBeUndefined()
    expect(pc.createOffer).not.toHaveBeenCalled()
  })

  it('drops the restart when the PeerConnection was replaced during the backoff', async () => {
    const { useNetworkStore } = await freshStore()
    useNetworkStore.getState().init('tok')
    welcome()
    peerJoined('peer-1', true)
    await settle()

    const stale = created.pcs[0]
    stale.iceConnectionState = 'failed'
    stale.oniceconnectionstatechange?.()

    // A manual reconnect replaces the PC before the backoff elapses.
    void useNetworkStore.getState().reconnectPeer('peer-1')
    await settle()

    // The old PC must not have produced a restart offer on the new epoch.
    expect(stale.createOffer).not.toHaveBeenCalled()
    expect(livePcs().length).toBe(1)
  })
})

describe('encrypted-ready publication boundary', () => {
  it('does not publish connected or recovered when DataChannel opens but ECDH export fails', async () => {
    const { useNetworkStore } = await freshStore()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    hasAESKeyResult = false
    getMyPublicKeyImpl = async () => { throw new Error('ECDH unavailable') }
    resetTurnGate(false)
    useNetworkStore.getState().init('tok')
    welcome()
    peerJoined('peer-1', true)
    await vi.advanceTimersByTimeAsync(1)
    useNetworkStore.setState({
      chatMessages: {
        'peer-1': [{
          id: 'prior',
          type: 'text',
          content: 'before reconnect',
          timestamp: Date.now(),
          direction: 'sent',
        }],
      },
    })

    turnGate.release()
    for (let i = 0; i < 10; i++) await Promise.resolve()

    expect(useNetworkStore.getState().peers[0].status).toBe('connecting')
    expect(useNetworkStore.getState().connectedPeers.has('peer-1')).toBe(false)
    expect(useNetworkStore.getState().chatMessages['peer-1']
      .some(message => message.content.includes('连接已恢复'))).toBe(false)
    expect(warn).toHaveBeenCalledWith('[net] ecdh-pub send failed', expect.any(Error))
    warn.mockRestore()
  })
})

describe('initial ICE checking recovery', () => {
  it('bounds an outbound attempt even when key generation never resolves', async () => {
    const { useNetworkStore } = await freshStore()
    hasAESKeyResult = false
    generateECDHKeyPairImpl = async () => new Promise<void>(() => {})
    useNetworkStore.getState().init('tok')
    welcome('a-session')
    peerJoined('z-session', true)
    await vi.advanceTimersByTimeAsync(1)

    const pc = created.pcs[0]
    pc.iceConnectionState = 'new'
    await vi.advanceTimersByTimeAsync(16_002)

    expect(pc.createOffer).toHaveBeenCalledWith({ iceRestart: true })
    expect(useNetworkStore.getState().peers[0].status).toBe('offline')
  })

  it('bounds a negotiation that never advances from the initial ICE state', async () => {
    const { useNetworkStore } = await freshStore()
    hasAESKeyResult = false
    useNetworkStore.getState().init('tok')
    welcome('a-session')
    peerJoined('z-session', true)
    await vi.advanceTimersByTimeAsync(1)

    const pc = created.pcs[0]
    pc.iceConnectionState = 'new'
    await vi.advanceTimersByTimeAsync(16_002)

    expect(pc.createOffer).toHaveBeenCalledWith({ iceRestart: true })
    expect(useNetworkStore.getState().peers[0].status).toBe('offline')
  })

  it('keeps the watchdog armed when ICE connects but encryption never becomes ready', async () => {
    const { useNetworkStore } = await freshStore()
    hasAESKeyResult = false
    useNetworkStore.getState().init('tok')
    welcome('a-session')
    peerJoined('z-session', true)
    await vi.advanceTimersByTimeAsync(1)

    const pc = created.pcs[0]
    pc.iceConnectionState = 'connected'
    pc.oniceconnectionstatechange?.()
    await vi.advanceTimersByTimeAsync(16_002)

    expect(pc.connectionState).toBe('closed')
    expect(pc.createOffer).not.toHaveBeenCalled()
    expect(livePcs()).toHaveLength(1)
    expect(useNetworkStore.getState().peers[0].status).toBe('offline')
  })

  it('rebuilds a connected but unencrypted session instead of restarting ICE on wedged SCTP', async () => {
    const { useNetworkStore } = await freshStore()
    hasAESKeyResult = false
    useNetworkStore.getState().init('tok')
    welcome('a-session')
    peerJoined('z-session', true)
    await vi.advanceTimersByTimeAsync(1)

    const stale = created.pcs[0]
    stale.iceConnectionState = 'connected'
    stale.oniceconnectionstatechange?.()
    const before = sdpFrames().length
    await vi.advanceTimersByTimeAsync(8_001)
    for (let i = 0; i < 10; i++) await Promise.resolve()

    expect(stale.connectionState).toBe('closed')
    expect(stale.createOffer).not.toHaveBeenCalled()
    expect(livePcs()).toHaveLength(1)
    expect(livePcs()[0]).not.toBe(stale)
    expect(sdpFrames()).toHaveLength(before + 1)
  })

  it('lets only the deterministic polite side restart a connection stuck in checking', async () => {
    const { useNetworkStore } = await freshStore()
    hasAESKeyResult = false
    useNetworkStore.getState().init('tok')
    welcome('a-session')
    peerJoined('z-session', true)
    await vi.advanceTimersByTimeAsync(1)

    const pc = created.pcs[0]
    const before = sdpFrames().length
    pc.iceConnectionState = 'checking'
    pc.oniceconnectionstatechange?.()
    await vi.advanceTimersByTimeAsync(8_001)

    expect(pc.createOffer).toHaveBeenCalledWith({ iceRestart: true })
    expect(sdpFrames().length).toBe(before + 1)
  })

  it('does not restart from the impolite side and create glare', async () => {
    const { useNetworkStore } = await freshStore()
    hasAESKeyResult = false
    useNetworkStore.getState().init('tok')
    welcome('z-session')
    peerJoined('a-session', true)
    await vi.advanceTimersByTimeAsync(1)

    const pc = created.pcs[0]
    const before = sdpFrames().length
    pc.iceConnectionState = 'checking'
    pc.oniceconnectionstatechange?.()
    await vi.advanceTimersByTimeAsync(8_001)

    expect(pc.createOffer).not.toHaveBeenCalled()
    expect(sdpFrames().length).toBe(before)
    expect(useNetworkStore.getState().peers[0].status).toBe('connecting')
  })

  it('surfaces an actionable offline state when the guarded restart throws', async () => {
    const { useNetworkStore } = await freshStore()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    hasAESKeyResult = false
    useNetworkStore.getState().init('tok')
    welcome('a-session')
    peerJoined('z-session', true)
    await vi.advanceTimersByTimeAsync(1)

    const pc = created.pcs[0]
    pc.createOffer.mockRejectedValueOnce(new Error('restart failed'))
    pc.iceConnectionState = 'checking'
    pc.oniceconnectionstatechange?.()
    await vi.advanceTimersByTimeAsync(8_001)

    expect(useNetworkStore.getState().peers[0].status).toBe('offline')
    expect(warn).toHaveBeenCalledWith(
      '[net] initial ICE recovery failed',
      'z-session',
      expect.any(Error),
    )
    warn.mockRestore()
  })

  it('re-observes an ineffective restart, then exposes the real retry affordance', async () => {
    const { useNetworkStore } = await freshStore()
    hasAESKeyResult = false
    useNetworkStore.getState().init('tok')
    welcome('a-session')
    peerJoined('z-session', true)
    await vi.advanceTimersByTimeAsync(1)

    const pc = created.pcs[0]
    pc.iceConnectionState = 'checking'
    pc.oniceconnectionstatechange?.()
    await vi.advanceTimersByTimeAsync(8_001)
    expect(pc.createOffer).toHaveBeenCalledWith({ iceRestart: true })
    expect(useNetworkStore.getState().peers[0].status).toBe('connecting')

    await vi.advanceTimersByTimeAsync(8_001)
    expect(useNetworkStore.getState().peers[0].status).toBe('offline')
  })

  it('cancels recovery when ICE connects and ignores a stale epoch', async () => {
    const { useNetworkStore } = await freshStore()
    hasAESKeyResult = false
    useNetworkStore.getState().init('tok')
    welcome('a-session')
    peerJoined('z-session', true)
    await vi.advanceTimersByTimeAsync(1)

    const pc = created.pcs[0]
    pc.iceConnectionState = 'checking'
    pc.oniceconnectionstatechange?.()
    hasAESKeyResult = true
    pc.iceConnectionState = 'connected'
    pc.oniceconnectionstatechange?.()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(pc.createOffer).not.toHaveBeenCalled()

    pc.iceConnectionState = 'checking'
    pc.oniceconnectionstatechange?.()
    useNetworkStore.getState().destroy()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(pc.createOffer).not.toHaveBeenCalled()
    expect(useNetworkStore.getState().peers).toEqual([])
  })
})

// ── 13th independent review: Findings 1-2 ───────────────────────────────
//
//   Finding 1  the encrypted-session rebuild's `.catch()` used to resolve its
//              own identity DYNAMICALLY (`networkEpoch` / `peerGeneration()`
//              read at rejection time instead of frozen at rebuild start),
//              so a late rejection always looked "current" to itself and
//              could act on a connection it no longer had any business
//              touching. It also silently did nothing when `initiateWebRTC`
//              rejected before ever creating a replacement PC, leaving the
//              peer stuck at 'connecting' forever with no watchdog.
//   Finding 2  `blockPeer()` tore the PC down but never cleared the one-shot
//              `initialEncryptedSessionRebuilds` guard, so a later rejoin
//              under the same sessionId could never arm recovery again.

describe('Finding 1: rebuild rejection identity and the no-PC failure path', () => {
  it('reaches the actionable offline state (never stuck at connecting) when initiateWebRTC rejects before creating any PC', async () => {
    const { useNetworkStore } = await freshStore()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    hasAESKeyResult = false
    useNetworkStore.getState().init('tok')
    welcome('a-session')
    peerJoined('z-session', true)
    await vi.advanceTimersByTimeAsync(1)

    const stale = created.pcs[0]
    stale.iceConnectionState = 'connected'
    stale.oniceconnectionstatechange?.()

    // Break signaling readiness right as the rebuild is about to fire, so its
    // `initiateWebRTC()` call rejects (signaling-not-ready timeout) before it
    // ever creates a replacement PeerConnection.
    useNetworkStore.setState({ signalingStatus: 'connecting' })

    // INITIAL_ICE_RECOVERY_MS (8s) fires the rebuild; SIGNALING_READY_TIMEOUT_MS
    // (8s) then times out `whenSignalingReady()` inside the rebuild's own
    // `initiateWebRTC()` call, which throws before ever building a PC.
    await vi.advanceTimersByTimeAsync(16_002)

    expect(created.pcs.length).toBe(1)       // no replacement PC was ever created
    expect(livePcs().length).toBe(0)         // the stale one was torn down
    expect(useNetworkStore.getState().peers[0].status).toBe('offline')
    expect(useNetworkStore.getState().peers[0].status).not.toBe('connecting')
    expect(useNetworkStore.getState().connectedPeers.has('z-session')).toBe(false)
    expect(warn).toHaveBeenCalledWith(
      '[net] initial encrypted-session rebuild failed',
      'z-session',
      expect.any(Error),
    )
    warn.mockRestore()
  })

  it('ignores a stale rebuild rejection once a newer, manually-created replacement connection has taken over the peer', async () => {
    const { useNetworkStore } = await freshStore()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    hasAESKeyResult = false

    // generateECDHKeyPair is called once per initiateWebRTC attempt: #1 is
    // the original connection, #2 is the rebuild we are about to freeze mid-
    // flight, #3+ is the manual reconnect that supersedes it.
    let ecdhCallCount = 0
    let rejectStaleEcdh: ((err: unknown) => void) | null = null
    generateECDHKeyPairImpl = async () => {
      ecdhCallCount++
      if (ecdhCallCount === 2) {
        return new Promise<void>((_resolve, reject) => { rejectStaleEcdh = reject })
      }
    }

    useNetworkStore.getState().init('tok')
    welcome('a-session')
    peerJoined('z-session', true)
    await vi.advanceTimersByTimeAsync(1)

    const original = created.pcs[0]
    original.iceConnectionState = 'connected'
    original.oniceconnectionstatechange?.()

    // The rebuild fires, tears the original PC down, and starts its own
    // initiateWebRTC() attempt — which immediately parks on the (stale)
    // ECDH keygen gate above.
    await vi.advanceTimersByTimeAsync(8_001)
    await flushMicrotasks()

    expect(original.connectionState).toBe('closed')
    expect(rejectStaleEcdh).not.toBeNull()
    const rebuiltPc = created.pcs[1]

    // Before the stale rebuild settles, a manual reconnect supersedes it —
    // exactly the "newer / manually-created replacement connection" from the
    // finding. This bumps the peer generation past the frozen rebuild's.
    void useNetworkStore.getState().reconnectPeer('z-session')
    await vi.advanceTimersByTimeAsync(1)
    await flushMicrotasks()

    expect(rebuiltPc.connectionState).toBe('closed')
    const replacementPc = created.pcs[2]
    expect(replacementPc).toBeDefined()

    // The replacement is healthy and current, but has not finished its own
    // ECDH handshake yet — a realistic in-flight state, not yet 'online'.
    replacementPc.iceConnectionState = 'connected'
    replacementPc.oniceconnectionstatechange?.()
    await flushMicrotasks()

    expect(useNetworkStore.getState().peers[0].status).toBe('connecting')

    // Now let the stale rebuild attempt's ECDH keygen finally reject. Its
    // rejection must be judged against the identity frozen when IT started,
    // not against whatever peer/generation happens to be current now. This
    // needs several microtask hops to propagate (reject → the `await
    // generateECDHKeyPair(...)` continuation → `initiateWebRTCInner`'s
    // rejection → through `.finally()` → the attached `.catch()`).
    rejectStaleEcdh!(new Error('stale rebuild ecdh failed'))
    await flushMicrotasks()

    expect(warn).toHaveBeenCalledWith(
      '[net] initial encrypted-session rebuild failed',
      'z-session',
      expect.any(Error),
    )
    // The stale rejection must not have touched the current, still-negotiating
    // replacement connection at all.
    expect(replacementPc.connectionState).not.toBe('closed')
    expect(useNetworkStore.getState().peers[0].status).toBe('connecting')
    expect(useNetworkStore.getState().connectedPeers.has('z-session')).toBe(false)

    // And the replacement's own recovery watchdog must still be intact —
    // when its AES key lands normally, it reaches 'online' on its own.
    hasAESKeyResult = true
    replacementPc.iceConnectionState = 'connected'
    replacementPc.oniceconnectionstatechange?.()
    for (let i = 0; i < 5; i++) await Promise.resolve()
    expect(useNetworkStore.getState().peers[0].status).toBe('online')
    expect(useNetworkStore.getState().connectedPeers.has('z-session')).toBe(true)

    warn.mockRestore()
  })
})

describe('Finding 2: blockPeer() must clear the one-shot encrypted-session rebuild guard', () => {
  it('lets recovery arm again after block → rejoin under the same sessionId', async () => {
    const { useNetworkStore } = await freshStore()
    hasAESKeyResult = false
    useNetworkStore.getState().init('tok')
    welcome('a-session')
    peerJoined('z-session', true)
    await vi.advanceTimersByTimeAsync(1)

    // Drive the peer into the connected-but-unencrypted state and let the
    // one-shot rebuild fire once, arming `initialEncryptedSessionRebuilds`.
    const first = created.pcs[0]
    first.iceConnectionState = 'connected'
    first.oniceconnectionstatechange?.()
    await vi.advanceTimersByTimeAsync(8_001)
    for (let i = 0; i < 5; i++) await Promise.resolve()

    expect(created.pcs.length).toBe(2)   // the rebuild's own replacement PC

    // Local teardown while the guard is still armed.
    useNetworkStore.getState().blockPeer('z-session')
    expect(useNetworkStore.getState().peers.find(p => p.sessionId === 'z-session')).toBeUndefined()

    // The same peer rejoins under the identical sessionId.
    peerJoined('z-session', true)
    await vi.advanceTimersByTimeAsync(1)
    expect(created.pcs.length).toBe(3)

    // Drive the rejoined connection into the same connected-but-unencrypted
    // state. If the rebuild guard survived the block, this next window will
    // find `initialEncryptedSessionRebuilds` still armed from before the
    // block and short-circuit straight to 'offline' without ever attempting
    // a rebuild for this brand-new connection.
    const rejoined = created.pcs[2]
    rejoined.iceConnectionState = 'connected'
    rejoined.oniceconnectionstatechange?.()
    await vi.advanceTimersByTimeAsync(8_001)
    for (let i = 0; i < 5; i++) await Promise.resolve()

    // A fresh one-shot rebuild fired: a THIRD replacement PC was created and
    // the peer is mid-rebuild ('connecting'), not stuck offline.
    expect(created.pcs.length).toBe(4)
    expect(useNetworkStore.getState().peers[0].status).toBe('connecting')
  })
})

// ── BUG-009 ────────────────────────────────────────────────────────────

describe('BUG-009: an online TURN/policy change migrates the selected ICE path', () => {
  it('restarts ICE on the PCs whose effective config changed', async () => {
    const { useNetworkStore } = await freshStore()
    useNetworkStore.getState().init('tok')
    welcome()
    peerJoined('peer-1', true)
    await settle()

    const pc = created.pcs[0]
    pc.iceConnectionState = 'connected'
    const sdpBefore = sdpFrames().length

    applyIceConfigResult = [pc]
    turnConfigListeners.forEach(fn => fn())
    await settle()

    expect(pc.createOffer).toHaveBeenCalledWith({ iceRestart: true })
    expect(sdpFrames().length).toBe(sdpBefore + 1)
  })

  it('does nothing when the effective config is unchanged', async () => {
    const { useNetworkStore } = await freshStore()
    useNetworkStore.getState().init('tok')
    welcome()
    peerJoined('peer-1', true)
    await settle()

    const pc = created.pcs[0]
    const sdpBefore = sdpFrames().length

    applyIceConfigResult = []
    turnConfigListeners.forEach(fn => fn())
    await settle()

    expect(pc.createOffer).not.toHaveBeenCalled()
    expect(sdpFrames().length).toBe(sdpBefore)
  })
})

// ── UX-COPY-003 ────────────────────────────────────────────────────────

describe('UX-COPY-003: auth / signaling / peer-transport / transfer are distinct states', () => {
  it('tracks signaling status separately from peer transport', async () => {
    const { useNetworkStore } = await freshStore()
    expect(useNetworkStore.getState().signalingStatus).toBe('idle')

    useNetworkStore.getState().init('tok')
    expect(useNetworkStore.getState().signalingStatus).toBe('connecting')

    // Socket open but not yet authenticated → still "connecting".
    signalingHandlers.connect.forEach(h => h())
    expect(useNetworkStore.getState().signalingStatus).toBe('connecting')

    welcome()
    expect(useNetworkStore.getState().signalingStatus).toBe('online')
    // …and signaling being up says nothing about any peer transport.
    expect(useNetworkStore.getState().peers).toEqual([])

    signalingHandlers.disconnect.forEach(h => h())
    expect(useNetworkStore.getState().signalingStatus).toBe('reconnecting')

    emitWS({ t: 'SERVER_SHUTDOWN', reason: 'maintenance' })
    expect(useNetworkStore.getState().signalingStatus).toBe('offline')
  })

  it('an idle connected peer is "online", not "transferring"', async () => {
    const { useNetworkStore, peerDisplayStatus } = await freshStore()
    useNetworkStore.getState().init('tok')
    welcome()
    peerJoined('peer-1', true)
    await settle()

    const peer = useNetworkStore.getState().peers[0]
    expect(peer.status).toBe('online')
    expect(useNetworkStore.getState().connectedPeers.has('peer-1')).toBe(true)

    // Only an actual in-flight transfer promotes the display state.
    expect(peerDisplayStatus(peer, [])).toBe('online')
    expect(peerDisplayStatus(peer, [{
      id: 't1', direction: 'send', peerSessionId: 'peer-1', peerNodeId: 99,
      fileName: 'f', fileSize: 1, progress: 0.5, speedBps: 1,
      status: 'transferring', startedAt: Date.now(),
    }])).toBe('transferring')
  })

  it('deriveNetworkStatus picks the layer that actually explains the situation', async () => {
    const { deriveNetworkStatus, networkStatusLabel } = await freshStore()
    const peer = (status: string) => ({
      sessionId: 'p', nodeId: 1, status, channelType: 'direct', joinedAt: 0,
    }) as never
    const transfer = (status: string) => ({
      id: 't', direction: 'send', peerSessionId: 'p', peerNodeId: 1,
      fileName: 'f', fileSize: 1, progress: 0, speedBps: 0, status, startedAt: 0,
    }) as never

    // Signaling down beats everything else — that is the actionable failure.
    expect(deriveNetworkStatus({ signalingStatus: 'offline', peers: [], transfers: [] })).toBe('offline')
    expect(deriveNetworkStatus({ signalingStatus: 'idle', peers: [], transfers: [] })).toBe('offline')
    expect(deriveNetworkStatus({ signalingStatus: 'reconnecting', peers: [peer('online')], transfers: [] }))
      .toBe('reconnecting')
    expect(deriveNetworkStatus({ signalingStatus: 'connecting', peers: [], transfers: [] })).toBe('connecting')
    // Signaling healthy, no peer yet → still just connecting, not "online".
    expect(deriveNetworkStatus({ signalingStatus: 'online', peers: [], transfers: [] })).toBe('connecting')
    expect(deriveNetworkStatus({ signalingStatus: 'online', peers: [peer('connecting')], transfers: [] }))
      .toBe('connecting')
    expect(deriveNetworkStatus({ signalingStatus: 'online', peers: [peer('reconnecting')], transfers: [] }))
      .toBe('reconnecting')
    expect(deriveNetworkStatus({ signalingStatus: 'online', peers: [peer('online')], transfers: [] }))
      .toBe('online')
    expect(deriveNetworkStatus({
      signalingStatus: 'online', peers: [peer('online')], transfers: [transfer('transferring')],
    })).toBe('transferring')
    // A finished transfer must not keep the badge stuck on "正在传输".
    expect(deriveNetworkStatus({
      signalingStatus: 'online', peers: [peer('online')], transfers: [transfer('completed')],
    })).toBe('online')

    expect(networkStatusLabel('online')).toBe('在线')
    expect(networkStatusLabel('transferring')).toBe('正在传输')
    expect(networkStatusLabel('connecting')).toBe('正在连接')
    expect(networkStatusLabel('reconnecting')).toBe('正在重新连接')
    expect(networkStatusLabel('offline')).toBe('已离线')
  })
})
