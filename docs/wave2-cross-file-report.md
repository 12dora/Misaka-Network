# Wave 2 · Cross-file leftovers — completion report

Worktree: `/Users/konata/code/misaka-w2` · branch `w2` · base `9a0c2be`

**Do not touch** (respected): `client/src/lib/transfer.ts`, `client/src/lib/transfer/**`,
`client/src/store/network.ts`, `client/src/store/network/**`.

---

## Done

### 1. `home.ts` stats race (02 P2)

Monotonic `statsFetchSeq` on `fetchStats`. Only the latest request may commit
`stats` / `statsStatus` / `statsLastUpdated` or clear `statsLoading`.

Tests in `home-stats-state.test.ts`:
- old-success-after-new-success
- old-error-after-new-success

### 2. `signaling.ts` — Contract 3 + socket ownership + connect watchdog

| Item | Fix |
|------|-----|
| **4003** | Reconnects with the **same token** via existing backoff. Does **not** dispatch `onAuthInvalid`. 4001/4002 unchanged. |
| **Socket ownership** | `detachAndClose`, generation/`ws === sock` guards on every callback. `reconnectNow` closes half-dead OPEN (PING throws) and CLOSING sockets instead of early-return / bare null. |
| **Connect watchdog** | `WS_CONNECT_TIMEOUT_MS` (15s). Closes only the exact CONNECTING socket, then backoff. |

Tests in `signaling-auth-recovery.test.ts` (4003, PING-throw reconnect, stale close isolation, forever-CONNECTING watchdog).

### 3. `webrtc.ts` — ICE config signature (02 P1)

- `createPeerConnection()` seeds `appliedIceSignature` from the real construction config.
- First-ever change compares against live `getConfiguration()` when no seed.
- Signature committed **only after** successful `setConfiguration`.
- Returns only PCs that genuinely changed.

Perfect-negotiation `makingOffer` state machine: **not duplicated** here (store-side on the other branch). `createOffer` already accepts `isCurrent?`.

### 4. `SettingsModal.tsx`

- **08 P1**: Nested `MisakaDialog` confirm for TURN delete; default focus on 保留; danger button is outline, not pill.
- **08 P2**: Roving tabindex, `aria-controls` ↔ tabpanel ids, Arrow/Home/End.
- **08 P3**: `useModalExit.requestCloseThen` drives /tos and /privacy after real exit (no hardcoded 180ms; respects reduced motion).
- **07 P2**: Copy via `client/src/copy/zh-CN/settings.ts` — NAT labels, 服务器协助连接, `剩余 Ns · 有效期 Ns`, manual form under 高级设置.

### 5. `IpFullPrompt.tsx` (07 P2)

Title: **当前网络的接入名额已满**. Body describes shared egress / CGNAT / dorm / office.
Identity-scoped release + zero-release no-retry assertions preserved.

### 6. Test rot (05)

| Item | Change |
|------|--------|
| `ui-contract.test.mjs` | Removed API/signaling/store/crypto/transfer source-regex blocks. UI contracts kept. |
| `manual-test.mjs` | Sender waits 已保存; receiver 接收完成\|已保存到所选位置. |
| `transfer.spec.ts` | `expectSenderSaved` / `expectReceiverComplete` by direction (📤/📥); sender saved only after receiver artifact digest. Frontend nonce via `assertE2eHostIceConfig`. |
| `playwright.config.ts` | Frontend `reuseExistingServer: false`. |
| `chunk-bitmap.test.ts` | Seeded Mulberry32 fuzz + byte-boundary cases (7/8, 31/32, trailing pad). |
| `transfer-protocol-version.test.ts` | Replaced frame-layout dup with v2 reject / repair / v1 control-plane tests (**import-only** of transfer public API). |

---

## Deferred (need transfer engine / network store — other branch)

### Top follow-up (05 P1) — **do not start until transfer restructure lands**

1. **Real-WebRTC E2E for protocol v2**: pause, in-flight chunk loss, repair, final ACK, cancel-during-pause. Needs deterministic send gate behind `VITE_E2E_BUILD_NONCE`.
2. **Ownership matrix**: every control message × (correct owner, wrong `peerSessionId`, stale `epoch`, `undefined`). `transfer-reject` still under-covered in store dispatcher tests.

### Blocked by file ownership (this wave)

| Finding | File | Why deferred |
|---------|------|--------------|
| `notifyIncomingFile` call site | `store/network.ts` | Owned by transfer restructure branch |
| `networkStatusLabel` unified vocabulary | `store/network.ts` | Same |
| `humanizeError` / `toUserMessage` write sites | `store/network.ts`, `lib/transfer.ts` | Same |
| `/api/transfer-done` telemetry caller | transfer/network after durable ACK | Must not influence delivery state; only POST after `saved` |
| Perfect-negotiation `makingOffer` window | `store/network.ts` | State machine on other branch |

### Backlog items intentionally not in this wave's scope

From `wave2-backlog.md` §B that were resolved earlier or are other tracks:
- `isRelayAllowed` / tri-state TURN (LIBS + existing tests already pin behaviour)
- `onSessionInvalid` → network epoch teardown (network store)
- QRModal file/channel types (verify-only; UI agent claimed removal)

---

## Gates (real exit codes)

| Command | Exit |
|---------|------|
| `npm test` | **0** (87 files, 729 tests + ui-contract) |
| `npm --prefix client run typecheck` | **0** |
| `npm --prefix client run typecheck:tests` | **0** |
| `npm --prefix server run build` | **0** |

No git write commands were run.
