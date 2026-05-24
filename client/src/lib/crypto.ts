// ── ECDH Key Exchange + AES-GCM per-peer chunk encryption ───────────
// The AES key is derived on the main thread (ECDH happens once per peer)
// and then mirrored into every worker in the crypto pool. Encrypt/decrypt
// hot-path calls dispatch to the pool — keeping ~tens of milliseconds per
// MB of CPU off the main thread and parallelizing across cores.

import { registerPeerKey, unregisterPeerKey, encryptInWorker, decryptInWorker } from './cryptoPool'

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
  state.myKeyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveKey'],
  )
  state.aesKey = null
  return state.myKeyPair
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
  const buf = Uint8Array.from(atob(peerPubBase64), c => c.charCodeAt(0)) as unknown as Uint8Array<ArrayBuffer>
  const peerPub = await crypto.subtle.importKey(
    'raw', buf,
    { name: 'ECDH', namedCurve: 'P-256' },
    false, [],
  )
  state.aesKey = await crypto.subtle.deriveKey(
    { name: 'ECDH', public: peerPub },
    state.myKeyPair.privateKey,
    { name: 'AES-GCM', length: 256 },
    // CryptoKey must be extractable=false but workers receive a structured
    // clone, which preserves the same usage flags. extractable=true would
    // let the key escape via exportKey — we never need that.
    false,
    ['encrypt', 'decrypt'],
  )
  registerPeerKey(peerSessionId, state.aesKey)
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
export function makeChunkIv(prefix: Uint8Array, index: number): Uint8Array<ArrayBuffer> {
  const iv = new Uint8Array(12)
  iv.set(prefix.subarray(0, 8), 0)
  new DataView(iv.buffer).setUint32(8, index >>> 0, false)
  return iv as Uint8Array<ArrayBuffer>
}

export function randomIvPrefix(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(8))
}

export async function encryptChunk(
  data: ArrayBuffer,
  peerSessionId: string,
  iv?: Uint8Array<ArrayBuffer>,
): Promise<{ iv: Uint8Array<ArrayBuffer>; encrypted: ArrayBuffer }> {
  if (!peerStates.get(peerSessionId)?.aesKey) throw new Error('AES key not derived')
  const actualIv = iv ?? (crypto.getRandomValues(new Uint8Array(12)) as Uint8Array<ArrayBuffer>)
  // `data` is transferred into the worker (zero-copy); the caller's reference
  // becomes detached. sendFileParallel does not reuse `raw` after encrypt, so
  // this is safe in the current hot path.
  const encrypted = await encryptInWorker(peerSessionId, actualIv, data)
  return { iv: actualIv, encrypted }
}

export async function decryptChunk(
  iv: Uint8Array<ArrayBuffer>,
  encrypted: ArrayBuffer,
  peerSessionId: string,
): Promise<ArrayBuffer> {
  if (!peerStates.get(peerSessionId)?.aesKey) throw new Error('AES key not derived')
  return decryptInWorker(peerSessionId, iv, encrypted)
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
