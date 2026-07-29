#!/usr/bin/env node
// UI structure contracts that are awkward as full component renders (CSS
// keyframes, install-prompt finally, footer cross-links). Behavioural
// contracts for API/signaling/crypto/transfer live in real unit suites —
// do NOT re-add source-regex assertions for those modules here (05 P2).
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
// Labels live in copy/zh-CN/legal.ts after the copy migration.
const legalCopy = read('src/copy/zh-CN/legal.ts')
assert.match(footer, /to="\/privacy"/)
assert.match(footer, /to="\/tos"/)
assert.match(privacy, /to="\/tos"/)
assert.match(legalCopy, /查看服务条款/)
assert.match(terms, /to="\/privacy"/)
assert.match(legalCopy, /查看隐私政策/)

assert.match(qr, /QRCode\.toCanvas/)
assert.match(qr, /QRCode\.toDataURL/)
assert.match(qr, /qrImageUrl/)
// Copy may live in zh-CN/network.ts (tokenRenderFailed) or inline.
assert.match(qr, /tokenRenderFailed|二维码渲染失败|QR 渲染失败/)
const networkCopy = read('src/copy/zh-CN/network.ts')
assert.match(networkCopy, /tokenRenderFailed:.*二维码渲染失败|二维码渲染失败/)

assert.match(network, /type="file" multiple/)
assert.match(network, /webkitdirectory/)
// Pending-items copy lives in zh-CN/network.ts after the copy migration.
assert.match(network, /pendingItems\(|待发送 \{pendingFiles\.length\} 个项目/)
assert.match(networkCopy, /pendingItems:\s*\(n:\s*number\)\s*=>\s*`待发送 \$\{n\} 个项目`|待发送/)

// Bumped to v5: shell-only install (no aggressive asset prefetch — that
// doubled first-paint network load and slowed initial visits on tight uplinks).
assert.match(serviceWorker, /misaka-shell-v5/)
assert.doesNotMatch(serviceWorker, /const cached = await caches\.match\(req\)\s+if \(cached\) return cached\s+try/s)

console.log('✅ 前端 UI 契约测试通过')
