// Session-epoch regressions across the auth ↔ signaling ↔ network boundary.
//
//   BUG-001  explicit Disconnect must END the network epoch: stop
//            reconnecting, forget the token, destroy every PC / DC / crypto
//            key / in-flight transfer, and only then release the server-side
//            session. Previously the UI said "未接入" while the old token
//            could still reconnect and the peer connections stayed alive.
//   BUG-002  a new token, or a new WELCOME.sessionId, is a new identity. All
//            session-scoped state from the previous epoch must be gone before
//            the new one starts, or peers/keys/transfers from two identities
//            coexist and can cross-route.
//
// Uses the REAL signaling + auth modules (with a fake WebSocket) so the
// hand-off actually runs end to end; only the heavy leaf libraries are mocked.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── fake WebSocket ─────────────────────────────────────────────────────
class StubWS {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  url: string
  readyState = 0
  onopen: (() => void) | null = null
  onclose: ((ev: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  close = vi.fn(() => { this.readyState = StubWS.CLOSED })
  send = vi.fn()
  constructor(url: string) {
    this.url = url
    sockets.push(this)
  }
  open() { this.readyState = StubWS.OPEN; this.onopen?.() }
  deliver(msg: unknown) { this.onmessage?.({ data: JSON.stringify(msg) }) }
  frames(): Array<Record<string, unknown>> {
    return this.send.mock.calls.map(c => JSON.parse(String(c[0])))
  }
}

let sockets: StubWS[] = []
let releaseCalls: string[] = []

// ── leaf-library mocks ─────────────────────────────────────────────────
interface FakePc {
  connectionState: RTCPeerConnectionState
  iceConnectionState: RTCIceConnectionState
  signalingState: RTCSignalingState
  iceGatheringState: RTCIceGatheringState
  localDescription: unknown
  onicecandidate: ((e: Event) => void) | null
  oniceconnectionstatechange: (() => void) | null
  ondatachannel: ((e: Event) => void) | null
  createOffer: ReturnType<typeof vi.fn>
  setLocalDescription: (d: unknown) => Promise<void>
  close: ReturnType<typeof vi.fn>
}

const pcs: FakePc[] = []
const dcs: Array<{ label: string; readyState: string; close: () => void }> = []

function makeFakeDc(label = 'misaka') {
  const listeners: Record<string, Array<(e: Event) => void>> = {}
  const dc = {
    label,
    readyState: 'open' as RTCDataChannelState,
    binaryType: 'arraybuffer' as BinaryType,
    onclose: null as ((e: Event) => void) | null,
    onmessage: null as ((e: MessageEvent) => void) | null,
    close: () => { dc.readyState = 'closed' as RTCDataChannelState; dc.onclose?.(new Event('close')) },
    send: vi.fn(),
    addEventListener: (t: string, h: (e: Event) => void) => { (listeners[t] ??= []).push(h) },
    removeEventListener: (t: string, h: (e: Event) => void) => {
      listeners[t] = (listeners[t] ?? []).filter(x => x !== h)
    },
  }
  dcs.push(dc as unknown as { label: string; readyState: string; close: () => void })
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
    createOffer: vi.fn(async () => ({ type: 'offer', sdp: 'x' })),
    setLocalDescription: async () => {},
    close: vi.fn(() => { pc.connectionState = 'closed' }),
  }
  pcs.push(pc)
  return pc
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
vi.mock('@/lib/turn', () => ({
  refreshAutoTurn: vi.fn(async () => []),
  clearAutoTurn: vi.fn(),
  onTurnConfigChange: vi.fn(() => () => {}),
  fetchTurnStatus: vi.fn(async () => null),
  getAutoTurnState: vi.fn(() => null),
  loadTurnSettings: vi.fn(() => ({ servers: [], enabled: false, forceRelay: false })),
}))

// ── harness ────────────────────────────────────────────────────────────

async function freshModules() {
  vi.resetModules()
  sockets = []
  releaseCalls = []
  pcs.length = 0
  dcs.length = 0
  sessionStorage.clear()
  ;(globalThis as unknown as { WebSocket: typeof StubWS }).WebSocket = StubWS
  const { useNetworkStore } = await import('../../src/store/network')
  const { useAuthStore } = await import('../../src/store/auth')
  const cryptoMod = await import('../../src/lib/crypto')
  return { useNetworkStore, useAuthStore, resetCrypto: cryptoMod.resetCrypto as ReturnType<typeof vi.fn> }
}

async function settle() {
  for (let i = 0; i < 8; i++) await Promise.resolve()
  await new Promise(r => setTimeout(r, 0))
}

function lastSocket() { return sockets[sockets.length - 1] }

function bringUp(sessionId = 'sid-A') {
  const sock = lastSocket()
  sock.open()
  sock.deliver({ t: 'WELCOME', sessionId, myNodeId: 1, sessionExpiresAt: Date.now() + 1e6 })
}

function joinPeer(sessionId = 'peer-1') {
  lastSocket().deliver({
    t: 'PEER_JOINED',
    peer: { sessionId, nodeId: 99, joinedAt: Date.now() },
    shouldInitiate: true,
  })
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/release')) {
      releaseCalls.push(String(init?.body ?? ''))
      return { ok: true, status: 200, json: async () => ({ released: 1 }) } as unknown as Response
    }
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response
  }))
})

