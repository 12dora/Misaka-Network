import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'crypto'
import type { WebSocket } from 'ws'
import type { NodeSession, QrTokenRecord, ReportRecord } from './types.js'
import { SERVER_SECRET_KEY, SCRYPT_MAX_CONCURRENT, SCRYPT_MAX_QUEUE } from './config.js'

// ── customIdentifier derivation (P2-11) ─────────────────────────────
//
// Cloudflare logs and the CF dashboard see only customIdentifier — never the
// sessionId or any user-recognisable handle. We derive it from
// HMAC-SHA-256 keyed by SERVER_SECRET and keep just the first 16 hex chars.
// The mapping is one-way: someone with CF logs alone cannot recover the
// sessionId, while the server keeps both halves in memory and can revoke /
// look up by either side. The redacted form is for log files we ship off-box.
//
// customIdentifier is deliberately session-bound: it ties a Cloudflare
// credential to one session so revoke can target that grant. Abuse DENY
// keys use `deriveTurnPrincipal` instead, which is restart-stable.
export function deriveCustomIdentifier(sessionId: string): string {
  return createHmac('sha256', SERVER_SECRET_KEY)
    .update('misaka:turn-custom-id:v1\0')
    .update(sessionId)
    .digest('hex')
    .slice(0, 16)
}

export function redactCustomIdentifier(cid: string): string {
  return `[redacted-${cid.slice(0, 4)}]`
}

/**
 * Restart-stable TURN principal for durable denial. HMAC over the identity
 * tuple (nodeId + passCodeHash) so the same person re-registering after a
 * process restart still hits the deny list. Never used as a Cloudflare
 * customIdentifier — that stays session-bound for revoke association.
 */
export function deriveTurnPrincipal(nodeId: number, passCodeHash: string): string {
  return createHmac('sha256', SERVER_SECRET_KEY)
    .update('misaka:turn-principal:v1\0')
    .update(String(nodeId))
    .update('\0')
    .update(passCodeHash)
    .digest('hex')
    .slice(0, 32)
}

// ── Re-registration proof (Contract 1) ───────────────────────────────
//
// Opaque single-purpose token that authenticates re-registration of the SAME
// identity after a tab refresh / WS 4001-4002 without needing the plaintext
// passcode. Stored on the session; rotated on every successful use or renew.
// Index is O(1) by proof so /api/re-register does not scan the session map.

const reRegisterProofIndex = new Map<string, string>() // proof → sessionId
// Tombstones keep nodeId attribution for retired/rotated proofs so failed
// re-register attempts still feed the owning identity's freeze budget
// (exactly like a wrong passcode) instead of a synthetic node 0.
const reRegisterProofTombstones = new Map<string, { nodeId: number; until: number }>()
const PROOF_TOMBSTONE_TTL_MS = 60 * 60_000

export function mintReRegisterProof(): string {
  return randomBytes(32).toString('hex')
}

export function indexReRegisterProof(proof: string, sessionId: string): void {
  reRegisterProofIndex.set(proof, sessionId)
  reRegisterProofTombstones.delete(proof)
}

export function unindexReRegisterProof(proof: string | undefined | null, nodeId?: number): void {
  if (!proof) return
  reRegisterProofIndex.delete(proof)
  if (typeof nodeId === 'number' && nodeId > 0) {
    reRegisterProofTombstones.set(proof, { nodeId, until: Date.now() + PROOF_TOMBSTONE_TTL_MS })
  }
}

export function findSessionByReRegisterProof(proof: string): NodeSession | null {
  const r = resolveReRegisterProof(proof)
  return r.status === 'ok' ? r.session : null
}

/**
 * Resolve a re-register proof. On failure, `nodeId` is the owning identity
 * when known (live/expired session, or a recently-retired tombstone) so the
 * freeze budget can be charged exactly like a wrong passcode.
 */
