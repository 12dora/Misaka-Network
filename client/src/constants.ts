// ── Client Constants ──────────────────────────────────────────────────
// All tuneable compile-time constants in one place.
// Runtime URL configuration lives in config.ts.

// ── Node identity ─────────────────────────────────────────────────────
export const NODE_ID_MIN = 1
export const NODE_ID_MAX = 20001

// ── File transfer ─────────────────────────────────────────────────────
export const CHUNK_SIZE = 64 * 1024              // 64 KB per chunk
export const HIGH_WATER_MARK = 16 * 1024 * 1024  // 16 MB — pause sending
export const LOW_WATER_MARK = 4 * 1024 * 1024    // 4 MB — resume sending

// ── WebRTC / ICE ──────────────────────────────────────────────────────
export const DEFAULT_STUN: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
]
export const MAX_ICE_RESTART_ATTEMPTS = 3
export const DC_OPEN_TIMEOUT_MS = 15_000         // DataChannel open timeout
export const ENCRYPTION_TIMEOUT_MS = 30_000      // ECDH negotiation timeout

// ── Signaling / WebSocket ─────────────────────────────────────────────
export const HEARTBEAT_INTERVAL_MS = 45_000
export const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000]
