#!/usr/bin/env node
// Standalone Playwright script for manual transfer testing.
// Run: npm run test:manual   (from client/)
//
// `chromium` is imported from `@playwright/test` — the only Playwright package
// this workspace declares. Importing bare `playwright` used to work only
// because it happened to be hoisted as a transitive dependency.

import { chromium } from '@playwright/test'
import { writeFileSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const BASE = 'http://localhost:5173'
const NODE_ID = '10001'
const PASS_CODE = '123456'

// ── Helpers ────────────────────────────────────────────────────────────
function createTempFile(name, sizeBytes) {
  const dir = mkdtempSync(join(tmpdir(), 'misaka-test-'))
  const path = join(dir, name)
  const buf = Buffer.alloc(sizeBytes)
  for (let i = 0; i < sizeBytes; i++) {
    buf[i] = (i * 7 + name.charCodeAt(i % name.length)) % 256
  }
  writeFileSync(path, buf)
  return { path, dir, size: sizeBytes }
}

async function login(page, label, nodeId, passCode) {
  page.on('console', msg => {
    if (msg.type() === 'error') {
      console.log(`[${label} console:${msg.type()}]`, msg.text().substring(0, 200))
    }
  })

  // Capture signaling WebSocket connections
  page.on('websocket', ws => {
    const isSignaling = ws.url().includes('/ws') && !ws.url().includes('token=')
    if (!isSignaling) return
    ws.on('framereceived', payload => {
      const text = typeof payload.payload === 'string'
        ? payload.payload.substring(0, 120)
        : (Buffer.isBuffer(payload.payload) ? payload.payload.toString().substring(0, 120) : '<unknown>')
      if (text.includes('WELCOME') || text.includes('PEER_JOINED') || text.includes('PEER_LEFT') || text.includes('ERROR')) {
        console.log(`[${label} sig-ws] ←`, text)
      }
    })
  })

  // Intercept config.json fetch to return empty values for local dev.
  await page.route('**/config.json', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ API_BASE: '', WS_URL: '' }),
    })
  })

  console.log(`[${label}] navigating to ${BASE}`)
  await page.goto(BASE, { waitUntil: 'load', timeout: 30000 })

  const desktopSection = page.locator('section[class*="hidden md:grid"]').first()
  const nodeInput = desktopSection.locator('input[type="number"]')
  await nodeInput.fill(nodeId)

  const passInputs = desktopSection.locator('input[maxlength="1"]')
  await passInputs.nth(0).click()
  await page.keyboard.type(passCode, { delay: 30 })

  await desktopSection.locator('button:has-text("接入网络")').click()

  await page.waitForURL('**/network', { timeout: 15000 })
  await page.waitForTimeout(3000)
  console.log(`[${label}] connected and on /network`)
}

async function waitForPeer(page, nodeId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const count = await page.getByText(`御坂 ${nodeId} 号`, { exact: false }).count()
    if (count > 0) {
      console.log(`[peer] found ${count} element(s) matching "御坂 ${nodeId} 号"`)
      return true
    }
    await page.waitForTimeout(500)
  }
  const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 800))
  console.log('[peer] TIMEOUT — body.innerText preview:', bodyText)
  throw new Error(`Peer ${nodeId} 号 not found within ${timeoutMs}ms`)
}

async function waitForTransferStatus(page, statusText, timeoutMs = 30000, minCount = 1) {
  // statusText may be a string or RegExp (role-specific completion wording).
  const matcher = statusText instanceof RegExp
    ? statusText
    : statusText
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const count = await page.getByText(matcher, { exact: false }).count()
    if (count >= minCount) {
      console.log(`[transfer] found ${String(statusText)} (count=${count})`)
      return
    }
    await page.waitForTimeout(500)
  }
  await page.screenshot({ path: 'test-results/transfer-timeout.png' })
  const transferInfo = await page.evaluate(() => {
    const transfers = document.querySelectorAll('[data-testid^="transfer-card-"]')
    return Array.from(transfers).map(el => el.textContent?.substring(0, 200))
  })
  console.log('[transfer] TIMEOUT — transfer elements:', JSON.stringify(transferInfo))
  throw new Error(`Transfer status ${String(statusText)} not found within ${timeoutMs}ms`)
}