export function resolveReRegisterProof(proof: string):
  | { status: 'ok'; session: NodeSession }
  | { status: 'invalid'; nodeId: number | null } {
  if (!proof || proof.length < 32) return { status: 'invalid', nodeId: null }
  const sessionId = reRegisterProofIndex.get(proof)
  if (sessionId) {
    const session = nodes.get(sessionId)
    if (!session) {
      reRegisterProofIndex.delete(proof)
    } else if (session.reRegisterProof !== proof) {
      reRegisterProofIndex.delete(proof)
      // Mismatch — index was stale; still charge the session's node if present.
      return { status: 'invalid', nodeId: session.nodeId }
    } else if (isSessionExpired(session)) {
      return { status: 'invalid', nodeId: session.nodeId }
    } else {
      return { status: 'ok', session }
    }
  }
  const tomb = reRegisterProofTombstones.get(proof)
  if (tomb) {
    if (Date.now() > tomb.until) {
      reRegisterProofTombstones.delete(proof)
      return { status: 'invalid', nodeId: null }
    }
    return { status: 'invalid', nodeId: tomb.nodeId }
  }
  return { status: 'invalid', nodeId: null }
}

/** Rotate proof in place (session-renew). Returns the new proof. */
export function rotateReRegisterProof(session: NodeSession): string {
  unindexReRegisterProof(session.reRegisterProof, session.nodeId)
  const next = mintReRegisterProof()
  session.reRegisterProof = next
  indexReRegisterProof(next, session.sessionId)
  return next
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

// ── Authenticated-socket index (SECURITY-014) ───────────────────────
//
// `activity.broadcast` used to answer "is this socket authenticated?" by
// scanning every session for every connected client — O(n²) per event, tens
// of millions of comparisons at a few thousand nodes, all on the event loop.
// This map is the O(1) answer. It is written in exactly three places (WS
// AUTH, WS close, supersede) so it cannot drift from `nodes`.
const authedSockets = new Map<WebSocket, string>()

export function markSocketAuthenticated(ws: WebSocket, sessionId: string) {
  authedSockets.set(ws, sessionId)
}

/** Idempotent — safe to call from both the supersede path and 'close'. */
export function unmarkSocket(ws: WebSocket) {
  authedSockets.delete(ws)
}

export function authenticatedSockets(): IterableIterator<WebSocket> {
  return authedSockets.keys()
}

export function isSocketAuthenticated(ws: WebSocket): boolean {
  return authedSockets.has(ws)
}

export function authenticatedSocketCount(): number {
  return authedSockets.size
}

// ── Session expiry (SECURITY-001) ───────────────────────────────────
//
// The advertised session TTL used to exist only as a number in the register
// response body: nothing stored it and nothing enforced it, so a token stayed
// valid for the lifetime of the process. `expiresAt` is now the single
// absolute deadline and this predicate is the single place that reads it.
export function isSessionExpired(session: NodeSession, now = Date.now()): boolean {
  return session.expiresAt > 0 && now >= session.expiresAt
}

/**
 * The one public token resolver. Every caller (HTTP bearer routes, WS AUTH,
 * /api/release, TURN issuance) goes through here, so expiry is enforced in a
 * single place instead of once per route. An expired session is reported as
 * "not found" — the cleanup sweep is what actually evicts it and closes the
 * socket.
 */
export function findSessionByToken(token: string): NodeSession | null {
  const r = resolveSessionByToken(token)
  return r.kind === 'ok' ? r.session : null
}

// Short-lived memory of tokens that belonged to sessions purged for expiry.
// Cleanup removes the session from `nodes`, but Contract 3 still requires
// AUTH with that token to close 4002 (expired) rather than 4001 (unknown)
// until the tombstone ages out.
const expiredTokenTombstones = new Map<string, number>()
const EXPIRED_TOKEN_TOMBSTONE_MS = 5 * 60_000

/** Record that `token` belonged to a session that expired (cleanup path). */
export function markTokenExpired(token: string | undefined | null): void {
  if (!token) return
  expiredTokenTombstones.set(token, Date.now() + EXPIRED_TOKEN_TOMBSTONE_MS)
}

/**
 * Discriminated token resolution for Contract 3 close-code mapping:
 *   - ok      → live session
 *   - expired → token matches a session past expiresAt, or a recent expiry tombstone → WS 4002
 *   - invalid → unknown token → WS 4001
 */
export function resolveSessionByToken(token: string):
  | { kind: 'ok'; session: NodeSession }
  | { kind: 'expired' }
  | { kind: 'invalid' } {
  if (!token) return { kind: 'invalid' }
  const now = Date.now()
  let sawExpired = false
  for (const s of nodes.values()) {
    if (s.token !== token) continue
    if (isSessionExpired(s, now)) {
      sawExpired = true
      markTokenExpired(token)
      continue
    }
    return { kind: 'ok', session: s }
  }
  if (sawExpired) return { kind: 'expired' }
  const until = expiredTokenTombstones.get(token)
  if (until !== undefined) {
    if (now < until) return { kind: 'expired' }
    expiredTokenTombstones.delete(token)
  }
  return { kind: 'invalid' }
}

/**
 * Drop expired re-register-proof and token tombstones. Called from the
 * periodic cleanup task: both maps used to grow without bound because
 * expiry was lazy and only fired when that exact key was presented again —
 * normal expiry/release/renew/rotation never re-presents those keys.
 */
export function cleanupExpiredTombstones(now = Date.now()): { proofs: number; tokens: number } {
  let proofs = 0
  for (const [proof, tomb] of reRegisterProofTombstones) {
    if (now > tomb.until) {
      reRegisterProofTombstones.delete(proof)
      proofs++
    }
  }
  let tokens = 0
  for (const [token, until] of expiredTokenTombstones) {
    if (now >= until) {
      expiredTokenTombstones.delete(token)
      tokens++
    }
  }
  return { proofs, tokens }
}

/** Test hooks for tombstone map sizing. */
export function _tombstoneCountsForTest(): { proofs: number; tokens: number } {
  return { proofs: reRegisterProofTombstones.size, tokens: expiredTokenTombstones.size }
}

/** Test hook — seed a proof tombstone with an absolute expiry. */
export function _seedProofTombstoneForTest(proof: string, nodeId: number, until: number): void {
  reRegisterProofTombstones.set(proof, { nodeId, until })
}

/** Test hook — seed a token tombstone with an absolute expiry. */
export function _seedTokenTombstoneForTest(token: string, until: number): void {
  expiredTokenTombstones.set(token, until)
}

// ── Passcode hashing ────────────────────────────────────────────────
//
// Two hashes are kept per session, with very different jobs:
//
//   passCodeHash           — HMAC-SHA-256(SERVER_SECRET, domain || passcode).
//                            This is the opaque "identity key" used for cluster
//                            channel id (so two devices with the same
//                            (nodeId, passcode) hit the same channel) and
//                            for the nodeId-occupied conflict check. It
//                            stays deterministic inside one deployment but a
//                            stolen session snapshot cannot be cracked with a
//                            precomputed six-digit SHA-256 table without the
//                            deployment secret.
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
  return createHmac('sha256', SERVER_SECRET_KEY)
    .update('misaka/passcode-identity/v1\0')
    .update(code)
    .digest('hex')
}

