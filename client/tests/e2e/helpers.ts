import { expect, type APIRequestContext, type Page } from '@playwright/test'
import { network as netCopy } from '../../src/copy/zh-CN/network'
import { transfer as xferCopy } from '../../src/copy/zh-CN/transfer'
import { auth as authCopy } from '../../src/copy/zh-CN/auth'

export { netCopy, xferCopy, authCopy }

const SIGNAL_BASE = 'http://localhost:19180/api'
const E2E_BUILD_NONCE = 'misaka-playwright-v1'

/** Escape a string for safe use inside a RegExp source. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Functional-page outage vocabulary after 07 P2.
 * Badge: offline / reconnecting; banners may use the longer connectionDropped /
 * restoringConnection forms (which contain the short badge labels as substrings
 * or close variants).
 */
export const OUTAGE_STATUS_MARKERS = [
  netCopy.peerStatus.offline,
  netCopy.peerStatus.reconnecting,
  netCopy.connectionDropped,
  netCopy.restoringConnection,
] as const

export const OUTAGE_STATUS_RE = new RegExp(
  [netCopy.peerStatus.offline, netCopy.peerStatus.reconnecting]
    .map(escapeRegExp)
    .join('|'),
)

/** UI strings that indicate a spurious reconnect/offline during a healthy transfer. */
export const CONNECTION_FAILURE_MARKERS = [
  netCopy.peerStatus.reconnecting,
  netCopy.peerStatus.offline,
  netCopy.restoringConnection,
  netCopy.connectionDropped,
] as const

export async function assertE2eBackend(request: APIRequestContext) {
  let ready: Awaited<ReturnType<APIRequestContext['get']>> | undefined
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      ready = await request.get(`${SIGNAL_BASE}/ready`)
      break
    } catch (error) {
      lastError = error
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)))
    }
  }
  if (!ready) throw lastError
  if (ready.status() !== 200) throw new Error(`E2E backend not ready: HTTP ${ready.status()}`)
  const body = await ready.json() as { ready?: boolean; turnState?: string; locksState?: string; e2eBuildNonce?: string }
  if (
    body.ready !== true ||
    typeof body.turnState !== 'string' ||
    typeof body.locksState !== 'string' ||
    body.e2eBuildNonce !== E2E_BUILD_NONCE
  ) {
    throw new Error(`port 19180 is not a compatible Misaka backend: ${JSON.stringify(body)}`)
  }
}

export async function assertE2eHostIceConfig(page: Page, request: APIRequestContext) {
  await assertE2eBackend(request)
  const backendNonce = E2E_BUILD_NONCE
  const snapshot = await page.evaluate(async () => {
    const modulePath = '/src/lib/e2e-ice.ts'
    const rtcPath = '/src/lib/webrtc.ts'
    const environment = await import(/* @vite-ignore */ modulePath) as {
      activeE2eBuildNonce(): string | null
    }
    const rtc = await import(/* @vite-ignore */ rtcPath) as {
      buildIceConfig(): RTCConfiguration
    }
    const config = rtc.buildIceConfig()
    return {
      nonce: environment.activeE2eBuildNonce(),
      policy: config.iceTransportPolicy ?? 'all',
      urls: (config.iceServers ?? []).flatMap(server =>
        Array.isArray(server.urls) ? server.urls : [server.urls],
      ),
    }
  })

  if (backendNonce !== E2E_BUILD_NONCE || snapshot.nonce !== backendNonce) {
    throw new Error(`E2E frontend/backend nonce mismatch: ${JSON.stringify({ backendNonce, snapshot })}`)
  }
  if (snapshot.policy !== 'all' || snapshot.urls.length !== 0) {
    throw new Error(`E2E peer config is not host-candidate-only: ${JSON.stringify(snapshot)}`)
  }
}

export async function cleanupE2eSessions(request: APIRequestContext) {
  await assertE2eBackend(request)
  const response = await request.post(`${SIGNAL_BASE}/release-by-ip`)
  if (response.status() !== 200) {
    throw new Error(`E2E cleanup failed: HTTP ${response.status()} ${await response.text()}`)
  }
  const body = await response.json() as { released?: unknown }
  if (typeof body.released !== 'number' || body.released < 0) {
    throw new Error(`E2E cleanup returned an invalid result: ${JSON.stringify(body)}`)
  }
  return body.released
}

/**
 * Watch the DOM for reconnect/offline banners that should not appear on a
 * healthy LAN transfer. Markers come from the zh-CN copy module so a future
 * vocabulary rename only needs one source of truth.
 */
export async function installConnectionFailureObserver(page: Page) {
  const markers = [...CONNECTION_FAILURE_MARKERS]
  await page.evaluate((failureMarkers) => {
    const state = window as Window & {
      __misakaConnectionFailureSeen?: boolean
      __misakaConnectionObserver?: MutationObserver
    }
    state.__misakaConnectionFailureSeen = false
    state.__misakaConnectionObserver?.disconnect()
    const inspect = () => {
      const text = document.body.innerText
      if (failureMarkers.some(marker => text.includes(marker))) {
        state.__misakaConnectionFailureSeen = true
      }
    }
    const observer = new MutationObserver(inspect)
    observer.observe(document.body, { subtree: true, childList: true, characterData: true })
    state.__misakaConnectionObserver = observer
    inspect()
  }, markers)
}

export async function expectNoReconnectingBanner(page: Page) {
  // Spurious cleanup used to fire dc.onclose → attemptIceRestart →
  // status='reconnecting' → outage banner on a peer that is actually healthy.
  expect(await page.evaluate(() =>
    (window as Window & { __misakaConnectionFailureSeen?: boolean }).__misakaConnectionFailureSeen,
  )).toBe(false)
}
