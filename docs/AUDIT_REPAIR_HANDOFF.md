# 审计修复交接状态（CODE_AUDIT_2026-07-27）

> 本文件记录 `docs/CODE_AUDIT_2026-07-27.md` 中 107 个问题的修复进度、编排规则与未完成事项。
> 上一轮会话在 wave 2 进行中因会话额度中断，此文件用于无损接续。

## 当前进度总览

| 批次 | 状态 | 覆盖 |
|---|---|---|
| Wave 1 | **已完成、已提交（5 个 commit）、全量测试绿** | 47 项 |
| Wave 2 服务端（W2-B） | **已完成、已提交、server 测试绿** | 8 项 |
| Wave 2 客户端（W2-A） | **中断，工作区未提交** | ~16 项 |
| Wave 3 | 未开始 | ~25 项 |
| Wave 4 | 未开始 | UX-COPY-001 + 收尾 |

**尚未 push。** 用户要求「分批 commit，最后 push」——push 必须等 codex 复核通过后再执行。

## 已提交的 Wave 1（HEAD 往前 5 个 commit）

```
e549dbf Server session expiry + trust-proxy IP + async scrypt; client epoch store
8060498 Server: WebSocket resource bounds, O(1) activity index, hardened abuse limits
9b8ebcb Client signaling: session epochs, single peer connection per peer, TURN master switch
ed9c04d Client UI: dialog primitive, scanner allow-list, camera lifecycle, a11y and layout
bed968f Deploy/CI: fix proxy trust, one deployment base, prod secrets and PR build gate
```

Wave 1 已修复：SECURITY-001~006、012、013、014、016、018、019；BUG-001、002、004~010、026、028~031；
UX-LAYOUT-001、003~009；UX-MOTION-001、002；A11Y-001~008；UX-COPY-003、007；
CONFIG-001~009（除 006 外由 W1-D，006 由 W1-C）；QUALITY-004、005、006；TEST-001、007、008、014(WS 半)。

提交时的基线：`npm test` 全绿——server 31 个脚本、client 55 文件 / 409 测试。

## Wave 2

### W2-B 服务端 TURN/持久化 —— **已完成、已提交、server 测试绿（38 脚本 exit 0）**

commit `bba4f16`，覆盖 SECURITY-008、009、010、017；BUG-022、023、024、025。

**⚠️ 这个 commit 改了 HTTP 契约，客户端尚未跟进——这是接续时的第一优先事项：**

1. `GET /api/turn-status`（公开）现在只返回粗粒度
   `{enabled, configured, provider, credentialTtlSec, available, reason?, detailed:false}`。
   详细字段（`killSwitchActive`、`monthlyBytes*`、`activeCredentials`、`lastCfSyncError` 等）
   只在带 `Authorization: Bearer $TURN_OPERATOR_TOKEN` 时返回，Bearer 不匹配返回 401。
   - `client/src/lib/turn.ts` 的 `TurnStatusResponse` 类型需要更新；
   - `client/src/store/network.ts` 里 `status.enabled && status.configured && !status.killSwitchActive`
     现在读到 `undefined`，应改用新的 `available` 字段；
   - `client/src/components/features/SettingsModal.tsx` 渲染详细计数，现在会显示 `undefined`，
     需要改成 operator-only 或删除该卡片；
   - `README.md` 里 `curl /api/turn-status | jq` 的示例已过时。
2. 新增 `GET /api/ready`（`/api/health` 保持不变，仍是容器存活探针）。
3. `GET /api/turn-credentials` 新增拒绝原因：`STATE_UNAVAILABLE` → 503，`IP_BANNED`/`SESSION_BANNED` → 403。

**新增环境变量（需要补进 `server/.env.example`，该文件不在 W2-B 的所有权范围内）：**
`TURN_CF_TIMEOUT_MS`(8000)、`TURN_ANALYTICS_PAGE_LIMIT`(1000)、`TURN_ANALYTICS_MAX_PAGES`(20)、
`TURN_IP_BAN_STRIKES`(3)、`TURN_OPERATOR_TOKEN`(空)；另外 `TURN_BAN_DURATION_SEC` 此前是死配置，现在真正生效。

