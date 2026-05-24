// ── Client Constants ──────────────────────────────────────────────────
// All tuneable compile-time constants in one place.
// Runtime URL configuration lives in config.ts.

// ── Node identity ─────────────────────────────────────────────────────
export const NODE_ID_MIN = 1
export const NODE_ID_MAX = 20001

// ── File transfer ─────────────────────────────────────────────────────
export const CHUNK_SIZE = 252 * 1024             // 252 KB — must stay ≤ 256 KiB SCTP max after AES-GCM (+16 B) + IV (+12 B) overhead
// Hard upper bound on file size the sender will accept. Keeps chunk index well within uint32
// (16 GB / 252 KB ≈ 66K chunks) and well below Number.MAX_SAFE_INTEGER for byte arithmetic.
// Receiver may further refuse via MAX_INMEMORY_RECEIVE_BYTES when no streaming sink is available.
export const MAX_FILE_SIZE = 16 * 1024 * 1024 * 1024  // 16 GB
// Sized for LAN: a 32 MB high-water mark pushed Chrome's SCTP send buffer
// into stop-and-go territory (bufferedAmountLow fired late, lane loops
// stalled in bursts). 8 MB is ~30 chunks of headroom, enough to absorb a
// disk-read + AES-GCM hiccup but small enough that the pipeline stays
// rhythm-steady on a saturated gigabit link.
export const HIGH_WATER_MARK = 8 * 1024 * 1024   // 8 MB — keep the DataChannel fed without overshooting SCTP
export const LOW_WATER_MARK = 2 * 1024 * 1024    // 2 MB — resume early so the lane never empties
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
  { urls: 'stun:stun.nextcloud.com:443' },        // TCP-friendly port
  { urls: 'stun:stun.miwifi.com:3478' },          // Xiaomi — China-friendly
  { urls: 'stun:stun.qq.com:3478' },              // Tencent — China-friendly
]

export const ICE_CANDIDATE_POOL_SIZE = 4         // pre-gather candidates for faster handshake

export const MAX_ICE_RESTART_ATTEMPTS = 5
export const ICE_RESTART_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000]
export const ICE_DISCONNECTED_RESTART_DELAY_MS = 5_000  // restart if 'disconnected' persists

export const DC_OPEN_TIMEOUT_MS = 25_000         // DataChannel open timeout — relaxed for cross-continent TURN relay
export const ENCRYPTION_TIMEOUT_MS = 30_000      // ECDH negotiation timeout

// ── NAT detection ─────────────────────────────────────────────────────
export const NAT_DETECTION_TIMEOUT_MS = 8_000

// ── IDB fallback ceiling ───────────────────────────────────────────────
// When neither File System Access nor OPFS is available (Firefox < 111 +
// Android privacy modes), incoming files have to be assembled in memory
// before they can be delivered as a Blob. Files larger than this would
// either OOM the tab on low-end devices or stall the main thread for
// many seconds — refuse the transfer upfront with a clear UX message
// instead. (See `MAX_INMEMORY_BYTES` callsite in transfer.ts.)
export const MAX_INMEMORY_RECEIVE_BYTES = 256 * 1024 * 1024  // 256 MB

// ── Signaling / WebSocket ─────────────────────────────────────────────
export const HEARTBEAT_INTERVAL_MS = 45_000
export const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000]
