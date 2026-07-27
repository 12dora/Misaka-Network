// E2E: authedFetch 401 self-heal in production(-ish) context.
//
// Commit 2fa6869 fixed the recurring bug where a stale sessionStorage token
// (e.g. server restarted) caused QR calls to fail with a bare 401. This test
// replays that: we intercept the first /api/qr-token with a 401, verify
// authedFetch re-registers and retries, and assert the QR canvas renders.
//
// Unit tests (P0.1) cover the retry state machine exhaustively. This file
// covers the integration: does the QR modal ↔ authedFetch ↔ /api/register
// pipeline actually work end-to-end.

import { test, expect, type Page } from '@playwright/test'
import { assertE2eHostIceConfig } from './helpers'

async function login(page: Page) {
  const NODE_ID = '20001'
  const PASS_CODE = '424242'

  await page.goto('/', { waitUntil: 'load' })

  const desktopSection = page.locator('section[class*="hidden md:grid"]').first()
  await desktopSection.locator('input[type="number"]').fill(NODE_ID)

  const passInputs = desktopSection.locator('input[maxlength="1"]')
  await passInputs.nth(0).click()
  await page.keyboard.type(PASS_CODE, { delay: 20 })
  await desktopSection.locator('button:has-text("接入网络")').click()

  await page.waitForURL('**/network', { timeout: 15_000 })
}

test.describe('401 self-heal (QR path)', () => {
  test('QR recovers after 401 on first API call', async ({ browser, request }) => {
    const ctx = await browser.newContext()
    const page = await ctx.newPage()

    // Intercept the first /api/qr-token call with a 401 — same effect as
    // a server restart where the cached token is no longer recognized.
    // The second call (retry after reAuth) passes through to the real server.
    let qrCalls = 0
    await page.route('**/api/qr-token**', async (route) => {
      qrCalls++
      if (qrCalls === 1) {
        await route.fulfill({ status: 401, body: JSON.stringify({ error: 'UNAUTHORIZED' }) })
      } else {
        await route.fallback()
      }
    })

    try {
      await login(page)
      // Prove this browser bundle and the signaling backend share the exact
      // test nonce, and that the real peer factory has no public ICE URLs.
      await assertE2eHostIceConfig(page, request)

      await page.locator('button:has-text("显示我的 QR")').first().click()

      // The QR modal opens when recovery succeeds. The authedFetch 401 →
      // reAuth → retry cycle produces a valid QR token, which the modal
      // renders inside an <img alt="接入 QR">.
      await expect(
        page.getByText('我的接入 QR'),
      ).toBeVisible({ timeout: 10_000 })

      await expect(
        page.locator('img[alt="接入 QR"]'),
      ).toBeVisible({ timeout: 10_000 })

      // The stale-token error message should never appear.
      await expect(
        page.getByText('会话已失效'),
      ).not.toBeAttached()

      // Confirm the interception actually ran — the test is worthless if
      // the route handler was never invoked.
      expect(qrCalls).toBeGreaterThanOrEqual(2)
    } finally {
      await ctx.close()
    }
  })
})
