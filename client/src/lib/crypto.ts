// ── ECDH Key Exchange + AES-GCM per-peer chunk encryption ───────────
// The AES key is derived on the main thread (ECDH happens once per peer)
// and then mirrored into every worker in the crypto pool. Encrypt/decrypt
// hot-path calls dispatch to the pool — keeping ~tens of milliseconds per
// MB of CPU off the main thread and parallelizing across cores.

import {
  registerPeerKey, unregisterPeerKey, encryptInWorker, decryptInWorker,
  decryptFrameInWorker,
} from './cryptoPool'

type PeerCryptoState = {
  myKeyPair: CryptoKeyPair | null
  aesKey: CryptoKey | null
}

const peerStates = new Map<string, PeerCryptoState>()

function stateFor(peerSessionId: string): PeerCryptoState {
  let state = peerStates.get(peerSessionId)
  if (!state) {
    state = { myKeyPair: null, aesKey: null }
    peerStates.set(peerSessionId, state)
  }
  return state
}

export async function generateECDHKeyPair(peerSessionId: string): Promise<CryptoKeyPair> {
  const state = stateFor(peerSessionId)
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveKey'],
  )
  // resetCrypto(peer) may have ended this generation while generateKey was
  // in flight. Never publish a keypair into a detached state object.
  if (peerStates.get(peerSessionId) !== state) return keyPair
  state.myKeyPair = keyPair
  state.aesKey = null
  return keyPair
}

export async function getMyPublicKey(peerSessionId: string): Promise<string> {
  const state = stateFor(peerSessionId)
  if (!state.myKeyPair) throw new Error('ECDH keypair not generated')
  const raw = await crypto.subtle.exportKey('raw', state.myKeyPair.publicKey)
  return btoa(String.fromCharCode(...new Uint8Array(raw as ArrayBuffer)))
}

export async function setPeerPublicKey(peerSessionId: string, peerPubBase64: string) {
  const state = stateFor(peerSessionId)
  if (!state.myKeyPair) throw new Error('ECDH keypair not generated')
  const keyPair = state.myKeyPair
  const stillCurrent = () =>
    peerStates.get(peerSessionId) === state
    && state.myKeyPair === keyPair
  const buf = Uint8Array.from(atob(peerPubBase64), c => c.charCodeAt(0)) as unknown as Uint8Array<ArrayBuffer>
  const peerPub = await crypto.subtle.importKey(
    'raw', buf,
    { name: 'ECDH', namedCurve: 'P-256' },
    false, [],
  )
  if (!stillCurrent()) return
  const aesKey = await crypto.subtle.deriveKey(
    { name: 'ECDH', public: peerPub },
    keyPair.privateKey,
    { name: 'AES-GCM', length: 256 },
    // CryptoKey must be extractable=false but workers receive a structured
    // clone, which preserves the same usage flags. extractable=true would
    // let the key escape via exportKey — we never need that.
    false,
    ['encrypt', 'decrypt'],
  )
  if (!stillCurrent()) return
  state.aesKey = aesKey
  // No await separates the state commit and pool registration, but keep the
  // identity check adjacent to the external side effect so a later refactor
  // cannot accidentally publish a detached generation.
  if (!stillCurrent() || state.aesKey !== aesKey) return
  registerPeerKey(peerSessionId, aesKey)
}

export function hasAESKey(peerSessionId: string): boolean {
  return peerStates.get(peerSessionId)?.aesKey !== null && peerStates.get(peerSessionId)?.aesKey !== undefined
}

// Build a 12-byte AES-GCM IV from an 8-byte per-transfer random prefix and a
// 4-byte chunk index. Per NIST SP 800-38D §8.2.1 this construction is safe
// as long as the (key, prefix) pair is unique across messages — our key is
// per-peer-session and the prefix is freshly random per transfer (~2^-64
// collision per pair), so each chunk gets a unique IV without paying the
// per-chunk getRandomValues syscall (~4000 RNG calls/GB avoided).
//
// CONTRACT (do not break without updating callers):
//   The `prefix` MUST be unique per (AES key, transfer) tuple.
//   Concretely: in our send path the AES key is derived per peerSessionId
//   via ECDH, and `randomIvPrefix()` is called once per call to
//   `sendFileParallel()`. So every call site that invokes the engine for a
//   NEW peer-and-transfer pair gets a fresh prefix, and reuse only occurs
//   *within* a single send loop (where the 4-byte index then disambiguates).
//   In particular, `sendFilesToAll` calls `sendFileToPeer` per (file, peer)
//   independently — each call gets its own prefix, so the same chunk index
//   across two peers produces different IVs even when the plaintext is the
//   same file. See `transfer-iv-multi-peer.test.ts` for the regression.
// Overloads:
//   - 2-arg (deprecated): legacy callers that pre-date P1-9. Sync,
//     no domain separation. New code should pass transferId.
//   - 3-arg (P1-9): async because the per-transfer domain separation is
//     a SHA-256 of (ivPrefix || transferIdBytes); the first 8 bytes of
//     the digest replace the raw prefix. Result: two transfers that
//     accidentally drew the same `randomIvPrefix()` get DIFFERENT IVs
//     for chunk index N, eliminating the (key, IV) reuse risk entirely.
export function makeChunkIv(prefix: Uint8Array, index: number): Uint8Array<ArrayBuffer>
export function makeChunkIv(prefix: Uint8Array, index: number, transferId: string): Promise<Uint8Array<ArrayBuffer>>
export function makeChunkIv(
  prefix: Uint8Array,
  index: number,
  transferId?: string,
): Uint8Array<ArrayBuffer> | Promise<Uint8Array<ArrayBuffer>> {
  if (transferId === undefined) {
    // Legacy fast path — unchanged from pre-P1-9.
    return assembleChunkIv(prefix.subarray(0, 8), index)
  }
  return makeChunkIvAsync(prefix, index, transferId)
}

