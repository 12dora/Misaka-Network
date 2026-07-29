# 御坂网络 2026-07-29 全面审计 · 总指挥合并报告

> 本次审计由 9 名**互不共享上下文**的独立审查员（codex / gpt-5.6-sol，high reasoning）并行完成，
> 每人负责一个互斥领域，被强制要求"只读代码 + 每条发现必须带 `file:line` 与代码证据 + 禁止猜测"。
> 本文件是合并、去重与交叉验证后的结论，**不替代**分报告——分报告含完整证据链与逐条修复方案。

## 分报告索引

| 报告 | 领域 | P0 | P1 | P2 | P3 | 合计 |
|---|---|---:|---:|---:|---:|---:|
| [01](01-transfer-engine.md) | 传输引擎 `transfer.ts` / crypto / db | **2** | 13 | 4 | 0 | 19 |
| [02](02-network-store.md) | 网络 Store / signaling / webrtc | **4** | 17 | 8 | 0 | 29 |
| [03](03-client-support-libs.md) | 客户端支撑库 turn/nat/api/hooks | 0 | 6 | 8 | 3 | 17 |
| [04](04-server.md) | 服务端 + 部署配置 | 0 | 10 | 9 | 3 | 22 |
| [05](05-test-rot.md) | 测试腐坏 + CI | **1** | 6 | 8 | 2 | 17 |
| [06](06-dead-code-and-junk.md) | 死代码与开发残留 | 0 | 0 | 10 | 13 | 23 |
| [07](07-i18n-and-copy.md) | zh-CN i18n 与用户文案 | 0 | 1 | 7 | 1 | 9 |
| [08](08-ui-ux-and-motion.md) | UI/UX、布局与动效 | **1** | 6 | 11 | 5 | 23 |
| [09](09-fullstack-contracts.md) | 前后端契约与会话生命周期 | 0 | 5 | 10 | 1 | 16 |
| | **合计** | **8** | **64** | **75** | **28** | **175** |

---

## 一、四条跨领域根因（本报告最重要的部分）

审查员之间没有共享上下文。当多人从不同角度独立指向同一个机制缺陷时，基本排除了单点误判——
**这四条根因直接解释了 26 条发现，连同第二节的次级交叉命中共约 37 条（占全部 175 条的五分之一强），
是修复投入产出比最高的地方——修根因比逐条修症状便宜得多。**

### 根因 A · 每个 `await` 之后都没有重新校验代际

**独立命中 8 次，跨 6 份报告。这是全库最普遍的缺陷模式。**

代码里到处是"进入函数时检查一次身份/代际，然后连续 await，提交结果时不再检查"。
任何一个慢响应都能在状态已经变化之后写回过期结果：

| 报告 | 位置 | 迟到的结果会造成什么 |
|---|---|---|
| 02 P0 | `network.ts:3260/3598/3637` | 入站传输的 continuation 越过 epoch teardown，把**旧身份的文件、聊天、通知注入新会话**，并生成下载 URL |
| 02 P1 | `auth.ts:67/136/246` | 用户已明确注销，迟到的 `/register` 响应把他重新登录；改了 nodeId 后 UI 是 B、服务端 session 实际是 A |
| 09 P1 | `auth.ts:246/312` | 同上，从契约侧独立确认 |
| 01 P1 | `transfer.ts:1353` | 用户在 FSA picker 期间取消，picker 仍成功并留下**无主的 writable 句柄** |
| 03 P1 | `nat.ts:49/112` | Wi-Fi 上的慢探测覆盖蜂窝网络的新结果 → 在新网络上错误强制 relay 或错误拒绝 relay |
| 03 P1 | `turn.ts:202/266` | 注销后迟到的凭证请求**复活 TURN 状态并重启刷新定时器** |
| 02 P2 | `home.ts:67` | 旧统计覆盖新统计，还写入更晚的 `statsLastUpdated`，把旧数据标成最新 |
| 04 P1 | `turn.ts:451/1090` | 重叠的全局轮询用旧用量**回退 kill-switch**，重新开放已熔断的签发 |

