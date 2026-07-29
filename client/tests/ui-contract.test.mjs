#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const read = path => readFileSync(join(root, path), 'utf8')

// Wave 4a: transfer implementation lives under src/lib/transfer/*; the
// facade at transfer.ts only re-exports. Contract patterns must match the
// implementation, not the barrel alone.
function readTransferTree(dir = 'src/lib/transfer') {
  const parts = [read('src/lib/transfer.ts')]
  const walk = (d) => {
    for (const name of readdirSync(join(root, d))) {
      const rel = `${d}/${name}`
      const abs = join(root, rel)
      if (statSync(abs).isDirectory()) walk(rel)
      else if (name.endsWith('.ts')) parts.push(read(rel))
    }
  }
  try { walk(dir) } catch { /* pre-split layout */ }
  return parts.join('\n')
}

const css = read('src/index.css')
const app = read('src/App.tsx')
const topNav = read('src/components/layout/TopNav.tsx')
const qr = read('src/components/features/QRModal.tsx')
const settings = read('src/components/features/SettingsModal.tsx')
const scan = read('src/components/features/ScanModal.tsx')
const footer = read('src/components/ui/AppFooter.tsx')
const privacy = read('src/pages/Privacy.tsx')
const terms = read('src/pages/Terms.tsx')
const network = read('src/pages/Network.tsx')
// Wave 4b: network implementation lives under src/store/network/*; the
// facade at network.ts only re-exports. Contract patterns must match the
// implementation, not the barrel alone.
function readNetworkStoreTree() {
  const parts = [read('src/store/network.ts')]
  const walk = (d) => {
    for (const name of readdirSync(join(root, d))) {
      const rel = `${d}/${name}`
      const abs = join(root, rel)
      if (statSync(abs).isDirectory()) walk(rel)
      else if (name.endsWith('.ts')) parts.push(read(rel))
    }
  }
  try { walk('src/store/network') } catch { /* pre-split layout */ }
  return parts.join('\n')
}
const networkStore = readNetworkStoreTree()
const authStore = read('src/store/auth.ts')
const signaling = read('src/lib/signaling.ts')
const api = read('src/lib/api.ts')
const crypto = read('src/lib/crypto.ts')
const transfer = readTransferTree()
const serviceWorker = read('public/sw.js')

assert.match(css, /@keyframes page-enter/)
assert.match(css, /@keyframes modal-backdrop-in/)
assert.match(css, /@keyframes modal-panel-in/)
assert.match(css, /@keyframes modal-backdrop-out/)
assert.match(css, /@keyframes modal-panel-out/)
assert.match(app, /key=\{location\.pathname\} className="page-enter"/)
assert.match(read('src/hooks/useModalExit.ts'), /modal-panel-out/)

for (const [name, source] of Object.entries({ qr, settings, scan })) {
  assert.match(source, /modal-(backdrop|panel)|useModalExit/, `${name} has modal animation hook/classes`)
}

assert.match(topNav, /<svg width="18" height="18" viewBox="0 0 24 24"/)
assert.match(topNav, /inline-grid place-items-center/)
assert.match(topNav, /lineHeight: 0/)
assert.match(topNav, /h-8 inline-flex items-center/)

