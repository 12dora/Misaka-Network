// ── Identity & Auth ──────────────────────────────────────────────
export interface Identity {
  nodeId: number
  passCode: string
  createdAt: number
}

export interface Session {
  token: string
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
  nodeId: number
  status: NodeStatus
  channelType: 'direct' | 'stun' | 'relay' | 'ws'
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
}

// ── WebSocket Protocol ────────────────────────────────────────────
export type WSMessage =
  | { t: 'AUTH'; token: string }
  | { t: 'JOIN_CHANNEL'; channelId: string }
  | { t: 'LEAVE_CHANNEL' }
  | { t: 'CONNECT_REQ'; targetNodeId: number }
  | { t: 'SIGNAL_SDP'; targetNodeId: number; sdp: RTCSessionDescriptionInit }
  | { t: 'SIGNAL_ICE'; targetNodeId: number; candidate: RTCIceCandidateInit }
  | { t: 'PING' }
  | { t: 'BLOCK'; nodeId: number }

export type WSServerMessage =
  | { t: 'WELCOME'; myNodeId: number; sessionExpiresAt: number }
  | { t: 'CONNECT_REQ_IN'; fromNodeId: number; requestId: string }
  | { t: 'SIGNAL_SDP'; fromNodeId: number; sdp: RTCSessionDescriptionInit }
  | { t: 'SIGNAL_ICE'; fromNodeId: number; candidate: RTCIceCandidateInit }
  | { t: 'PEER_JOINED'; node: { nodeId: number; joinedAt: number } }
  | { t: 'PEER_LEFT'; nodeId: number }
  | { t: 'ACTIVITY'; event: ActivityEvent }
  | { t: 'PONG' }
  | { t: 'SERVER_SHUTDOWN'; reason: string }
  | { t: 'ERROR'; code: string; message: string }