**统一修复方向**：为每个有生命周期的域（auth、network epoch、NAT 探测、TURN 刷新、传输 attempt）引入
单调 generation + `AbortController`，规定"每个 await 之后、每个副作用之前必须 compare-and-swap"。
这是一条能一次性消灭 8 个缺陷的架构约束，值得作为编码规范写进 CLAUDE.md。

### 根因 B · 终止清理既不集中也不幂等

**独立命中 8 次，跨 4 份报告。**

系统里有多条并存的清理路径，它们互相假设对方会做某件事，结果是**都不做**，或者**做反了**：

- **02 P0**：`cancelTransfer()` 先设 `cancelled=true`，同一同步栈立刻 `forgetTransfer()` 删掉 signal。
  仍在 `File.slice()`/加密/backpressure await 中的 lane 下次读不到 cancel 标志，**继续加密并发送剩余内容**。
  UI 卡片已消失，但用户要求取消的数据仍在离开设备。
- **09 P1 + 04 P2**：`POST /api/release` 先把 `session.socket = null`，导致 WS `close` 回调的
  `session.socket !== ws` 守卫**跳过**正常离场路径；而 handler 自己又不 `nodes.delete()`、不移出 channel、
  不广播 `PEER_LEFT`。两条清理路径互相抵消，最终什么都没清理。
- **02 P1**：零字节接收手写终态，绕过 `finalizeReceive()` —— 不关 backend、不改 DB row、不做 OPFS 精确清理。
  违反 CLAUDE.md "`finalizeReceive()` 是三后端唯一 terminal API"的硬契约。
- **02 P1**：chunk 解密/写入失败后只删 demux 映射，ReceiveSession、DB row、partial chunks、writable、owner 全部存活，
  发送端也没收到 cancel，会继续发完整个文件再等 ACK 超时。
- **01 P1**：`finalizeReceive()` 不 drain `inflightSaves`，慢写可能在 `deleteChunks()` **之后**执行，重新制造孤儿 chunk。
- **01 P1**：终止清理对 IDB 失败用空 catch，随后仍删除内存 session → DB row 停在 `active`，
  下次启动列为可续传，但 chunks 已删 → **bitmap 声称完整、磁盘却无数据的幽灵续传**。
- **02 P2**：`blockPeer` 直接删聊天但不 retire download artifact，object URL / OPFS closure 永久无人触达。

**统一修复方向**：每个域恰好一个幂等的 terminal API（客户端传输已有 `finalizeReceive()`，需要补
`abortInboundTransfer()`；服务端需要 `terminateSession()`），所有入口共用，禁止手写终态。

### 根因 C · protocol v2 控制消息只校验所有权，不校验 attempt 与字段

**独立命中 6 次，01 与 02 从引擎侧和 dispatcher 侧分别确认。**

`assertTransferOwner()` 只回答"这个 peer 有权操作这个 transfer 吗"，但不回答
"这是**当前那一次尝试**吗"和"这个字段**说得通**吗"：

- **02 P0**：`shortId` 映射可被同一 peer 的第二个 `meta` 覆盖。两个几何相同的传输复用同一 32 位 `shortId` 时，
  A 的后续帧被路由到 B；因为共享同一 peer AES key、帧自带 IV，**AES-GCM 仍然验证通过**，
  B 以 A 的内容成功落盘并通过大小校验 → **静默的文件内容错配**。
- **01 P1 + 02 P1**：`transfer-ready` 的 `shortId` 声明了要用来区分 superseded attempt，
  但 dispatcher 只传 `transferId`，waiter 也只按 `transferId` 建键 → 第一次尝试的迟到 ready 能解锁第二次尝试。
- **01 P1 + 02 P1**：`transfer-done.bytes` 从头到尾没有被交给 ACK handler。发 `{bytes: 0}` 即可
  把一个非空文件提升为 `saved`，store 随后删除唯一的重试源。
- **01 P1**：未知 `transferId` 被 `assertTransferOwner()` 判为**通过**（`if (!rec) return true`），
  于是任意 peer 连发不同 ID 的 `transfer-pause` 就能在 `transferSignals` 里无限建条目。
- **02 P0**：legacy resume 在 `record.peerSessionId` 缺失时回退到 `peerNodeId` 匹配，
  **直接违反"owner 永远不是 peerNodeId"的硬契约** —— 同一身份的另一台设备会收到本机的 transferId 与进度 bitmap。

