# CLAUDE.md

This file instructs AI agents (Claude Code, Cursor, etc.) working on the Misaka Network codebase. Follow these rules strictly.

## Testing discipline

- Before modifying any existing feature: run `npm test` first and verify the full suite passes. Do not start work against a red baseline.
- After any code change in `client/src/` or `server/src/`: run `npm test`. Do not report the task as done until it passes.
- When adding a feature: add tests in the same change. No feature ships without tests. Cover at least the happy path and one edge case.
- When fixing a bug: write a failing test that reproduces it first, then fix the code. Never silently fix a bug — the test is proof the fix works.
- When modifying behavior: update the corresponding tests so they reflect the new behavior. Never delete or skip a test to make CI green without understanding why it failed.

## Test commands

```bash
npm test              # everything except E2E
npm run test:e2e      # Playwright E2E (real server + real WebRTC)
npm --prefix server test
npm --prefix client test
npm --prefix client run test:unit -- --coverage
```

## Project layout

```
client/src/lib/       # pure-ish modules under Vitest unit tests
client/src/store/      # Zustand stores
client/tests/unit/    # Vitest unit specs (jsdom)
client/tests/e2e/     # Playwright E2E specs
server/src/           # Express + ws signaling, TURN logic
server/tests/         # spawn-process integration tests
```

## Key contracts (do not break these without updating tests)

- `authedFetch` must retry once on 401, and throw `AuthRequiredError` on double 401. See `client/src/lib/api.ts`.
- WS close codes 4001/4002 must trigger `onAuthInvalid` → clear cached session → re-register. See `client/src/lib/signaling.ts` and `client/src/store/auth.ts`.
- `CHUNK_FRAME_TAG = 0x01`. Frame layout: [tag:1][shortId:4][index:4][iv:12][ciphertext]. See `client/src/lib/transfer.ts`.
- `makeChunkIv` merges an 8-byte random prefix (same per transfer) with a 4-byte BE index. See `client/src/lib/crypto.ts`.
- TURN relay is controlled by `turnSettings.enabled` — when off, neither auto nor manual TURN servers are added to the peer connection. See `client/src/lib/webrtc.ts`.

## CI

PRs trigger `.github/workflows/test.yml`. A guard job ensures `src/` changes are accompanied by `tests/` changes (override with `[skip-test-guard]` in the PR title or latest commit message).
