// End-to-end: real Vite + real signaling + real WebRTC DataChannel between two
// (or more) browser contexts. Mocking any of those layers would defeat the
// point — the regressions this suite catches (chunk-frame layout, IV
// derivation, SDP races, session 401 recovery, spurious "重新协商中" on LAN
// peers) all live in the unmocked path.

import { test, expect, type Page, type BrowserContext } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const NODE_ID = '10001'
const PASS_CODE = '123456'

// Each test spins up 2–3 fresh browser contexts → 2–3 fresh signaling
// sessions. The server keeps disconnected sessions around for
// DISCONNECTED_TTL_MS (10s) and caps IPs at MAX_NODES_PER_IP=10, so a few
// tests in a row eventually trip IP_LIMITED for the next context that tries
// to register. Clear our IP slate before each test so test order can't
// poison the next one.
test.beforeEach(async ({ request }) => {
  await request.post('http://localhost:19180/api/release-by-ip').catch(() => {})
})

function createTempFile(name: string, sizeBytes: number) {
  const dir = mkdtempSync(join(tmpdir(), 'misaka-e2e-'))
  const path = join(dir, name)
  const buf = Buffer.alloc(sizeBytes)
  for (let i = 0; i < sizeBytes; i++) {
    buf[i] = (i * 7 + name.charCodeAt(i % name.length)) % 256
  }
  writeFileSync(path, buf)
  return { path, dir, size: sizeBytes }
}

function createTempFolder(folderName: string, files: { name: string; size: number }[]) {
  const root = mkdtempSync(join(tmpdir(), 'misaka-e2e-dir-'))
  const folderPath = join(root, folderName)
  mkdirSync(folderPath, { recursive: true })
  const paths: string[] = []
  for (const f of files) {
    const p = join(folderPath, f.name)
    const buf = Buffer.alloc(f.size)
    for (let i = 0; i < f.size; i++) buf[i] = (i + f.name.charCodeAt(0)) % 256
    writeFileSync(p, buf)
    paths.push(p)
  }
  return { root, folderPath, paths }
}

async function login(page: Page, nodeId: string, passCode: string) {
  await page.goto('/', { waitUntil: 'load' })

  const desktopSection = page.locator('section[class*="hidden md:grid"]').first()
  await desktopSection.locator('input[type="number"]').fill(nodeId)

  // Fill each passcode digit by directly addressing its input. keyboard.type
  // depends on focus tracking which gets racy when several browser contexts
  // are spinning up at once (the broadcast test starts three in parallel).
  const passInputs = desktopSection.locator('input[maxlength="1"]')
  for (let i = 0; i < passCode.length; i++) {
    await passInputs.nth(i).fill(passCode[i])
  }

  const connectBtn = desktopSection.locator('button:has-text("接入网络")')
  await expect(connectBtn).toBeEnabled({ timeout: 5_000 })
  await connectBtn.click()

  await page.waitForURL('**/network', { timeout: 30_000 })
}

async function waitForPeer(page: Page, nodeId: string) {
  await expect(page.getByText(`御坂 ${nodeId} 号`, { exact: false }).first()).toBeVisible({ timeout: 15_000 })
}

async function waitForPeerCount(page: Page, nodeId: string, count: number) {
  await expect.poll(
    async () => await page.getByText(`御坂 ${nodeId} 号`, { exact: false }).count(),
    { timeout: 20_000, intervals: [500, 1_000, 2_000] },
  ).toBeGreaterThanOrEqual(count)
}

async function selectPeer(page: Page, nodeId: string) {
  await page.getByText(`御坂 ${nodeId} 号`, { exact: false }).first().click()
}

async function uploadFiles(page: Page, paths: string[]) {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('button:has-text("选择文件")').first().click(),
  ])
  await chooser.setFiles(paths)
}

async function uploadFolder(page: Page, folderPath: string) {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('button:has-text("选择文件夹")').first().click(),
  ])
  // webkitdirectory inputs require the directory path itself, not the files.
  await chooser.setFiles(folderPath)
}

async function broadcastFiles(page: Page, paths: string[]) {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('button:has-text("群发文件到全部节点")').first().click(),
  ])
  await chooser.setFiles(paths)
}

async function clickSend(page: Page) {
  await page.locator('[data-testid="send-pending-file"]').first().click()
}

async function expectTransferComplete(page: Page, atLeast = 1) {
  // Multiple "已完成" badges can appear (sender + receiver, multiple cards);
  // we just require at least `atLeast` of them.
  await expect.poll(
    async () => await page.getByText('已完成', { exact: false }).count(),
    { timeout: 60_000, intervals: [500, 1_000, 2_000] },
  ).toBeGreaterThanOrEqual(atLeast)
}

async function expectNoReconnectingBanner(page: Page) {
  // The bug under test: a stray cleanup on the WebRTC PC fired dc.onclose
  // → attemptIceRestart → status='reconnecting' → "正在尝试重新协商连接…"
  // banner appears for a peer that's actually healthy. Assert the banner
  // never shows during the run.
  await expect(page.getByText('正在尝试重新协商连接')).toHaveCount(0)
}

