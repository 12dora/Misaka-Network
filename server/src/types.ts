import type { WebSocket } from 'ws'

export interface NodeSession {
  nodeId: number
  passCodeHash: string
  token: string
  socket: WebSocket | null
  lastSeen: number
  channelId: string | null
  blockedIds: Set<number>
  failedAttempts: number
  lockedUntil: number
  joinedAt: number
}

export interface QrTokenRecord {
  token: string
  ownerNodeId: number
  fileSessionId?: string
  channelId?: string
  type: 'node' | 'file' | 'channel'
  createdAt: number
  expiresAt: number
  used: boolean
}

export interface ActivityEvent {
  id: string
  type: 'join' | 'leave' | 'transfer' | 'channel'
  nodeId?: number
  timestamp: number
  message: string
}

export type WSClientMessage =
  | { t: 'JOIN_CHANNEL'; channelId: string }
  | { t: 'LEAVE_CHANNEL' }
  | { t: 'CONNECT_REQ'; targetNodeId: number }
  | { t: 'SIGNAL_SDP'; targetNodeId: number; sdp: object }
  | { t: 'SIGNAL_ICE'; targetNodeId: number; candidate: object }
  | { t: 'PING' }
  | { t: 'BLOCK'; nodeId: number }
