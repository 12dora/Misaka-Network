import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'crypto'
import type { NodeSession, QrTokenRecord, ReportRecord } from './types.js'
import { SERVER_SECRET } from './config.js'

// ── customIdentifier derivation (P2-11) ─────────────────────────────
//
// Cloudflare logs and the CF dashboard see only customIdentifier — never the
// sessionId or any user-recognisable handle. We derive it from
// sha256(sessionId + SERVER_SECRET) and keep just the first 16 hex chars.
// The mapping is one-way: someone with CF logs alone cannot recover the
// sessionId, while the server keeps both halves in memory and can revoke /
// look up by either side. The redacted form is for log files we ship off-box.
export function deriveCustomIdentifier(sessionId: string): string {
  return createHash('sha256').update(sessionId + SERVER_SECRET).digest('hex').slice(0, 16)
}

export function redactCustomIdentifier(cid: string): string {
  return `[redacted-${cid.slice(0, 4)}]`
}

// Sessions keyed by unique sessionId (one entry per WS session). Multiple
// sessions may share the same nodeId — that is the "multi-device same
// identity" model the cluster channel relies on.
export const nodes    = new Map<string, NodeSession>()
export const channels = new Map<string, Set<string>>()    // channelId -> sessionIds
export const qrTokens = new Map<string, QrTokenRecord>()
export const reports: ReportRecord[] = []

// Per-attempter brute-force lockout (Bug F7).
//
// Why this is separate from NodeSession.failedAttempts:
// The old design incremented the OWNER's session counter when a 3rd party
// guessed wrong, which let an attacker lock out the legitimate owner just
// by spamming /api/register with the right nodeId and any passcode. The
// fix is to track failures on the ATTEMPTER's side — keyed by
// (ip, nodeId) — so the lock follows the attacker, not the victim. An
// owner on a different IP can still register on attempt 1 even while an
// attacker on another IP is in lockout.
//
// Key shape: `${ip}::${nodeId}`. The lock is cleared on a successful
// register from the same (ip, nodeId), so a legitimate user who mistyped
// once or twice and then gets it right is not punished, and so the
// per-session cleanup task can purge stale entries.
export interface AttemptLock {
  attempts: number
  lockedUntil: number   // 0 = not currently locked
  lastAttemptAt: number // for cleanup / TTL purposes
}
export const attemptLocks = new Map<string, AttemptLock>()

export function attemptKey(ip: string, nodeId: number): string {
  return `${ip}::${nodeId}`
}

// Per-nodeId GLOBAL freeze (defends against the IP-rotation brute-force
// pattern that the per-(ip,nodeId) lock cannot see). When too many
// distinct IPs fail against the same nodeId within the window, we freeze
// the nodeId itself for an hour — every new register attempt from any IP
// is refused with NODE_LOCKED. The owner is unaffected if they are already
// connected (their WS stays open and is independent of register). If the
// owner reconnects from a new IP during the freeze, they get the same
// rejection as everyone else — that is the price we accept for stopping a
// distributed brute-force.
export interface NodeFreeze {
  // recent failed attempts: timestamp + the IP that attempted, so the cleanup
  // job can age them out by NODE_FREEZE_WINDOW_MS and we can tell whether a
  // freeze was caused by 1 noisy IP vs. true rotation. Kept compact: just
  // {at, ip} per record.
  recentFailures: Array<{ at: number; ip: string }>
  frozenUntil: number   // 0 = not currently frozen
}
export const nodeFreezes = new Map<number, NodeFreeze>()

export function findSessionByToken(token: string): NodeSession | null {
  for (const s of nodes.values()) {
    if (s.token === token) return s
  }
  return null
}

export function findSessionsByNodeAndHash(nodeId: number, passCodeHash: string): NodeSession[] {
  const out: NodeSession[] = []
  for (const s of nodes.values()) {
    if (s.nodeId === nodeId && s.passCodeHash === passCodeHash) out.push(s)
  }
  return out
}

// ── Passcode hashing ────────────────────────────────────────────────
//
// Two hashes are kept per session, with very different jobs:
//
//   passCodeHash           — sha256(passCode). Deterministic, salt-free.
//                            This is the "identity key" used for cluster
//                            channel id (so two devices with the same
//                            (nodeId, passcode) hit the same channel) and
//                            for the nodeId-occupied conflict check. It
//                            does NOT defend against offline brute-force
//                            of a 6-digit passcode (no hash can — the
//                            keyspace is 10^6) so we accept its limits as
//                            an identifier only.
//
//   passCodeVerifyHash +   — scrypt(passCode, salt). Per-session 16-byte
//   passCodeSalt             salt. This is the only thing checked when
//                            authenticating an attempt; the cost factor
//                            (N=2^14 ≈30 ms / verify) caps the online
//                            guess rate so even 10^6 candidates take days
//                            per IP under the brute-force lock.
//
//   passCodeAlgo           — 'scrypt' for any session born after P0-2, or
//                            'sha256' for legacy in-memory sessions where
//                            we never had a salt. On first successful
//                            authentication we synthesize a salt + scrypt
//                            hash and bump algo to 'scrypt' (lazy upgrade).

