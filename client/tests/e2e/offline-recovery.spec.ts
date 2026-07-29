// E2E: offline peer banner exposes reconnect affordance.
//
// Replays the bug where a peer whose WS dropped (or whose ICE failed) left
// the user staring at a red banner with no recovery affordance. Network.tsx
// now wires reconnectPeer(sessionId) into the banner; this test asserts the
// button appears, is clickable, and the peer card transitions away from
// 'offline'. Status strings come from the zh-CN copy module (07 P2).

import { test, expect, type Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cleanupE2eSessions,
  authCopy,
  netCopy,
  xferCopy,
  escapeRegExp,
  OUTAGE_STATUS_MARKERS,
  OUTAGE_STATUS_RE,
} from './helpers'

const NODE_A = '11001'
// Clusters are identity-scoped on the server (clusterChannelId = nodeId +
// passcode), so two sessions only appear in each other's radar when they share
// the SAME nodeId + passcode — i.e. two devices of the same 御坂 node. B is a
// second device on node A's identity; giving it a different nodeId (the old
// '11002') puts it in a different cluster where A can never see it.
const NODE_B = NODE_A
const PASS_CODE = '424242'

test.beforeEach(async ({ request }) => {
  await cleanupE2eSessions(request)
})

async function login(page: Page, nodeId: string) {
  await page.goto('/', { waitUntil: 'load' })
  const section = page.locator('section[class*="hidden md:grid"]').first()
  await section.locator('input[type="number"]').fill(nodeId)
  const passInputs = section.locator('input[maxlength="1"]')
  for (let i = 0; i < PASS_CODE.length; i++) await passInputs.nth(i).fill(PASS_CODE[i])
  await section.locator(`button:has-text("${authCopy.accessNetwork}")`).click()
  await page.waitForURL('**/network', { timeout: 30_000 })
}

async function openContext(browser: Parameters<typeof test>[1] extends never ? never : any) {
  const ctx = await browser.newContext()
  return { ctx, page: await ctx.newPage() }
}

test('offline-peer banner offers and acts on reconnect', async ({ browser }) => {
  const a = await openContext(browser)
  const b = await openContext(browser)
  let replacement: Awaited<ReturnType<typeof openContext>> | undefined
  const observedStates = new Set<string>()
  const trackMarkers = [
    ...OUTAGE_STATUS_MARKERS,
    netCopy.peerStatus.online,
    xferCopy.recvDone,
  ]
  const observer = setInterval(async () => {
    const text = await a.page.locator('body').innerText().catch(() => '')
    for (const state of trackMarkers) {
      if (text.includes(state)) observedStates.add(state)
    }
  }, 100)
  try {
    await login(a.page, NODE_A)
    await login(b.page, NODE_B)

    // Wait for A to see B in the radar.
    await expect(a.page.getByText(netCopy.misakaNumber(Number(NODE_B)), { exact: false }).first())
      .toBeVisible({ timeout: 20_000 })

    // Close B entirely → A's PEER_LEFT path fires; if PC still alive via TURN it
    // stays 'reconnecting' for a while, otherwise it goes 'offline'.
    await b.ctx.close()

    // Force-select B in A's radar so the right pane shows the banner.
    await a.page.getByText(netCopy.misakaNumber(Number(NODE_B)), { exact: false }).first().click()

    // Wait for status to surface as offline or reconnecting (banner shows on either).
    await expect.poll(
      async () => await a.page.getByText(OUTAGE_STATUS_RE).count(),
      { timeout: 30_000, intervals: [500, 1_000, 2_000] },
    ).toBeGreaterThan(0)

    // Offline uses reconnectThisDevice; reconnecting uses reconnectNow — both
    // share the reconnect prefix from the copy module.
    const reconnectBtn = a.page.locator(
      `button:has-text("${netCopy.reconnectNow}"), button:has-text("${netCopy.reconnectThisDevice}")`,
    )
    await expect(reconnectBtn.first()).toBeVisible({ timeout: 10_000 })
    await reconnectBtn.first().click()

    // Bring the peer back as a fresh device session. A URL assertion alone
    // would let a no-op reconnect handler pass; a real encrypted transfer
    // after the observed outage proves discovery and communication recovered.
    replacement = await openContext(browser)
    await login(replacement.page, NODE_B)
    await expect(replacement.page.getByText(netCopy.misakaNumber(Number(NODE_A)), { exact: false }).first())
      .toBeVisible({ timeout: 20_000 })
    // A still has the deliberately retained offline card for B's old
    // session. Wait for and select the replacement's genuinely online card
    // so same-node duplicate labels cannot leave the test (or user)
    // operating on the stale session. Prefer the radar card aria-label
    // (includes peerStatus). Anchor on `，连接$` so reconnecting/connecting
    // labels that merely contain the online token do not match.
    const onlineLabel = new RegExp(
      `选择御坂 ${NODE_B} 号设备.*，${escapeRegExp(netCopy.peerStatus.online)}$`,
    )
    const replacementOnline = a.page.getByRole('button', { name: onlineLabel }).last()
    await expect(replacementOnline).toBeVisible({ timeout: 30_000 })
    await replacementOnline.click()

    const dir = mkdtempSync(join(tmpdir(), 'misaka-recovery-'))
    const path = join(dir, 'after-reconnect.bin')
    writeFileSync(path, Buffer.from('communication recovered after offline transition'))
    try {
      await replacement.page.getByText(netCopy.misakaNumber(Number(NODE_A)), { exact: false }).first().click()
      const replacementReady = replacement.page
        .getByText(netCopy.peerConnected, { exact: false }).first()
      const retry = replacement.page.locator(
        `button:has-text("${netCopy.reconnectNow}"), button:has-text("${netCopy.reconnectThisDevice}")`,
      ).first()
      const firstOutcome = await expect.poll(async () => {
        if (await replacementReady.isVisible().catch(() => false)) return 'ready'
        if (await retry.isVisible().catch(() => false)) return 'retry'
        return 'waiting'
      }, { timeout: 35_000, intervals: [250, 500, 1_000] }).not.toBe('waiting')
      void firstOutcome
      if (!await replacementReady.isVisible().catch(() => false)) {
        await retry.click()
      }
      await expect(replacementReady).toBeVisible({ timeout: 30_000 })
      const [chooser] = await Promise.all([
        replacement.page.waitForEvent('filechooser'),
        replacement.page.getByRole('button', { name: netCopy.selectFile }).first().click(),
      ])
      await chooser.setFiles(path)
      await replacement.page.locator('[data-testid="send-pending-file"]').first().click()
      await expect.poll(
        async () => await a.page.getByText(xferCopy.recvDone, { exact: false }).count(),
        { timeout: 60_000, intervals: [500, 1_000, 2_000] },
      ).toBeGreaterThan(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }

    const sawOutage = OUTAGE_STATUS_MARKERS.some(marker => observedStates.has(marker))
    expect(sawOutage).toBe(true)
    expect(await a.page.getByText(xferCopy.recvDone, { exact: false }).count()).toBeGreaterThan(0)
    // Online peer badge uses peerStatus.online ("连接"), not the retired
    // ACGN lore term "脑波同步中".
    expect(
      await a.page.getByText(netCopy.peerStatus.online, { exact: true }).count(),
    ).toBeGreaterThan(0)
  } finally {
    clearInterval(observer)
    await a.ctx.close().catch(() => {})
    await b.ctx.close().catch(() => {})
    await replacement?.ctx.close().catch(() => {})
  }
})
