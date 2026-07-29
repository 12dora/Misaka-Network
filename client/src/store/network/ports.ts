/**
 * Injected ports that break the six circular dependency cycles Report 02 named.
 *
 * No module below store.ts may import the Zustand singleton. Controllers reach
 * shared state and each other only through these narrow interfaces, bound once
 * at composition time in store.ts.
 */

import type {
  ChannelMessage,
  MessageStatus,
  NodeStatus,
  Peer,
  PendingFileItem,
  Transfer,
} from '@/types'
import type { NatType } from '@/lib/nat'
import type { DeliveryState, ResumeRequest, TransferOwner } from '@/lib/transfer'
import type {
  NetworkState,
  PendingRemoteIceOverflowState,
  SignalingStatus,
} from './contracts'

/** Zustand read/write without importing the store singleton. */
export interface StorePort {
  getState: () => NetworkState
  setState: (
    partial:
      | Partial<NetworkState>
      | ((state: NetworkState) => Partial<NetworkState> | NetworkState),
  ) => void
}

/**
 * Peer presence / transport status without chatting or negotiating.
 * Breaks: PEER_OFFLINE / roster updates ↔ peer runtime cleanup cycles.
 */
export interface PeerPresencePort {
  setPeerStatus: (sessionId: string, status: NodeStatus) => void
  isPeerInRoster: (sessionId: string) => boolean
  mySessionId: () => string | null
  markConnected: (sessionId: string, encryptionReady: boolean) => void
  removeConnected: (sessionId: string) => void
}

/**
 * Access to live PC/DC/lanes without owning negotiation or transfer.
 * Breaks: chat/transfer → ensureConnected → setupDataChannel → chat/transfer.
 */
export interface DataChannelProvider {
  getPrimary: (peerSessionId: string) => RTCDataChannel | undefined
  getLanes: (peerSessionId: string) => RTCDataChannel[]
  ensureConnected: (peerSessionId: string) => Promise<RTCDataChannel>
  ensureTransferLanes: (peerSessionId: string) => Promise<RTCDataChannel[]>
  cleanupPeerConnection: (
    sessionId: string,
    options?: { failQueuedMessages?: boolean },
  ) => void
  hasOpenEncryptedChannel: (sessionId: string) => boolean
}

/**
 * Chat control-plane handlers for the data-channel router.
 * Breaks: setupDataChannel ↔ chat-controller import cycle.
 */
export interface ChatProtocolHandler {
  handleChat: (
    peerSessionId: string,
    msg: Record<string, unknown>,
    dc: RTCDataChannel,
  ) => void
  handleMsgAck: (peerSessionId: string, msgId: string) => void
  flushOutgoing: (peerSessionId: string, dc: RTCDataChannel) => void
  failPendingMessages: (peerSessionId: string) => void
  noteInboundChatId: (peerSessionId: string, msgId: string) => boolean
  clearPeerChatDedupe: (peerSessionId: string) => void
  clearAllChatDedupe: () => void
  appendSystemChat: (
    peerSessionId: string,
    content: string,
    direction?: 'sent' | 'recv' | 'system',
  ) => void
  appendFileChat: (
    peerSessionId: string,
    fileName: string,
    fileSize: number,
    downloadUrl: string,
  ) => void
}

/**
 * Transfer control-plane + binary demux for the data-channel router.
 * Breaks: setupDataChannel ↔ transfer-controller import cycle.
 */
export interface TransferProtocolHandler {
  handleBinaryChunk: (
    peerSessionId: string,
    data: ArrayBuffer,
    dc: RTCDataChannel,
    stillThisAttempt: () => boolean,
    owner: TransferOwner,
  ) => Promise<void>
  handleMeta: (
    raw: unknown,
    peerSessionId: string,
    dc: RTCDataChannel,
    owner: TransferOwner,
    stillThisAttempt: () => boolean,
  ) => Promise<void>
  handleResume: (
    req: ResumeRequest,
    peerSessionId: string,
    owner: TransferOwner,
  ) => Promise<void>
  handleTransferReady: (
    transferId: string,
    shortId: number,
    owner: TransferOwner,
  ) => void
  handleTransferReject: (
    transferId: string,
    message: string,
    owner: TransferOwner,
  ) => void
  handleTransferRepair: (
    msg: { transferId: string; missingRanges?: Array<[number, number]> },
    peerSessionId: string,
    owner: TransferOwner,
  ) => Promise<void>
  handleTransferDone: (
    transferId: string,
    bytes: number,
    owner: TransferOwner,
  ) => void
  handleTransferPause: (transferId: string, owner: TransferOwner) => boolean
  handleTransferResume: (transferId: string, owner: TransferOwner) => boolean
  handleTransferCancel: (
    transferId: string,
    owner: TransferOwner,
  ) => void
  flushPendingDurableAcks: (peerSessionId: string) => void
  sendResumeRequests: (peerSessionId: string, dc: RTCDataChannel) => Promise<void>
  clearPeerDemux: (peerSessionId: string) => void
  clearAllTransferEphemeral: () => void
  getDeliveryState: (transferId: string) => DeliveryState | undefined
  setSendingFileForTests: (transferId: string, file: File | null) => void
  hasLiveSendWork: () => boolean
  sendingFilesSize: () => number
}