afterEach(() => { vi.unstubAllGlobals() })

describe('BUG-001: explicit Disconnect ends the network epoch', () => {
  it('destroys peer connections, drops the token and releases the session', async () => {
    const { useNetworkStore, useAuthStore, resetCrypto } = await freshModules()
    useAuthStore.setState({
      session: { token: 'tok-1', sessionId: 'sid-A', expiresAt: Date.now() + 1e6 },
      isConnected: true,
    })
    useNetworkStore.getState().init('tok-1')
    bringUp()
    joinPeer()
    await settle()

    expect(pcs.length).toBe(1)
    expect(useNetworkStore.getState().peers.length).toBe(1)
    const sock = lastSocket()

    await useAuthStore.getState().disconnect()
    await settle()

    // Peer transport is gone…
    expect(pcs[0].close).toHaveBeenCalled()
    expect(pcs[0].connectionState).toBe('closed')
    expect(dcs.every(d => d.readyState === 'closed')).toBe(true)
    expect(resetCrypto).toHaveBeenCalled()
    // …store state is back to an empty epoch…
    expect(useNetworkStore.getState().peers).toEqual([])
    expect(useNetworkStore.getState().transfers).toEqual([])
    expect(useNetworkStore.getState().mySessionId).toBeNull()
    expect(useNetworkStore.getState().signalingStatus).toBe('idle')
    // …the socket is closed…
    expect(sock.close).toHaveBeenCalled()
    // …and the server-side session was released with the old token.
    expect(releaseCalls.length).toBe(1)
    expect(JSON.parse(releaseCalls[0]).token).toBe('tok-1')
  })

  it('a released token cannot silently reconnect on the next `online` event', async () => {
    const { useNetworkStore, useAuthStore } = await freshModules()
    useAuthStore.setState({
      session: { token: 'tok-1', sessionId: 'sid-A', expiresAt: Date.now() + 1e6 },
      isConnected: true,
    })
    useNetworkStore.getState().init('tok-1')
    bringUp()
    await settle()
    const socketsBefore = sockets.length

    await useAuthStore.getState().disconnect()
    await settle()

    window.dispatchEvent(new Event('online'))
    await settle()

    expect(sockets.length).toBe(socketsBefore)
  })

  it('is idempotent — a double click releases once and tears down once', async () => {
    const { useNetworkStore, useAuthStore } = await freshModules()
    useAuthStore.setState({
      session: { token: 'tok-1', sessionId: 'sid-A', expiresAt: Date.now() + 1e6 },
      isConnected: true,
    })
    useNetworkStore.getState().init('tok-1')
    bringUp()
    await settle()

    await Promise.all([
      useAuthStore.getState().disconnect(),
      useAuthStore.getState().disconnect(),
    ])
    await settle()

    expect(releaseCalls.length).toBe(1)
    expect(useAuthStore.getState().session).toBeNull()
    expect(sessionStorage.getItem('misaka.session')).toBeNull()
  })

  it('logging out then back in re-registers signaling handlers exactly once', async () => {
    const { useNetworkStore, useAuthStore } = await freshModules()
    useAuthStore.setState({
      session: { token: 'tok-1', sessionId: 'sid-A', expiresAt: Date.now() + 1e6 },
      isConnected: true,
    })
    useNetworkStore.getState().init('tok-1')
    bringUp()
    await settle()
    await useAuthStore.getState().disconnect()
    await settle()

    useNetworkStore.getState().init('tok-2')
    bringUp('sid-B')
    await settle()

    // Exactly one JOIN_CLUSTER for the one WELCOME — a duplicated onMessage
    // registration would emit two (and process every future signal twice).
    const joins = lastSocket().frames().filter(f => f.t === 'JOIN_CLUSTER')
    expect(joins.length).toBe(1)
    expect(useNetworkStore.getState().mySessionId).toBe('sid-B')
  })
})

