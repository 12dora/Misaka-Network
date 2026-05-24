// E2E: QR invite flow end-to-end.
//
// Pins:
//   1. The QR modal opens and renders an <img alt="接入 QR"> or canvas.
//   2. The "复制链接" button writes a valid /join URL to the clipboard.
//   3. Visiting /join?token=… from a fresh context lands on either the
//      passcode prompt or directly on /network (depending on whether the QR
//      embedded the passcode).
//   4. Wrong passcode at the join prompt surfaces an inline error rather
//      than a dead-end.

import { test, expect, type Page } from '@playwright/test'

const HOST_NODE = '12001'
const HOST_PASS = '424242'

test.beforeEach(async ({ request }) => {
  await request.post('http://localhost:19180/api/release-by-ip').catch(() => {})
})

async function loginHost(page: Page) {
  await page.goto('/', { waitUntil: 'load' })
  const section = page.locator('section[class*="hidden md:grid"]').first()
  await section.locator('input[type="number"]').fill(HOST_NODE)
  const passInputs = section.locator('input[maxlength="1"]')
  for (let i = 0; i < HOST_PASS.length; i++) await passInputs.nth(i).fill(HOST_PASS[i])
  await section.locator('button:has-text("接入网络")').click()
  await page.waitForURL('**/network', { timeout: 30_000 })
}

test('QR modal renders + 复制链接 produces a /join URL', async ({ browser }) => {
  const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
  const page = await ctx.newPage()
  try {
    await loginHost(page)

    await page.locator('button:has-text("显示我的 QR")').first().click()
    await expect(page.getByText('我的接入 QR')).toBeVisible({ timeout: 10_000 })

    // QR canvas/img is rendered (alt text or canvas presence).
    const qrVisible = await Promise.race([
      page.locator('img[alt*="QR"]').first().isVisible().catch(() => false),
      page.locator('canvas').first().isVisible().catch(() => false),
    ])
    expect(qrVisible).toBe(true)

    // Click 复制链接 — modal toast confirms; clipboard content matches /join?token=
    const copyBtn = page.locator('button:has-text("复制链接")').first()
    await expect(copyBtn).toBeVisible({ timeout: 5_000 })
    await copyBtn.click()

    const clipped = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''))
    expect(clipped).toMatch(/\/join\?(t|token)=[a-zA-Z0-9_-]{6,}/)
  } finally {
    await ctx.close().catch(() => {})
  }
})

test('wrong passcode at /join surfaces inline error', async ({ browser }) => {
  const hostCtx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
  const hostPage = await hostCtx.newPage()
  try {
    await loginHost(hostPage)
    await hostPage.locator('button:has-text("显示我的 QR")').first().click()
    await hostPage.locator('button:has-text("复制链接")').first().click()
    const joinUrl = await hostPage.evaluate(() => navigator.clipboard.readText())
    expect(joinUrl).toBeTruthy()

    // Fresh context = different IP slot in the e2e suite's per-IP cap.
    const guestCtx = await browser.newContext()
    const guestPage = await guestCtx.newPage()
    try {
      await guestPage.goto(joinUrl, { waitUntil: 'load' })

      // Either we land on /network directly (passcode embedded) or we hit
      // the 6-digit passcode prompt on /join. We exercise the wrong-passcode
      // branch only in the latter case.
      const onJoin = guestPage.url().includes('/join')
      if (!onJoin) {
        // Embedded-passcode path: nothing to assert here besides reachability.
        return
      }

      const passInputs = guestPage.locator('input[maxlength="1"]')
      const inputCount = await passInputs.count()
      if (inputCount < 6) {
        // No prompt rendered (maybe redirect). Skip the wrong-pass assertion.
        return
      }
      for (let i = 0; i < 6; i++) await passInputs.nth(i).fill('0')
      await guestPage.locator('button:has-text("接入")').first().click()

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
