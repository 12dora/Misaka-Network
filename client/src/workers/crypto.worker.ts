// AES-GCM encrypt/decrypt worker.
//
// Each worker keeps a Map<peerSessionId, CryptoKey>; the main thread derives
// the key (via ECDH on the WebCrypto API) and broadcasts the resulting
// CryptoKey to every worker in the pool (CryptoKey is structured-cloneable).
// Encrypted/decrypted payloads cross the wire as Transferable ArrayBuffers
// for zero-copy hand-off.
//
// PROTOCOL_VERSION ≥ 3 binds transferId / shortId / index / plaintextLength
// as AES-GCM additionalData so a frame cannot be re-routed across indexes
// or transfers without the tag failing.

type SetKeyMsg = { type: 'set-key'; peerSessionId: string; aesKey: CryptoKey }
type DropKeyMsg = { type: 'drop-key'; peerSessionId?: string }
type OpMsg = {
  type: 'op'
  id: number
  op: 'encrypt' | 'decrypt'
  peerSessionId: string
  iv: Uint8Array
  data: ArrayBuffer
  /** Optional AES-GCM AAD (protocol v3+). */
  additionalData?: Uint8Array
  /**
   * When set, `data` is a full chunk frame and these mark the ciphertext
   * region (and optionally the IV region). Avoids a main-thread ciphertext
   * copy for every ~252 KB message.
   */
  cipherOffset?: number
  cipherLength?: number
  ivOffset?: number
  ivLength?: number
}

type InMsg = SetKeyMsg | DropKeyMsg | OpMsg

const keys = new Map<string, CryptoKey>()

// Avoid pulling the WebWorker lib into the whole project's tsconfig; the
// worker is type-checked by the same `lib: ["ES2020","DOM",...]` config and
// `self` resolves to `Window` in that lib. Treat the global as a postMessage
// surface explicitly.
interface WorkerLike {
  postMessage: (data: unknown, transfer?: Transferable[]) => void
  onmessage: ((e: MessageEvent<InMsg>) => unknown) | null
}
const ctx = self as unknown as WorkerLike

ctx.onmessage = async (e: MessageEvent<InMsg>) => {
  const msg = e.data

  if (msg.type === 'set-key') {
    keys.set(msg.peerSessionId, msg.aesKey)
    return
  }

  if (msg.type === 'drop-key') {
    if (msg.peerSessionId) keys.delete(msg.peerSessionId)
    else keys.clear()
    return
  }

  if (msg.type === 'op') {
    const { id, op, peerSessionId, data } = msg
    const key = keys.get(peerSessionId)
    if (!key) {
      ctx.postMessage({ id, ok: false, error: 'No AES key for peer' })
      return
    }
    try {
      let ivBytes: Uint8Array
      let payload: ArrayBuffer
      if (
        typeof msg.cipherOffset === 'number'
        && typeof msg.cipherLength === 'number'
      ) {
        payload = data.slice(msg.cipherOffset, msg.cipherOffset + msg.cipherLength)
        if (typeof msg.ivOffset === 'number' && typeof msg.ivLength === 'number') {
          ivBytes = new Uint8Array(data, msg.ivOffset, msg.ivLength)
        } else {
          ivBytes = new Uint8Array(msg.iv)
        }
      } else {
        payload = data
        ivBytes = new Uint8Array(msg.iv)
      }

      const params: AesGcmParams = {
        name: 'AES-GCM',
        iv: ivBytes as BufferSource,
      }
      if (msg.additionalData && msg.additionalData.byteLength > 0) {
        params.additionalData = msg.additionalData as BufferSource
      }

      const result = await crypto.subtle[op](params, key, payload) as ArrayBuffer
      ctx.postMessage({ id, ok: true, result }, [result])
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      ctx.postMessage({ id, ok: false, error: message })
    }
  }
}