// #20 — beforeinstallprompt is single-use; the consumed event MUST be cleared
// on BOTH accepted and dismissed (a `finally { setInstallPrompt(null) }` does
// it). Previously only the accepted branch cleared it, leaving a dead button.
assert.match(topNav, /finally\s*\{\s*setInstallPrompt\(null\)/)

// #29 — clicking the settings gear must close the mobile hamburger menu so
// the dropdown doesn't sit on top of the opening SettingsModal.
assert.match(topNav, /onClick=\{\(\)\s*=>\s*\{\s*setMenuOpen\(false\);\s*setShowSettings\(true\)/)

// #31 — "刷新 QR" button must be disabled while a fetch is in-flight so the
// user can't spam-click it. fetchToken sets `loading` on entry; we reuse that.
assert.match(qr, /onClick=\{fetchToken\}\s+disabled=\{loading\}/)

// #32 — TURN "测试" button must disable itself while a test is in-flight,
// signalled by testingId === s.id (same condition the row label uses).
assert.match(settings, /disabled=\{testingId === s\.id\}/)

// #34 — deleting a server that's currently being edited must clear the
// editing form so "保存" doesn't silently no-op against a vanished id.
assert.match(settings, /editingServer\?\.id === id/)
assert.match(settings, /setEditingServer\(null\)/)

// #30 — footer must surface Privacy + Terms links; pages must cross-link.
assert.match(footer, /to="\/privacy"/)
assert.match(footer, /to="\/tos"/)
assert.match(privacy, /to="\/tos"/)
assert.match(privacy, /查看服务条款/)
assert.match(terms, /to="\/privacy"/)
assert.match(terms, /查看隐私政策/)

assert.match(qr, /QRCode\.toCanvas/)
assert.match(qr, /QRCode\.toDataURL/)
assert.match(qr, /qrImageUrl/)
assert.match(qr, /QR 渲染失败/)

// authedFetch core contract: retry once with a fresh token after 401, then
// throw AuthRequiredError (not just resolve a 401 response).
assert.match(api, /export class AuthRequiredError/)
assert.match(api, /export async function authedFetch/)
assert.match(api, /res\.status !== 401/)
assert.match(api, /throw new AuthRequiredError\(\)/)
assert.match(api, /sessionStorage\.removeItem\('misaka\.session'\)/)

// WS close codes 4001/4002 (AUTH_REQUIRED / INVALID_TOKEN) must trigger the
// auth-invalid signal — otherwise the client loops on the dead token forever.
assert.match(signaling, /e\.code === 4001 \|\| e\.code === 4002/)
assert.match(signaling, /export function onAuthInvalid/)
assert.match(authStore, /onAuthInvalid\(\(\)\s*=>/)
assert.match(authStore, /store\.clearSession\(\)/)
assert.match(authStore, /void store\.connect\(\)/)

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
assert.match(networkStore, /setPeerPublicKey\(peerSessionId,\s*(?:String\()?msg\.pub/)
assert.match(networkStore, /hasAESKey\(peerSessionId\)/)
assert.match(networkStore, /const isTransferLane = dc\.label\.startsWith\('misaka-transfer-'\)/)
assert.match(networkStore, /if \(!isTransferLane\)/)
assert.match(networkStore, /const publishEncryptedReady = \(\) =>/)
assert.match(networkStore, /if \(!stillCurrent\(\) \|\| !hasAESKey\(peerSessionId\)\) return false/)
assert.match(networkStore, /if \(hasAESKey\(peerSessionId\)\) flushOutgoing\(peerSessionId, dc\)/)
assert.match(networkStore, /flushOutgoing\(peerSessionId, dc\)\s+flushPendingDurableAcks\(peerSessionId\)\s+sendResumeRequests\(peerSessionId, dc\)/)
// receiveChunk: production uses rawFrame + offsets (zero-copy). Must NOT
// evaluate frame.ciphertext (lazy getter runs ArrayBuffer.slice on main thread).
assert.match(networkStore, /EMPTY_CIPHERTEXT/)
assert.match(networkStore, /receiveChunk\(\s*transferId, frame\.index, frame\.iv, EMPTY_CIPHERTEXT, peerSessionId,/)
assert.match(networkStore, /rawFrame:\s*frame\.rawFrame/)
assert.match(networkStore, /cipherOffset:\s*frame\.cipherOffset/)
assert.doesNotMatch(networkStore, /receiveChunk\(\s*transferId, frame\.index, frame\.iv, frame\.ciphertext, peerSessionId,/)
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
// P1-9: the prefix is domain-separated with `transferId` ONCE per transfer
// (`deriveTransferIvPrefix`), then each chunk uses makeChunkIv(domain, i).
// v3 binds AAD; production decrypt prefers decryptChunkFrame (zero-copy).
assert.match(transfer, /deriveTransferIvPrefix\(ivPrefix, transferId\)/)
assert.match(transfer, /makeChunkIv\(domainIvPrefix, i\)/)
assert.match(transfer, /encryptChunk\(raw, peerSessionId, ivForChunk/)
assert.match(transfer, /decryptChunkFrame\(|decryptChunk\(iv, encrypted, peerSessionId/)
assert.match(transfer, /const ivPrefix = randomIvPrefix\(\)/)

// Bumped to v5: shell-only install (no aggressive asset prefetch — that
// doubled first-paint network load and slowed initial visits on tight uplinks).
assert.match(serviceWorker, /misaka-shell-v5/)
assert.doesNotMatch(serviceWorker, /const cached = await caches\.match\(req\)\s+if \(cached\) return cached\s+try/s)

console.log('✅ 前端 UI 契约测试通过')
