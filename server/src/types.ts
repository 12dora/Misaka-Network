import type { WebSocket } from 'ws'

export interface NodeSession {
  sessionId: string         // unique per WS session — primary routing key
  nodeId: number            // user-input node id; shared across devices of same identity
  passCodeHash: string      // legacy sha256(passcode) — kept for migration window
  passCodeVerifyHash?: string  // scrypt(passcode, salt) — primary verification field for new sessions
  passCodeSalt?: string        // 16-byte hex salt for scrypt; absent for legacy sha256 records
  passCodeAlgo?: 'sha256' | 'scrypt'  // absent = 'sha256' (legacy)
  token: string             // auth token (private)
  socket: WebSocket | null
  lastSeen: number
  channelId: string | null
  blockedIds: Set<string>   // blocked sessionIds
  failedAttempts: number
  lockedUntil: number
  joinedAt: number
  // Absolute session expiry (SECURITY-001). Stamped once at register time
  // from SESSION_TTL_MS and never extended — reconnecting with the same token
  // does not buy more time. Every token resolution, WS frame and cleanup pass
  // compares against this, so HTTP, WS, QR, TURN and release permissions all
  // stop at the same instant.
  expiresAt: number
  ip: string
}

export interface QrTokenRecord {
  token: string
  ownerNodeId: number
  fileSessionId?: string
  channelId?: string
  type: 'node' | 'file' | 'channel'
  passCodeHash?: string
  createdAt: number
  expiresAt: number
  used: boolean
  failedAttempts?: number   // wrong-passcode guesses; the single-use token is burned after MAX_ATTEMPTS
}

export interface ReportRecord {
  id: string
  sourceNodeId: number
  targetNodeId: number
  reason: 'spam' | 'malicious' | 'harassment' | 'other'
  reporterIp: string
  reportedAt: number
}

export interface ActivityEvent {
  id: string
  type: 'join' | 'leave' | 'transfer' | 'channel'
  nodeId?: number
  timestamp: number
  message: string
}

export type WSClientMessage =
  | { t: 'AUTH'; token: string }
  | { t: 'JOIN_CLUSTER' }                                       // auto-join own identity cluster
  | { t: 'LEAVE_CHANNEL' }
  | { t: 'SIGNAL_SDP'; targetSessionId: string; sdp: object }
  | { t: 'SIGNAL_ICE'; targetSessionId: string; candidate: object }
  | { t: 'PING' }
  | { t: 'BLOCK'; sessionId: string }
