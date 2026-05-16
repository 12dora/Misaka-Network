// ── Client Constants ──────────────────────────────────────────────────
// All tuneable compile-time constants in one place.
// Runtime URL configuration lives in config.ts.

// ── Node identity ─────────────────────────────────────────────────────
export const NODE_ID_MIN = 1
export const NODE_ID_MAX = 20001

// ── File transfer ─────────────────────────────────────────────────────
export const CHUNK_SIZE = 252 * 1024             // 252 KB — must stay ≤ 256 KiB SCTP max after AES-GCM (+16 B) + IV (+12 B) overhead
export const HIGH_WATER_MARK = 32 * 1024 * 1024  // 32 MB — keep the DataChannel fed on fast local links
export const LOW_WATER_MARK = 12 * 1024 * 1024   // 12 MB — resume before the sender drains completely
export const TRANSFER_PROGRESS_INTERVAL_MS = 200
export const TRANSFER_RECORD_INTERVAL_MS = 1_000
export const TRANSFER_LANE_COUNT = 4

// ── WebRTC / ICE ──────────────────────────────────────────────────────
// Diversified STUN pool: more servers → more chances to discover srflx
// candidates from different network paths, and the port-443 entries help
// punch through restrictive firewalls that block UDP/3478.
export const DEFAULT_STUN: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.cloudflare.com:53' },        // alt port — bypasses some UDP filters
  { urls: 'stun:stun.nextcloud.com:443' },        // TCP-friendly port
  { urls: 'stun:stun.miwifi.com:3478' },          // Xiaomi — China-friendly
  { urls: 'stun:stun.qq.com:3478' },              // Tencent — China-friendly
]

export const ICE_CANDIDATE_POOL_SIZE = 4         // pre-gather candidates for faster handshake

export const MAX_ICE_RESTART_ATTEMPTS = 5
export const ICE_RESTART_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000]
export const ICE_DISCONNECTED_RESTART_DELAY_MS = 5_000  // restart if 'disconnected' persists

export const DC_OPEN_TIMEOUT_MS = 15_000         // DataChannel open timeout
export const ENCRYPTION_TIMEOUT_MS = 30_000      // ECDH negotiation timeout

// ── NAT detection ─────────────────────────────────────────────────────
export const NAT_DETECTION_TIMEOUT_MS = 8_000

// ── Signaling / WebSocket ─────────────────────────────────────────────
export const HEARTBEAT_INTERVAL_MS = 45_000
export const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000]
