import { beforeEach, describe, expect, it, vi } from 'vitest'

const registerPeerKey = vi.fn()
const unregisterPeerKey = vi.fn()

vi.mock('@/lib/cryptoPool', () => ({
  registerPeerKey,
  unregisterPeerKey,
  encryptInWorker: vi.fn(),
  decryptInWorker: vi.fn(),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => { resolve = res })
  return { promise, resolve }
}

describe('ECDH peer generation isolation', () => {
  beforeEach(() => {
    vi.resetModules()
    registerPeerKey.mockReset()
    unregisterPeerKey.mockReset()
    vi.restoreAllMocks()
  })

  it('cannot register a stale derivation after cleanup and a new key generation', async () => {
    const oldPair = {
      publicKey: { id: 'old-public' },
      privateKey: { id: 'old-private' },
    } as unknown as CryptoKeyPair
    const newPair = {
      publicKey: { id: 'new-public' },
      privateKey: { id: 'new-private' },
    } as unknown as CryptoKeyPair
    const importedKey = { id: 'remote-public' } as unknown as CryptoKey
    const staleAes = { id: 'stale-aes' } as unknown as CryptoKey
    const currentAes = { id: 'current-aes' } as unknown as CryptoKey
    const staleDerive = deferred<CryptoKey>()

    let generateCalls = 0
    vi.spyOn(globalThis.crypto.subtle, 'generateKey').mockImplementation(async () => {
      generateCalls++
      return generateCalls === 1 ? oldPair : newPair
    })
    vi.spyOn(globalThis.crypto.subtle, 'importKey').mockResolvedValue(importedKey)
    let deriveCalls = 0
    vi.spyOn(globalThis.crypto.subtle, 'deriveKey').mockImplementation(async () => {
      deriveCalls++
      return deriveCalls === 1 ? staleDerive.promise : currentAes
    })

    const cryptoModule = await import('../../src/lib/crypto')
    await cryptoModule.generateECDHKeyPair('peer-1')
    const staleWork = cryptoModule.setPeerPublicKey('peer-1', 'AA==')
    for (let i = 0; i < 5; i++) await Promise.resolve()

    cryptoModule.resetCrypto('peer-1')
    await cryptoModule.generateECDHKeyPair('peer-1')
    await cryptoModule.setPeerPublicKey('peer-1', 'AA==')
    staleDerive.resolve(staleAes)
    await staleWork

    expect(registerPeerKey).toHaveBeenCalledTimes(1)
    expect(registerPeerKey).toHaveBeenCalledWith('peer-1', currentAes)
    expect(registerPeerKey).not.toHaveBeenCalledWith('peer-1', staleAes)
    expect(cryptoModule.hasAESKey('peer-1')).toBe(true)
  })

  it('abandons an imported peer key when cleanup replaces its captured state', async () => {
    const oldPair = {
      publicKey: { id: 'old-public' },
      privateKey: { id: 'old-private' },
    } as unknown as CryptoKeyPair
    const newPair = {
      publicKey: { id: 'new-public' },
      privateKey: { id: 'new-private' },
    } as unknown as CryptoKeyPair
    const importedKey = { id: 'remote-public' } as unknown as CryptoKey
    const currentAes = { id: 'current-aes' } as unknown as CryptoKey
    const staleImport = deferred<CryptoKey>()

    let generateCalls = 0
    vi.spyOn(globalThis.crypto.subtle, 'generateKey').mockImplementation(async () => {
      generateCalls++
      return generateCalls === 1 ? oldPair : newPair
    })
    let importCalls = 0
    vi.spyOn(globalThis.crypto.subtle, 'importKey').mockImplementation(async () => {
      importCalls++
      return importCalls === 1 ? staleImport.promise : importedKey
    })
    const derive = vi.spyOn(globalThis.crypto.subtle, 'deriveKey').mockResolvedValue(currentAes)

    const cryptoModule = await import('../../src/lib/crypto')
    await cryptoModule.generateECDHKeyPair('peer-1')
    const staleWork = cryptoModule.setPeerPublicKey('peer-1', 'AA==')
    for (let i = 0; i < 5; i++) await Promise.resolve()

    cryptoModule.resetCrypto('peer-1')
    await cryptoModule.generateECDHKeyPair('peer-1')
    await cryptoModule.setPeerPublicKey('peer-1', 'AA==')
    staleImport.resolve(importedKey)
    await staleWork

    expect(derive).toHaveBeenCalledTimes(1)
    expect(registerPeerKey).toHaveBeenCalledTimes(1)
    expect(registerPeerKey).toHaveBeenCalledWith('peer-1', currentAes)
  })
})