async function selectPeer(page, nodeId) {
  const peerCard = page.getByText(`御坂 ${nodeId} 号`, { exact: false }).first()
  await peerCard.click()
  await page.waitForTimeout(500)
}

async function uploadFiles(page, filePaths) {
  const [fileChooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 10000 }),
    page.locator('button:has-text("选择文件")').first().click(),
  ])
  await fileChooser.setFiles(filePaths)
  await page.waitForTimeout(500)
}

async function uploadBroadcastFile(page, filePath) {
  const [fileChooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 10000 }),
    page.locator('button:has-text("群发文件到全部节点")').first().click(),
  ])
  await fileChooser.setFiles(filePath)
}

async function clickSend(page) {
  const sendBtn = page.locator('[data-testid="send-pending-file"]').first()
  if (await sendBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await sendBtn.click()
    console.log('[transfer] send clicked')
    return true
  }
  return false
}

// ═══════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════

async function main() {
  const browser = await chromium.launch({ headless: true })

  try {
    const ctx1 = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const page1 = await ctx1.newPage()
    const page2 = await ctx2.newPage()

    // ── Step 1: Login both pages ───────────────────────────────────
    console.log('\n── Step 1: Login ──')
    await login(page1, 'p1', NODE_ID, PASS_CODE)
    await login(page2, 'p2', NODE_ID, PASS_CODE)

    // ── Step 2: Wait for peers ─────────────────────────────────────
    console.log('\n── Step 2: Wait for peers ──')
    await waitForPeer(page1, NODE_ID)
    await waitForPeer(page2, NODE_ID)

    // ── Step 3: Test single file transfer ──────────────────────────
    console.log('\n── Step 3: Single file transfer ──')
    const file = createTempFile('hello.txt', 1024 * 256)

    await selectPeer(page1, NODE_ID)
    await uploadFiles(page1, [file.path])
    if (!(await clickSend(page1))) {
      await page1.screenshot({ path: 'test-results/no-send-btn.png' })
      throw new Error('Send button not visible')
    }

    // Role-specific completion wording (the generic "已完成" was removed):
    // sender → 已保存 (v2 durable ACK); receiver → 接收完成 / 已保存到所选位置.
    console.log('[transfer] waiting for completion...')
    await waitForTransferStatus(page2, /接收完成|已保存到所选位置/, 30000)
    await waitForTransferStatus(page1, '已保存', 30000)
    console.log('✅ Single file transfer completed!')
    rmSync(file.dir, { recursive: true, force: true })

    // ── Step 4: Test multiple files ────────────────────────────────
    console.log('\n── Step 4: Multiple file transfer ──')
    const files = [
      createTempFile('report.pdf', 1024 * 256),
      createTempFile('image.png', 1024 * 200),
      createTempFile('data.json', 1024 * 128),
    ]

    await uploadFiles(page1, files.map(f => f.path))
    await clickSend(page1)

    await waitForTransferStatus(page2, /接收完成|已保存到所选位置/, 60000, 3)
    await waitForTransferStatus(page1, '已保存', 60000, 3)
    console.log('✅ Multiple file transfer completed!')
    files.forEach(f => rmSync(f.dir, { recursive: true, force: true }))

    // ── Step 5: Test broadcast ─────────────────────────────────────
    console.log('\n── Step 5: Broadcast to all nodes ──')
    const bcFile = createTempFile('broadcast.txt', 1024 * 64)

    await uploadBroadcastFile(page1, bcFile.path)
    await waitForTransferStatus(page2, /接收完成|已保存到所选位置/, 60000)
    await waitForTransferStatus(page1, '已保存', 60000)
    console.log('✅ Broadcast transfer completed!')
    rmSync(bcFile.dir, { recursive: true, force: true })

    await ctx1.close()
    await ctx2.close()

    console.log('\n🎉 All tests passed!')

  } catch (err) {
    console.error('❌ Test failed:', err.message)
    process.exit(1)
  } finally {
    await browser.close()
  }
}

main()
