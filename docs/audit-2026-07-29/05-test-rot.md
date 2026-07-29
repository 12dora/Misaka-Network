# Misaka Network 测试腐化审计报告

## 摘要

- 零字节文件测试锁定了错误的 protocol v2 语义：它明确期待未收到 `transfer-done` 就进入 `saved`，会让发送端在接收端拒绝或断线时仍显示“已保存”并释放源 `File`。
- WebSocket 重连替换测试吞掉旧连接未关闭的超时；服务端即使保留两个同时有效的认证 socket，该测试仍可通过。
- 多个安全阈值测试只检查“若干次内最终被限流/冻结”，不检查阈值前允许、阈值点拒绝；把阈值错误降到 1 也能通过。
- 定时“传输压力测试”完全没有调用客户端传输、加密、DataChannel 或存储实现，却被工作流当作真实字节完整性和内存预算门禁。
- 真实 WebRTC E2E 没有覆盖 protocol v2 的暂停、在途丢块、repair、恢复和最终 ACK；所有权边界也只对 `transfer-done` 做了错误会话测试。
- CI 缺少覆盖率阈值，测试触达守卫可被任意无关测试改动满足；Pages 部署也不依赖测试工作流成功。

## 发现

### [P0] 零字节测试锁定了“无 ACK 即 saved”的错误交付语义

- 位置: `client/tests/unit/transfer-zero-byte.test.ts:57`；`client/src/lib/transfer.ts:781`；`CLAUDE.md:60`
- 证据:

```ts
    await expect(
      sendFileParallel(
        [dc], empty,
        'transfer-id-empty',
        1, 'peer-session',
        undefined,
        { onProgress: (sent, total) => progress.push([sent, total]) },
      ),
    ).resolves.toMatchObject({ state: 'saved', acked: false })
```

- 影响: 该测试没有注册 peer 版本，因此实际走默认 v1，却要求 `saved`；这已经违反“v1 最多到 `delivered`”。对 v2，契约又明确规定只有 `{ type: 'transfer-done' }` 才能提升到 `saved`，且源 `File` 必须保留到 ACK 到达。当前实现对零字节统一返回 `saved + acked:false`：当 `meta` 发出后接收端因后端不可写而发送 `transfer-reject`，或 DataChannel 在 `transfer-ready`/`transfer-done` 前关闭时，发送端仍显示“已保存”并删除 `sendingFiles` 中的源文件；接收端实际上没有持久化该文件。
- 建议: 保留 `(1,1)` 进度修复，但删除该错误断言。v1 零字节传输应返回 `delivered`；v2 同样等待 `transfer-ready`，并仅在 `transfer-done` 后返回 `{ state:'saved', acked:true }`，拒绝时必须失败。同步更新 `client/src/lib/transfer.ts`、`client/tests/unit/transfer-zero-byte.test.ts`，并在 `client/tests/e2e/transfer.spec.ts` 增加 v1 fallback、v2 成功、接收端拒绝三个用例。此修复明确触及 `CLAUDE.md:49-64` 的 protocol delivery contract。

### [P1] 重连替换测试吞掉“旧认证 socket 未关闭”的失败

- 位置: `server/tests/ws-reconnect-supersede.test.mjs:86`
- 证据:

```js
  // Reconnect A on ws2 with the SAME token. The server must close ws1
  // (SUPERSEDED) and keep the session pointed at ws2.
  const wsA2 = await openWS()
  const msgsA2 = []
  wsA2.on('message', raw => { try { msgsA2.push(JSON.parse(raw.toString())) } catch { /* ignore */ } })
  const ws1ClosePromise = waitForClose(wsA1, 3000).catch(() => null)
  wsA2.send(JSON.stringify({ t: 'AUTH', token: regA.token }))
  const welcome2 = await waitFor(() => msgsA2.find(m => m.t === 'WELCOME'), 1500)
  if (welcome2.sessionId !== regA.sessionId) throw new Error('ws2 WELCOME should reuse the same sessionId')

  // ws1 should be closed by the server (superseded).
  await ws1ClosePromise
```

