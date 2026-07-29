import type { WebSocket } from 'ws'

export interface NodeSession {
  sessionId: string         // unique per WS session — primary routing key
  nodeId: number            // user-input node id; shared across devices of same identity
  passCodeHash: string      // deployment-keyed HMAC identity representation
  passCodeVerifyHash?: string  // scrypt(passcode, salt) — primary verification field for new sessions
  passCodeSalt?: string        // 16-byte hex salt for scrypt; absent for legacy sha256 records
  passCodeAlgo?: 'sha256' | 'scrypt'  // absent = 'sha256' (legacy)
  token: string             // auth token (private)
  /**
   * Contract 1: opaque single-purpose re-registration proof. 32 random bytes
   * hex. Authenticates re-registration of THIS identity only — never accepted
   * as a Bearer token. Rotated on every successful use / renew.
   */
  reRegisterProof: string
  /**
   * Restart-stable TURN principal (server HMAC over identity tuple). Used as
   * the deny-list key so an abuse ban survives re-registration. Distinct from
   * customIdentifier, which stays session-bound for Cloudflare revoke.
   */
  turnPrincipal: string
  socket: WebSocket | null
  lastSeen: number
  channelId: string | null
  blockedIds: Set<string>   // blocked sessionIds
  failedAttempts: number
  lockedUntil: number
  joinedAt: number
  // Absolute session expiry (SECURITY-001). Stamped once at register time
  // from SESSION_TTL_MS. Reconnects alone never extend it; only an explicit
  // authenticated POST /api/session-renew does (Contract 2).
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
  /**
   * Redeeming proves knowledge of the owner's passcode but does not consume
   * the invitation. The opaque grant is committed atomically by /register so
   * an admission failure (IP/capacity/network) can safely retry.
   */
  admissionGrant?: string
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
  | { t: 'SIGNAL_ICE_END'; targetSessionId: string; candidate?: object }
  | { t: 'PING' }
  | { t: 'BLOCK'; sessionId: string }