test.describe('two-peer file transfer (happy path)', () => {
  test('single file transfers end-to-end', async ({ browser }) => {
    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()

    try {
      await login(pageA, NODE_ID, PASS_CODE)
      await login(pageB, NODE_ID, PASS_CODE)
      await waitForPeer(pageA, NODE_ID)
      await waitForPeer(pageB, NODE_ID)

      const file = createTempFile('hello.txt', 256 * 1024)
      try {
        await selectPeer(pageA, NODE_ID)
        await uploadFiles(pageA, [file.path])
        await clickSend(pageA)
        await expectTransferComplete(pageA)
        await expectTransferComplete(pageB)
        await expectNoReconnectingBanner(pageA)
        await expectNoReconnectingBanner(pageB)
      } finally {
        rmSync(file.dir, { recursive: true, force: true })
      }
    } finally {
      await ctxA.close()
      await ctxB.close()
    }
  })

  test('multi-file transfer keeps order and finishes all', async ({ browser }) => {
    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()

    try {
      await login(pageA, NODE_ID, PASS_CODE)
      await login(pageB, NODE_ID, PASS_CODE)
      await waitForPeer(pageA, NODE_ID)
      await waitForPeer(pageB, NODE_ID)

      const files = [
        createTempFile('report.pdf', 256 * 1024),
        createTempFile('image.png', 200 * 1024),
        createTempFile('data.json', 128 * 1024),
      ]
      try {
        await selectPeer(pageA, NODE_ID)
        await uploadFiles(pageA, files.map(f => f.path))
        await clickSend(pageA)
        await expectTransferComplete(pageA, 3)
        await expectTransferComplete(pageB, 3)
        await expectNoReconnectingBanner(pageA)
        await expectNoReconnectingBanner(pageB)
      } finally {
        files.forEach(f => rmSync(f.dir, { recursive: true, force: true }))
      }
    } finally {
      await ctxA.close()
      await ctxB.close()
    }
  })
})

test.describe('folder transfer', () => {
  test('folder picker enqueues every file in the directory and they all finish', async ({ browser }) => {
    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()

    try {
      await login(pageA, NODE_ID, PASS_CODE)
      await login(pageB, NODE_ID, PASS_CODE)
      await waitForPeer(pageA, NODE_ID)
      await waitForPeer(pageB, NODE_ID)

      const folder = createTempFolder('photos', [
        { name: 'a.bin', size: 128 * 1024 },
        { name: 'b.bin', size: 96 * 1024 },
        { name: 'c.bin', size: 160 * 1024 },
      ])
      try {
        await selectPeer(pageA, NODE_ID)
        await uploadFolder(pageA, folder.folderPath)
        await clickSend(pageA)
        // Each file in the folder becomes its own transfer card on both sides.
        await expectTransferComplete(pageA, folder.paths.length)
        await expectTransferComplete(pageB, folder.paths.length)
        await expectNoReconnectingBanner(pageA)
        await expectNoReconnectingBanner(pageB)
      } finally {
        rmSync(folder.root, { recursive: true, force: true })
      }
    } finally {
      await ctxA.close()
      await ctxB.close()
    }
  })
})

test.describe('broadcast to all peers', () => {
  test('"群发文件到全部节点" fans the same file out to every connected peer', async ({ browser }) => {
    // Three nodes in the same identity cluster: A broadcasts, B and C both receive.
    const ctxs: BrowserContext[] = []
    const pages: Page[] = []
    for (let i = 0; i < 3; i++) {
      const c = await browser.newContext()
      ctxs.push(c)
      pages.push(await c.newPage())
    }
    const [pageA, pageB, pageC] = pages

    try {
      for (const p of pages) await login(p, NODE_ID, PASS_CODE)
      await waitForPeerCount(pageA, NODE_ID, 2)
      await waitForPeer(pageB, NODE_ID)
      await waitForPeer(pageC, NODE_ID)

      const file = createTempFile('broadcast.bin', 128 * 1024)
      try {
        // Broadcast does not require selecting a peer; the broadcast button is
        // mounted on the empty TransferChannel as well as the per-peer view.
        // Selecting a peer just makes the button reachable via the same DOM
        // path the test helper uses.
        await selectPeer(pageA, NODE_ID)
        await broadcastFiles(pageA, [file.path])
        // Sender card per recipient (2) + receiver card on each recipient (2) = 4
        // "已完成" entries minimum.
        await expectTransferComplete(pageA, 2)
        await expectTransferComplete(pageB, 1)
        await expectTransferComplete(pageC, 1)
        for (const p of pages) await expectNoReconnectingBanner(p)
      } finally {
        rmSync(file.dir, { recursive: true, force: true })
      }
    } finally {
      for (const c of ctxs) await c.close()
    }
  })
})