已知既有 flake：`tests/trust-proxy.test.mjs` 偶发固定端口/`npx tsx` 启动超时，改动前的基线也会偶发，单跑通过。

### W2-A 客户端传输完整性 —— **中断时仍在运行，产出可能不完整，未提交**

覆盖目标：SECURITY-007、015；BUG-011~021、027；QUALITY-001、002；TEST-006、009。
涉及 `client/src/lib/{transfer,db,chunk-bitmap,cryptoPool,crypto}.ts`、`client/src/store/network.ts`、
`client/src/pages/Network.tsx`（仅接线）、`client/tests/unit/**`。
要求：BUG-013~017 必须**成组**发布并引入协议版本协商（审计 P0 第 9 条）。

**接续第一步：** `git status` + `npm --prefix client test`，判断工作区里的客户端改动是完整可用、
需要补完、还是应当丢弃重做。服务端与 wave 1 都已提交，因此 `git diff HEAD` 的内容**就是** W2-A 的全部增量。
中断时已观察到的 W2-A 产出：`client/tests/unit/_transfer-fixtures.ts`、
`cryptopool-worker-replacement.test.ts` 等新文件，以及对 `transfer.ts`/`db.ts`/`cryptoPool.ts`/
`store/network.ts` 和约 10 个既有 transfer 测试的修改。

## codex 复核结果

### deploy/CI 域（已完成）

结论：CONFIG-001/003/004/008/009、QUALITY-004/006 **VERIFIED**；
CONFIG-002、005、QUALITY-005 **INCOMPLETE**。另报 8 个新问题，**均未修复**：

1. **HIGH** — 生产升级会重置耐久状态：旧容器用 Dockerfile 匿名 `/app/data` 卷，新 Compose 用具名卷覆盖挂载，
   TURN 计数/活动凭据/revoke 队列/滥用锁全部归零；且 Compose 会把卷名前缀成 `deploy_misaka_data`，
   README 里 `docker run -v misaka_data:/data` 的备份命令指向另一个卷，会产出「看起来成功的空备份」。
   修复：给卷显式 `name:`、更正备份命令、补一次性迁移步骤。
2. **MEDIUM** — 文档里的 Cloudflare/CDN 拓扑会摧毁真实客户端 IP：`{http.request.remote.host}` 是 CDN 边缘地址，
   Caddy 已删除转发链，`TRUST_PROXY=2` 也救不回来。需要单独的 CDN 拓扑文档（只信任 CDN 公布的 CIDR）。
3. **MEDIUM** — `TURN_AUTO_ENABLED=true` 但三个 Cloudflare 凭据为空时仍可「健康」启动，自动 TURN 必然不可用。
   应在启用自动 TURN 且凭据缺失时启动失败。
4. **MEDIUM** — `APP_BASE`/`VITE_APP_BASE` 重新引入了第二个部署 base：只移动 router/公共资源/SW 而不动静态资源与 404；
   且 `APP_BASE="/"` 归一化为空串后被 `configuredBase() || buildBase()` 回退掉，无法显式覆盖为根。
5. **MEDIUM** — 新开的 Caddy 访问日志持久化客户端 IP，却没有大小/时间上限与保留说明。
6. **MEDIUM** — 新的构建 job 会运行但**不构成合并门禁**（分支保护按 job 名指定必需检查）。
7. **LOW** — `deploy/verify-proxy-trust.sh` 的 `--fresh` 把任何非 429（含 401/404/500）当成功；且只测 `/api/health`，不测 `/ws`。
8. **LOW** — `docs/PROGRESS.md` 仍宣传未实际执行的封禁时长策略。

完整原文在会话 scratchpad 的 `review-deploy.md`（临时目录，可能已随会话清理；上面的摘要是权威副本）。

### client UI/a11y 域（已完成）