**统一修复方向**：把 attempt token `(transferId, shortId, peerSessionId, epoch)` 作为所有 v2 控制消息的一等公民，
并对每个消息的每个字段做语义校验（`bytes === file.size`、`shortId === 当前 active shortId`）。
未知 transfer 必须返回 false 而不是 true。

### 根因 D · 巨型文件已经在兑现具体缺陷，不再是风格问题

**四份报告独立强调，且都拒绝把它当作抽象技术债。**

- **04**：`http.ts` 764 行混合路由/认证状态机/会话生命周期 → **已经导致**根因 B 里的 release teardown 漂移。
- **04**：`turn.ts` 1117 行混合供应商客户端/策略/持久化/定时器 → **已经导致**注释声称"已持久化"但实际只 `markDirty()`。
- **01**：`transfer.ts` 2396 行、`runSendEngine()` 单函数 341 行 → **已经导致** ready flag 残留、
  finalize 不 drain、后端准备取消竞态三个终止不变量缺口。
- **02**：`network.ts` 4057 行承担 **11 个责任域**，通过 Zustand singleton + 模块级 Map + 互相回调形成
  至少 6 组隐藏循环依赖 → **已经导致**本报告中 stale epoch、artifact 漏清、状态混淆难以局部修复。

02 和 01 各给出了可直接执行的模块清单（02 给了 12 个模块 + 6 个注入 port，01 给了 7 个模块）。
**建议顺序：先补 characterization tests 锁住 CLAUDE.md 的硬契约，再逐模块迁移，绝不在拆分中顺带改协议语义。**

---

## 二、其余高置信度交叉命中

### 零字节传输 —— 三份报告从三个角度命中同一处
- **01 P1**（发送端）：v2 零字节不等 ACK 就返回 `{state:'saved'}`，违反硬契约
- **02 P1**（接收端）：零字节绕过 `finalizeReceive()`，留下 active row 与未关闭的 backend 句柄
- **05 P0**（测试）：`transfer-zero-byte.test.ts:57` 把错误行为**固化为期望值**，且该用例根本没注册 peer 版本

三方独立确认意味着这不是"漏了一个分支"，而是**契约、实现、测试三者已经分叉**。修复必须三处同时改。

### TURN `enabled` 三态缺失 —— 02 与 03 从两侧命中
- **02 P1**：`isRelayAllowed()` 在没有存储记录时返回 true，**直接违反 `turnSettings.enabled` 总闸门硬契约**
- **03 P1**：`SettingsModal` 挂载时的 effect 无条件 `saveTurnSettings()`，用户没碰开关，
  运行态就从"允许自动 TURN"变成"禁止全部 TURN"

同一个根因：两态存储无法表示"未设置"。对称 NAT 用户会因此**失去唯一可用的 relay 路径**。

### 会话是绝对 30 分钟，UI 与文档却写"30 分钟无活动" —— 07 与 09 独立命中
09 补出了功能后果：第 29 分钟开始的大文件传输，即使双方持续收发数据，WS 仍会在固定 deadline 被 4002 关闭；
客户端按硬契约换 token/sessionId，而 v2 传输 owner 是 `(peerSessionId, epoch)` → **在途传输被整个拆除**。

### TURN 关闭时仍消耗服务端配额 —— 03 与 09 独立命中
`buildIceConfig()` 确实不会把凭证加入 PeerConnection（硬契约没破），但服务端已记一次签发、
占用每 IP 每小时额度、建立 pessimistic-byte reservation。**用户在"TURN 已关闭"状态下烧你的 Cloudflare 熔断预算。**

### `/api/turn-status` 轮询无限重叠 —— 03 与 09 独立命中
10 秒 interval 不检查 in-flight 也不 abort。设置弹窗开 10 分钟即累积约 60 个 pending 请求。

---

## 三、必须立刻修的（P0 / 会破坏数据或可远程触发）

按"能造成的最坏后果"排序，不按报告顺序：