export function newPassCodeSalt(): string {
  return randomBytes(16).toString('hex')
}

// ── Bounded async scrypt (SECURITY-013) ─────────────────────────────
//
// `scryptSync` is ~30-50 ms of pure CPU on the event loop. Ten concurrent
// registrations therefore froze every WS frame, timer, cleanup pass and TURN
// accounting call for half a second. The async form runs on the libuv
// threadpool instead — but that pool is shared with fs (persistence) and dns,
// so unbounded concurrency just moves the starvation. The semaphore below
// caps in-flight hashes and refuses admissions past a bounded queue with
// `ScryptBusyError`, which the routes translate to 503 SERVER_BUSY.

export class ScryptBusyError extends Error {
  constructor() {
    super('SCRYPT_BUSY')
    this.name = 'ScryptBusyError'
  }
}

let scryptInFlight = 0
const scryptWaiters: Array<() => void> = []

async function acquireScryptSlot(): Promise<void> {
  if (scryptInFlight < SCRYPT_MAX_CONCURRENT) {
    scryptInFlight++
    return
  }
  if (scryptWaiters.length >= SCRYPT_MAX_QUEUE) throw new ScryptBusyError()
  // The releaser hands the slot over directly (it does NOT decrement), so no
  // late arrival can slip past the limit between wake-up and resumption.
  await new Promise<void>(resolve => scryptWaiters.push(resolve))
}

