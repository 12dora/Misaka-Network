// End-to-end: real Vite + real signaling + real WebRTC DataChannel between two
// browser contexts. Mocking any of those layers would defeat the point — the
// regressions this suite catches (chunk-frame layout, IV derivation, SDP races,
// session 401 recovery) all live in the unmocked path.
//
// Sourced from the legacy tests/manual-test.mjs and rewritten in
// @playwright/test format so it runs under `npm run test:e2e`.

import { test, expect, type Page } from '@playwright/test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const NODE_ID = '10001'
const PASS_CODE = '123456'

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

async function login(page: Page, nodeId: string, passCode: string) {
  await page.goto('/', { waitUntil: 'load' })

  const desktopSection = page.locator('section[class*="hidden md:grid"]').first()
  await desktopSection.locator('input[type="number"]').fill(nodeId)

  const passInputs = desktopSection.locator('input[maxlength="1"]')
  await passInputs.nth(0).click()
  await page.keyboard.type(passCode, { delay: 20 })
  await desktopSection.locator('button:has-text("接入网络")').click()

  await page.waitForURL('**/network', { timeout: 15_000 })
}

async function waitForPeer(page: Page, nodeId: string) {
  await expect(page.getByText(`御坂 ${nodeId} 号`, { exact: false }).first()).toBeVisible({ timeout: 15_000 })
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
      } finally {
        files.forEach(f => rmSync(f.dir, { recursive: true, force: true }))
      }
    } finally {
      await ctxA.close()
      await ctxB.close()
    }
  })
})