/** Derive the 8-byte domain-separated IV prefix once per transfer. The wire
 *  IV for chunk `i` is then this prefix || BE32(i) — identical bytes to the
 *  previous per-chunk SHA-256 path, without recomputing the digest ~66k times
 *  for a 16 GB file. */
export async function deriveTransferIvPrefix(
  randomPrefix: Uint8Array,
  transferId: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const transferIdBytes = new TextEncoder().encode(transferId)
  const input = new Uint8Array(8 + transferIdBytes.length)
  input.set(randomPrefix.subarray(0, 8), 0)
  input.set(transferIdBytes, 8)
  const digest = await crypto.subtle.digest('SHA-256', input)
  return new Uint8Array(digest, 0, 8) as Uint8Array<ArrayBuffer>
}

function assembleChunkIv(domainPrefix: Uint8Array, index: number): Uint8Array<ArrayBuffer> {
  const iv = new Uint8Array(12)
  iv.set(domainPrefix.subarray(0, 8), 0)
  new DataView(iv.buffer).setUint32(8, index >>> 0, false)
  return iv as Uint8Array<ArrayBuffer>
}

async function makeChunkIvAsync(
  prefix: Uint8Array,
  index: number,
  transferId: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const domain = await deriveTransferIvPrefix(prefix, transferId)
  return assembleChunkIv(domain, index)
}

export function randomIvPrefix(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(8))
}

/**
 * PROTOCOL_VERSION ≥ 3 AES-GCM AAD. Deterministic, length-prefixed transferId
 * so field boundaries are unambiguous. Bound into every encrypt/decrypt when
 * the negotiated version is ≥ 3; v1/v2 peers keep empty AAD behaviour.
 */
export function chunkAad(
  protocolVersion: number,
  transferId: string,
  shortId: number,
  index: number,
  plaintextLength: number,
): Uint8Array<ArrayBuffer> {
  const idBytes = new TextEncoder().encode(transferId)
  const out = new Uint8Array(4 + 4 + idBytes.length + 4 + 4 + 4)
  const view = new DataView(out.buffer)
  let o = 0
  view.setUint32(o, protocolVersion >>> 0, false); o += 4
  view.setUint32(o, idBytes.length >>> 0, false); o += 4
  out.set(idBytes, o); o += idBytes.length
  view.setUint32(o, shortId >>> 0, false); o += 4
  view.setUint32(o, index >>> 0, false); o += 4
  view.setUint32(o, plaintextLength >>> 0, false)
  return out as Uint8Array<ArrayBuffer>
}

export async function encryptChunk(
  data: ArrayBuffer,
  peerSessionId: string,
  iv?: Uint8Array<ArrayBuffer>,
  additionalData?: Uint8Array,
): Promise<{ iv: Uint8Array<ArrayBuffer>; encrypted: ArrayBuffer }> {
  if (!peerStates.get(peerSessionId)?.aesKey) throw new Error('AES key not derived')
  const actualIv = iv ?? (crypto.getRandomValues(new Uint8Array(12)) as Uint8Array<ArrayBuffer>)
  // `data` is transferred into the worker (zero-copy); the caller's reference
  // becomes detached. sendFileParallel does not reuse `raw` after encrypt, so
  // this is safe in the current hot path.
  const encrypted = await encryptInWorker(peerSessionId, actualIv, data, additionalData)
  return { iv: actualIv, encrypted }
}

export async function decryptChunk(
  iv: Uint8Array<ArrayBuffer>,
  encrypted: ArrayBuffer,
  peerSessionId: string,
  additionalData?: Uint8Array,
): Promise<ArrayBuffer> {
  if (!peerStates.get(peerSessionId)?.aesKey) throw new Error('AES key not derived')
  return decryptInWorker(peerSessionId, iv, encrypted, additionalData)
}

/** Decrypt ciphertext in-place from a full chunk frame (no main-thread copy). */
export async function decryptChunkFrame(
  peerSessionId: string,
  frame: ArrayBuffer,
  ivOffset: number,
  ivLength: number,
  cipherOffset: number,
  cipherLength: number,
  additionalData?: Uint8Array,
): Promise<ArrayBuffer> {
  if (!peerStates.get(peerSessionId)?.aesKey) throw new Error('AES key not derived')
  return decryptFrameInWorker(
    peerSessionId, frame, ivOffset, ivLength, cipherOffset, cipherLength, additionalData,
  )
}

export function resetCrypto(peerSessionId?: string) {
  if (peerSessionId) {
    peerStates.delete(peerSessionId)
    unregisterPeerKey(peerSessionId)
    return
  }
  peerStates.clear()
  unregisterPeerKey()
}