function releaseScryptSlot(): void {
  const next = scryptWaiters.shift()
  if (next) next()
  else scryptInFlight--
}

/** Test hook — number of scrypt hashes started (occupied wrong-passcode path). */
export let _scryptInvokeCountForTest = 0
export function _resetScryptInvokeCountForTest(): void {
  _scryptInvokeCountForTest = 0
}

export async function hashPassCodeScrypt(code: string, saltHex: string): Promise<string> {
  _scryptInvokeCountForTest++
  await acquireScryptSlot()
  try {
    const salt = Buffer.from(saltHex, 'hex')
    return await new Promise<string>((resolve, reject) => {
      scrypt(code, salt, SCRYPT_DK_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 }, (err, dk) => {
        if (err) reject(err)
        else resolve(dk.toString('hex'))
      })
    })
  } finally {
    releaseScryptSlot()
  }
}

interface PassCodeFields {
  passCodeHash: string                         // keyed identity representation
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
export async function verifyAndMaybeUpgrade(
  candidate: string,
  stored: PassCodeFields,
): Promise<{ ok: boolean; upgrade?: PassCodeFields }> {
  // Preferred path: scrypt+salt present.
  if (stored.passCodeAlgo === 'scrypt' && stored.passCodeSalt && stored.passCodeVerifyHash) {
    const candidateHash = await hashPassCodeScrypt(candidate, stored.passCodeSalt)
    return { ok: timingSafeEqualHex(candidateHash, stored.passCodeVerifyHash) }
  }
  // Legacy fall-back: only the keyed identity representation is present.
  // if matched, return the scrypt fields so the caller upgrades on the spot.
  const legacy = hashPassCodeIdentity(candidate)
  if (!timingSafeEqualHex(legacy, stored.passCodeHash)) return { ok: false }
  const salt = newPassCodeSalt()
  const upgraded: PassCodeFields = {
    passCodeHash: stored.passCodeHash,          // unchanged; identity stays sha256
    passCodeVerifyHash: await hashPassCodeScrypt(candidate, salt),
    passCodeSalt: salt,
    passCodeAlgo: 'scrypt',
  }
  return { ok: true, upgrade: upgraded }
}

/**
 * Compute the canonical hashes for a fresh registration. Identity hash is
 * a deterministic deployment-keyed HMAC (used as identity key and cluster id);
 * verify hash is scrypt with a fresh per-session salt.
 */
export async function newPassCodeRecord(code: string): Promise<{
  passCodeHash: string
  passCodeVerifyHash: string
  passCodeSalt: string
  passCodeAlgo: 'scrypt'
}> {
  const salt = newPassCodeSalt()
  return {
    passCodeHash: hashPassCodeIdentity(code),
    passCodeVerifyHash: await hashPassCodeScrypt(code, salt),
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

export function clusterChannelId(nodeId: number, passCodeHash: string): string {
  // Channel scope = identity tuple. Same nodeId+passcode → same cluster.
  return `cluster-${nodeId}-${passCodeHash.slice(0, 16)}`
}
