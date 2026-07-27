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
  onicecandidate: ((e: Event) => void) | null
  oniceconnectionstatechange: (() => void) | null
  ondatachannel: ((e: Event) => void) | null
  createOffer: ReturnType<typeof vi.fn>
  setLocalDescription: (d: unknown) => Promise<void>
  setConfiguration: ReturnType<typeof vi.fn>
  close: () => void
}

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
    onicecandidate: null,
    oniceconnectionstatechange: null,
    ondatachannel: null,
    createOffer: vi.fn(async () => ({ type: 'offer', sdp: 'restart' })),
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
function resetTurnGate(open = true) {
  let release!: () => void
  const promise = new Promise<void>(r => { release = r })
  turnGate = { promise, release }
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

let applyIceConfigResult: unknown[] = []

vi.mock('@/lib/webrtc', () => ({
  createPeerConnection: () => makeFakePc(),
  createDataChannel: (_pc: unknown, label = 'misaka') => makeFakeDc(label),
  createOffer: vi.fn(async () => ({ type: 'offer', sdp: 'local-offer' })),
  createAnswer: (pc: unknown, offer: { sdp?: string }) => createAnswerImpl(pc, offer),
  applyAnswer: vi.fn(async () => {}),
  addIceCandidate: vi.fn(async () => {}),
  getSelectedChannelType: vi.fn(async () => 'direct'),
  getSelectedIcePath: vi.fn(async () => ({ channelType: 'direct', pathText: 'host/udp → host/udp' })),
  ensureAutoTurnReady: vi.fn(() => turnGate.promise),
  applyIceConfigToAll: vi.fn(() => applyIceConfigResult),
  whenSignalingStable: vi.fn(async () => {}),
  endOfCandidatesFor: vi.fn(() => ({ candidate: '', sdpMid: '0', sdpMLineIndex: 0 })),
  installIceErrorListener: vi.fn(),
  isRelayAllowed: vi.fn(() => true),
  hasUsableTurnServer: vi.fn(() => true),
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
  applyIceConfigResult = []
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

function sdpFrames() {
  return signalingHandlers.sent.filter(m => m.t === 'SIGNAL_SDP')
}

function livePcs() {
  return created.pcs.filter(pc => pc.connectionState !== 'closed')
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

// ── BUG-007 ────────────────────────────────────────────────────────────

describe('BUG-007: a delayed ICE restart must not act on a replaced connection', () => {
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
