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
      command: 'npm --prefix ../server run build && PORT=' + SIGNAL_PORT +
               ' MAX_NODES=200 TURN_AUTO_ENABLED=false node ../server/dist/index.js',
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
      },
    },
  ],
})