- 影响: 如果 `server/src/ws.ts` 的 supersede 逻辑退化为不关闭 `wsA1`，`waitForClose` 三秒后拒绝，但 `.catch(() => null)` 把失败转成成功；随后只验证 `wsA2` 可 PING，整项测试仍通过。结果是同一 token 可留下两个活跃认证 socket，旧页面继续收发信令，与测试声称保护的单会话连接语义相反。
- 建议: 不要捕获该超时；直接 `const close = await waitForClose(...)`，断言 `close.code === 1000` 且 reason 为 `SUPERSEDED`，再验证 `wsA1.readyState === WebSocket.CLOSED`。保留 `wsA2` PING 和“不广播伪 `PEER_LEFT`”断言，分别覆盖旧连接终止、新连接存活、旁观者状态三个独立结果。

### [P1] 安全阈值测试没有验证边界，过早冻结/限流也会通过

- 位置: `server/tests/brute-force-global.test.mjs:69`；同根因见 `server/tests/trust-proxy.test.mjs:52`、`server/tests/qr-redeem-ratelimit.test.mjs:86`、`server/tests/http-abuse-bounds.test.mjs:126`
- 证据:

```js
  // Now rotate through 10 distinct attacker IPs, 1 wrong attempt each.
  // Threshold is 8 → freeze should trigger by attempt 8.
  let freezeSeen = false
  for (let i = 0; i < 10; i++) {
    const ip = `198.51.100.${100 + i}`
    const r = await postFrom('/register', { nodeId: NODE_ID, passCode: '000000' }, ip)
    if (r.error === 'NODE_LOCKED' && r.reason === 'NODE_FROZEN') {
      freezeSeen = true
      break
    }
  }
  if (!freezeSeen) throw new Error('IP 轮换 8+ 次后应触发 NODE_FROZEN，但未出现')
```

- 影响: 如果 `NODE_FREEZE_THRESHOLD` 错误变成 1，第一次错误尝试即冻结整个 nodeId，上述测试仍把它当作成功；合法用户会被单次恶意请求拒绝服务。同样，`trust-proxy` 用例在第一次注册即 `IP_LIMITED` 时也会通过，两个限流用例也只要求最终出现一次 429，无法证明限额前请求仍被允许。
- 建议: 把每个阈值测试改成精确边界断言：前 `N-1` 次必须得到预期的非冻结/非 429 结果，第 `N` 次必须得到指定错误码，第 `N+1` 次继续拒绝；`trust-proxy` 必须逐项断言前 10 次有 token、第 11 次恰为 `IP_LIMITED`。不要只用 `saw429`/`freezeSeen`。

### [P1] “传输压力测试”只测试自写的 Node 模拟器，不测试产品传输代码

- 位置: `server/tests/stress-1gb.test.mjs:11`；`.github/workflows/stress-benchmark.yml:23`
- 证据:

```js
import crypto from 'crypto'
import assert from 'node:assert/strict'
import { createRequire } from 'module'
import { runTest } from './_harness.mjs'

const require = createRequire(import.meta.url)

const CHUNK_SIZE = 64 * 1024        // 64KB
const FILE_SIZE = Number(process.env.STRESS_FILE_SIZE_MB ?? 1024) * 1024 * 1024
const TOTAL_CHUNKS = Math.ceil(FILE_SIZE / CHUNK_SIZE) // 16384
const STREAM_RSS_BUDGET = Number(process.env.STRESS_STREAM_RSS_BUDGET_MB ?? 256) * 1024 * 1024
```

