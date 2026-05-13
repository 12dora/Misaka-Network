// ── ECDH Key Exchange + AES-GCM per-chunk encryption ────────────────

let myKeyPair: CryptoKeyPair | null = null
let aesKey: CryptoKey | null = null

export async function generateECDHKeyPair(): Promise<CryptoKeyPair> {
  myKeyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveKey'],
  )
  return myKeyPair
}

export async function getMyPublicKey(): Promise<string> {
  if (!myKeyPair) throw new Error('ECDH keypair not generated')
  const raw = await crypto.subtle.exportKey('raw', myKeyPair.publicKey)
  return btoa(String.fromCharCode(...new Uint8Array(raw as ArrayBuffer)))
}

export async function setPeerPublicKey(peerPubBase64: string) {
  if (!myKeyPair) throw new Error('ECDH keypair not generated')
  const buf = Uint8Array.from(atob(peerPubBase64), c => c.charCodeAt(0)) as unknown as Uint8Array<ArrayBuffer>
  const peerPub = await crypto.subtle.importKey(
    'raw', buf,
    { name: 'ECDH', namedCurve: 'P-256' },
    false, [],
  )
  aesKey = await crypto.subtle.deriveKey(
    { name: 'ECDH', public: peerPub },
    myKeyPair.privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export function hasAESKey(): boolean {
  return aesKey !== null
}

export async function encryptChunk(data: ArrayBuffer): Promise<{ iv: Uint8Array<ArrayBuffer>; encrypted: ArrayBuffer }> {
  if (!aesKey) throw new Error('AES key not derived')
  const iv = crypto.getRandomValues(new Uint8Array(12)) as Uint8Array<ArrayBuffer>
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    data,
  )
  return { iv, encrypted }
}

export async function decryptChunk(iv: Uint8Array<ArrayBuffer>, encrypted: ArrayBuffer): Promise<ArrayBuffer> {
  if (!aesKey) throw new Error('AES key not derived')
  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    encrypted,
  )
}

export function resetCrypto() {
  myKeyPair = null
  aesKey = null
}
