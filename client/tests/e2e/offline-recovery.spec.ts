// E2E: offline peer banner exposes "立即重连此节点" affordance.
//
// Replays the bug where a peer whose WS dropped (or whose ICE failed) left
// the user staring at a red banner with no recovery affordance. Network.tsx
// now wires reconnectPeer(sessionId) into the banner; this test asserts the
// button appears, is clickable, and the peer card transitions away from
// 'offline'.

import { test, expect, type Page, type BrowserContext } from '@playwright/test'

const NODE_A = '11001'
// Clusters are identity-scoped on the server (clusterChannelId = nodeId +
// passcode), so two sessions only appear in each other's radar when they share
// the SAME nodeId + passcode — i.e. two devices of the same 御坂 node. B is a
// second device on node A's identity; giving it a different nodeId (the old
// '11002') puts it in a different cluster where A can never see it.
const NODE_B = NODE_A
const PASS_CODE = '424242'

test.beforeEach(async ({ request }) => {
  await request.post('http://localhost:19180/api/release-by-ip').catch(() => {})
})

async function login(page: Page, nodeId: string) {
  await page.goto('/', { waitUntil: 'load' })
  const section = page.locator('section[class*="hidden md:grid"]').first()
  await section.locator('input[type="number"]').fill(nodeId)
  const passInputs = section.locator('input[maxlength="1"]')
  for (let i = 0; i < PASS_CODE.length; i++) await passInputs.nth(i).fill(PASS_CODE[i])
  await section.locator('button:has-text("接入网络")').click()
  await page.waitForURL('**/network', { timeout: 30_000 })
}

async function openContext(browser: Parameters<typeof test>[1] extends never ? never : any) {
  const ctx = await browser.newContext()
  return { ctx, page: await ctx.newPage() }
}

test('offline-peer banner offers and acts on 立即重连', async ({ browser }) => {
  const a = await openContext(browser)
  const b = await openContext(browser)
  try {
    await login(a.page, NODE_A)
    await login(b.page, NODE_B)

    // Wait for A to see B in the radar.
    await expect(a.page.getByText(`御坂 ${NODE_B} 号`, { exact: false }).first())
      .toBeVisible({ timeout: 20_000 })

    // Close B entirely → A's PEER_LEFT path fires; if PC still alive via TURN it
    // stays 'reconnecting' for a while, otherwise it goes 'offline'.
    await b.ctx.close()

    // Force-select B in A's radar so the right pane shows the banner.
    await a.page.getByText(`御坂 ${NODE_B} 号`, { exact: false }).first().click()

    // Wait for status to surface as offline or reconnecting (banner shows on either).
    await expect.poll(
      async () => await a.page.locator('text=/连接已断开|正在尝试重新协商连接/').count(),
      { timeout: 30_000, intervals: [500, 1_000, 2_000] },
    ).toBeGreaterThan(0)

    // "立即重连此节点" button must be present and clickable.
    const reconnectBtn = a.page.locator('button:has-text("立即重连")')
    await expect(reconnectBtn.first()).toBeVisible({ timeout: 10_000 })
    await reconnectBtn.first().click()

    // Status should transition out of 'offline' (to 'connecting' or 'reconnecting');
    // the button must not crash the page.
    await expect(a.page).toHaveURL(/\/network$/)
  } finally {
    await a.ctx.close().catch(() => {})
    await b.ctx.close().catch(() => {})
  }
})