- 影响: 文件没有导入 `client/src/lib/transfer.ts`、`client/src/lib/crypto.ts` 或任何存储后端，并自定义了与产品 `252 KiB` 不同的 `64 KiB` chunk、Node AES-GCM 和“写盘即丢弃”流程。即使真实 `sendFileParallel` 把整文件缓存、OPFS/FSA 写入路径泄漏内存、frame 布局损坏，月度工作流仍会绿色，形成错误的容量与完整性保证。
- 建议: 删除该测试作为产品正确性门禁，若保留则明确改名为 Node AES-GCM micro-benchmark。另建客户端压力测试：在 Chromium 中调用真实传输引擎和真实 OPFS，使用生产 `CHUNK_SIZE`，校验最终 SHA-256、sender/receiver 峰值内存、终态清理；至少把 256 MiB 版本放入定时工作流，并让结果明确关联生产模块。

### [P1] Pages 部署不受测试结果门禁

- 位置: `.github/workflows/deploy.yml:3`、`.github/workflows/deploy.yml:58`、`.github/workflows/deploy.yml:75`；对照 `.github/workflows/test.yml:3`
- 证据:

```yaml
      - name: Build
        env:
          VITE_BASE: ${{ steps.base.outputs.vite_base }}
        run: cd client && npm run build

      - name: Upload artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: client/dist

      - name: Deploy to GitHub Pages
        uses: actions/deploy-pages@v4
```

- 影响: `deploy.yml` 和 `test.yml` 都由 `push main` 独立触发；部署只要求构建和两条 grep 成功。一个“可编译但单元/E2E 失败”的 main 提交会在测试工作流失败的同时被部署到生产 Pages。
- 建议: 合并为单一工作流并让部署 job `needs` 全部 server/client/E2E job，或让部署通过 `workflow_run` 只消费同一 commit 的成功 Test workflow；部署前校验 `head_sha`，避免上一次成功测试授权下一次未测试构建。

### [P1] 真实 WebRTC E2E 没有覆盖 v2 暂停、在途丢块与 repair

- 位置: `client/tests/unit/transfer-receiver-pause.test.ts:48`；覆盖入口为 `client/tests/e2e/transfer.spec.ts:219`
- 证据:

```ts
interface FakeDc {
  label: string
  readyState: RTCDataChannelState
  binaryType: BinaryType
  bufferedAmount: number
  bufferedAmountLowThreshold: number
  onclose: ((e: Event) => void) | null
  onmessage: ((e: MessageEvent) => void) | null
  close: () => void
  send: (payload: string | ArrayBuffer) => void
  addEventListener: (t: string, h: (e: Event) => void) => void
```

- 影响: 暂停/repair 的强单测使用自建 `FakeDc` 和人工 `wire` 队列；8 个 Playwright 用例只有正常传输、广播、QR、认证与离线重连，没有一次通过真实 SCTP 队列触发暂停。真实浏览器中 `bufferedAmount`、多个 lane、暂停消息与已排队 chunk 的竞态发生回归时，单测模型可继续通过，而用户会得到缺块或永远等不到 `transfer-done` 的文件。
- 建议: 在 `client/tests/e2e/transfer.spec.ts` 增加确定性暂停测试，不要依赖“localhost 文件足够慢”。提供仅在 `VITE_E2E_BUILD_NONCE` 存在时启用的发送闸门：第 N 个 chunk 入队后阻塞；UI 点击暂停，释放在途帧，断言进度不再持久化；点击恢复，断言同一 transferId 发出 repair、最终 artifact SHA-256 相等且 sender 只在 ACK 后显示 `saved`。同时覆盖 cancel during pause。

### [P1] v2 控制消息的所有权负向覆盖不完整，`transfer-reject` 路径完全未测

- 位置: `client/tests/unit/transfer-delivery-semantics.test.ts:229`；待覆盖实现位于 `client/src/lib/transfer.ts:539`、`client/src/lib/transfer.ts:557`、`client/src/lib/transfer.ts:1055`、`client/src/lib/transfer.ts:1065`、`client/src/lib/transfer.ts:1915`
- 证据:

