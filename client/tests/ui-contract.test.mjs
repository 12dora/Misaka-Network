#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const read = path => readFileSync(join(root, path), 'utf8')

const css = read('src/index.css')
const app = read('src/App.tsx')
const topNav = read('src/components/layout/TopNav.tsx')
const qr = read('src/components/features/QRModal.tsx')
const settings = read('src/components/features/SettingsModal.tsx')
const scan = read('src/components/features/ScanModal.tsx')
const receive = read('src/components/features/ReceiveConfirmModal.tsx')
const network = read('src/pages/Network.tsx')
const networkStore = read('src/store/network.ts')
const crypto = read('src/lib/crypto.ts')
const transfer = read('src/lib/transfer.ts')
const serviceWorker = read('public/sw.js')

assert.match(css, /@keyframes page-enter/)
assert.match(css, /@keyframes modal-backdrop-in/)
assert.match(css, /@keyframes modal-panel-in/)
assert.match(css, /@keyframes modal-backdrop-out/)
assert.match(css, /@keyframes modal-panel-out/)
assert.match(app, /key=\{location\.pathname\} className="page-enter"/)
assert.match(read('src/hooks/useModalExit.ts'), /modal-panel-out/)

for (const [name, source] of Object.entries({ qr, settings, scan, receive })) {
  assert.match(source, /modal-(backdrop|panel)|useModalExit/, `${name} has modal animation hook/classes`)
}

assert.match(topNav, /<svg width="18" height="18" viewBox="0 0 24 24"/)
assert.match(topNav, /inline-grid place-items-center/)
assert.match(topNav, /lineHeight: 0/)
assert.match(topNav, /h-8 inline-flex items-center/)

assert.match(qr, /QRCode\.toCanvas/)
assert.match(qr, /QRCode\.toDataURL/)
assert.match(qr, /qrImageUrl/)
assert.match(qr, /QR 渲染失败/)

assert.match(network, /type="file" multiple/)
assert.match(network, /webkitdirectory/)
assert.match(network, /待发送 \{pendingFiles\.length\} 个项目/)

assert.match(networkStore, /startQueuedDelivery\(peerSessionId\)/)
assert.match(networkStore, /ensureConnected\(peerSessionId\)/)
assert.match(networkStore, /cleanupPeerConnection\(peerSessionId, \{ failQueuedMessages: false \}\)/)
assert.match(networkStore, /remoteInitiatingPeers\.add\(sessionId\)/)
assert.match(networkStore, /waitForPrimaryChannel\(peerSessionId\)/)
assert.match(networkStore, /peerConnections\.has\(peerSessionId\)\) && !dataChannels\.has\(peerSessionId\)/)
assert.match(networkStore, /notifyPrimaryChannel\(fromSessionId\)/)
assert.match(networkStore, /getMyPublicKey\(peerSessionId\)/)
assert.match(networkStore, /setPeerPublicKey\(peerSessionId, msg\.pub\)/)
assert.match(networkStore, /hasAESKey\(peerSessionId\)/)
assert.match(networkStore, /if \(!dc\.label\.startsWith\('misaka-transfer-'\)\)/)
assert.match(networkStore, /if \(hasAESKey\(peerSessionId\)\) flushOutgoing\(peerSessionId, dc\)/)
assert.match(networkStore, /flushOutgoing\(peerSessionId, dc\)\s+sendResumeRequests\(peerSessionId, dc\)/)
// receiveChunk now takes (transferId, index, iv, ciphertext) — chunk frame is
// a single binary message; the transferId comes from the shortId map.
assert.match(networkStore, /receiveChunk\(\s*transferId, frame\.index, frame\.iv, frame\.ciphertext, peerSessionId,/)
assert.match(networkStore, /decodeChunkFrame\(e\.data\)/)
assert.match(networkStore, /shortIdToTransferId/)
// Per-chunk JSON header and ack are removed — the binary frame carries both
// shortId and index; DataChannel reliability makes app-level acks redundant.
assert.doesNotMatch(networkStore, /lastChunkHeader/)
assert.doesNotMatch(networkStore, /dc\.send\(JSON\.stringify\(ack\)\)/)
assert.match(networkStore, /engineSendFileParallel\([^)]*peerSessionId/s)
assert.match(networkStore, /if \(s\.transfers\.some\(t => t\.id === meta\.transferId\)\) return s/)
assert.match(networkStore, /if \(!pc && sdp\.type !== 'offer'\)/)
assert.match(networkStore, /pc\.signalingState !== 'have-local-offer'/)

assert.match(crypto, /const peerStates = new Map<string, PeerCryptoState>\(\)/)
assert.match(crypto, /generateECDHKeyPair\(peerSessionId: string\)/)
assert.match(crypto, /setPeerPublicKey\(peerSessionId: string, peerPubBase64: string\)/)
assert.match(crypto, /resetCrypto\(peerSessionId\?: string\)/)

// Per-chunk IV is built from an 8-byte per-transfer prefix + 4-byte index
// (NIST SP 800-38D §8.2.1) instead of a per-chunk getRandomValues call.
assert.match(transfer, /encryptChunk\(raw, peerSessionId, makeChunkIv\(ivPrefix, i\)\)/)
assert.match(transfer, /decryptChunk\(iv, encrypted, peerSessionId\)/)
assert.match(transfer, /const ivPrefix = randomIvPrefix\(\)/)

assert.match(serviceWorker, /misaka-shell-v3/)
assert.doesNotMatch(serviceWorker, /const cached = await caches\.match\(req\)\s+if \(cached\) return cached\s+try/s)

console.log('✅ 前端 UI 契约测试通过')