describe('BUG-002: network state is bound to the auth session epoch', () => {
  it('a new token wipes peers, connections and keys before reconnecting', async () => {
    const { useNetworkStore, resetCrypto } = await freshModules()
    useNetworkStore.getState().init('tok-1')
    bringUp('sid-A')
    joinPeer('peer-1')
    await settle()
    expect(useNetworkStore.getState().peers.length).toBe(1)
    const oldPc = pcs[0]

    // Auth recovery re-registered and handed us a fresh token.
    useNetworkStore.getState().init('tok-2')
    lastSocket().open()
    await settle()

    expect(oldPc.close).toHaveBeenCalled()
    expect(resetCrypto).toHaveBeenCalled()
    expect(useNetworkStore.getState().peers).toEqual([])
    expect(useNetworkStore.getState().mySessionId).toBeNull()
    expect(useNetworkStore.getState().chatMessages).toEqual({})
    // A brand-new socket carries the new token.
    expect(lastSocket().frames().some(f => f.t === 'AUTH' && f.token === 'tok-2')).toBe(true)
  })

  it('a WELCOME with a different sessionId starts a new epoch', async () => {
    const { useNetworkStore } = await freshModules()
    useNetworkStore.getState().init('tok-1')
    bringUp('sid-A')
    joinPeer('peer-1')
    await settle()

    useNetworkStore.setState(s => ({
      chatMessages: { ...s.chatMessages, 'peer-1': [{
        id: 'm1', type: 'text', content: 'hi', timestamp: Date.now(), direction: 'sent',
      }] },
    }))
    const oldPc = pcs[0]

    // Same socket, but the server issued us a different session (we were
    // GC'd and re-admitted). Everything scoped to sid-A is now dead.
    lastSocket().deliver({ t: 'WELCOME', sessionId: 'sid-B', myNodeId: 1, sessionExpiresAt: Date.now() + 1e6 })
    await settle()

    expect(useNetworkStore.getState().mySessionId).toBe('sid-B')
    expect(useNetworkStore.getState().peers).toEqual([])
    expect(useNetworkStore.getState().chatMessages).toEqual({})
    expect(oldPc.close).toHaveBeenCalled()
  })

  it('a repeated WELCOME for the SAME sessionId keeps the epoch intact', async () => {
    const { useNetworkStore } = await freshModules()
    useNetworkStore.getState().init('tok-1')
    bringUp('sid-A')
    joinPeer('peer-1')
    await settle()
    const oldPc = pcs[0]

    // Reconnect of the same session (transient WS drop) must NOT nuke live
    // peer connections — that is exactly what makes fast resume possible.
    lastSocket().deliver({ t: 'WELCOME', sessionId: 'sid-A', myNodeId: 1, sessionExpiresAt: Date.now() + 1e6 })
    await settle()

    expect(oldPc.close).not.toHaveBeenCalled()
    expect(useNetworkStore.getState().peers.length).toBe(1)
  })
})
