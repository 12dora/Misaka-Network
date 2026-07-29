// End-to-end: real Vite + real signaling + real WebRTC DataChannel between two
// (or more) browser contexts. Mocking any of those layers would defeat the
// point — the regressions this suite catches (chunk-frame layout, IV
// derivation, SDP races, session 401 recovery, spurious "重新协商中" on LAN
// peers) all live in the unmocked path.

import { test, expect, type Page, type BrowserContext } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanupE2eSessions, assertE2eHostIceConfig } from './helpers'

const NODE_ID = '10001'
const PASS_CODE = '123456'

// Each test spins up 2–3 fresh browser contexts → 2–3 fresh signaling
// sessions. The server keeps disconnected sessions around for
// DISCONNECTED_TTL_MS (10s) and caps IPs at MAX_NODES_PER_IP=10, so a few
// tests in a row eventually trip IP_LIMITED for the next context that tries
// to register. Clear our IP slate before each test so test order can't
// poison the next one.
test.beforeEach(async ({ request }) => {
  await cleanupE2eSessions(request)
})

// 05 P2: reuseExistingServer can leave a stale Vite on 5174. Every describe
// that opens a page must verify the frontend build nonce matches the suite.
async function assertFrontendNonce(page: Page, request: Parameters<typeof assertE2eHostIceConfig>[1]) {
  await page.goto('/', { waitUntil: 'load' })
  await assertE2eHostIceConfig(page, request)
}

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