1. **取消 FSA 接收会覆盖用户原有文件** — `transfer.ts:2279`（01 P0）
   用 `close()` 而非 `abort()`。用户选了一个**已存在的文件**作为保存目标、传到 10% 时取消 →
   原文件被截断为半个传输内容且不可恢复。**这是本次审计中唯一会破坏用户既有数据的缺陷。**
2. **`shortId` 冲突导致文件内容静默错配** — `network.ts:3263/3574`（02 P0）
   见根因 C。AES-GCM 仍验证通过、大小校验也通过，**用户拿到的是一份内容完全错误但看起来正常的文件**。
3. **AES-GCM 未认证 transfer/shortId/index** — `crypto.worker.ts:55`（01 P1，但后果是静默污染）
   把某个满长度 chunk 的 `{iv, ciphertext}` 放到另一个满长度 index，GCM tag 仍通过，
   接收端按**未认证的** frame header 写入错误偏移。整文件 hash 已停用 → 静默错序污染并通过 size gate。
   修复需引入 AAD，属加密语义变更，必须通过协议版本协商推进。
4. **不可信 range 会被无界展开** — `transfer.ts:565`、`chunk-bitmap.ts:138`（01 P0）
   对端发 `missingRanges: [[0, 4294967295]]` 即可让页面 OOM 或主线程锁死。
   **可远程触发的拒绝服务**，且 `transfer-repair` 与 `resume.receivedRanges` 两条路径都吃不可信 JSON。
5. **取消后引擎继续发送** — `network.ts:1851/3451`（02 P0）
   见根因 B。用户点了取消、卡片消失了，数据仍在离开设备。
6. **入站传输 continuation 跨 epoch 复活旧身份数据** — `network.ts:3260/3598/3637`（02 P0）
   见根因 A。构成**跨身份数据暴露**。
7. **legacy resume 按 `peerNodeId` 归属** — `network.ts:3981`（02 P0）
   同一身份的另一台设备会收到本机的 transferId 与进度 bitmap，违反硬契约。
8. **活跃传输可被一次误触取消** — `Network.tsx:686`（08 P0）
   "暂停"与"取消"同层级并排，无二次确认、无撤销期。已收 90% 的大文件误触即丢。

---

## 四、服务端 P1 集群：金钱与安全约束的持久化边界不可靠

04 的 10 条 P1 有一个统一主题——**deny、锁、账本、kill-switch 都可能因崩溃或重启而丢失**：

- 认证锁快照加载失败后仍 **fail-open**，10 秒后的 flusher 还会用空 Map **覆盖原快照**（毁掉排障证据）
- 安全状态跃迁只 `markDirty()`，却在落盘前就执行 Cloudflare revoke / 返回 423
- 关机强制刷盘失败被 `Promise.allSettled` 吞掉，仍打印"已安全关闭"并 `exit(0)`
- 优雅关机在刷盘**完成后**才停止接收请求 → 新签发的 credential 不进快照
- TURN session deny 绑定重启即变的 `sessionId` → 重启后同一身份立即可重新领取凭证
- 每 IP 小时字节账本完全不持久化 → 重启即清零，绕过 10 GiB/hour/IP 上限
- `TRUST_PROXY=true` 允许客户端伪造所有 per-IP 身份（绕过限流、`MAX_NODES_PER_IP`、暴破锁、TURN 配额）
- 未认证 WS 连接没有全局或每 IP 上限
- JSON body parser 在 API 限流**之前** → 畸形/超限 body 可无限绕过 IP 预算

另外 04 指出 `/register` 的**错误通行码路径从不执行 scrypt** —— 唯一的 scrypt 调用在 HMAC 已通过之后，
所以在线猜测成本只有一次快速 HMAC，与 `passcode-scrypt.test.mjs` 的描述不符。

---

## 五、测试可信度问题（05）

比"缺测试"更危险的是"测试在假绿"：

- `transfer-zero-byte.test.ts` **把违反硬契约的行为锁定为期望值**
- `ws-reconnect-supersede.test.mjs:86` 用 `.catch(() => null)` **吞掉**"旧 socket 未关闭"的超时 → 即使服务端保留两个同时有效的认证 socket，测试仍通过
- 多个安全阈值测试只检查"若干次内最终被限流"，**把阈值错误改成 1 也能通过**
- `stress-1gb.test.mjs` **完全没有 import 任何产品传输代码**，自定义 64 KiB chunk（生产是 252 KiB），
  却被月度工作流当作真实字节完整性与内存预算门禁
