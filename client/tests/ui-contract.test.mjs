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
const footer = read('src/components/ui/AppFooter.tsx')
const privacy = read('src/pages/Privacy.tsx')
const terms = read('src/pages/Terms.tsx')
const useModalExitHook = read('src/hooks/useModalExit.ts')
const network = read('src/pages/Network.tsx')
const networkStore = read('src/store/network.ts')
const authStore = read('src/store/auth.ts')
const signaling = read('src/lib/signaling.ts')
const api = read('src/lib/api.ts')
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

// #14 — global Escape-to-close lives inside useModalExit so every consumer
// (QR / Scan / Settings) gets it for free without bespoke listeners.
assert.match(useModalExitHook, /addEventListener\(['"]keydown['"]/)
assert.match(useModalExitHook, /e\.key !== ['"]Escape['"]/)

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

// QR fetch must go through authedFetch so a stale session (server restarted,
// token unknown server-side) auto-recovers via re-register-and-retry instead
// of leaving the user staring at "HTTP 401". Same for the copy-link path.
assert.match(qr, /authedFetch\(path\)/)
assert.match(qr, /AuthRequiredError/)
assert.match(qr, /会话已失效/)
assert.doesNotMatch(qr, /Authorization:\s*`Bearer\s*\$\{session\.token\}`/)
assert.match(network, /authedFetch\(path\)/)
assert.match(network, /AuthRequiredError/)
assert.match(network, /会话已失效/)
assert.doesNotMatch(network, /headers:\s*\{\s*Authorization:\s*`Bearer\s*\$\{auth\.session\.token\}`/)

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
// P1-9: the prefix is additionally domain-separated with `transferId`
// (SHA-256 of prefix||transferId) so two transfers that draw the same
// random prefix still produce distinct IVs. The hot-path call is now
// awaited (digest is async) and threads `transferId` through.
assert.match(transfer, /makeChunkIv\(ivPrefix, i, transferId\)/)
assert.match(transfer, /encryptChunk\(raw, peerSessionId, ivForChunk\)/)
assert.match(transfer, /decryptChunk\(iv, encrypted, peerSessionId\)/)
assert.match(transfer, /const ivPrefix = randomIvPrefix\(\)/)

// P0-9: bumped to v4 with asset-discovery prime + skip-waiting handshake.
assert.match(serviceWorker, /misaka-shell-v4/)
assert.doesNotMatch(serviceWorker, /const cached = await caches\.match\(req\)\s+if \(cached\) return cached\s+try/s)

console.log('✅ 前端 UI 契约测试通过')
