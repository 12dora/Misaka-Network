// E2E: QR invite flow end-to-end.
//
// Pins:
//   1. The QR modal opens and renders an <img alt="接入二维码"> or canvas.
//   2. The "复制链接" button writes a valid /join URL to the clipboard.
//   3. Visiting /join?token=… from a fresh context lands on either the
//      passcode prompt or directly on /network (depending on whether the QR
//      embedded the passcode).
//   4. Wrong passcode at the join prompt surfaces an inline error rather
//      than a dead-end.

import { test, expect, type Page } from '@playwright/test'
import jsQR from 'jsqr'
import { PNG } from 'pngjs'
import { cleanupE2eSessions, authCopy, netCopy } from './helpers'

const HOST_NODE = '12001'
const HOST_PASS = '424242'

test.beforeEach(async ({ request }) => {
  await cleanupE2eSessions(request)
})

async function loginHost(page: Page) {
  await page.goto('/', { waitUntil: 'load' })
  const section = page.locator('section[class*="hidden md:grid"]').first()
  await section.locator('input[type="number"]').fill(HOST_NODE)
  const passInputs = section.locator('input[maxlength="1"]')
  for (let i = 0; i < HOST_PASS.length; i++) await passInputs.nth(i).fill(HOST_PASS[i])
  await section.locator(`button:has-text("${authCopy.accessNetwork}")`).click()
  await page.waitForURL('**/network', { timeout: 30_000 })
}

function decodeQrDataUrl(dataUrl: string): string {
  const encoded = dataUrl.split(',', 2)[1]
  if (!encoded) throw new Error('QR image is not a base64 data URL')
  const image = PNG.sync.read(Buffer.from(encoded, 'base64'))
  const decoded = jsQR(new Uint8ClampedArray(image.data), image.width, image.height)
  if (!decoded?.data) throw new Error('rendered QR image could not be decoded')
  return decoded.data
}

test('rendered QR image decodes and admits a fresh device', async ({ browser }) => {
  const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
  const page = await ctx.newPage()
  try {
    await loginHost(page)

    await page.getByRole('button', { name: netCopy.showMyQr }).first().click()
    await expect(page.getByText(netCopy.qr.myAccessQr)).toBeVisible({ timeout: 10_000 })

    // The radar empty-state ALSO renders a "复制链接" button, so an unscoped
    // `.first()` resolves to it — and it sits behind the modal backdrop, so the
    // click is intercepted. Scope to the QR modal panel.
    const modal = page.locator('.modal-panel-in')

    // QR canvas/img is rendered (alt text or canvas presence).
    const qrImage = modal.locator(`img[alt="${netCopy.qr.accessQr}"]`)
    await expect(qrImage).toBeVisible({ timeout: 10_000 })
    await expect.poll(async () => qrImage.getAttribute('src')).toMatch(/^data:image\/png;base64,.+/)
    const imageUrl = await qrImage.getAttribute('src')
    const scannedUrl = decodeQrDataUrl(imageUrl ?? '')
    expect(scannedUrl).toMatch(/\/join\?/)
    expect(scannedUrl).toMatch(/[?&]t=[a-zA-Z0-9_-]{6,}/)
    expect(scannedUrl).not.toMatch(/[?&]c=/)

    // Click 复制链接 — modal toast confirms; clipboard content matches /join?token=
    const copyBtn = modal.getByRole('button', { name: netCopy.qr.copyLink })
    await expect(copyBtn).toBeVisible({ timeout: 5_000 })
    await copyBtn.click()

    const clipped = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''))
    // buildURL emits /join?type=node&id=<n>&t=<token> — assert it's a join URL
    // carrying a token param, without pinning param order.
    expect(clipped).toMatch(/\/join\?/)
    expect(clipped).toMatch(/[?&]t=[a-zA-Z0-9_-]{6,}/)
    expect(clipped).toBe(scannedUrl)
    expect(clipped).not.toMatch(/[?&]c=/)

    const guestCtx = await browser.newContext()
    const guestPage = await guestCtx.newPage()
    try {
      await guestPage.goto(scannedUrl, { waitUntil: 'load' })
      const passInput = guestPage.locator('#join-passcode')
      await expect(passInput).toBeVisible()
      await passInput.fill(HOST_PASS)
      // Join page primary action is a short "接入" label (not auth.accessNetwork).
      await guestPage.locator('button:has-text("接入")').click()
      await guestPage.waitForURL('**/network', { timeout: 30_000 })
      await expect(page.getByText(netCopy.misakaNumber(Number(HOST_NODE)), { exact: false }).first())
        .toBeVisible({ timeout: 20_000 })
    } finally {
      await guestCtx.close().catch(() => {})
    }
  } finally {
    await ctx.close().catch(() => {})
  }
})

test('wrong passcode at /join surfaces inline error', async ({ browser }) => {
  const hostCtx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
  const hostPage = await hostCtx.newPage()
  try {
    await loginHost(hostPage)
    await hostPage.getByRole('button', { name: netCopy.showMyQr }).first().click()
    // Scope to the QR modal — the radar empty-state also has a 复制链接 button
    // that sits behind the modal backdrop (unscoped `.first()` picks it and the
    // click is intercepted).
    const hostModal = hostPage.locator('.modal-panel-in')
    await expect(hostModal.getByText(netCopy.qr.myAccessQr)).toBeVisible({ timeout: 10_000 })
    await hostModal.getByRole('button', { name: netCopy.qr.copyLink }).click()
    const joinUrl = await hostPage.evaluate(() => navigator.clipboard.readText())
    expect(joinUrl).toBeTruthy()

    // Fresh context = different IP slot in the e2e suite's per-IP cap.
    const guestCtx = await browser.newContext()
    const guestPage = await guestCtx.newPage()
    try {
      await guestPage.goto(joinUrl, { waitUntil: 'load' })

      await expect(guestPage).toHaveURL(/\/join/)
      const passInput = guestPage.locator('#join-passcode')
      await expect(passInput).toBeVisible()
      await passInput.fill('000000')
      await guestPage.locator('button:has-text("接入")').click()

      await expect(
        guestPage.locator('text=/通行码不正确|通行码错误|WRONG_PASSCODE/'),
      ).toBeVisible({ timeout: 15_000 })
    } finally {
      await guestCtx.close().catch(() => {})
    }
  } finally {
    await hostCtx.close().catch(() => {})
  }
})
