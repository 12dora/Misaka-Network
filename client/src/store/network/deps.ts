/**
 * Late-bound inter-controller deps. Bound once from store.ts after all
 * domain modules are loaded. Domain modules call deps.X instead of importing
 * each other when that would form a cycle.
 *
 * Ports introduced:
 * - StorePort (store-access.ts) — breaks every controller ↔ Zustand cycle
 * - DataChannelProvider fields on deps — chat/transfer → ensureConnected
 * - ChatProtocolHandler / TransferProtocolHandler fields — router → handlers
 * - NegotiationPort fields — ice-recovery ↔ negotiation
 * - PeerPresencePort fields — signaling PEER_OFFLINE vs transport
 */
import type { Transfer } from '@/types'
import type { MessageStatus } from '@/types'
import type { TransferOwner, ResumeRequest, DeliveryState } from '@/lib/transfer'
import type { FlushResult, PendingRemoteIceOverflowState } from './contracts'

export interface NetworkDeps {
  // peer-runtime
  ensureConnected: (peerSessionId: string) => Promise<RTCDataChannel>
  ensureTransferLanes: (peerSessionId: string) => Promise<RTCDataChannel[]>
  cleanupPeerConnection: (sessionId: string, options?: { failQueuedMessages?: boolean }) => void
  initiateWebRTC: (peerSessionId: string) => Promise<void>
  getPrimary: (peerSessionId: string) => RTCDataChannel | undefined
  getLanes: (peerSessionId: string) => RTCDataChannel[]
  peerConnections: Map<string, RTCPeerConnection>
  dataChannels: Map<string, RTCDataChannel>
  transferLanes: Map<string, RTCDataChannel[]>
  peerGeneration: (id: string) => number
  bumpPeerGeneration: (id: string) => number
  isCurrentGeneration: (id: string, gen: number) => boolean
  captureGenerationAttempt: (id: string, gen?: number) => any
  capturePeerConnectionAttempt: (id: string, pc: RTCPeerConnection, gen?: number) => any
  isPeerConnectionAttemptCurrent: (attempt: any) => boolean
  isPeerGenerationAttemptCurrent: (attempt: any) => boolean
  ownerFor: (peerSessionId: string) => TransferOwner
  hasOpenEncryptedChannel: (sessionId: string) => boolean

  // negotiation
  captureSignalReceipt: (peerSessionId: string, options?: any) => any
  enqueuePeerTask: (receipt: any, name: string, task: () => Promise<void>, options?: any) => Promise<void>
  handleRemoteSDP: (receipt: any, fromNodeId: number, sdp: RTCSessionDescriptionInit) => Promise<void>
  handleRemoteICE: (receipt: any, candidate: RTCIceCandidateInit) => Promise<void>
  handleRemoteICEEnd: (receipt: any) => Promise<void>
  beginLocalOffer: (peerSessionId: string) => number
  invalidatePendingLocalOffer: (peerSessionId: string) => void
  isLocalOfferCurrent: (peerSessionId: string, token: number) => boolean
  sendLocalOffer: (peerSessionId: string, pc: RTCPeerConnection, sdp: RTCSessionDescriptionInit) => void
  negState: (peerSessionId: string) => any
  isPolite: (peerSessionId: string) => boolean
  getPendingSignalingQueueCount: () => number
  getPendingRemoteIceCount: () => number
  getPendingRemoteIceCandidateCount: () => number
  getPendingRemoteIceReservationCount: () => number
  getPendingRemoteIceOverflowState: (id: string) => PendingRemoteIceOverflowState | null
  clearPeerNegotiationState: (sessionId: string) => void
  clearAllNegotiationState: () => void
  invalidatePeerSignalingIncarnation: (id: string) => void
  peerSignalingIncarnation: (id: string) => number
  peerLocalOfferTokens: Map<string, number>
  pendingRemoteIce: Map<string, any>
  remoteInitiatingPeers: Set<string>
  connectingPeers: Map<string, Promise<RTCDataChannel>>
  initiatingPeers: Map<string, { gen: number; task: Promise<void> }>
  peerTaskQueues: Map<string, Promise<void>>
  peerGenerations: Map<string, number>
  peerSignalingIncarnations: Map<string, number>
  ecdhResolvers: Map<string, any>
  primaryChannelResolvers: Map<string, Set<() => void>>
  notifyPrimaryChannel: (id: string) => void
  waitForPrimaryChannel: (id: string, timeoutMs?: number) => Promise<void>
  abandonPeerConnection: (id: string, pc: RTCPeerConnection) => void
  installIceCandidateHandler: (attempt: any) => void

