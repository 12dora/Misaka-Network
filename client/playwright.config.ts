import { defineConfig, devices } from '@playwright/test'

// E2E runs against a real Vite dev server + real signaling server. Playwright
// starts both via `webServer:` so `npm run test:e2e` is one command.
//
// We intentionally do NOT mock the signaling backend or WebRTC stack:
// AES-GCM, DataChannel framing and SDP/ICE negotiation are exactly the layer
// that breaks during refactors, and a mocked stub would defeat the whole
// point of the suite.

const PORT = 5174 // separate from dev (5173) so devs can keep coding while CI runs
const SIGNAL_PORT = 19180
const E2E_BUILD_NONCE = 'misaka-playwright-v1'

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false, // suite spins up real signaling state; serial avoids cross-test pollution
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Two browser contexts per test simulate two devices on the same LAN.
        launchOptions: { args: ['--disable-blink-features=AutomationControlled'] },
      },
    },
  ],
  webServer: [
    {
      // Build the server once (turn tests reuse dist/) then run it.
      //
      // RATE_LIMIT_PER_MIN is raised far above the prod default (60): the whole
      // suite hammers the API from one IP (127.0.0.1) — every page.goto +
      // register + qr-token + the per-test release-by-ip counts against the
      // `api:${ip}` limiter. Once 60/min trips, release-by-ip starts 429ing
      // (silently, via its .catch), the per-IP node cap then fills, and later
      // tests (e.g. folder transfer, the 7th) time out at login. A high limit
      // removes that cross-test coupling without touching prod behaviour.
      command: 'npm --prefix ../server run build && PORT=' + SIGNAL_PORT +
               ' MAX_NODES=200 RATE_LIMIT_PER_MIN=100000 TURN_AUTO_ENABLED=false' +
               ' TURN_PERSIST_DIR=$(mktemp -d) E2E_ALLOW_UNAUTH_RELEASE_BY_IP=1' +
               ` E2E_BUILD_NONCE=${E2E_BUILD_NONCE} node ../server/dist/index.js`,
      port: SIGNAL_PORT,
      timeout: 60_000,
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: `npm run dev -- --port ${PORT} --strictPort`,
      port: PORT,
      timeout: 60_000,
      reuseExistingServer: !process.env.CI,
      env: {
        VITE_API_BASE: `http://localhost:${SIGNAL_PORT}`,
        VITE_WS_URL: `ws://localhost:${SIGNAL_PORT}/ws`,
        VITE_E2E_BUILD_NONCE: E2E_BUILD_NONCE,
        VITE_E2E_HOST_ICE_ONLY: '1',
      },
    },
  ],
})
