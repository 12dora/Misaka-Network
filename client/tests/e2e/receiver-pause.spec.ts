// E2E: receiver-driven pause / resume.
//
// Pins the new UI affordance: the receiver's TaskPanel now exposes pause &
// resume buttons (previously only sender-side). The store action chain is
// pauseReceiveTransfer → pauseTransfer → 'transfer-pause' control frame
// over the primary DC; sender's lane loop stops emitting chunks until
// resume.

import { test, expect, type Page } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SENDER_NODE = '13001'
const RECEIVER_NODE = '13002'
const PASS = '424242'

test.beforeEach(async ({ request }) => {
  await request.post('http://localhost:19180/api/release-by-ip').catch(() => {})
})

function createTempFile(name: string, sizeBytes: number) {
  const dir = mkdtempSync(join(tmpdir(), 'misaka-e2e-pause-'))
  const path = join(dir, name)
  const buf = Buffer.alloc(sizeBytes)
  for (let i = 0; i < sizeBytes; i++) buf[i] = (i * 13) % 256
  writeFileSync(path, buf)
  return { path }
}

async function login(page: Page, nodeId: string) {
  await page.goto('/', { waitUntil: 'load' })
  const section = page.locator('section[class*="hidden md:grid"]').first()
  await section.locator('input[type="number"]').fill(nodeId)
  const passInputs = section.locator('input[maxlength="1"]')
  for (let i = 0; i < PASS.length; i++) await passInputs.nth(i).fill(PASS[i])
  await section.locator('button:has-text("接入网络")').click()
  await page.waitForURL('**/network', { timeout: 30_000 })
}

test('receiver TaskPanel exposes pause/resume buttons', async ({ browser }) => {
  const senderCtx = await browser.newContext()
  const senderPage = await senderCtx.newPage()
  const recvCtx = await browser.newContext()
  const recvPage = await recvCtx.newPage()

  try {
    await login(senderPage, SENDER_NODE)
    await login(recvPage, RECEIVER_NODE)

    // Wait for sender to see receiver and select.
    await expect(senderPage.getByText(`御坂 ${RECEIVER_NODE} 号`, { exact: false }).first())
      .toBeVisible({ timeout: 20_000 })
    await senderPage.getByText(`御坂 ${RECEIVER_NODE} 号`, { exact: false }).first().click()

    // 2 MB file — large enough that pause has time to take effect mid-transfer.
    const { path } = createTempFile('pause-target.bin', 2 * 1024 * 1024)

    const fileInput = senderPage.locator('input[type="file"]').first()
    await fileInput.setInputFiles(path)

    // Receiver side: switch to 任务 tab and wait for the incoming transfer.
    await recvPage.locator('button:has-text("任务")').first().click().catch(() => {})

    // The transfer card appears on the receiver too.
    await expect(recvPage.locator('text=/pause-target\\.bin|正在接收/').first())
      .toBeVisible({ timeout: 20_000 })

    // The pause button is present (used to be sender-only).
    const pauseBtn = recvPage.locator('button:has-text("暂停")').first()
    await expect(pauseBtn).toBeVisible({ timeout: 10_000 })
    await pauseBtn.click()

    // After clicking pause, the resume button appears (status = paused).
    await expect(recvPage.locator('button:has-text("继续")').first())
      .toBeVisible({ timeout: 10_000 })

    // Resume to let the transfer complete cleanly.
    await recvPage.locator('button:has-text("继续")').first().click()
  } finally {
    await senderCtx.close().catch(() => {})
    await recvCtx.close().catch(() => {})
  }
})