结论：SECURITY-006、BUG-030、031、CONFIG-006、UX-LAYOUT-001/003/005/006/007/008/009、
UX-MOTION-002、A11Y-003/004/005/006/007、UX-COPY-007 **VERIFIED**。
其中 SECURITY-006 复核者专门尝试了协议相对 URL、反斜杠、内嵌凭据、大小写/默认端口、
尾点、IDN、编码键值、点段、活动 scheme、fragment 和重定向参数，**未找到绕过**。

**INCOMPLETE / 新问题（1 个已修，其余未修）：**

1. ~~**HIGH** — 切换摄像头后扫描器永久失效~~ **已修复并提交（`6e652f1`）**：
   `ScanModal` 把控制器放在 ref 里跨整个生命周期，而按 `facingMode` 重跑的 effect
   在 cleanup 里调用了永久性的 `dispose()`，切换后每次 acquire 都返回 `stale`；
   StrictMode 的挂载重放也会以同样方式破坏首次挂载。改为每次 effect 运行创建独立控制器、
   只 dispose 被取代的那个。新增组件级测试 `scan-modal-camera-switch.test.tsx`
   （在修复前失败、修复后通过）。
2. **MEDIUM** — `MisakaDialog` 清理时无条件移除 body 子元素的 `inert`/`aria-hidden`，
   会破坏本来就处于隐藏状态的子树。应记录原值并按引用计数还原。
3. **MEDIUM** — 堆叠对话框的 Escape：每个消费者各自在 `window` 上注册监听，
   `stopPropagation()` 不能抑制同目标的其他监听器，一次 Escape 会关闭所有层；
   而 `IpFullPrompt` 没有 `useModalExit`，**根本无法用 Escape 关闭**。
   应由 primitive 自己处理 Escape，只让 `dialogStack` 栈顶响应。
4. **MEDIUM** — TURN 状态的「重试」按钮不会真的重试：只把状态置为 `idle`，
   轮询 effect 只依赖 `tab`，要等下一个 10 秒周期。
5. **MEDIUM** — BUG-026 未完成：5 秒超时从 `createOffer()`/`setLocalDescription()`
   **resolve 之后**才开始计时，这两个 Promise 可以永远 pending；NAT 检测也没有外层 deadline。
6. **MEDIUM** — BUG-028 未完成：「重试」只清空 error boundary 状态，
   模块级 `lazy()` 对象仍持有已 reject 的 import promise，会立刻再次抛出。
7. **MEDIUM** — BUG-029 未完成：`UpdateBanner` 在 3 秒超时后**无条件 reload**，
   不确认新 worker 是否接管；点击守卫用的是上一次渲染的 `busy` 值，可能滞后。
8. **MEDIUM** — BUG-008 UI 半未完成：任何非空手工 TURN 字符串都算「可用」，
   填 `foo` 这种无效值也能开启强制中继，仍可造成「relay-only 但无可用 relay」。
9. **MEDIUM** — UX-MOTION-001 / A11Y-008 未完成：`ActivityStream` 仍每 45 秒注入内容并自动滚动，
   没有暂停控件、也没有 coarse-pointer 静态化（ACGN 那条独立的 lore log 才加了暂停）。
10. **MEDIUM** — A11Y-002 未完成：`ACGN.tsx` 仍把原始 `--accent-cyan` 用作白底 12px 文字
    （约 2.25:1）。对比度测试只校验声明的配对，不校验实际用法。
11. **MEDIUM** — UX-LAYOUT-004 未完成：导航改到 `md` 断点后，768–800px
    （审计区间的上半段）仍是原来的密集布局，也没有加该断点的回归测试。
12. **LOW** — `TopNav` 的 PWA 安装提示永不消失（3 秒后的相等性判断比的是上一轮渲染的 `null`）。
13. **LOW** — 测试对两个最高风险集成给出虚假信心（摄像头、UpdateBanner 都只测了注册表/控制器本身）。
    第 1 条已按此建议补了组件级测试，UpdateBanner 仍缺。

### server core、client net core 域