  // ice-recovery
  attemptIceRestart: (peerSessionId: string) => Promise<void> | void
  handleIceStateChange: (attempt: any) => void
  scheduleInitialIceRecovery: (pc: RTCPeerConnection, peerSessionId: string) => void
  clearInitialIceRecovery: (peerSessionId: string) => void
  clearDisconnectedTimer: (peerSessionId: string) => void
  initialEncryptedSessionRebuilds: Set<string>
  iceRestartAttempts: Map<string, number>
  iceRestarting: Map<string, number>
  iceRestartRetryTimers: Map<string, ReturnType<typeof setTimeout>>
  iceRestartPreconditionStarted: Map<string, number>
  clearPeerIceRecovery: (sessionId: string) => void
  clearAllIceRecovery: () => void

  // connectivity
  installForegroundRecovery: () => void
  installTurnConfigPropagation: () => void
  startNatAndTurnProbes: () => void
  recoverConnections: () => void
  renegotiateOrphanPeers: () => void
  propagateIceConfig: () => void
  pendingIceMigration: Set<string>
  clearConnectivityTimers: () => void

  // data-channel-router
  setupDataChannel: (dc: RTCDataChannel, attempt: any) => void

  // chat
  queueOutgoing: (peerSessionId: string, payload: string, msgId?: string) => void
  flushOutgoing: (peerSessionId: string, dc: RTCDataChannel) => FlushResult
  failPendingMessages: (peerSessionId: string) => void
  startQueuedDelivery: (peerSessionId: string) => void
  updateMessageStatus: (peerSessionId: string, msgId: string, status: MessageStatus) => void
  appendSystemChat: (peerSessionId: string, content: string, direction?: 'sent' | 'recv' | 'system') => void
  appendFileChat: (peerSessionId: string, fileName: string, fileSize: number, downloadUrl: string) => void
  noteInboundChatId: (peerSessionId: string, msgId: string) => boolean
  clearPeerChatState: (sessionId: string) => void
  clearAllChatState: () => void
  genMsgId: () => string
  outgoingQueue: Map<string, any[]>
  queuedMessageIds: Map<string, Set<string>>
  seenInboundChatIds: Map<string, Set<string>>
  removeQueuedMessage: (peerSessionId: string, msgId: string) => void

  // transfer
  sendFileToPeer: (file: File, peerSessionId: string, displayName?: string) => Promise<boolean>
  handleIncomingMeta: (raw: unknown, peerSessionId: string, dc: RTCDataChannel, owner: TransferOwner, stillThisAttempt?: () => boolean) => Promise<void>
  handleResumeRequest: (req: ResumeRequest, peerSessionId: string, owner: TransferOwner) => Promise<void>
  deliverCompletedFile: (transferId: string, peerSessionId: string) => Promise<void>
  sendDurableAck: (peerSessionId: string, transferId: string, bytes: number) => void
  flushPendingDurableAcks: (peerSessionId: string) => void
  sendResumeRequests: (peerSessionId: string, dc: RTCDataChannel) => Promise<void>
  shortIdToTransferId: Map<string, Map<number, string>>
  sendingFiles: Map<string, File>
  transferDelivery: Map<string, DeliveryState>
  transferSpeedSamples: Map<string, { bytes: number; at: number }>
  deliveredTransfers: Set<string>
  pendingDurableAcks: Map<string, any>
  clearPeerTransferState: (sessionId: string) => void
  clearAllTransferState: () => void
  failTransferRecord: (transferId: string, error: string) => void
  cleanupTransferRecord: (transferId: string) => void
  hasLiveSendTaskAny: () => boolean
  runSendEngine: (...args: any[]) => Promise<any>
  reenterSendTaskForRepair: (transferId: string, peerSessionId: string, owner: TransferOwner) => Promise<void>
  checkResumePreconditions: (transferId: string, peerSessionId: string, transfer: Transfer | undefined) => Promise<any>

  // session
  getNetworkEpoch: () => number
  endNetworkEpoch: (reason: string) => void
  networkEpochRef: () => number
  whenSignalingReady: (timeoutMs?: number) => Promise<boolean>
  isSignalingReady: () => boolean
  notifySignalingReady: () => void
  abortSignalingReadyWaiters: () => void
  signalingJoined: boolean
  setSignalingJoined: (v: boolean) => void

  // signaling readiness + unsubs
  unsubscribeSignaling: Array<() => void>
}

/** Filled by store composition; domain modules read deps at call time. */
export const deps = {} as NetworkDeps

export function bindDeps(partial: Partial<NetworkDeps>): void {
  Object.assign(deps, partial)
}
