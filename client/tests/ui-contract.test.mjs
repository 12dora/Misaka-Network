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

console.log('✅ 前端 UI 契约测试通过')
