/**
 * Public contracts for the network store: state slices, errors, and result types.
 *
 * NetworkState is composed of five logical slices (session / peer / conversation /
 * transfer / connectivity) so controllers can depend on narrow shapes. The
 * Zustand singleton still holds one flat object for API compatibility.
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

// ── Status ───────────────────────────────────────────────────────────

export type SignalingStatus = 'idle' | 'connecting' | 'online' | 'reconnecting' | 'offline'
export type NetworkStatusKey = 'online' | 'transferring' | 'connecting' | 'reconnecting' | 'offline'

// ── Slices (logical; flattened into NetworkState for the public API) ─

/** Auth/signaling session identity for this tab. */
export interface SessionSlice {
  wsConnected: boolean
  signalingStatus: SignalingStatus
  mySessionId: string | null
  channelId: string | null
}

/** Roster + encrypted-channel membership. */
export interface PeerSlice {
  peers: Peer[]
  selectedSessionId: string | null
  connectedPeers: Set<string>
}

/** Chat + staging for a peer conversation. */
export interface ConversationSlice {
  chatMessages: Record<string, ChannelMessage[]>
  pendingFiles: Record<string, PendingFileItem[]>
  unreadByPeer: Record<string, { message: number; file: number }>
  sendingPeers: Set<string>
}

/** Live transfer cards (UI). Delivery truth lives in transfer-controller maps. */
export interface TransferSlice {
  transfers: Transfer[]
}

/** NAT / TURN connectivity facts for banners. */
export interface ConnectivitySlice {
  myNatType: NatType | null
  autoTurnAvailable: boolean
}

export type NetworkStateSlices =
  SessionSlice & PeerSlice & ConversationSlice & TransferSlice & ConnectivitySlice

// ── Full store surface (actions + slices) ────────────────────────────

export interface NetworkState extends NetworkStateSlices {
  init: (token: string) => void
  destroy: () => void
  selectPeer: (sessionId: string | null) => void
  addPendingFiles: (sessionId: string, files: File[]) => void
  removePendingFile: (sessionId: string, itemId: string) => void
  clearPendingFiles: (sessionId: string) => void
  sendPendingFile: (sessionId: string) => Promise<void>
  sendFile: (file: File) => Promise<void>
  sendFilesToAll: (files: File[]) => Promise<void>
  pauseTransfer: (transferId: string) => void
  resumeTransfer: (transferId: string, peerSessionId: string) => Promise<void>
  cancelTransferAction: (transferId: string) => void
  pauseReceiveTransfer: (transferId: string) => void
  resumeReceiveTransfer: (transferId: string) => Promise<void>
  cancelReceiveTransfer: (transferId: string) => void
  sendChatMessage: (peerSessionId: string, text: string) => void
  retryChatMessage: (peerSessionId: string, msgId: string) => void
  blockPeer: (sessionId: string) => void
  recoverConnections: () => void
  reconnectPeer: (sessionId: string) => Promise<void>
}

// ── Shared result / error types ──────────────────────────────────────

export interface PendingRemoteIceOverflowState {
  groupDrops: number
  candidateDrops: number
  lastKind: 'group' | 'candidate'
}

/** Per-message outcome of one flush attempt (BUG-020). */
export interface FlushResult {
  sent: string[]
  failed: string[]
}

export type ResumeFailureCode =
  | 'unknown-transfer'
  | 'not-resumable'
  | 'source-missing'
  | 'record-missing'
  | 'channel-unavailable'

export class TransferResumeError extends Error {
  code: ResumeFailureCode
  constructor(code: ResumeFailureCode, message: string) {
    super(message)
    this.name = 'TransferResumeError'
    this.code = code
  }
}

export class PartialFanoutError extends Error {
  failures: Array<{ peerSessionId: string; fileName: string }>
  constructor(message: string, failures: Array<{ peerSessionId: string; fileName: string }>) {
    super(message)
    this.name = 'PartialFanoutError'
    this.failures = failures
  }
}

export type EpochTransferTeardown = (transfers: Transfer[]) => void

export type {
  Peer,
  Transfer,
  ChannelMessage,
  MessageStatus,
  PendingFileItem,
  NodeStatus,
  NatType,
}