**故意未跑**——wave 2 当时正在改同一批文件。应在 W2-A 落地后，
对「wave1+wave2 最终状态」各跑一次合并复核。

## 编排规则（沿用，勿破坏）

1. **文件所有权互斥**：并行子代理绝不共享可写文件。冲突的领域改为串行 wave。
2. **测试作用域隔离**：server 集成测试绑定固定端口，同一时间只允许一个代理跑 `npm --prefix server test`；
   客户端代理只跑 `npm --prefix client test`。禁止并行跑根 `npm test`。
3. **子代理不得执行** `git commit/add/push/stash/checkout`——由总指挥统一提交。
4. **codex 调用必须重定向 stdin**：
   ```bash
   codex exec -m gpt-5.6-sol -c model_reasoning_effort="high" -s read-only --ephemeral \
     -o <输出文件> "<prompt>" < /dev/null
   ```
   缺少 `< /dev/null` 时，后台运行的 codex 会一直阻塞在 “Reading additional input from stdin...”，
   表现为「跑了很久、CPU 几乎为 0」，最终被杀（exit 144），且不产生任何复核结果。
   也不要把 stdout 管道给 `tail`，否则看不到中间进度。
5. **提交批次切分**：并行代理仍在改工作区时，`git commit <pathspec>` 会带上它们的半成品。
   安全做法是先 `git add -A`（排除 `.agents/`、`AGENTS.md`）做快照，再只对「工作区与索引一致」的路径
   用 pathspec 分批提交，最后用不带 pathspec 的 `git commit` 收尾索引剩余部分。

## 剩余工作

### Wave 3（wave 2 落地后）
- **W3-A 跨栈 QR/邀请**：SECURITY-011、BUG-003、UX-COPY-002。
  涉及 `server/src/http.ts` + `client` 的 QRModal/Join/auth/IpFullPrompt。
  注意 UX-COPY-002 需要服务端返回真实 released 数量。
- **W3-B `pages/Network.tsx` UI 收尾**：UX-COPY-004、005、006；BUG-019 的 UI 面；QUALITY-003；A11Y-007 剩余部分。
  必须采纳 wave 1 留下的接口：`registerActiveWorkProbe`（否则 BUG-029 是空操作）、
  `.pt-nav`/`var(--nav-h-total)`、`scrollIntoViewSafely`、`.tap-target`、`*-on-light`/`*-on-blue` 色板、
  `MisakaStatusBadge` 的 `surface` 属性；TopNav 的「已接入/未接入」应改用 `deriveNetworkStatus` + `networkStatusLabel`。
- **W3-C 测试基础设施**：TEST-002、003、004、005、010、011、012、013、015、016。
  （TEST-001、006、007、008、009、014-WS 已在前两个 wave 处理。）

### Wave 4
- **UX-COPY-001**（High，隐私/条款/About 与真实行为矛盾）——必须**最后**做，
  因为最终文案取决于 SECURITY-001、BUG-001、BUG-008、CONFIG-002 的落地结果和实际 STUN/TURN 供应商与保留策略。
  审计明确要求：在到期执行真正生效前，**不得**直接发布「过期后清除」的文案。
- 修复上面 deploy 复核的 8 个新问题。
- 补完 CONFIG-008：把 `client/tests/**/*.ts` 纳入类型检查（需要改 `client/tsconfig.json` 的 `include`，
  或新增 `tsconfig.tests.json` + `typecheck:tests` 脚本并接进 CI）。

### 未决的小尾巴
- `server/.env.example` 已补齐 wave 1 新增变量；wave 2 若新增变量需要同步。
- W2-B 若改动了 `index.ts`/`http.ts`，需与 server core 的复核结论合并核对。

## 完成标准（审计原文要求）

每个 bug 先写可失败的复现测试；改动 `client/src/` 或 `server/src/` 后跑 `npm test`；
新功能同时覆盖 happy path 与至少一个 edge case；认证与传输的 P0 必须有真实协议、生命周期和
**字节级**产物断言，不得以 source regex 或状态文案代替。
