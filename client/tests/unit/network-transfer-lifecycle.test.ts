// Store-side lifecycle and UX-correctness regressions.
//
//   BUG-019  Retry on a failed transfer flipped the card to 传输中 and then hit
//            a silent early return (no source File / no record / no channel),
//            producing a permanently fake in-progress state.
//   BUG-020  chat flush marked EVERY queued message 'sent' after a best-effort
//            loop that swallowed per-message failures, and `sendFilesToAll`
//            discarded every result — a broadcast where everything failed
//            looked exactly like one where everything succeeded.
//   BUG-021  a completed staged-file snapshot deleted the WHOLE pendingFiles
//            bucket (destroying anything added mid-flight), and PEER_LEFT
//            deleted it outright when a peer merely stepped away.
//   QUALITY-001  terminal transfer cards and chat logs grew without bound.

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
}))

// `sendFileParallel` behaviour is per-test: some cases need every send to fail.
let sendOutcome: () => Promise<unknown> = async () => ({ state: 'saved', acked: true, legacyPeer: false })
vi.mock('@/lib/transfer', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/transfer')>('../../src/lib/transfer')
  return {
    ...actual,
    sendFileParallel: vi.fn(() => sendOutcome()),
  }
})

const records = new Map<string, any>()
vi.mock('@/lib/db', () => ({
  saveTransfer: vi.fn(async (rec: any) => { records.set(rec.transferId, rec) }),
  updateTransfer: vi.fn(async () => {}),
  getTransfer: vi.fn(async (id: string) => records.get(id) ?? null),
  getActiveTransfers: vi.fn(async () => []),
  deleteTransfer: vi.fn(async () => {}),
  saveChunk: vi.fn(async () => {}),
  getChunk: vi.fn(async () => null),
  deleteChunks: vi.fn(async () => {}),
  getSavedChunkIndexes: vi.fn(async () => []),
  pruneTerminalTransfers: vi.fn(async () => 0),
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

const PEER = 'peer-1'

async function settle(rounds = 12) {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
  await new Promise(r => setTimeout(r, 0))
}

type StoreMod = typeof import('../../src/store/network')

async function freshStore(opts: { withPeer?: boolean } = {}): Promise<StoreMod> {
  vi.resetModules()
  sockets = []
  dcs.length = 0
  records.clear()
  sessionStorage.clear()
  sendOutcome = async () => ({ state: 'saved', acked: true, legacyPeer: false })
  ;(globalThis as unknown as { WebSocket: typeof StubWS }).WebSocket = StubWS
  const mod = await import('../../src/store/network')
  mod.useNetworkStore.getState().init('tok')
  const sock = sockets[sockets.length - 1]
  sock.open()
  sock.deliver({ t: 'WELCOME', sessionId: 'me', myNodeId: 1, sessionExpiresAt: Date.now() + 1e6 })
  if (opts.withPeer !== false) {
    sock.deliver({
      t: 'PEER_JOINED',
      peer: { sessionId: PEER, nodeId: 7, joinedAt: Date.now() },
      shouldInitiate: true,
    })
  }
  await settle()
  return mod
}

let origCreateURL: unknown
beforeEach(() => {
  origCreateURL = (URL as any).createObjectURL
  ;(URL as any).createObjectURL = vi.fn(() => 'blob:stub')
  ;(URL as any).revokeObjectURL = vi.fn()
})
afterEach(() => { (URL as any).createObjectURL = origCreateURL })

// ── BUG-019 ────────────────────────────────────────────────────────────
describe('BUG-019: Retry validates preconditions before changing state', () => {
  it('rejects and leaves the card failed when the source File is gone', async () => {
    const { useNetworkStore } = await freshStore()
    useNetworkStore.setState({
      transfers: [{
        id: 'gone', direction: 'send', peerSessionId: PEER, peerNodeId: 7,
        fileName: 'x.bin', fileSize: 10, progress: 0.4, speedBps: 0,
        status: 'failed', startedAt: Date.now(),
      }],
    })

    await expect(useNetworkStore.getState().resumeTransfer('gone', PEER))
      .rejects.toMatchObject({ name: 'TransferResumeError', code: 'source-missing' })

    // The whole point: the status must NOT have been flipped to a fake
    // "transferring" that nothing will ever advance.
    const card = useNetworkStore.getState().transfers.find(t => t.id === 'gone')
    expect(card?.status).toBe('failed')
    expect(card?.error).toMatch(/源文件/)
  })

  it('rejects when the DataChannel is not open', async () => {
    const { useNetworkStore } = await freshStore({ withPeer: false })
    useNetworkStore.setState({
      transfers: [{
        id: 'nodc', direction: 'send', peerSessionId: 'ghost', peerNodeId: 7,
        fileName: 'x.bin', fileSize: 10, progress: 0, speedBps: 0,
        status: 'failed', startedAt: Date.now(),
      }],
    })
    await expect(useNetworkStore.getState().resumeTransfer('nodc', 'ghost'))
      .rejects.toMatchObject({ code: 'channel-unavailable' })
    expect(useNetworkStore.getState().transfers[0].status).toBe('failed')
  })

  it('rejects an unknown transfer instead of silently doing nothing', async () => {
    const { useNetworkStore } = await freshStore()
    await expect(useNetworkStore.getState().resumeReceiveTransfer('nope'))
      .rejects.toMatchObject({ code: 'unknown-transfer' })
  })

  it('proceeds for a receive transfer whose channel is live', async () => {
    const { useNetworkStore } = await freshStore()
    useNetworkStore.setState({
      transfers: [{
        id: 'recv-ok', direction: 'recv', peerSessionId: PEER, peerNodeId: 7,
        fileName: 'r.bin', fileSize: 10, progress: 0.5, speedBps: 0,
        status: 'paused', startedAt: Date.now(),
      }],
    })
    await useNetworkStore.getState().resumeReceiveTransfer('recv-ok')
    expect(useNetworkStore.getState().transfers[0].status).toBe('transferring')
    const primary = dcs.find(d => d.label === 'misaka')!
    const sent = primary.send.mock.calls.map(c => String(c[0]))
    expect(sent.some(p => p.includes('transfer-resume'))).toBe(true)
  })
})

// ── BUG-020 ────────────────────────────────────────────────────────────
describe('BUG-020: chat flush and fanout report structured results', () => {
  it('does not mark a message sent when the channel closed mid-flush', async () => {
    const { useNetworkStore } = await freshStore()
    const primary = dcs.find(d => d.label === 'misaka')!
    // Queue two messages while the channel is "closed" from the store's view.
    primary.readyState = 'connecting'
    useNetworkStore.getState().sendChatMessage(PEER, 'first')
    useNetworkStore.getState().sendChatMessage(PEER, 'second')
    await settle()

    // The channel dies before the flush runs. The old code deleted the queue
    // and marked BOTH messages 'sent'.
    primary.readyState = 'closed'
    primary.send.mockImplementation(() => { throw new Error('closed') })
    ;(primary as unknown as { onclose: null }).onclose = null
    // Drive the flush through the store's own open path.
    const openHandlerFired = useNetworkStore.getState()
    void openHandlerFired
    // Simulate the reconnect flush: ecdh-pub arrival triggers flushOutgoing.
    primary.onmessage?.({ data: JSON.stringify({ type: 'ecdh-pub', pub: 'p' }) } as MessageEvent)
    await settle()

    const msgs = (useNetworkStore.getState().chatMessages[PEER] ?? []).filter(m => m.type === 'text')
    expect(msgs.length).toBe(2)
    expect(msgs.every(m => m.status === 'failed')).toBe(true)
    expect(msgs.some(m => m.status === 'sent')).toBe(false)
  })

  it('sendFilesToAll surfaces a total failure instead of resolving quietly', async () => {
    const { useNetworkStore } = await freshStore()
    sendOutcome = async () => { throw new Error('link down') }
    await expect(useNetworkStore.getState().sendFilesToAll([new File(['a'], 'a.txt')]))
      .rejects.toThrow(/全部未送达/)
  })

  it('sendFilesToAll surfaces a PARTIAL failure with the failing pairs', async () => {
    const { useNetworkStore } = await freshStore()
    const sock = sockets[sockets.length - 1]
    sock.deliver({
      t: 'PEER_JOINED',
      peer: { sessionId: 'peer-2', nodeId: 8, joinedAt: Date.now() },
      shouldInitiate: true,
    })
    await settle()

    let n = 0
    sendOutcome = async () => {
      n++
      if (n === 2) throw new Error('peer-2 down')
      return { state: 'saved', acked: true, legacyPeer: false }
    }
    await expect(useNetworkStore.getState().sendFilesToAll([new File(['a'], 'a.txt')]))
      .rejects.toMatchObject({ name: 'PartialFanoutError' })
  })
})

// ── BUG-021 ────────────────────────────────────────────────────────────
describe('BUG-021: staged files are never silently destroyed', () => {
  it('normalises folder entries by relative path while preserving ordinary picker order', async () => {
    const { useNetworkStore } = await freshStore()
    const folderC = new File(['c'], 'c.txt')
    const folderA = new File(['a'], 'a.txt')
    Object.defineProperty(folderC, 'webkitRelativePath', { value: 'folder/c.txt' })
    Object.defineProperty(folderA, 'webkitRelativePath', { value: 'folder/a.txt' })

    useNetworkStore.getState().addPendingFiles(PEER, [folderC, folderA])
    expect(useNetworkStore.getState().pendingFiles[PEER].map(item => item.displayName))
      .toEqual(['folder/a.txt', 'folder/c.txt'])

    useNetworkStore.getState().clearPendingFiles(PEER)
    useNetworkStore.getState().addPendingFiles(
      PEER,
      [new File(['z'], 'z.txt'), new File(['a'], 'a.txt')],
    )
    expect(useNetworkStore.getState().pendingFiles[PEER].map(item => item.displayName))
      .toEqual(['z.txt', 'a.txt'])
  })

  it('only removes the staged ids that actually sent', async () => {
    const { useNetworkStore } = await freshStore()
    const store = useNetworkStore.getState()
    store.addPendingFiles(PEER, [new File(['a'], 'a.txt'), new File(['b'], 'b.txt')])
    const staged = useNetworkStore.getState().pendingFiles[PEER]
    expect(staged.length).toBe(2)

    // Second file fails.
    let n = 0
    sendOutcome = async () => {
      n++
      if (n === 2) throw new Error('nope')
      return { state: 'saved', acked: true, legacyPeer: false }
    }
    await useNetworkStore.getState().sendPendingFile(PEER)

    const remaining = useNetworkStore.getState().pendingFiles[PEER] ?? []
    expect(remaining.map(i => i.displayName)).toEqual(['b.txt'])
  })

  it('keeps files staged mid-flight instead of wiping the whole bucket', async () => {
    const { useNetworkStore } = await freshStore()
    useNetworkStore.getState().addPendingFiles(PEER, [new File(['a'], 'a.txt')])

    // Everything succeeds, but the user drops a NEW file while the snapshot
    // is in flight. The old code deleted `pendingFiles[peer]` wholesale on
    // `allOk` and the new file vanished without ever being sent.
    sendOutcome = async () => {
      useNetworkStore.getState().addPendingFiles(PEER, [new File(['c'], 'c.txt')])
      return { state: 'saved', acked: true, legacyPeer: false }
    }
    await useNetworkStore.getState().sendPendingFile(PEER)

    const remaining = useNetworkStore.getState().pendingFiles[PEER] ?? []
    expect(remaining.map(i => i.displayName)).toEqual(['c.txt'])
  })

  it('a peer leaving does not delete the files staged for it', async () => {
    const { useNetworkStore } = await freshStore()
    useNetworkStore.getState().addPendingFiles(PEER, [new File(['a'], 'a.txt')])
    // Kill the DC so PEER_LEFT takes the full-cleanup branch.
    for (const dc of dcs) dc.readyState = 'closed'
    sockets[sockets.length - 1].deliver({ t: 'PEER_LEFT', sessionId: PEER, nodeId: 7 })
    await settle()

    expect(useNetworkStore.getState().peers.find(p => p.sessionId === PEER)?.status).toBe('offline')
    // The user picked these files by hand; a transient absence must not throw
    // them away.
    expect((useNetworkStore.getState().pendingFiles[PEER] ?? []).length).toBe(1)
  })
})

// ── QUALITY-001 ────────────────────────────────────────────────────────
describe('QUALITY-001: bounded retention for terminal state', () => {
  it('prunes the oldest terminal transfer cards and keeps every live one', async () => {
    const mod = await freshStore()
    const many = Array.from({ length: 80 }, (_, i) => ({
      id: `t-${i}`, direction: 'send' as const, peerSessionId: PEER, peerNodeId: 7,
      fileName: `f${i}.bin`, fileSize: 1, progress: 1, speedBps: 0,
      status: (i % 10 === 0 ? 'transferring' : 'completed') as 'transferring' | 'completed',
      startedAt: i,
    }))
    const pruned = mod.pruneTerminalTransferCards(many)

    const live = pruned.filter(t => t.status === 'transferring')
    const terminal = pruned.filter(t => t.status === 'completed')
    expect(live.length).toBe(8)             // untouched
    expect(terminal.length).toBe(30)        // capped
    // The survivors are the NEWEST terminal cards.
    expect(terminal[0].startedAt).toBeGreaterThan(terminal.length)
  })

  it('is a no-op below the cap', async () => {
    const mod = await freshStore()
    const few = Array.from({ length: 5 }, (_, i) => ({
      id: `s-${i}`, direction: 'send' as const, peerSessionId: PEER, peerNodeId: 7,
      fileName: 'f.bin', fileSize: 1, progress: 1, speedBps: 0,
      status: 'completed' as const, startedAt: i,
    }))
    expect(mod.pruneTerminalTransferCards(few)).toBe(few)
  })

  it('bounds one peer chat log and revokes the dropped download URLs', async () => {
    const mod = await freshStore()
    const revoke = vi.fn()
    ;(URL as any).revokeObjectURL = revoke
    const msgs = Array.from({ length: 420 }, (_, i) => ({
      id: `m-${i}`, type: 'file' as const, content: 'f', timestamp: i,
      direction: 'recv' as const, downloadUrl: `blob:${i}`,
    }))
    const kept = mod.pruneChatMessages(msgs)
    expect(kept.length).toBe(300)
    expect(kept[0].id).toBe('m-120')
    // The 120 dropped entries pinned Blob bytes; they must be released.
    expect(revoke).toHaveBeenCalledTimes(120)
  })
})