async function waitForSelectedChannelReady(page: Page) {
  const ready = page.getByText('连接成功。现在可以发送消息或文件。', { exact: false }).first()
  const retry = page.locator('button:has-text("立即重连")').first()
  await expect.poll(async () => {
    if (await ready.isVisible().catch(() => false)) return 'ready'
    if (await retry.isVisible().catch(() => false)) return 'retry'
    return 'waiting'
  }, { timeout: 35_000, intervals: [250, 500, 1_000] }).not.toBe('waiting')
  if (!await ready.isVisible().catch(() => false)) {
    await retry.click()
    await expect(ready).toBeVisible({ timeout: 30_000 })
  }
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

/** Sender durability: "✓ 已保存" on a send-direction card (📤). */
async function expectSenderSaved(page: Page, atLeast = 1) {
  await expect.poll(
    async () => page.locator('[data-testid^="transfer-card-"]')
      .filter({ hasText: '📤' })
      .filter({ hasText: /已保存/ })
      .count(),
    { timeout: 60_000, intervals: [500, 1_000, 2_000] },
  ).toBeGreaterThanOrEqual(atLeast)
}

/** Receiver availability: "接收完成" or FSA "已保存到所选位置" on a recv card (📥). */
async function expectReceiverComplete(page: Page, atLeast = 1) {
  await expect.poll(
    async () => page.locator('[data-testid^="transfer-card-"]')
      .filter({ hasText: '📥' })
      .filter({ hasText: /接收完成|已保存到所选位置/ })
      .count(),
    { timeout: 60_000, intervals: [500, 1_000, 2_000] },
  ).toBeGreaterThanOrEqual(atLeast)
}

async function installConnectionFailureObserver(page: Page) {
  await page.evaluate(() => {
    const state = window as Window & { __misakaConnectionFailureSeen?: boolean; __misakaConnectionObserver?: MutationObserver }
    state.__misakaConnectionFailureSeen = false
    state.__misakaConnectionObserver?.disconnect()
    const inspect = () => {
      const text = document.body.innerText
      if (text.includes('正在尝试重新协商连接') || text.includes('连接已断开')) {
        state.__misakaConnectionFailureSeen = true
      }
    }
    const observer = new MutationObserver(inspect)
    observer.observe(document.body, { subtree: true, childList: true, characterData: true })
    state.__misakaConnectionObserver = observer
    inspect()
  })
}

async function installArtifactCapture(page: Page) {
  await page.evaluate(() => {
    const state = window as Window & { __misakaCapturedBlobs?: Blob[]; __misakaOriginalCreateObjectURL?: typeof URL.createObjectURL }
    state.__misakaCapturedBlobs = []
    if (!state.__misakaOriginalCreateObjectURL) state.__misakaOriginalCreateObjectURL = URL.createObjectURL.bind(URL)
    const original = state.__misakaOriginalCreateObjectURL
    URL.createObjectURL = (blob: Blob | MediaSource) => {
      if (blob instanceof Blob) state.__misakaCapturedBlobs!.push(blob)
      return original!(blob)
    }
  })
}

interface CapturedArtifact {
  name: string
  size: number
  sha256: string
}

async function capturedArtifacts(page: Page, count: number): Promise<CapturedArtifact[]> {
  await expect.poll(
    async () => page.evaluate(() =>
      ((window as Window & { __misakaCapturedBlobs?: Blob[] }).__misakaCapturedBlobs ?? []).length,
    ),
    { timeout: 30_000 },
  ).toBeGreaterThanOrEqual(count)
  return page.evaluate(async () => {
    const blobs = (window as Window & { __misakaCapturedBlobs?: Blob[] }).__misakaCapturedBlobs ?? []
    return Promise.all(blobs.map(async blob => {
      const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
      return {
        name: blob instanceof File ? blob.name : '',
        size: blob.size,
        sha256: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join(''),
      }
    }))
  })
}

function expectedArtifact(path: string, name?: string): CapturedArtifact {
  const bytes = readFileSync(path)
  return {
    name: name ?? path.split('/').pop() ?? '',
    size: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

async function expectNoReconnectingBanner(page: Page) {
  // The bug under test: a stray cleanup on the WebRTC PC fired dc.onclose
  // → attemptIceRestart → status='reconnecting' → "正在尝试重新协商连接…"
  // banner appears for a peer that's actually healthy. Read the observer
  // installed before transfer so a transient error cannot disappear between
  // two point-in-time assertions.
  expect(await page.evaluate(() =>
    (window as Window & { __misakaConnectionFailureSeen?: boolean }).__misakaConnectionFailureSeen,
  )).toBe(false)
}

test.describe('two-peer file transfer (happy path)', () => {
  test('single file transfers end-to-end', async ({ browser, request }) => {
    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()

    try {
      await assertFrontendNonce(pageA, request)
      await login(pageA, NODE_ID, PASS_CODE)
      await login(pageB, NODE_ID, PASS_CODE)
      await waitForPeer(pageA, NODE_ID)
      await waitForPeer(pageB, NODE_ID)
      await installArtifactCapture(pageB)

      const file = createTempFile('hello.txt', 256 * 1024)
      try {
        await selectPeer(pageA, NODE_ID)
        await waitForSelectedChannelReady(pageA)
        await installConnectionFailureObserver(pageA)
        await installConnectionFailureObserver(pageB)
        await uploadFiles(pageA, [file.path])
        await clickSend(pageA)
        // v2: receiver durable write first, then sender may promote to saved.
        await expectReceiverComplete(pageB)
        expect(await capturedArtifacts(pageB, 1)).toEqual([expectedArtifact(file.path)])
        await expectSenderSaved(pageA)
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
      await installArtifactCapture(pageB)

      const files = [
        createTempFile('report.pdf', 256 * 1024),
        createTempFile('image.png', 200 * 1024),
        createTempFile('data.json', 128 * 1024),
      ]
      try {
        await selectPeer(pageA, NODE_ID)
        await waitForSelectedChannelReady(pageA)
        await installConnectionFailureObserver(pageA)
        await installConnectionFailureObserver(pageB)
        await uploadFiles(pageA, files.map(f => f.path))
        await clickSend(pageA)
        await expectReceiverComplete(pageB, 3)
        expect(await capturedArtifacts(pageB, 3)).toEqual(
          files.map(file => expectedArtifact(file.path)),
        )
        await expectSenderSaved(pageA, 3)
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
      await installArtifactCapture(pageB)

      const folder = createTempFolder('photos', [
        { name: 'a.bin', size: 128 * 1024 },
        { name: 'b.bin', size: 96 * 1024 },
        { name: 'c.bin', size: 160 * 1024 },
      ])
      try {
        await selectPeer(pageA, NODE_ID)
        await waitForSelectedChannelReady(pageA)
        await installConnectionFailureObserver(pageA)
        await installConnectionFailureObserver(pageB)
        await uploadFolder(pageA, folder.folderPath)
        await clickSend(pageA)
        // Each file in the folder becomes its own transfer card on both sides.
        await expectReceiverComplete(pageB, folder.paths.length)
        // Folder relative paths are flattened at the storage boundary so a
        // peer cannot create directories. Assert the ordered path→safe-name
        // mapping as well as every artifact's bytes.
        const folderName = folder.folderPath.split('/').pop()
        expect(await capturedArtifacts(pageB, folder.paths.length)).toEqual(
          folder.paths.map(path =>
            expectedArtifact(path, `${folderName}_${path.split('/').pop()}`),
          ),
        )
        await expectSenderSaved(pageA, folder.paths.length)
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
  test('"群发文件到全部节点" preserves every file at every connected peer', async ({ browser }) => {
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
      await installArtifactCapture(pageB)
      await installArtifactCapture(pageC)

      const files = [
        createTempFile('broadcast-first.bin', 160 * 1024),
        createTempFile('broadcast-second.json', 96 * 1024),
      ]
      try {
        // Broadcast does not require selecting a peer; the broadcast button is
        // mounted on the empty TransferChannel as well as the per-peer view.
        // Selecting a peer just makes the button reachable via the same DOM
        // path the test helper uses.
        for (let peerIndex = 0; peerIndex < 2; peerIndex++) {
          await pageA.getByText(`御坂 ${NODE_ID} 号`, { exact: false }).nth(peerIndex).click()
          await waitForSelectedChannelReady(pageA)
        }
        for (const page of pages) await installConnectionFailureObserver(page)
        await broadcastFiles(pageA, files.map(file => file.path))
        // Two ordered files × two recipients produce four independent sender
        // outcomes; each receiver must expose both complete artifacts.
        await expectReceiverComplete(pageB, 2)
        await expectReceiverComplete(pageC, 2)
        const expected = files.map(file => expectedArtifact(file.path))
        expect(await capturedArtifacts(pageB, 2)).toEqual(expected)
        expect(await capturedArtifacts(pageC, 2)).toEqual(expected)
        await expectSenderSaved(pageA, 4)
        for (const p of pages) await expectNoReconnectingBanner(p)
      } finally {
        files.forEach(file => rmSync(file.dir, { recursive: true, force: true }))
      }
    } finally {
      for (const c of ctxs) await c.close()
    }
  })
})