```ts
    // SECURITY-015: a sibling device in the same identity cluster must not be
    // able to confirm someone else's transfer.
    expect(markTransferAcked(id, { peerSessionId: 'intruder', epoch: 0 })).toBe(false)
    expect(markTransferAcked(id, OWNER)).toBe(true)
```

- 影响: 全测试目录只有 `transfer-done`/`markTransferAcked` 验证了错误 session；没有测试错误 session 或旧 epoch 对 `transfer-ready`、`transfer-reject`、`transfer-repair`、pause、resume、cancel 的拒绝，测试中甚至没有出现字符串 `transfer-reject`。如果重构时漏掉任一路径的 `assertTransferOwner`，同 nodeId 的兄弟设备可以解锁、拒绝、重排或取消他人的传输，CI 仍通过。
- 建议: 在 `client/tests/unit/transfer-delivery-semantics.test.ts` 增加参数化所有权矩阵，对每个控制 API 分别传入正确 owner、错误 `peerSessionId`、旧 `epoch`、`undefined`；断言返回失败且 live task、bitmap、ready waiter、delivery state 均不变。另在 store 级测试通过真实 DataChannel dispatcher 注入 `transfer-reject`，断言正确 owner 立即结束等待并标记失败、错误 owner 不删除 `sendingFiles`。

### [P2] 手工 Playwright 脚本仍等待已删除的“已完成”文案

- 位置: `client/tests/manual-test.mjs:179`；当前行为见 `client/src/pages/Network.tsx:714`
- 证据:

```js
    console.log('[transfer] waiting for completion...')
    await waitForTransferStatus(page1, '已完成', 30000)
    await waitForTransferStatus(page2, '已完成', 15000)
```

```tsx
✓ {t.direction === 'send'
  ? getTransferDeliveryState(t.id) === 'saved' ? '已保存' : '已送达'
  : t.storageMode === 'fsa' ? '已保存到所选位置' : '接收完成'}
```

- 影响: 当前 UI 不再渲染通用“已完成”；脚本的单文件、多文件、广播三阶段都等待该旧文案，因此真实传输成功也会依次超时。`npm --prefix client run test:manual` 已不能作为人工验收入口。
- 建议: 与 E2E 一样按角色精确等待：发送端 `已保存`（或显式验证 v1 为 `已送达`），接收端按后端等待 `接收完成`/`已保存到所选位置`；同时校验捕获文件的字节摘要，而不是只看状态文案。

### [P2] `ui-contract.test.mjs` 用源码正则冒充行为测试

- 位置: `client/tests/ui-contract.test.mjs:79`
- 证据:

```js
// authedFetch core contract: retry once with a fresh token after 401, then
// throw AuthRequiredError (not just resolve a 401 response).
assert.match(api, /export class AuthRequiredError/)
assert.match(api, /export async function authedFetch/)
assert.match(api, /res\.status !== 401/)
assert.match(api, /throw new AuthRequiredError\(\)/)
assert.match(api, /sessionStorage\.removeItem\('misaka\.session'\)/)
```

- 影响: 这些正则只证明若干字符串同处一个文件，既不证明控制流顺序，也会扫描注释和不可达代码。把 retry 删除但留下相同辅助代码/注释可以继续通过；等价的函数提取或格式化却会无行为变化地失败。`authedFetch.test.ts`、`signaling-auth-recovery.test.ts`、transfer 系列已存在真实行为覆盖，这部分契约脚本重复且更弱。
- 建议: 删除 `ui-contract.test.mjs` 中 API、signaling、network store、crypto、transfer 的源码正则断言；保留的 UI 契约改成渲染组件后触发点击/异步失败并断言可观察结果。静态结构要求应由类型、lint 或明确的构建检查承担，不应伪装成行为回归测试。

### [P2] 覆盖率配置没有阈值，CI 也从不运行 coverage

