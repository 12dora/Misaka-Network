// ── Identity & Auth ──────────────────────────────────────────────
export interface Identity {
  nodeId: number
  passCode: string
  createdAt: number
}

export interface Session {
  token: string
  sessionId: string
  expiresAt: number
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
}

// ── Channel Message ───────────────────────────────────────────────
export interface ChannelMessage {
  id: string
  type: 'system' | 'text' | 'file'
  content: string
  timestamp: number
  direction: 'sent' | 'recv' | 'system'
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
  | { t: 'PING' }
  | { t: 'BLOCK'; sessionId: string }

export type WSServerMessage =
  | { t: 'WELCOME'; sessionId: string; myNodeId: number; sessionExpiresAt: number }
  | { t: 'SIGNAL_SDP'; fromSessionId: string; fromNodeId: number; sdp: RTCSessionDescriptionInit }
  | { t: 'SIGNAL_ICE'; fromSessionId: string; fromNodeId: number; candidate: RTCIceCandidateInit }
  | { t: 'PEER_JOINED'; peer: { sessionId: string; nodeId: number; joinedAt: number }; shouldInitiate: boolean }
  | { t: 'PEER_LEFT'; sessionId: string; nodeId: number }
  | { t: 'ACTIVITY'; event: ActivityEvent }
  | { t: 'PONG' }
  | { t: 'SERVER_SHUTDOWN'; reason: string }
  | { t: 'ERROR'; code: string; message: string }