/**
 * Opaque receipt identity for queued SDP/ICE (defined by negotiation-controller).
 * Kept structural here so ports.ts does not import controllers.
 */
export interface SignalReceiptRef {
  peerSessionId: string
  epoch: number
  incarnation: number
  gen: number
  originatingPc: RTCPeerConnection | null
  localOfferToken: number | null
  pendingRemoteNegotiationToken: number | null
  remoteIceGroupKey: string | null
  remoteIceUfrag: string | null
  remoteIceEndCandidate: RTCIceCandidateInit | null
}

/**
 * Negotiation without owning ICE recovery timers or chat.
 * Breaks: ice-recovery ↔ negotiation ↔ peer-runtime cycles.
 */
export interface NegotiationPort {
  handleRemoteSDP: (
    receipt: SignalReceiptRef,
    fromNodeId: number,
    sdp: RTCSessionDescriptionInit,
  ) => Promise<void>
  handleRemoteICE: (
    receipt: SignalReceiptRef,
    candidate: RTCIceCandidateInit,
  ) => Promise<void>
  handleRemoteICEEnd: (
    receipt: SignalReceiptRef,
  ) => Promise<void>
  captureSignalReceipt: (
    peerSessionId: string,
    options?: {
      preparePendingRemoteIce?: boolean
      candidate?: RTCIceCandidateInit
      endOfCandidates?: RTCIceCandidateInit | null
    },
  ) => SignalReceiptRef
  enqueuePeerTask: (
    receipt: SignalReceiptRef,
    name: string,
    task: () => Promise<void>,
    options?: {
      requireOriginatingPc?: boolean
      requireLocalOfferToken?: boolean
      allowMissingPeer?: boolean
      bindLocalOfferToken?: boolean
    },
  ) => Promise<void>
  beginLocalOffer: (peerSessionId: string) => number
  invalidatePendingLocalOffer: (peerSessionId: string) => void
  isLocalOfferCurrent: (peerSessionId: string, token: number) => boolean
  sendLocalOffer: (
    peerSessionId: string,
    pc: RTCPeerConnection,
    sdp: RTCSessionDescriptionInit,
  ) => void
  clearPeerNegotiation: (sessionId: string) => void
  clearAllNegotiation: () => void
  getPendingSignalingQueueCount: () => number
  getPendingRemoteIceCount: () => number
  getPendingRemoteIceCandidateCount: () => number
  getPendingRemoteIceReservationCount: () => number
  getPendingRemoteIceOverflowState: (
    peerSessionId: string,
  ) => PendingRemoteIceOverflowState | undefined
}

/** Session epoch + token lifecycle without importing controllers. */
export interface SessionScopePort {
  getEpoch: () => number
  endEpoch: (reason: string) => void
  getToken: () => string
  setToken: (token: string) => void
  isInitialized: () => boolean
  setInitialized: (v: boolean) => void
  ownerFor: (peerSessionId: string) => TransferOwner
}

/** Snapshot helpers used by pure selectors (no side effects). */
export type NetworkStatusInput = Pick<
  NetworkState,
  'signalingStatus' | 'peers' | 'transfers'
>

export type UnreachableInput = Pick<
  NetworkState,
  'myNatType' | 'autoTurnAvailable'
>

/** Re-export slice-friendly state pieces for composition. */
export type {
  NetworkState,
  SignalingStatus,
  Peer,
  Transfer,
  ChannelMessage,
  PendingFileItem,
  MessageStatus,
  NatType,
}