- 位置: `client/vitest.config.ts:17`；`client/package.json:14`；`.github/workflows/test.yml:66`
- 证据:

```ts
coverage: {
  provider: 'v8',
  reporter: ['text', 'html'],
  include: ['src/lib/**/*.ts', 'src/store/**/*.ts'],
  exclude: ['src/lib/sound.ts', 'src/lib/notify.ts'],
},
```

```json
"test": "npm run test:unit && npm run test:contract",
"test:unit": "vitest run",
"test:contract": "node tests/ui-contract.test.mjs",
```

- 影响: 没有 `thresholds`，常规脚本也没有 `--coverage`。删除整组高风险 store/transfer 测试，只要剩余测试通过，CI 不会因覆盖骤降而失败；页面、组件和 server 侧更完全没有覆盖门禁。
- 建议: CI 单独运行 `vitest run --coverage`，为 `client/src/lib/transfer.ts`、`client/src/store/network.ts`、`api.ts`、`signaling.ts` 设置按文件的 lines/branches/functions 阈值，并设置全局最低值；server 用 c8/nyc 包裹现有脚本并对 auth/ws/TURN 核心模块设 patch coverage。阈值以当前基线起步，只允许提高。

### [P2] E2E 完成断言混淆发送端与接收端语义

- 位置: `client/tests/e2e/transfer.spec.ts:132`
- 证据:

```ts
async function expectTransferComplete(page: Page, atLeast = 1) {
  // The product deliberately distinguishes sender durability ("已保存") from
  // receiver availability ("接收完成"); the old generic "已完成" wording was
  // removed because it could not say what had actually happened.
  await expect.poll(
    async () => await page.getByText(/已保存|接收完成/).count(),
    { timeout: 60_000, intervals: [500, 1_000, 2_000] },
  ).toBeGreaterThanOrEqual(atLeast)
}
```

- 影响: 注释声称保护角色语义，断言却允许任一页面出现任一文案。发送端错误显示“接收完成”或接收端错误显示“已保存”时，所有传输 E2E 仍通过；它也没有证明 sender 的 `saved` 出现在 receiver artifact 可读之后。
- 建议: 拆成 `expectSenderSaved(transferId)` 与 `expectReceiverComplete(transferId, backend)`，定位到对应 transfer card 并使用方向/transferId test id；在捕获 artifact 并校验 hash 后再断言 sender 为 `saved`，同时增加 ACK 到达前必须保持 `已送达` 的受控用例。

### [P2] 本地 E2E 可静默复用任意占用 5174 的旧前端

- 位置: `client/playwright.config.ts:61`
- 证据:

```ts
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
```

- 影响: 非 CI 时 Playwright 只凭端口可用性复用服务。直接运行 `playwright test transfer.spec.ts` 时，如果 5174 是旧 checkout 或其他 Vite 应用，测试会针对错误 bundle 运行；除 `auth-recovery.spec.ts` 外的用例没有校验前端 nonce，因此会产生无法解释的假失败，甚至可能验证旧实现。
- 建议: 默认关闭前端 `reuseExistingServer`；若必须复用，在全局 setup 或每个 spec 的公共 `beforeEach` 请求前端专用 nonce endpoint，并调用 `activeE2eBuildNonce()` 验证与配置完全一致。该校验应覆盖定向执行单个 spec 的情况。

### [P2] 服务端集成测试端口分配会与并行运行或外部进程碰撞

- 位置: `server/tests/ws-auth.test.mjs:28`；`server/tests/turn-http.test.mjs:12`
- 证据:

