import type { APIRequestContext, Page } from '@playwright/test'

const SIGNAL_BASE = 'http://localhost:19180/api'
const E2E_BUILD_NONCE = 'misaka-playwright-v1'

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
