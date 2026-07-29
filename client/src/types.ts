// ── Identity & Auth ──────────────────────────────────────────────
export interface Identity {
  nodeId: number
  passCode: string
  createdAt: number
}

/**
 * Live client session (Contract 1).
 *
 * `reRegisterProof` is a required key with a nullable value: every construction
 * site must decide deliberately, but absence degrades silent 4001/4002
 * recovery rather than blocking connect/chat/transfer.
 */
export interface Session {
  token: string
  sessionId: string
  expiresAt: number
  /**
   * Opaque re-registration proof for 4001/4002 recovery without the passcode.
   * `null` means the session works normally but cannot auto-recover from
   * auth-invalid closes (older server, stripped field, or legacy cache).
   */
  reRegisterProof: string | null
}

/**
 * sessionStorage shape — may omit proof (pre-Contract rows or older servers).
 * Restored via `tryRestoreSession` with `reRegisterProof: null` when missing.
 */
export interface LegacyStoredSession {
  token: string
  sessionId: string
  expiresAt: number
  reRegisterProof?: string | null
}

// ── Network Stats ─────────────────────────────────────────────────
export interface NetworkStats {
  onlineNodes: number
  peakConcurrent: number
  totalTransfers: number
  totalBytes: number
  activeChannels: number
  uptimeLongestMs: number
  uptimeSeconds: number
  cpuLoadPercent: number
}

// ── Activity Stream ───────────────────────────────────────────────
export type ActivityType = 'join' | 'leave' | 'transfer' | 'channel'

export interface ActivityEvent {
  id: string
  type: ActivityType
  nodeId?: number
  timestamp: number
  message: string
}

// ── Node / Peer ───────────────────────────────────────────────────
export type NodeStatus = 'online' | 'transferring' | 'connecting' | 'reconnecting' | 'unauthorized' | 'offline'

export interface Peer {
  sessionId: string      // unique per device — routing key
  nodeId: number         // user-input identity number — for display
  status: NodeStatus
  channelType: 'direct' | 'stun' | 'relay' | 'ws'
  icePath?: string
  icePathMeasuredAt?: number
  joinedAt: number
}

// ── Transfer ──────────────────────────────────────────────────────
export type TransferStatus =
  | 'pending'
  | 'transferring'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'reconnecting'
  // P1-5: receiver refused the transfer up-front because the current
  // browser can't safely assemble a file this large (no OPFS / no FSA).
  // Surfaced as a distinct red card with a recovery hint.
  | 'failed:unsupported'

export interface Transfer {
  id: string
  direction: 'send' | 'recv'
  peerSessionId: string
  peerNodeId: number
  fileName: string
  fileSize: number
  progress: number     // 0-1
  speedBps: number
  status: TransferStatus
  error?: string
  startedAt: number
  // Where the receiver is materializing this transfer. 'fsa' = user-visible file via
  // showSaveFilePicker, 'opfs' = origin-private FS, 'idb' = in-memory assembly with
  // IndexedDB chunk store (size-capped). Affects completion-state UI affordances.
  storageMode?: 'fsa' | 'opfs' | 'idb'
}

export interface PendingFileItem {
  id: string
  file: File
  displayName: string
}

// ── Channel Message ───────────────────────────────────────────────
export type MessageStatus = 'sending' | 'sent' | 'delivered' | 'failed'

export interface ChannelMessage {
  id: string
  type: 'system' | 'text' | 'file'
  content: string
  timestamp: number
  direction: 'sent' | 'recv' | 'system'
  status?: MessageStatus   // only meaningful for direction='sent' text messages
  // file-type only
  fileName?: string
  fileSize?: number
  downloadUrl?: string
}

// ── WebSocket Protocol ────────────────────────────────────────────
export type WSMessage =
  | { t: 'AUTH'; token: string }
  | { t: 'JOIN_CLUSTER' }
  | { t: 'LEAVE_CHANNEL' }
  | { t: 'SIGNAL_SDP'; targetSessionId: string; sdp: RTCSessionDescriptionInit }
  | { t: 'SIGNAL_ICE'; targetSessionId: string; candidate: RTCIceCandidateInit }
  | { t: 'SIGNAL_ICE_END'; targetSessionId: string; candidate?: RTCIceCandidateInit }
  | { t: 'PING' }
  | { t: 'BLOCK'; sessionId: string }

export type WSServerMessage =
  | { t: 'WELCOME'; sessionId: string; myNodeId: number; sessionExpiresAt: number }
  | { t: 'SIGNAL_SDP'; fromSessionId: string; fromNodeId: number; sdp: RTCSessionDescriptionInit }
  | { t: 'SIGNAL_ICE'; fromSessionId: string; fromNodeId: number; candidate: RTCIceCandidateInit }
  | { t: 'SIGNAL_ICE_END'; fromSessionId: string; fromNodeId: number; candidate?: RTCIceCandidateInit }
  | { t: 'PEER_JOINED'; peer: { sessionId: string; nodeId: number; joinedAt: number }; shouldInitiate: boolean }
  | { t: 'PEER_LEFT'; sessionId: string; nodeId: number }
  | { t: 'PEER_OFFLINE'; targetSessionId: string }   // signaling forward failed: target absent or socket dead
  | { t: 'ACTIVITY'; event: ActivityEvent }
  | { t: 'PONG' }
  | { t: 'SERVER_SHUTDOWN'; reason: string }
  | { t: 'ERROR'; code: string; message: string }