const SCRYPT_N = 1 << 14   // 16384, ≈30 ms per call on a 2 GHz core
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_DK_LEN = 32

export function hashPassCodeIdentity(code: string): string {
  return createHash('sha256').update(code).digest('hex')
}

export function newPassCodeSalt(): string {
  return randomBytes(16).toString('hex')
}

export function hashPassCodeScrypt(code: string, saltHex: string): string {
  const salt = Buffer.from(saltHex, 'hex')
  const dk = scryptSync(code, salt, SCRYPT_DK_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
  return dk.toString('hex')
}

interface PassCodeFields {
  passCodeHash: string                         // sha256 identity hash
  passCodeVerifyHash?: string                  // scrypt hash (current sessions)
  passCodeSalt?: string
  passCodeAlgo?: 'sha256' | 'scrypt'
}

/**
 * Compare a candidate plaintext passcode against the stored session.
 * Returns the comparison result PLUS the canonical fields the caller
 * should write back onto the session (used to lazily upgrade a session
 * that only has the legacy sha256 hash to also carry a scrypt+salt pair).
 *
 * Callers that mutate the session on success:
 *
 *   const { ok, upgrade } = verifyAndMaybeUpgrade(code, session)
 *   if (ok && upgrade) Object.assign(session, upgrade)
 */
export function verifyAndMaybeUpgrade(
  candidate: string,
  stored: PassCodeFields,
): { ok: boolean; upgrade?: PassCodeFields } {
  // Preferred path: scrypt+salt present.
  if (stored.passCodeAlgo === 'scrypt' && stored.passCodeSalt && stored.passCodeVerifyHash) {
    const candidateHash = hashPassCodeScrypt(candidate, stored.passCodeSalt)
    return { ok: timingSafeEqualHex(candidateHash, stored.passCodeVerifyHash) }
  }
  // Legacy fall-back: only the sha256 identity hash is on disk. Verify and,
  // if matched, return the scrypt fields so the caller upgrades on the spot.
  const legacy = hashPassCodeIdentity(candidate)
  if (!timingSafeEqualHex(legacy, stored.passCodeHash)) return { ok: false }
  const salt = newPassCodeSalt()
  const upgraded: PassCodeFields = {
    passCodeHash: stored.passCodeHash,          // unchanged; identity stays sha256
    passCodeVerifyHash: hashPassCodeScrypt(candidate, salt),
    passCodeSalt: salt,
    passCodeAlgo: 'scrypt',
  }
  return { ok: true, upgrade: upgraded }
}

/**
 * Compute the canonical hashes for a fresh registration. Identity hash is
 * the deterministic sha256 (used as identity key and for cluster id);
 * verify hash is scrypt with a fresh per-session salt.
 */
export function newPassCodeRecord(code: string): {
  passCodeHash: string
  passCodeVerifyHash: string
  passCodeSalt: string
  passCodeAlgo: 'scrypt'
} {
  const salt = newPassCodeSalt()
  return {
    passCodeHash: hashPassCodeIdentity(code),
    passCodeVerifyHash: hashPassCodeScrypt(code, salt),
    passCodeSalt: salt,
    passCodeAlgo: 'scrypt',
  }
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
  } catch {
    return false
  }
}

export const stats = {
  totalTransfers: 0,
  totalBytes: 0,
  startedAt: Date.now(),
  peakConcurrent: 0,
}

// Track peak concurrent connections
const cpuStart = process.cpuUsage()
export function getCpuUsagePercent(): number {
  const elapsed = (Date.now() - stats.startedAt) / 1000
  const used = process.cpuUsage(cpuStart)
  const totalMs = (used.user + used.system) / 1000 // CPU time in ms
  return Math.round((totalMs / (elapsed * 1000)) * 100)
}

export function updatePeakConcurrent() {
  const online = getOnlineCount()
  if (online > stats.peakConcurrent) stats.peakConcurrent = online
}

export function getOnlineCount() {
  let count = 0
  for (const n of nodes.values()) {
    if (n.socket !== null) count++
  }
  return count
}

export function getLongestUptimeMs() {
  let longest = 0
  const now = Date.now()
  for (const n of nodes.values()) {
    if (n.socket !== null) {
      const uptime = now - n.joinedAt
      if (uptime > longest) longest = uptime
    }
  }
  return longest
}

export function countNodesByIp(ip: string): number {
  let count = 0
  for (const n of nodes.values()) {
    if (n.ip === ip) count++
  }
  return count
}

export function countReportsForTarget(nodeId: number, since: number): number {
  let count = 0
  for (const r of reports) {
    if (r.targetNodeId === nodeId && r.reportedAt > since) count++
  }
  return count
}

export function clusterChannelId(nodeId: number, passCodeHash: string): string {
  // Channel scope = identity tuple. Same nodeId+passcode → same cluster.
  return `cluster-${nodeId}-${passCodeHash.slice(0, 16)}`
}