```js
const PORT = 18993
const BASE = `http://localhost:${PORT}/api`
const WS_URL = `ws://localhost:${PORT}/ws`
```

```js
const port = 19080 + Math.floor(Math.random() * 1000)
const env = {
  ...process.env,
  PORT: String(port),
```

- 影响: 大多数脚本固定端口，少数脚本在小范围内无保留地随机选择；同时运行两个定向测试、另一个 checkout 或本机服务占用端口时，目标 child 会 `EADDRINUSE`。`_harness.mjs` 的 nonce 能防止误连旧服务，但不能防碰撞，因此正确代码会稳定地报测试失败；随机端口还使失败不可复现。
- 建议: 统一由 harness 分配端口：让 child 监听 `0` 并通过 IPC/stdout 返回实际端口，随后构造 BASE/WS URL；需要多 server 的测试一次性申请多个已绑定端口。不要以随机数代替端口保留。

### [P2] 性能回归测试用绝对墙钟阈值阻断常规 CI

- 位置: `server/tests/activity-broadcast-scale.test.mjs:141`；同根因见 `server/tests/scrypt-nonblocking.test.mjs:113`
- 证据:

```js
  const startedAt = Date.now()
  activity.broadcast({ type: 'transfer', nodeId: 7, message: 'scale' })
  const elapsed = Date.now() - startedAt

  assertEq(sockets[0].sent.length, 1, '第一个 socket 应收到事件')
  assertEq(sockets[SCALE - 1].sent.length, 1, '最后一个 socket 也应收到事件')
  assert(
    elapsed < SCALE_BUDGET_MS,
    `${SCALE} 个 socket 的一次广播耗时 ${elapsed}ms（上限 ${SCALE_BUDGET_MS}ms）—— 说明仍是每个 socket 再扫一遍 session 的 O(n²)`,
  )
```

- 影响: 正确的 O(n) 实现在 CPU 被抢占、虚拟机降频或 GC 恰好发生时也可能超过 300 ms，使普通 PR 随 runner 负载红灯；反过来，较小数据上的较快 O(n²) 实现也可能偶尔低于阈值。`scrypt-nonblocking` 同样以 5 ms timer tick 和最大 RTT 判定实现性质。
- 建议: 常规 CI 用可观测操作次数/索引查找次数证明 O(n)，并验证事件循环确实让出至少一次；绝对耗时放到独立 benchmark job，预热后多轮取中位数/分位数，与保存的基线比较且不因单次抖动失败。deadline 功能测试可用 fake timers，性能预算不要共用功能测试门禁。

### [P2] “tests touched” 守卫可被任意无关测试改动满足

- 位置: `scripts/guard-tests-touched.mjs:44`；调用位置 `.github/workflows/test.yml:157`
- 证据:

```js
const files = changedFiles()
const srcTouched = files.some(f =>
  f.startsWith('client/src/') || f.startsWith('server/src/'),
)
const testsTouched = files.some(f =>
  f.startsWith('client/tests/') || f.startsWith('server/tests/'),
)
```

```js
if (testsTouched) {
  console.log('[guard] src/ touched AND tests/ touched — ok.')
  process.exit(0)
}
```

- 影响: 修改 `client/src/lib/transfer.ts`，同时只给任意法律文案测试加注释，守卫即通过；它没有证明相关测试存在、新断言会在旧实现上失败，和注释中“forces every behavioral change through the test suite”的承诺不一致。
- 建议: 保留目录守卫作为最低提示，但增加 diff/patch coverage 门禁；对核心模块要求对应测试文件或显式审查标签，并让 CI 报告改动行是否被执行。`[skip-test-guard]` 应使用受保护 label/审批，而不是任意 PR 标题字符串。

### [P3] bitmap fuzz 使用不可复现的未播种随机数

- 位置: `client/tests/unit/chunk-bitmap.test.ts:91`
- 证据:

```ts
  it('fuzz: random index sets round-trip identically', () => {
    const TOTAL = 200
    for (let trial = 0; trial < 50; trial++) {
      const want = new Set<number>()
      const count = Math.floor(Math.random() * TOTAL)
      for (let k = 0; k < count; k++) {
        want.add(Math.floor(Math.random() * TOTAL))
      }
      const b = bitmapFromIndexes(want, TOTAL)
      const got = new Set(bitmapToIndexes(b, TOTAL))
      expect(got.size).toBe(want.size)
      for (const i of want) expect(got.has(i)).toBe(true)
```

- 影响: 只在某个 byte 边界或稀疏组合触发的缺陷可能在一次 CI 中命中、下一次完全消失；失败日志没有 seed，维护者无法重放输入。随机生成也不能保证覆盖 7/8、31/32、末位 padding 等关键边界。
- 建议: 使用固定 seed 的 PRNG，并在断言消息输出 seed/trial/输入；再增加确定性的 byte-boundary 表格。若要真正 property-based testing，使用支持 shrinking 和 seed replay 的库。

### [P3] protocol 版本测试重复了已有的完整 frame 布局测试

- 位置: `client/tests/unit/transfer-protocol-version.test.ts:152`；重复目标 `client/tests/unit/transfer-frame.test.ts:59`
- 证据:

```ts
describe('the binary chunk frame is UNCHANGED across v1 and v2', () => {
  it('keeps tag 0x01 and the [tag:1][shortId:4][index:4][iv:12][ciphertext] layout', () => {
    expect(CHUNK_FRAME_TAG).toBe(0x01)
    const iv = new Uint8Array(12).fill(7)
    const cipher = new Uint8Array([1, 2, 3, 4]).buffer
    const frame = encodeChunkFrame(0xdeadbeef, 0x01020304, iv, cipher)
    const view = new DataView(frame)
    expect(view.getUint8(0)).toBe(0x01)
    expect(view.getUint32(1, false)).toBe(0xdeadbeef)
    expect(view.getUint32(5, false)).toBe(0x01020304)
    expect(frame.byteLength).toBe(21 + 4)
```

- 影响: `transfer-frame.test.ts` 已更完整地验证固定字节布局、round-trip、空/真实 payload、短帧和错误 tag；这里再次调用同一 encoder/decoder，并没有分别经过 v1/v2 路径，因此新增覆盖为零，却增加协议改动时的同步维护点。
- 建议: 删除该重复 `describe`。在版本测试中改为验证 v1 和 v2 的 JSON control plane 差异；二进制 frame 的稳定契约只保留在 `transfer-frame.test.ts`。

## 附录: 已核查但结论为无问题的区域

- 已读取并遵循 `CLAUDE.md` 与 `AGENTS.md`；本审计未运行测试、构建、安装或 Git 命令。
- 检查了 `client/tests/unit/**`、全部 4 个 E2E spec、`ui-contract.test.mjs`、`manual-test.mjs`、全部 `server/tests/*.test.mjs`、`_harness.mjs`、三个 workflow、根/client/server scripts、Vitest 与 Playwright 配置。
- 未发现 `it.skip`、`test.skip`、`describe.skip`、`.only`、`test.todo` 或被注释掉的测试声明。
- 所有 `server/tests/*.test.mjs` 都由 `server/package.json` 的常规、TURN 或 stress 脚本引用，并均调用 `runTest`；需要启动 child 的脚本使用 harness `spawn`，常规服务清理由 `killChild`/注册 child 终结器覆盖。
- 未发现由 `node` 直接运行并导入 `.ts` 的服务端测试脚本；服务端测试先构建并从 `dist/*.js` 导入。
- `_transfer-fixtures.ts`、E2E `helpers.ts` 和 `pngjs.d.ts` 均有实际导入/类型检查入口，不是死 fixture。
- 已核查 `authedFetch` 双 401、WS 4001/4002 恢复、frame tag/layout、IV prefix+BE index、TURN enabled gating、meta geometry validation、持久化顺序、三后端 finalize 等关键契约；除报告中明确列出的零字节、所有权负向覆盖与真实暂停 E2E 缺口外，现有相关单测具有可失败的行为断言。
