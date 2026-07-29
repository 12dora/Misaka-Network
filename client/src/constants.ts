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
// A black-holing firewall can leave WebSocket in CONNECTING forever; after
// this budget the exact socket is closed and the existing backoff takes over.
export const WS_CONNECT_TIMEOUT_MS = 15_000

// ── A11Y-002 — verified colour pairings ───────────────────────────────
// The semantic `--state-*` tokens are FILL colours (dots, badges, bars).
// Using them as small-size text produced 1.58:1–4.05:1 across the app.
// The table below is the single source of truth for which foreground token
// may be painted on which background token, and is enforced by
// `tests/unit/a11y-contrast.test.ts`, which parses the real hex values out
// of `src/index.css` and recomputes the WCAG 2.1 ratios.
//
// `minRatio` is 4.5 (AA normal text) for everything the UI renders at
// 10–14 px, and 3.0 (AA large / non-text) only for pure graphical fills.

export interface ContrastPair {
  /** CSS custom property name of the foreground (without `--`). */
  fg: string
  /** CSS custom property name of the background (without `--`). */
  bg: string
  /** Minimum WCAG 2.1 contrast ratio this pair must satisfy. */
  minRatio: number
  /** Where the pair is used — shown in the assertion message. */
  usage: string
}

/** Light surfaces: white cards and the pale-blue tint panels. */
export const LIGHT_BACKGROUNDS = ['surface', 'surface-tint'] as const
/** Blue surfaces: the page background and the deep-blue chrome. */
export const BLUE_BACKGROUNDS = ['bg-primary', 'bg-deep'] as const

export const CONTRAST_PAIRS: ContrastPair[] = [
  // ── Text on light surfaces ──────────────────────────────────────────
  ...LIGHT_BACKGROUNDS.flatMap((bg): ContrastPair[] => [
    { fg: 'text-on-white',           bg, minRatio: 4.5, usage: '卡片主文本' },
    { fg: 'text-on-white-2',         bg, minRatio: 4.5, usage: '卡片次要文本' },
    { fg: 'text-muted-on-light',     bg, minRatio: 4.5, usage: '卡片弱化文本 / 未测试状态' },
    { fg: 'state-success-on-light',  bg, minRatio: 4.5, usage: '成功状态文本（可达 / 已下发）' },
    { fg: 'state-warn-on-light',     bg, minRatio: 4.5, usage: '警告状态文本（配额 / 同步失败）' },
    { fg: 'state-danger-on-light',   bg, minRatio: 4.5, usage: '错误状态文本（不可达 / 删除）' },
  ]),
  // ── Text on blue surfaces ───────────────────────────────────────────
  ...BLUE_BACKGROUNDS.flatMap((bg): ContrastPair[] => [
    { fg: 'text-on-blue',            bg, minRatio: 4.5, usage: '蓝底主文本' },
    { fg: 'text-on-blue-2',          bg, minRatio: 4.5, usage: '蓝底次要文本' },
    { fg: 'accent-cyan-on-blue',     bg, minRatio: 4.5, usage: '蓝底强调文本 / 链接' },
    { fg: 'state-success-on-blue',   bg, minRatio: 4.5, usage: '蓝底成功状态文本' },
    { fg: 'state-warn-on-blue',      bg, minRatio: 4.5, usage: '蓝底警告状态文本' },
    { fg: 'state-danger-on-blue',    bg, minRatio: 4.5, usage: '蓝底错误状态文本' },
  ]),
  // ── Non-text fills (AA large / graphical objects, 3:1) ──────────────
  { fg: 'state-success', bg: 'bg-deep',  minRatio: 3.0, usage: '状态圆点 / 进度条填充' },
  { fg: 'state-warn',    bg: 'bg-deep',  minRatio: 3.0, usage: '状态圆点 / 进度条填充' },
  { fg: 'accent-cyan',   bg: 'bg-deep',  minRatio: 3.0, usage: '强调线 / 图形填充' },
  { fg: 'state-danger',  bg: 'surface',  minRatio: 3.0, usage: '错误边框 / 图形填充' },
]

/**
 * Foreground tokens that must NEVER be used as a small-size text colour.
 * They are graphical fills only. The contrast test asserts each of these
 * fails AA somewhere, which is what makes the `*-on-light` / `*-on-blue`
 * variants necessary in the first place — if one ever becomes AA-safe
 * everywhere the guard should be revisited deliberately, not silently.
 */
export const FILL_ONLY_TOKENS = ['state-success', 'state-warn', 'text-muted'] as const