- `ui-contract.test.mjs` 用**源码正则**冒充行为测试——删掉 retry 但保留注释即可通过
- `deploy.yml` 与 `test.yml` 独立触发，**"可编译但测试失败"的 main 提交会被部署到生产 Pages**
- 覆盖率没有任何阈值，CI 也从不跑 `--coverage`
- "tests touched" 守卫可被任意无关测试的一个注释满足

02 还补了一条：现有 auth recovery mock **不校验请求体**，所以掩盖了"刷新后重注册固定使用空通行码"这个 P1
（`auth.ts:153` 有意丢弃 passCode，重注册必然 400，4001/4002 恢复链路在常见路径上是断的）。

---

## 六、需要你决策的四个问题

1. **会话 TTL**：改文案承认"接入后固定 30 分钟"（低成本、诚实），还是实现到期前的无缝续期（高成本、体验好）？
   09 指出后者会触及 `session-expiry`、`signaling-auth-recovery`、`network-epoch` 及 v2 传输生命周期测试。
2. **刷新后如何重新认证**：02 指出当前"丢弃 passCode + 自动重注册"必然失败。
   要么服务端签发可撤销的 opaque re-registration proof，要么产品上改成要求用户重新输入并明确修改 CLAUDE.md 契约。
   **不能保持现状**——现状是一条永远返回 400 的恢复路径。
3. **`file` / `channel` 类型二维码**：09 查证服务端始终存 `type:'node'`，`cid` 无人读取，
   `fid` 写进 `sessionStorage` 后也没有消费者——功能从未端到端实现，但 UI 和文档都宣称已交付。
   删掉入口与文档，还是补完服务端签名绑定？
4. **`stress-1gb.test.mjs`**：删除，还是改名为 Node AES-GCM micro-benchmark 并另建真实的浏览器端压力测试？

---

## 七、低风险清理（06，可以随时做）

06 未发现任何已提交的构建产物或 P0/P1 级死代码，仓库卫生总体良好。可安全删除的有：
`useCardIn.ts`（零导入的完整孤立模块）、transfer 的 4 个零消费者导出、
`ReadyMessage`/`RejectMessage`/`DoneMessage`/`DCProtocolMessage` 类型岛、
network store 的 2 个零消费者 wrapper、服务端 4 个零消费者 helper + `WSClientMessage`、
`http.ts` 的 legacy re-export、6 组无引用 CSS、`favicon.svg`、根 `package-lock.json`、
3 个测试 job 的 `fetch-depth: 0`。

两个值得注意的**非删除类**发现：
- `.gitignore` 的非锚定 `data/` 会连 `client/src/data/` 一起忽略 →
  新增源码数据文件会本地可运行、提交后 CI 构建失败。改为 `/data/`。
- E2E 直接 import `pngjs`、配置类型检查直接要求 `@types/node`，但**两者都未声明**，
  只因当前传递依赖树碰巧可用。上游一变即 `ERR_MODULE_NOT_FOUND`。

---

## 八、审计方法与范围说明

- 每位审查员被明确禁止修改除自己报告外的任何文件，禁止运行 `npm test`、构建、安装或任何 git 命令。
  所有结论来自静态阅读、调用链追踪与现有测试源码的交叉核查。
- 各报告末尾的"附录：已核查但结论为无问题的区域"记录了覆盖面，包括审查员**主动排除**的怀疑项——
  例如 03 确认 `useCameraStream` 无轨道泄漏、04 确认 activity 广播无 O(n²)、
  06 确认协议 v1 协商与 passcode sha256→scrypt 升级路径**不是**死代码、
  02 确认 `SIGNAL_*` 的 per-peer 串行与 receipt 丢弃逻辑正确、
  05 确认全部 44 个服务端测试脚本都正确使用了 `runTest` 生命周期。
- 本合并报告未做二次代码验证；分报告的证据链是第一手依据。
- 未发现任何审查员违反只读约束：`git status` 显示改动仅限 `docs/audit-2026-07-29/`。
