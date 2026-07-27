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
- `CHUNK_FRAME_TAG = 0x01`. Frame layout: [tag:1][shortId:4][index:4][iv:12][ciphertext]. See `client/src/lib/transfer.ts`. **Unchanged by protocol v2** — only the JSON control plane grew.
- `makeChunkIv` merges an 8-byte random prefix (same per transfer) with a 4-byte BE index. See `client/src/lib/crypto.ts`. **Unchanged by protocol v2.**
- TURN relay is controlled by `turnSettings.enabled` — when off, neither auto nor manual TURN servers are added to the peer connection. See `client/src/lib/webrtc.ts`.

### Transfer protocol version (`PROTOCOL_VERSION = 2`)

Delivery semantics are versioned so an old peer and a new peer can never silently
disagree about what "sent" and "completed" mean. Each side announces its version
in a `hello` frame on the primary DataChannel (and again as `meta.v`); both run
`negotiatedProtocolVersion() = min(mine, theirs)`. Unknown/absent ⇒ v1.

- **v1** — `meta` then chunks immediately; "completed" means locally queued; a
  receiver pause loses in-flight chunks with no repair; no finalization ACK.
- **v2** — adds four receiver→sender JSON control messages:
  - `{ type: 'transfer-ready', transferId, shortId }` — the receiver's storage
    backend is **committed and proven writable**. No payload may move before it.
  - `{ type: 'transfer-reject', transferId, reason, message }` — refused up-front
    (invalid metadata, ownership mismatch, or over the in-memory cap once the
    committed backend turned out to be IndexedDB).
  - `{ type: 'transfer-repair', transferId, missingRanges: [[start,len],…] }` —
    chunks the receiver is still missing (typically dropped in-flight by a
    pause). Re-queued into the **same live send task**, never a second engine.
  - `{ type: 'transfer-done', transferId, bytes }` — the file is durably written.
    Only this promotes a send from `delivered` to `saved`; the source `File` is
    held until it arrives (or the peer is v1 and can never send it).
- Send delivery states are `queued → delivered → saved` (`SendOutcome.state`);
  a v1 peer tops out at `delivered`.
- Transfer ownership is `(peerSessionId, epoch)` — never `peerNodeId`, which
  every device of one identity shares. `meta`, `resume`, and all six control
  messages are ownership-checked (`assertTransferOwner`).
- Inbound `meta` must pass `validateMetaMessage` before ANY state change:
  `totalChunks === ceil(fileSize / CHUNK_SIZE)` exactly, safe-integer bounds,
  id/name/MIME limits, and each chunk's plaintext length must equal the length
  the declared geometry implies.
- The receive order is fixed: **decrypt → durable write → set bitmap → persist
  bitmap → progress**. A resume bitmap must never claim a byte the disk lacks.
- `finalizeReceive()` is the single terminal completion API for all three
  backends (FSA / OPFS / IDB): close, size-verify, delete chunks, remove the
  exact OPFS entry, retire the DB row, drop session + signal + owner.

## Test-script lifecycle (do not regress)

- Server integration scripts (`server/tests/*.test.mjs`) must wrap `main` with `runTest` from `server/tests/_harness.mjs` so the script always calls `process.exit()` explicitly. Any new dangling handle (keep-alive socket, forgotten `setTimeout`, child stderr pipe) silently wedged CI in the past — `runTest` is what prevents that.
- Use `killChild(proc)` for spawned-server cleanup. It uses an unref'd SIGKILL fallback timer; don't write your own `setTimeout(...kill...)` that itself holds the loop open.
- Test scripts that import TypeScript directly must be run via `tsx`, not `node`. Node 20 (CI) doesn't auto-strip `.ts`. Mirror the test under Vitest instead whenever possible.

## CI

PRs trigger `.github/workflows/test.yml`. A guard job ensures `src/` changes are accompanied by `tests/` changes (override with `[skip-test-guard]` in the PR title or latest commit message).
