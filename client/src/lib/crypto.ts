// ── ECDH Key Exchange + AES-GCM per-peer chunk encryption ───────────

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
    false,
    ['encrypt', 'decrypt'],
  )
}

export function hasAESKey(peerSessionId: string): boolean {
  return peerStates.get(peerSessionId)?.aesKey !== null && peerStates.get(peerSessionId)?.aesKey !== undefined
}

export async function encryptChunk(
  data: ArrayBuffer,
  peerSessionId: string,
): Promise<{ iv: Uint8Array<ArrayBuffer>; encrypted: ArrayBuffer }> {
  const aesKey = peerStates.get(peerSessionId)?.aesKey
  if (!aesKey) throw new Error('AES key not derived')
  const iv = crypto.getRandomValues(new Uint8Array(12)) as Uint8Array<ArrayBuffer>
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    data,
  )
  return { iv, encrypted }
}

export async function decryptChunk(
  iv: Uint8Array<ArrayBuffer>,
  encrypted: ArrayBuffer,
  peerSessionId: string,
): Promise<ArrayBuffer> {
  const aesKey = peerStates.get(peerSessionId)?.aesKey
  if (!aesKey) throw new Error('AES key not derived')
  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    encrypted,
  )
}

export function resetCrypto(peerSessionId?: string) {
  if (peerSessionId) {
    peerStates.delete(peerSessionId)
    return
  }
  peerStates.clear()
}
