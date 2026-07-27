// The browser E2E suite runs two Chromium contexts on the same machine. Its
// connectivity proof must not depend on public STUN DNS or a production TURN
// service, so the Playwright dev server can opt into host-candidate-only ICE.
//
// Keep this deliberately hard to activate: it is development-only, requires
// the exact suite nonce, and is ignored by production builds even if an
// operator accidentally copies the environment variables.
export const E2E_BUILD_NONCE = 'misaka-playwright-v1'

export function isE2eHostIceOnly(): boolean {
  return import.meta.env.DEV
    && import.meta.env.VITE_E2E_BUILD_NONCE === E2E_BUILD_NONCE
    && import.meta.env.VITE_E2E_HOST_ICE_ONLY === '1'
}

/** Exposed for the browser-side Playwright compatibility assertion. */
export function activeE2eBuildNonce(): string | null {
  return isE2eHostIceOnly() ? E2E_BUILD_NONCE : null
}
