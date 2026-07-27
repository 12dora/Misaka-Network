# Misaka Network 综合审计报告（已验证）

审计日期：2026-07-27  
审计修订：`9d14b688719d0c3c59551f7c2a183de371af9976`  
仓库文件改动：无

## 执行摘要

本报告汇总本次审计形成的四份领域二次验证结果与一份关键候选校准结果，不重新扩展漏洞搜索。最终保留 **107 个去重且可独立修复的问题：0 个 Critical、31 个 High、59 个 Medium、17 个 Low**。

风险集中在会话生命周期、WebSocket 资源边界、代理/IP 归因、TURN 配额与持久状态、QR/摄像头信任边界、WebRTC 协商、文件传输一致性、模态框与无障碍基础，以及测试“假绿”和生产部署模板。所有原始 Critical 候选均经复核下调为 High 或更低；本报告没有 Critical 问题。

当前单元、集成和构建基线总体为绿色，但不能据此认定可发布：部分测试把丢块行为写成预期，只检查状态文字，不执行生产接收编排，或通过提前返回跳过核心断言。建议按下文依赖顺序完成 P0，并让真实协议与字节级产物测试成为同一修复的一部分。

## 范围、方法与限制

- **审计范围：** 前后端逻辑、认证与会话、WebSocket/WebRTC、TURN、文件传输与存储、用户文案与状态、动效、响应式布局、无障碍、测试质量、构建部署、配置和仓库卫生。
- **方法：** 复用二次验证已经完成的源码与测试复核、定向只读复现、既有运行时观察、依赖审计及 Compose 检查；按不同根因、修复边界、负责人、发布顺序和回归测试拆分或合并；关键候选逐项校准严重度。
- **证据锚点：** 测试结果和行号均以审计修订及审计时工作树为准。报告只引用该仓库中存在的相对路径。
- **非目标：** 未检查验证输入未覆盖的代码以寻找新问题；未修改源码、测试、依赖、配置或本地生成物。
- **运行限制：** 本轮未重新完成全量 Playwright E2E、真实跨设备 WebRTC、真实 TURN 供应商或生产代理拓扑复现。二次 UI 验证的 Chrome 配置被 EasyAuth 重定向，因此没有新增超出既有运行记录的观察。
- **设备限制：** 未获得物理 iOS standalone safe-area 验证；640–800 px 平板导航、窄卡片 ACGN 行和 320 px QR 几何为静态高置信证据，未声称已有对应设备截图。
- **规模限制：** 高基数 TURN analytics、O(n²) activity 和部分并发窗口由源码与定向实验支持，未进行生产规模压测。

## 经限定的测试与基线

- `npm --prefix client test`：通过，40 个文件、191 个测试。
- `npm --prefix server test`：通过，包括构建、19 个集成脚本和 6 个 TURN 脚本。
- `npm --prefix client run build`：通过。
- 5 个定向客户端单测文件共 20 个测试通过；其中 receiver-pause 测试明确把破坏性丢块作为预期，TURN-disabled 测试没有注入自动 TURN 凭据。
- `client/tests/unit/transfer-cancel-send-loop.test.ts` 单独连续 10/10 通过；此前整套运行曾在固定延时断言上失败，因此结论是间歇性测试缺陷，不是确定性红基线。
- server 范围的依赖审计确认直接依赖 `ws@8.20.1` 命中高严重度内存耗尽公告，修复版本为 8.21.0。
- `docker compose config` 在干净检出下确定失败，因为 Compose 强制要求一个检出中不存在的根目录环境文件。
- 本轮未完成新的全量 Playwright E2E；绿色单元/集成结果不覆盖下文列明的真实浏览器、代理、供应商和跨设备限制。

## 严重度与置信度定义

### 严重度

- **Critical：** 可直接造成系统级失陷、广泛不可逆数据损失，或无需重要前置条件的大规模攻击。本次为 0。
- **High：** 可造成会话/隐私边界失效、远程资源耗尽、文件损坏或假成功、主要流程不可用，或广泛阻断无障碍使用；作为发布阻断项。
- **Medium：** 需要特定时序、环境或规模，或主要影响恢复、可用性、部署正确性和测试可信度；应计划修复。
- **Low：** 配置依赖、有限诊断/文案问题、长期维护或存储债，或未证明造成主要任务失败的问题。

### 置信度

- **很高：** 源码控制流或运行时结果直接证明，且证据链完整。
- **高：** 源码结构和定向检查强力支持，但频率、特定平台或生产规模未直接测量。
- **中高：** 静态几何或条件组合明确支持，仍缺目标断点/设备运行捕获。

## 数量统计

| 分类 | Critical | High | Medium | Low | 合计 |
|---|---:|---:|---:|---:|---:|
| BUG | 0 | 12 | 17 | 2 | 31 |
| SECURITY | 0 | 14 | 1 | 4 | 19 |
| UX-COPY | 0 | 1 | 4 | 2 | 7 |
| UX-LAYOUT | 0 | 1 | 8 | 0 | 9 |
| UX-MOTION | 0 | 0 | 1 | 1 | 2 |
| A11Y | 0 | 2 | 6 | 0 | 8 |
| TEST | 0 | 0 | 14 | 2 | 16 |
| QUALITY | 0 | 0 | 1 | 5 | 6 |
| CONFIG | 0 | 1 | 7 | 1 | 9 |
| **总计** | **0** | **31** | **59** | **17** | **107** |

## 五个用户目标映射

| 用户目标 | 主要覆盖 | 数量 | 结论 |
|---|---|---:|---|
| 1. 查找潜在前后端缺陷 | `SECURITY-*`、`BUG-*` | 50 | 26 个 High 覆盖会话、WS/代理/TURN、WebRTC、传输完整性、存储和恢复。 |
| 2. 查找过度技术化、难懂或泄漏内部状态的文案 | `UX-COPY-*` | 7 | 1 个 High 披露矛盾、4 个 Medium 状态/恢复问题、2 个 Low 结果或风险说明问题。 |
| 3. 查找缺失或有害动效 | `UX-MOTION-*` | 2 | 保留 reduced-motion/可操作性缺陷和 QR 覆盖动效；未证实缺少装饰动画会破坏任务。 |
| 4. 查找不合理、难用、破损或错位布局 | `UX-LAYOUT-*`、`A11Y-*` | 17 | 3 个 High 涉及被 transform 破坏的模态框、dialog/focus 基础和广泛对比度。 |
| 5. 查找代码异味、测试衰退、无效/死代码和开发垃圾 | `TEST-*`、`QUALITY-*`、`CONFIG-*` | 31 | 1 个 High 生产代理模板缺陷、22 个 Medium 测试/配置/保留缺口、8 个 Low 维护问题。 |

## P0 / P1 / P2 依赖路线图

优先级表示交付顺序，不改变严重度：P0 对应本报告全部 High 发布阻断项；P1 对应 Medium；P2 对应 Low。

### P0：发布阻断项

1. **统一会话 epoch 与拆除：** `SECURITY-001` → `BUG-001` → `BUG-002`。先定义唯一到期/身份代际，再让退出、服务端恢复和 4001/4002 走同一幂等清理。
2. **收紧互联网 WebSocket 边界：** `SECURITY-004` → `SECURITY-002` → `SECURITY-003`。先升级 transport，再做缓冲前大小限制、入站频率和慢读者背压；以 `TEST-014` 做边界回归。
3. **统一可信代理/IP 语义：** `SECURITY-005` 与 `CONFIG-001` 同批完成，之后才能信任所有按 IP 的注册、锁、节点和 TURN 限制。
4. **关闭持久状态与 TURN fail-open：** `SECURITY-009` 先于 `SECURITY-008`、`SECURITY-010`；`CONFIG-002` 是持久部署前提。实现耐久本地状态机、供应商超时、可重试 `revokePending`，不要求跨外部供应商的单次数据库原子事务。
5. **消除事件循环放大：** `SECURITY-013` 与 `SECURITY-014` 并行；使用有界异步 scrypt、O(1) 认证索引及有限生产人口预算。
6. **修复 QR/摄像头信任边界：** `SECURITY-006`、`SECURITY-012` 可独立实施；`SECURITY-011` 与 Medium 的 `BUG-003` 共同设计创建、兑换、注册提交和恢复事务。
7. **稳定 WebRTC 策略与协商：** `BUG-008` 先建立 TURN 主开关不变量；再以 `BUG-002` 的 epoch 为基础实现 `BUG-004` readiness 和 `BUG-005` 每 peer 单一创建任务。
8. **先建立传输协议输入边界：** `SECURITY-007` → `BUG-011` → `BUG-012`。只有元数据合法且接收后端已提交，才允许 payload 进入。
9. **以协议版本成组修复交付语义：** `BUG-013`、`BUG-014`、`BUG-015`、`BUG-016`、`BUG-017` 一起发布或做版本协商；同步把 `TEST-005`、`TEST-006`、`TEST-009` 升级为字节级门禁。
10. **修复 UI 基础：** `UX-LAYOUT-001` 与 `A11Y-001` 共用 body portal dialog；`A11Y-002` 独立完成语义色前景/背景配对和自动化检查。
11. **发布真实披露：** `UX-COPY-001` 先做临时纠正；最终文本依赖 `SECURITY-001`、`BUG-001`、`BUG-008`、`CONFIG-002` 以及实际 STUN/TURN 供应商和保留策略。

### P1：计划修复

1. **恢复与异步生命周期：** `BUG-003`、`BUG-006`、`BUG-007`、`BUG-009`、`BUG-019` 至 `BUG-031`，先建立 epoch/取消/结构化结果，再改界面。
2. **传输收尾与保留：** `BUG-018`、`SECURITY-015`、`QUALITY-001` 共享 `(peerSessionId, transferId, epoch)` 所有权和单一终态清理 API。
3. **部署和配置：** `CONFIG-002` 至 `CONFIG-008` 先统一启动/环境/base/runtime-config 契约，再补 PR 构建和干净部署 smoke test。
4. **用户状态、布局与无障碍：** `UX-COPY-002` 至 `UX-COPY-006`、`UX-LAYOUT-002` 至 `UX-LAYOUT-009`、`UX-MOTION-001`、`A11Y-003` 至 `A11Y-008`。
5. **测试可信度：** `TEST-001` 至 `TEST-014`。优先修进程隔离、错误提前返回、真实接收编排、4001/4002、字节产物和 pause/resume。

### P2：维护与收口

处理 `SECURITY-016` 至 `SECURITY-019`、`BUG-010`、`BUG-025`、`UX-COPY-005`、`UX-COPY-007`、`UX-MOTION-002`、`TEST-015`、`TEST-016`、`QUALITY-002` 至 `QUALITY-006`、`CONFIG-009`。这些项仍需进入有负责人的 backlog，不应因低严重度静默删除。

## 详细问题

## SECURITY

### SECURITY-001 — 宣称的会话/令牌到期未存储或执行（High）

- **置信度与证据依据：** 很高；`server/src/config.ts:37-39`、`server/src/http.ts:207-246`、`server/src/types.ts:3-19`、`server/src/store.ts:74-78`、`server/src/cleanup.ts:15-31`、`server/src/ws.ts:116-146`。短 TTL 定向复现中，过期后受保护 QR 请求仍返回 200。
- **触发与影响：** 会话保持连接或 bearer 被复用；HTTP、WS、QR、TURN 和 release 权限可延续至进程生命周期，违背 API 和隐私承诺。
- **修复方向：** 在 `NodeSession` 保存唯一绝对 `expiresAt`，由公共 token resolver、HTTP/WS AUTH 和在线清理统一执行，并关闭/删除过期会话。
- **来源 ID：** MBS-001、FT-003、TEST-013、CV-02。

### SECURITY-002 — 64 KiB WebSocket 限制发生在 transport 完整缓冲之后（High）

- **置信度与证据依据：** 很高；`server/src/index.ts:56-70` 未设置 `maxPayload`，`server/src/ws.ts:91-99` 在完整 message 到达并转字符串后才测量。
- **触发与影响：** 未认证客户端发送超大首条消息；应用拒绝前已经产生大量内存/CPU 分配，可终止 signaling 进程。
- **修复方向：** 在 `WebSocketServer` 设置 transport `maxPayload`，并测试超大首帧和分片消息。
- **来源 ID：** MBS-002、DEPLOY-001、CV-03。

### SECURITY-003 — 信令缺少每 socket 入站频率与慢读者出站背压边界（High）

- **置信度与证据依据：** 高；`server/src/ws.ts:21-35,45-60,185-285` 对格式合法消息无 rate bucket，转发不检查目标 `bufferedAmount`。
- **触发与影响：** 已注册节点高频发送 SDP/ICE，或持续向慢读目标转发；即使修复 payload 大小，CPU、内存和发送队列仍可无界增长。
- **修复方向：** 设置每 socket/identity 和消息类型预算、`bufferedAmount` 高水位、丢弃/断开策略及边界测试。
- **来源 ID：** CV-04。

### SECURITY-004 — 锁定的 `ws@8.20.1` 命中内存耗尽公告（High）

- **置信度与证据依据：** 很高；`server/package.json:20`、`server/package-lock.json:1396-1401`，server 范围依赖审计确认 GHSA-96hv-2xvq-fx4p，受影响版本低于 8.21.0。
- **触发与影响：** 互联网入口接收恶意碎片/data-chunk 流量；风险独立于应用层 `maxPayload` 后置检查。
- **修复方向：** 升级并锁定 `ws >= 8.21.0`，重跑 server/E2E，并把直接生产依赖审计加入 CI。
- **来源 ID：** MBS-002、DEPLOY-001、CV-05。

### SECURITY-005 — WS IP 解析未实现 Express trust-proxy 语义（High）

- **置信度与证据依据：** 很高；`server/src/config.ts:18-25`、`server/src/ws.ts:63-75,128-134`、`server/src/http.ts:386-400`。定向检查中，WS 接受了伪造的左侧 XFF。
- **触发与影响：** 代理追加客户端提供的 XFF，WS 选择最左地址并覆盖 session IP；可污染节点上限、限流、TURN 签发和字节归因。
- **修复方向：** HTTP 与 upgrade 共用 `proxy-addr`/Express trust 函数，从可信侧回溯；边缘必须移除不可信转发头。
- **来源 ID：** MBS-003、CV-06。

### SECURITY-006 — “Misaka QR” scanner 接受任意来源和主动 URL scheme（High）

- **置信度与证据依据：** 高；`client/src/components/features/ScanModal.tsx:211-251` 将任何 `new URL()` 成功值交给 `window.location.href`。
- **触发与影响：** 扫描或粘贴外站 HTTPS、`javascript:`、`data:` 等；外站/钓鱼导航确定存在，脚本执行依赖浏览器与 CSP。
- **修复方向：** 仅允许 `http:`/`https:`、配置的本站 origin/base、精确 join 路由和严格参数；拒绝 credentials、外站及其他 scheme。
- **替换文案：** “仅扫描御坂网络接入码”；“请扫描或粘贴本站生成的接入链接。”
- **来源 ID：** MBS-005、FT-006、UIUX-002、CV-19。

### SECURITY-007 — 入站传输元数据和索引缺少运行时校验（High）

- **置信度与证据依据：** 很高；`client/src/store/network.ts:1449-1508`、`client/src/lib/transfer.ts:475-518,562-635,1048-1069,1144-1161`、`client/src/lib/chunk-bitmap.ts:23-34`。
- **触发与影响：** 已连接恶意 peer 发送小文件加巨大 `totalChunks`，或越界 uint32 index；可分配数百 MB bitmap、填满 IDB 或制造巨大稀疏写。
- **修复方向：** 状态变更前验证 safe integer、ID/name/MIME 边界、总大小、精确 chunk 数、index、明文长度和 owner/collision。
- **来源 ID：** MBS-006、FT-017、CV-29。

### SECURITY-008 — 同一 session 重签 TURN 凭据覆盖活跃配额记录（High）

- **置信度与证据依据：** 高；`server/src/turn.ts:107-152,396-410`。6 个并发请求在 25-byte 小时上限下全部成功，本地只保留一个 10-byte active entry。
- **触发与影响：** 同 session 并发或重复签发；多个供应商 grant 只占一个 accounting key，失败回滚还可删除成功记录。
- **修复方向：** 每 session 单一在途任务/缓存当前凭据，或每次签发使用唯一 reservation ID；回滚只作用于同一实例。
- **来源 ID：** MBS-008、CV-08。

### SECURITY-009 — 服务监听早于持久安全与 TURN 状态加载（High）

- **置信度与证据依据：** 很高；`server/src/index.ts:76-96` 未等待加载即 `listen`，`server/src/persist.ts:81-123` 随后替换 TURN 状态对象。
- **触发与影响：** 冷启动或慢盘后立即猜码/申请 TURN；持久 lock、freeze 和 kill switch 可在窗口内失效，新 reservation 也可能被覆盖。
- **修复方向：** bind 前等待并校验状态；TURN 状态无法加载时签发 fail closed，并把健康与就绪端点分开。
- **来源 ID：** MBS-009、CV-07。

### SECURITY-010 — TURN 撤销丢失用量、ban 未执行且 kill-switch 失败不重试（High）

- **置信度与证据依据：** 很高；`server/src/turn.ts:280-305,379-390,413-434,540-555`、`server/src/config.ts:90-91`。
- **触发与影响：** 超限撤销成功后立即重签，或全局 kill 时供应商撤销失败；触发用量不再计入小时上限，配置的 ban 无效，失败记录不进入重试。
- **修复方向：** 实现耐久的 revoke/account/deny 状态机：先折算用量，成功删除，失败标记 `revokePending`，并持久执行 IP/session deny。
- **来源 ID：** MBS-010、CV-09。

### SECURITY-011 — QR 创建把可复用 passcode 放进 GET URL，恢复会话会生成坏邀请（High）

- **置信度与证据依据：** 很高；`client/src/components/features/QRModal.tsx:48-56`、`client/src/pages/Network.tsx:923-929`、`client/src/store/auth.ts:130-165`、`server/src/http.ts:446-483,523-542`。
- **触发与影响：** 新会话创建 QR 时六位凭据进入 URL 日志面；刷新恢复后的空 passcode 又会生成必然无法兑换的 token。
- **修复方向：** 改为 bearer-authenticated POST，绑定服务端现有 identity hash；创建请求不发送明文，响应设置 `Cache-Control: no-store`。
- **来源 ID：** MBS-012、FT-004、CV-17。

### SECURITY-012 — Camera Retry 可在 modal 关闭后遗留采集（High）

- **置信度与证据依据：** 很高；`client/src/components/features/ScanModal.tsx:70-80,96-130,199-209,320-322`。Retry 没有生命周期取消谓词。
- **触发与影响：** Retry 后在 `getUserMedia()` 等待期间关闭；晚到 stream 无清理 owner，摄像头指示和采集可继续。
- **修复方向：** 每次 acquisition 使用 mounted/request generation；过期 generation resolve 后立即停止 tracks，并禁止重叠请求。
- **来源 ID：** MBS-014、FT-007、UIUX-004、CV-20。

### SECURITY-013 — 同步 scrypt 阻塞 signaling event loop（High）

- **置信度与证据依据：** 高；`server/src/store.ts:129-132,181-193`、`server/src/http.ts:207-210`、`server/src/config.ts:27-29`。本机 10 次创建约阻塞 481 ms。
- **触发与影响：** 多来源成功注册；每次 `scryptSync` 阻塞全部 WS、timer、cleanup 和 TURN accounting。
- **修复方向：** 使用异步 `crypto.scrypt` 或有界 worker pool，并设置全局注册并发/速率及有限生产人口上限。
- **来源 ID：** MBS-015、CV-12。

### SECURITY-014 — Activity 广播为 O(n²)，且默认人口无上限（High）

- **置信度与证据依据：** 高；`server/src/activity.ts:16-20,30-42` 对每个 WS 再扫描 session，`server/src/config.ts:28` 默认为无限。
- **触发与影响：** 大规模节点下广播 activity；一次广播可产生数千万次比较并拖垮 signaling。
- **修复方向：** 维护 socket→认证/session 的 O(1) 索引，使广播为 O(n)，并限制生产人口与广播频率。
- **来源 ID：** CV-13。

### SECURITY-015 — 传输 resume/control/meta 所有权范围过弱（Medium）

- **置信度与证据依据：** 很高；`client/src/lib/db.ts:3-35`、`client/src/store/network.ts:1616-1649,1848-1857`、`client/src/lib/transfer.ts:490-492`。
- **触发与影响：** 同一 identity cluster 的第三个设备连接，获知或猜中另一个 peer 的 transfer ID；可观察 resume bitmap 或发送 pause/cancel。
- **修复方向：** 以 `(peerSessionId, transferId, epoch)` 持久和校验所有权，拒绝 owner 或不可变元数据不匹配。
- **来源 ID：** FT-024。

### SECURITY-016 — 生产路由中的 E2E 开关可误配为未认证 IP 级释放（Low）

- **置信度与证据依据：** 高；`server/src/http.ts:249-270,333-351`。
- **触发与影响：** 生产进程误设 `E2E_ALLOW_UNAUTH_RELEASE_BY_IP=1`；调用者可删除其表观 IP 下全部 session，共享 NAT/代理折叠时范围更大。
- **修复方向：** 从生产路由移除；或同时限定 test build、`NODE_ENV === 'test'` 与隔离 listener。
- **来源 ID：** MBS-023。

### SECURITY-017 — 公共 TURN 状态暴露供应商错误和详细配额状态（Low）

- **置信度与证据依据：** 高；`server/src/http.ts:414-417`、`server/src/turn.ts:190-214,561-596`。
- **触发与影响：** 未认证查询正常或失败状态；外部可获得成本/阈值/kill-switch 侦察和原始供应商诊断。
- **修复方向：** 公共接口只返回粗粒度可用性；详细计数和错误置于 operator 认证后，并映射稳定错误码。
- **来源 ID：** MBS-024。

### SECURITY-018 — 任意注册用户可伪造或溢出公共传输统计（Low）

- **置信度与证据依据：** 高；`server/src/http.ts:428-443` 接受任意非负 JavaScript integer，缺少 safe/现实上限、幂等和频率限制。
- **触发与影响：** 重复提交巨大 `bytes`；公共指标可被伪造并推至 `Infinity`。
- **修复方向：** 优先使用服务端可观察生命周期；否则要求 `Number.isSafeInteger`、现实大小上限、去重和 rate limit。
- **来源 ID：** MBS-025。

### SECURITY-019 — 六位 passcode 使用 `Math.random`（Low）

- **置信度与证据依据：** 高；`client/src/store/auth.ts:126-128,216-220`。
- **触发与影响：** 用户重新生成凭据；约 20 bit 的小空间还受非密码学 PRNG 可预测性影响。
- **修复方向：** 使用 `crypto.getRandomValues()` 对 `0..999999` 做无偏拒绝采样。
- **来源 ID：** MBS-026。

## BUG

### BUG-001 — 显式 Disconnect 未结束网络 epoch（High）

- **置信度与证据依据：** 很高；`client/src/store/auth.ts:289-300`、`client/src/store/network.ts:557-590`、`client/src/lib/signaling.ts:97-109,144-154`、`server/src/http.ts:355-369`、`server/src/ws.ts:150-175`。
- **触发与影响：** 初始化 network 后点击 Disconnect；旧 token 可重连，PC/DC 继续存活，peer 不一定收到 `PEER_LEFT`，UI 与真实连接状态分离。
- **修复方向：** 一个幂等 logout 协调停止重连、清 token、销毁 PC/DC/crypto/transfer，再删除服务端 session/channel 并通知 peer。
- **来源 ID：** MBS-004、FT-001、CV-01。

### BUG-002 — 客户端网络状态未绑定认证 session epoch（High）

- **置信度与证据依据：** 很高；`client/src/pages/Network.tsx:891-895`、`client/src/store/network.ts:397-416,557-590`。
- **触发与影响：** join 切换身份或 4001/4002 后重新注册；新 session ID 与旧 peer、PC、DC、ICE、密钥和传输共存，可能错路由或跨身份泄漏状态。
- **修复方向：** token 或 `WELCOME.sessionId` 改变即创建新 epoch，并在连接前清理全部 session-scoped 状态。
- **来源 ID：** FT-002、CV-25。

### BUG-003 — QR redemption 在注册提交前消费一次性邀请（Medium）

- **置信度与证据依据：** 很高；`client/src/pages/Join.tsx:64-155`、`server/src/http.ts:508-547`。
- **触发与影响：** token 兑换成功后注册因 IP 上限、容量或网络失败；重试复用已烧毁 token，恢复确定失败。
- **修复方向：** 将兑换与 admission 做原子/幂等事务，或兑换为短时 completion grant，仅在注册提交时最终消费。
- **来源 ID：** MBS-013、FT-005、UIUX-003（其中 IP 上限文案/恢复的独立部分保留在 `UX-COPY-002`）、CV-18。

### BUG-004 — 恢复流程在 signaling 认证/加入完成前创建并丢弃 offer（High）

- **置信度与证据依据：** 高；`client/src/store/network.ts:286-318,534-550,1056-1069`、`client/src/lib/signaling.ts:90-95,181-185`。
- **触发与影响：** 慢网前台恢复时 PC/offer 先于 WELCOME/JOIN；`send` 静默丢弃，残留 PC 又阻止后续发起。
- **修复方向：** 暴露 authenticated-and-joined readiness barrier，排队 SDP/ICE，并在重连后按 generation 重协商孤儿 PC。
- **来源 ID：** FT-008、CV-23。

### BUG-005 — 并发发起可创建并泄漏两个 peer connection（High）

- **置信度与证据依据：** 很高；`client/src/store/network.ts:315,430-442,839-885,1031-1040,1694` 在首个 await 前未占位。
- **触发与影响：** TURN 等待期间 recovery、manual reconnect 或 send 同时发起；两个 PC 覆盖 map、竞争 offer，其中一个脱离清理。
- **修复方向：** 首个 await 前同步注册 per-peer generation/promise；所有入口共享，失败 generation 自行 close。
- **来源 ID：** FT-009、CV-24。

### BUG-006 — 异步 signaling handler 既不捕获 rejection，也不串行（Medium）

- **置信度与证据依据：** 很高；`client/src/lib/signaling.ts:5,115-122`、`client/src/store/network.ts:410,494-503,1088-1225`。
- **触发与影响：** 快速重叠 offer/answer/restart 或 malformed SDP；同 peer 操作可交错，Promise rejection 逃逸为未处理异常。
- **修复方向：** handler 类型允许 `Promise<void>`，统一 catch，并按 peer/generation 串行 negotiation。
- **来源 ID：** FT-010、CV-27。

### BUG-007 — 延迟 ICE restart 在 peer 清理后仍可作用于替代连接（Medium）

- **置信度与证据依据：** 高；`client/src/store/network.ts:1656-1695,1860-1865`。
- **触发与影响：** ICE 失败后等待 1–16 秒，期间 peer 离开、被 block 或 PC 被替换；旧任务可重建离线 peer、重启新 PC 或清除新锁。
- **修复方向：** 使用 AbortController 或单调 generation，并在每个 await 后核对 peer、signaling readiness 和精确 PC identity。
- **来源 ID：** FT-011、CV-26。

### BUG-008 — TURN 主开关被绕过，且可形成无 TURN 的 relay-only 配置（High）

- **置信度与证据依据：** 很高；`client/src/lib/webrtc.ts:108-138`、`client/src/components/features/SettingsModal.tsx:394-428`、`client/tests/unit/turn-config-propagation.test.ts:43-85`。
- **触发与影响：** 已缓存自动 TURN 后关闭开关，或 TURN 不可用时强制 relay；可能违背隐私选择继续中继，或保证连接失败。
- **修复方向：** `turnSettings.enabled` 同时控制自动/手工 TURN；无可用 TURN 时禁用并清除 force-relay，测试缓存凭据场景。
- **来源 ID：** MBS-007、FT-012、CV-22。

### BUG-009 — 在线 TURN/策略变化不迁移已选择 ICE path（Medium）

- **置信度与证据依据：** 高；`client/src/lib/webrtc.ts:145-173`、`client/src/store/network.ts:160-179` 只调用 `setConfiguration()`。
- **触发与影响：** 开关 relay、增删 TURN 或轮换凭据；当前 candidate pair 继续使用，界面设置与实际路由不一致。
- **修复方向：** 合并配置变化，在 signaling stable 且 generation 安全时触发 ICE restart。
- **来源 ID：** FT-013。

### BUG-010 — Relay 诊断只检查本地 candidate（Low）

- **置信度与证据依据：** 很高；`client/src/lib/webrtc.ts:56-66,84-99`。
- **触发与影响：** host/srflx 本地 candidate 与 remote relay 配对；中继路径被显示为 direct/STUN，误导用户、成本和支持诊断。
- **修复方向：** 以 pair 分类：任一侧 relay 即 relay，其次任一侧 srflx 即 STUN，否则 host-host 为 direct。
- **来源 ID：** FT-014。

### BUG-011 — 多 lane metadata 与接收存储选择竞态可交付空/残缺文件（High）

- **置信度与证据依据：** 很高；`client/src/lib/transfer.ts:238-250,490-518,610-616`、`client/src/store/network.ts:1363,1461-1560,1749-1780`。
- **触发与影响：** 正常多 lane 接收中 chunk 早于异步存储准备；数据进入 IDB，完成时却优先暴露空/部分 OPFS。
- **修复方向：** 按 `(peerSessionId, transferId)` 单一在途准备并提交后端；此前缓冲 chunk，receiver-ready ACK 后才发送 payload。
- **来源 ID：** FT-015、CV-30。

### BUG-012 — 大文件 OOM guard 检查 API 存在而非已提交可写后端（High）

- **置信度与证据依据：** 很高；`client/src/lib/transfer.ts:475-487,1208-1271`、`client/src/store/network.ts:1465-1524`。
- **触发与影响：** FSA 存在但无 user activation、OPFS 不可写，随后回退 IDB；超大文件仍进入整文件 Blob/内存路径并可使 tab OOM。
- **修复方向：** 先选择并证明后端可写，再按实际结果执行 cap；落到 IDB 时拒绝超限文件。
- **来源 ID：** FT-016、CV-31。

### BUG-013 — Receiver pause 丢弃可靠的在途 chunk 且没有修复握手（High）

- **置信度与证据依据：** 很高；`client/src/lib/transfer.ts:361-383,573-582`、`client/src/store/network.ts:767-784`、`client/tests/unit/transfer-receiver-pause.test.ts:86-117`。
- **触发与影响：** SCTP 已缓冲 chunk 时暂停再恢复；receiver 丢块、sender 认为已发，传输永久低于 100%。
- **修复方向：** 暂停新发送但继续认证/持久化在途块，或加入 pause ACK 与 missing-bitmap 重传。
- **来源 ID：** FT-018、CV-32。

### BUG-014 — Outbound resume 同时唤醒旧 sender 并启动新 engine（High）

- **置信度与证据依据：** 很高；`client/src/lib/transfer.ts:299-315,783-795`、`client/src/store/network.ts:767-798`。
- **触发与影响：** 本地发送暂停后恢复；两个 engine 用同 transfer ID 并发发送，造成重复流量与写入/进度竞态。
- **修复方向：** 每 transfer 只保留一个 live task；resume 只唤醒原任务，旧 generation 完全结束并对账后才能替换。
- **来源 ID：** FT-019、CV-33。

### BUG-015 — 并发传输覆盖 DataChannel 唯一 buffer-low waiter（High）

- **置信度与证据依据：** 很高；`client/src/store/network.ts:674-678,931-939`、`client/src/lib/transfer.ts:798-821` 使用单槽 `onbufferedamountlow`。
- **触发与影响：** 同 peer 两文件同时超过高水位；后 waiter 覆盖前者，任一 cleanup 又可清掉另一个，导致发送 Promise 永久挂起。
- **修复方向：** 使用独立 event listener 与身份安全清理，或每 channel 单一串行发送/背压仲裁器。
- **来源 ID：** FT-020、CV-34。

### BUG-016 — Sender “completed” 只表示本地排队而非接收端耐久完成（High）

- **置信度与证据依据：** 很高；`client/src/lib/transfer.ts:361-410`、`client/src/store/network.ts:988-1005`，协议没有 receiver finalization ACK。
- **触发与影响：** 最后一次 `dc.send()` 后、SCTP 排空和接收端完成前断线；发送端显示完成并删除重试源，接收端文件不完整。
- **修复方向：** 接收端耐久完成后发送 ACK；保留源文件至 ACK/cancel，并区分 queued、delivered、saved。
- **来源 ID：** FT-021、CV-35。

### BUG-017 — Resume bitmap 先于对应磁盘写入持久化（High）

- **置信度与证据依据：** 很高；`client/src/lib/transfer.ts:520-537,633-663`、`client/src/store/network.ts:1422-1428`。
- **触发与影响：** bitmap 保存后、OPFS/FSA 写入前崩溃或磁盘失败；恢复跳过磁盘缺失块，可能暴露稀疏/损坏文件。
- **修复方向：** 解密→耐久写→设置并持久化 bitmap→进度；最终校验大小和完整性后成功。
- **来源 ID：** FT-022、CV-36。

### BUG-018 — 成功流式接收缺少权威的存储/session 终态清理（Medium）

- **置信度与证据依据：** 很高；`client/src/lib/transfer.ts:688-694,1072-1104`、`client/src/store/network.ts:1752-1771,1829-1836`、`client/src/lib/db.ts:77-85`。
- **触发与影响：** 任意 OPFS/FSA 接收完成；文件名 handle 先丢失，OPFS 文件、DB active row、receive session 和 bitmap 长期积累。
- **修复方向：** 单一 terminal completion API 负责关闭后端、交付、精确删除 OPFS、更新/删除 DB 记录及清理 demux/dedupe。
- **来源 ID：** FT-023、CV-37。

### BUG-019 — 失败传输 Retry 可制造永久假的 “transferring” 状态（Medium）

- **置信度与证据依据：** 很高；`client/src/store/network.ts:767-799,1002-1005`、`client/src/pages/Network.tsx:730-739`。
- **触发与影响：** 失败后源文件已删，或 DC/记录不可用时点击 Retry；UI 先改状态再静默退出，没有任何字节移动。
- **修复方向：** 状态切换前验证前置条件；保留可重试源或要求重新选择，并 await/显示结构化失败。
- **来源 ID：** FT-025、UIUX-009、CV-39。

### BUG-020 — Chat flush 与 fanout 在发送失败后仍报告成功或沉默（Medium）

- **置信度与证据依据：** 很高；`client/src/store/network.ts:84-96,674-678,942-1020`。
- **触发与影响：** DC 在队列 flush 时关闭，或广播部分/全部目标失败；消息仍标已发，失败文件无全局结果或重试集合。
- **修复方向：** 保留逐条/逐 peer 结构化结果，只移除成功项，失败项留在可重试队列并展示部分成功。
- **来源 ID：** FT-026。

### BUG-021 — 快照完成或 peer 离开会静默删除暂存文件（Medium）

- **置信度与证据依据：** 很高；`client/src/store/network.ts:472-489,633-665`。
- **触发与影响：** 旧快照发送期间新增文件，或离线等待时 peer 暂时离开；用户已选 `File` 被静默清空。
- **修复方向：** 只移除成功发送的快照 ID；保留新加入和离线等待项，直至用户删除或 session 全部拆除。
- **来源 ID：** FT-027、CV-40。

### BUG-022 — Cloudflare 请求无 deadline，Express 4 异步路由无拒绝边界（Medium）

- **置信度与证据依据：** 高；`server/src/turn.ts:138-188,315-351,443-459`、`server/src/http.ts:386-412`。
- **触发与影响：** 供应商连接后不完成或返回畸形成功体；请求/reservation 可永久等待，后置异常可造成 hung response 或未处理 rejection。
- **修复方向：** 添加 AbortSignal deadline、响应 schema、全路径 rollback 和集中 Express async error propagation。
- **来源 ID：** MBS-019。

### BUG-023 — 并发 TURN reservation 可超过全局 kill threshold（Medium）

- **置信度与证据依据：** 高；`server/src/turn.ts:73-88,107-161`。
- **触发与影响：** 用量接近阈值时并发大量请求；每个请求都在供应商调用前看到 kill switch 未开启，造成突发超额凭据。
- **修复方向：** 供应商调用前原子比较 projected usage 并预占/开启开关；明确跨阈值回滚和允许超额策略。
- **来源 ID：** MBS-020。

### BUG-024 — TURN analytics 固定结果上限可低估高基数人口（Medium）

- **置信度与证据依据：** 中高；`server/src/turn.ts:478-557,561-618` 使用 1,000/10,000 固定 limit，无分页或截断检查。
- **触发与影响：** abuse window 超过 1,000 identifier 或月内超过 10,000；部分对象逃过检查，月总量可能不足以触发 kill switch。
- **修复方向：** 全局总量使用权威 aggregate；逐 identifier 查询分页/分块，截断进入明确 degraded/fail-safe 状态。
- **来源 ID：** MBS-021、CV-10。

### BUG-025 — Auth-lock snapshot 可在同一临时路径上竞态（Low）

- **置信度与证据依据：** 高；`server/src/persist.ts:170-200,274-288`、`server/src/index.ts:126-140`。
- **触发与影响：** 周期 flush 未完成时 shutdown 再 flush；rename 可 `ENOENT`，最新 lock/freeze 不一定成为重启后的快照。
- **修复方向：** lock state 使用独立 dirty/in-flight promise 或唯一临时文件；shutdown 前等待在途 flush。
- **来源 ID：** MBS-022。

### BUG-026 — TURN/NAT 诊断可静默失败或永久卡在测试中（Medium）

- **置信度与证据依据：** 很高；`client/src/components/features/SettingsModal.tsx:94-101,166-175,291-390`、`client/src/lib/turn.ts:285-317`。
- **触发与影响：** 无效 URL、WebRTC 构造/offer/setLocalDescription 或 credential issuance 失败；按钮永久显示 testing 或没有结果。
- **修复方向：** 每项诊断使用 typed result/error 和 `try/finally`，映射为用户可执行的恢复建议。
- **来源 ID：** FT-029。

### BUG-027 — 崩溃的 crypto worker 仍留在轮询队列（Medium）

- **置信度与证据依据：** 很高；`client/src/lib/cryptoPool.ts:28-41,61-69`。
- **触发与影响：** worker 加载错误、未捕获异常或 OOM；后续每 N 个加解密操作被派给死 worker，传输永久等待。
- **修复方向：** terminate 并移除/替换失败 worker，向替代者重发 peer key；无健康 worker 时立即拒绝。
- **来源 ID：** FT-030。

### BUG-028 — App bootstrap 可长期空白，lazy route 错误无恢复 UI（Medium）

- **置信度与证据依据：** 很高；`client/src/main.tsx:8-24`、`client/src/config.ts:44-57`、`client/src/App.tsx:8-13,36-59`。
- **触发与影响：** `client/public/config.json` 请求挂起、离线旧 chunk 或部署切换时 lazy import 失败；用户只见空白或未捕获错误。
- **修复方向：** 配置完成前先 mount shell，给配置请求 deadline/fallback，并加 route error boundary、retry/reload 和 offline 状态。
- **来源 ID：** FT-031。

### BUG-029 — 更新 reload 可中断活动传输并早于 worker 激活（Medium）

- **置信度与证据依据：** 很高；`client/src/components/features/UpdateBanner.tsx:38-80`、`client/src/App.tsx:24-31`、`client/src/pages/Network.tsx:783-809`。
- **触发与影响：** active transfer 时用户点击刷新；连接和任务被中断，且页面可能仍由旧 worker 控制。
- **修复方向：** 活动任务期间延后/禁用，等待 activation/controller change，再 reload。
- **替换文案：** “有新版本可用。刷新会中断当前连接，请先完成正在进行的传输。”；按钮“安全时刷新”“稍后”。
- **来源 ID：** UIUX-018、CV-60。

### BUG-030 — “实时”统计把失败或陈旧数据渲染为有效值（Medium）

- **置信度与证据依据：** 高；`client/src/store/home.ts:5-40`、`client/src/components/features/StatsDashboard.tsx:41-51,78-126`。
- **触发与影响：** 首次或轮询 fetch 失败；零值/旧值仍标“实时服务状态”，outage 被误解为正常。
- **修复方向：** 建模 `idle/loading/ready/error` 和 `lastUpdated`，显示 skeleton、retry 或 stale 提示。
- **替换文案：** “暂时无法获取服务状态，重试”；“数据更新于 HH:mm，当前可能已过期”。
- **来源 ID：** UIUX-021。

### BUG-031 — QR copy 失败承诺不存在的 fallback，错误提示也可能被裁切（Medium）

- **置信度与证据依据：** 高；`client/src/components/features/QRModal.tsx:106-115,134-150,268-275`。
- **触发与影响：** clipboard 被拒或不可用；提示用户选择“下方链接”，但界面没有链接，绝对定位反馈还可能落入 overflow 外。
- **修复方向：** 优先 `navigator.share({url})`，始终渲染只读可选择 URL，反馈放进普通流或全局 toast portal。
- **替换文案：** “无法复制链接。请长按下方链接复制，或使用系统分享。”
- **来源 ID：** UIUX-019。

## UX-COPY

### UX-COPY-001 — 公开隐私、条款和 About 声明与实际持久化/中继行为矛盾（High）

- **置信度与证据依据：** 很高；`client/src/pages/Privacy.tsx:21-45,59-63`、`client/src/pages/Terms.tsx:22-38`、`client/src/pages/ACGN.tsx:338-340`、`server/src/persist.ts:17-52,170-175,226-285`、`client/src/constants.ts:26-39`、`client/src/lib/webrtc.ts:108-118`。
- **触发与影响：** 用户阅读披露后使用自动 TURN 或服务端持久化 abuse/relay 状态；关于不持久 IP、不与第三方共享、立即删除和仅用户配置 TURN 才经服务器的说法不真实，影响知情选择与合规信任。
- **修复方向：** 先建立真实字段、用途、接收方、保留和删除清单；立即删除绝对化错误承诺，最终文本待 `SECURITY-001`、`BUG-001`、`BUG-008`、`CONFIG-002` 和供应商/保留决策落地后，由产品与隐私/法务复核。
- **条件式替换文案：** 行为修复后可采用：“节点和会话信息通常只保存在服务器内存中，并按公布的到期规则清除。为限制滥用和管理连接中继，部分安全记录、IP 限流记录及中继用量会在公布的期限内持久保存。”；“应用优先让设备直接传输文件。无法直连时，端到端加密的数据可能通过中继服务器转发；中继服务无法读取文件内容。”；“建立连接时，应用可能联系所列明的第三方 STUN/TURN 服务；这些服务会看到必要的网络连接信息，但无法读取端到端加密的文件内容。”当前实现未完成到期执行，不得直接发布“过期后清除”的版本。
- **来源 ID：** MBS-011、UIUX-001、CV-57。

### UX-COPY-002 — IP 上限恢复夸大删除范围，且经常无法腾出容量（Medium）

- **置信度与证据依据：** 很高；`client/src/components/features/IpFullPrompt.tsx:31-42`、`client/src/store/auth.ts:237-255`、`server/src/http.ts:333-352`。
- **触发与影响：** 表观 IP 已满且由不同 identity 占用；UI 承诺销毁“全部本地节点”，但未认证恢复只证明一个 identity，服务端只释放匹配 session，可能释放 0 个且 IP 仍满。正确授权不是绕过，缺陷是误导性/破坏性承诺和死路恢复。
- **修复方向：** 保留 identity-scoped 授权，返回并展示实际 released 数量；只在策略允许时提供经认证/operator 的更广恢复路径，不得承诺 IP 级删除。
- **替换文案：** 标题“此网络已有过多活动连接”；正文“可以结束此节点的旧连接，然后重试。若仍无法连接，请稍后再试或联系服务管理员。”；按钮“结束此节点的旧连接并重试”。
- **来源 ID：** UIUX-003、CV-21。

### UX-COPY-003 — UI 混淆 auth、signaling、peer transport 和 transfer 状态（Medium）

- **置信度与证据依据：** 高；`client/src/store/network.ts:419-527,1289-1336`、`client/src/lib/signaling.ts:115-145`、`client/src/components/layout/TopNav.tsx:184-196`、`client/src/pages/Network.tsx:208-213`。
- **触发与影响：** server shutdown、信令中断或健康 idle peer；导航仍显示“已接入”，空信道固定说已连接，idle peer 被标“数据流注入中”，用户无法判断是否需要重试。
- **修复方向：** 分开建模 auth、signaling、peer transport 和 active transfer；从正确层派生状态，并给 shutdown/reconnect 明确动作。
- **替换文案：** “在线 / 正在传输 / 正在连接 / 正在重新连接 / 已离线”；空信道“连接成功。现在可以发送消息或文件。”
- **来源 ID：** FT-028、UIUX-008、CV-28、CV-54。

### UX-COPY-004 — 界面直接显示协议、供应商和原始异常（Medium）

- **置信度与证据依据：** 很高；`client/src/store/network.ts:946-951,1012-1018,1435-1444`、`client/src/lib/transfer.ts:895-907`、`client/src/pages/Network.tsx:416-423,529-547,736-752,940-945`、`client/src/components/features/SettingsModal.tsx:291-389`、`client/src/components/features/ScanModal.tsx:19-32,83-91`。
- **触发与影响：** transfer、reconnect、TURN、copy 或 camera 失败；用户看到 `Missing chunk 0`、`No open DataChannel lane`、`HTTP_503` 和供应商内部错误，却没有可执行恢复指导。
- **修复方向：** 建立 typed failure code 和统一本地化 presentation mapper；原始细节仅进入日志或明确的“技术诊断”区域。
- **替换文案：** “连接中断，文件未发送。请重新连接后重试。”；“文件接收不完整，请让对方重新发送。”；“暂时无法生成接入二维码。请检查网络后重试。”；“当前网络可能阻止设备直连。请打开「设置 → 连接中继」，或换一个网络后重试。”
- **来源 ID：** UIUX-016、CV-58。

### UX-COPY-005 — 浏览器管理存储的接收完成被统一写成“已保存”（Low）

- **置信度与证据依据：** 很高；`client/src/pages/Network.tsx:702-727`、`client/src/store/network.ts:1752-1784`。
- **触发与影响：** OPFS/IDB 接收完成；用户以为文件已进入 Downloads 或所选位置，关闭页面后失去便捷访问。
- **修复方向：** 区分“接收完成/可下载”和“已保存到用户选择位置”。
- **替换文案：** 默认“接收完成，请在消息中下载”；仅确认 File System Access 写入后显示“已保存到所选位置”。
- **来源 ID：** UIUX-017、CV-59。

### UX-COPY-006 — 移动导航标签和空态指向错误动作/位置（Medium）

- **置信度与证据依据：** 高；`client/src/pages/Network.tsx:467-490,768-815,1100-1181`。
- **触发与影响：** 移动 Network 首次使用；“文件/消息”实为跳到任务/信道，“从左侧选择”指向当前布局不存在的左侧栏。
- **修复方向：** 使用一套真实目的地词汇，或把“文件”做成真正选文件动作；空态提供直接切换节点页的操作。
- **替换文案：** “请先在「节点」页选择目标节点”；按钮“前往节点”。
- **来源 ID：** UIUX-015。

### UX-COPY-007 — QR 内嵌密码警告未说明分享后果（Low）

- **置信度与证据依据：** 很高；`client/src/components/features/QRModal.tsx:232-243` 只说“不安全”。
- **触发与影响：** 用户勾选把 passcode 放入邀请并分享链接；无法理解获得链接的人无需另输密码即可加入。
- **修复方向：** 明确说明能力转移和可信渠道要求。
- **替换文案：** “链接包含接入密码，获得链接的人可以直接加入。仅通过可信渠道分享。”
- **来源 ID：** CV-61。

## UX-LAYOUT

### UX-LAYOUT-001 — Route 动画保留 transform，使 fixed modal 被错位和裁切（High）

- **置信度与证据依据：** 很高；`client/src/App.tsx:36-57`、`client/src/index.css:370-375`、`client/src/components/features/QRModal.tsx:128-151`。320×568 运行记录中 overlay 被偏移到 y=-72，动作超出视口。
- **触发与影响：** 短手机或横屏在已滚动 Network 打开 modal；fixed 后代相对 transform route wrapper 定位，关闭/复制等动作不可见，用户可能被困。
- **修复方向：** 将 overlay portal 到 `document.body`；或确保动画结束为 `transform:none`，短高视口中 backdrop 可滚动且 panel 顶部对齐。
- **来源 ID：** UIUX-006、CV-56。

### UX-LAYOUT-002 — 移动底部动作栏仍在普通文档流，却按 fixed 栏预留空间（Medium）

- **置信度与证据依据：** 高；`client/src/pages/Network.tsx:783-809,1100-1102,1134-1136,1177-1182`、`client/src/index.css:440-446`。
- **触发与影响：** 消息、peer 或任务超过一屏；主动作可被推到 fold 下，同时内容保留多余 96 px 空间。
- **修复方向：** 使用确定 viewport 高度、`overflow:hidden`、scroll child `min-height:0` 和栏 `shrink-0`；或真正 sticky/fixed 并只保留一次 safe-area 空间。
- **来源 ID：** UIUX-013、CV-49。

### UX-LAYOUT-003 — 紧凑手机 onboarding 首屏被装饰占据并隐藏首个完整动作（Medium）

- **置信度与证据依据：** 高；`client/src/pages/Home.tsx:15-78`、`client/src/components/features/LoginCard.tsx:235-243,277-317`；375 px 运行记录中 login card 约从 y=534 开始。
- **触发与影响：** 320–390 px 短手机首次打开；用户可能把页面误认为 splash，连接动作在首屏下方。
- **修复方向：** 为短高视口缩小/移除装饰，或在首屏提供紧凑“开始接入”动作。
- **来源 ID：** UIUX-014。

### UX-LAYOUT-004 — 已连接状态下平板导航可能超出 640–800 px 宽度预算（Medium）

- **置信度与证据依据：** 中高；`client/src/components/layout/TopNav.tsx:99-200`、`client/src/index.css:98-116`。静态 intrinsic/no-wrap 宽度算术支持裁切，但缺该断点运行截图。
- **触发与影响：** `sm` 断点同时显示 logo、中心导航和已连接动作；body 隐藏横向 overflow，部分导航/动作可能不可见。
- **修复方向：** 增加中间 breakpoint，折叠操作组或提前切换 hamburger，并添加 640/768/800 px 截图测试。
- **来源 ID：** CV-48。

### UX-LAYOUT-005 — ACGN 查询行在窄卡片中可能溢出（Medium）

- **置信度与证据依据：** 高；`client/src/pages/ACGN.tsx:117-135` 的 intrinsic number input 作为 `flex-1`，没有 `min-width:0`。为静态源码证据，未运行复现该断点。
- **触发与影响：** 三列平板或窄卡片布局；输入和按钮可能超出卡片、被裁切或压缩错位。
- **修复方向：** 给 flex child `min-width:0` 和有界宽度，在受影响 breakpoint 换行或垂直堆叠。
- **来源 ID：** CV-50。

### UX-LAYOUT-006 — 320 px 手机上 QR frame 超出 modal 内容宽度（Medium）

- **置信度与证据依据：** 很高；`client/src/components/features/QRModal.tsx:129-150,185-203`。220 px QR 加 24 px padding 约比 232 px 内容宽度多 12 px；无物理设备截图。
- **触发与影响：** 320 px 宽手机；QR frame 横向超出内容区。未声称已证明扫码失败。
- **修复方向：** 以 `max-width:100%`/容器计算使 QR 响应式，同时保持 quiet zone。
- **来源 ID：** CV-51。

### UX-LAYOUT-007 — Standalone iOS 忽略顶部 safe-area（Medium）

- **置信度与证据依据：** 高；`client/index.html:6`、`client/public/manifest.webmanifest:7`、`client/src/components/layout/TopNav.tsx:98-107,221-229`、`client/src/pages/Home.tsx:15`、`client/src/pages/Network.tsx:1056-1057`。仅静态证据。
- **触发与影响：** 刘海 iPhone 从 Home Screen 启动；硬编码 64 px nav 与 offset 可能落到状态区下。
- **修复方向：** 定义 `calc(64px + env(safe-area-inset-top))` 共用 token，nav padding、页面和 dropdown offset 全部使用。
- **来源 ID：** UIUX-022、CV-52。

### UX-LAYOUT-008 — 程序化登录跳转保留滚动并把移动 tabs 放到固定 nav 下（Medium）

- **置信度与证据依据：** 很高；`client/src/components/features/LoginCard.tsx:104-108`、`client/src/App.tsx:36-58`、`client/src/pages/Network.tsx:1056-1057,1100-1126`。390×844 运行记录中进入 Network 时 `scrollY=72`。
- **触发与影响：** 用户在 Home 下部完成连接；节点/信道/任务 tabs 被固定 nav 覆盖，看似缺失。
- **修复方向：** 前向 app navigation 在 layout effect 中滚到顶部并 focus 新 main/heading；只为显式 history restore 保留滚动。
- **来源 ID：** UIUX-007、CV-55。

### UX-LAYOUT-009 — 固定更新 banner 与底部动作、safe-area 和 dialog 图层冲突（Medium）

- **置信度与证据依据：** 高；`client/src/components/features/UpdateBanner.tsx:38-80`、`client/src/App.tsx:24-31`、`client/src/pages/Network.tsx:783-809`；运行记录观察到覆盖 Home/login 下部。
- **触发与影响：** onboarding、移动 Network 或 modal 打开时更新可用；重要控件被覆盖，notification z-index 与位置不协调。
- **修复方向：** 使用统一、感知 nav/action-bar/safe-area/modal 的通知层；dialog 打开时移动或抑制。
- **来源 ID：** UIUX-018。

## UX-MOTION

### UX-MOTION-001 — Reduced-motion 仍保留 transition、脚本平滑滚动和不可暂停移动内容（Medium）

- **置信度与证据依据：** 很高；`client/src/index.css:410-427`、`client/src/hooks/useModalExit.ts:3-24`、`client/src/pages/Network.tsx:179-181,367-370`、`client/src/components/layout/TopNav.tsx:90-93`、`client/src/components/features/ActivityStream.tsx:54-57`。
- **触发与影响：** `prefers-reduced-motion` 或键盘/触摸阅读移动 lore；仍有视口平滑移动和 transition，modal 视觉结束后仍等待，文本无可操作暂停。
- **修复方向：** reduced motion 下清零 transition/delay；所有脚本滚动先检查 media query；modal 即时完成；移动内容提供 pause/resume，coarse pointer 默认静态。
- **来源 ID：** UIUX-020、CV-46。

### UX-MOTION-002 — 动画扫描线覆盖展示中的二维码（Low）

- **置信度与证据依据：** 很高；`client/src/components/features/QRModal.tsx:185-211`、`client/src/index.css:319-330` 确认 2 px 移动线绘制在 QR 上。
- **触发与影响：** QR 展示期间持续播放；机器可读内容被不必要装饰覆盖。未证明实际扫码失败，因此仅为 Low。
- **修复方向：** QR 显示时移除扫描线，或把装饰移到 quiet/data 区域之外。
- **来源 ID：** CV-47。

## A11Y

### A11Y-001 — Modal 缺少一致 dialog 语义、focus containment 和恢复（High）

- **置信度与证据依据：** 很高；`client/src/components/features/SettingsModal.tsx:189-221`、`client/src/components/features/ScanModal.tsx:253-273`、`client/src/components/features/QRModal.tsx:128-159`、`client/src/components/features/IpFullPrompt.tsx:19-46`、`client/src/hooks/useModalExit.ts:5-27`；运行记录观察到 focus 进入被遮挡页面且关闭后不恢复。
- **触发与影响：** 键盘或辅助技术打开任一 modal；用户可能操作隐藏控件、错过 dialog 或失去导航位置。
- **修复方向：** 一个共享 dialog primitive：`role=dialog`、`aria-modal`、标题关联、初始 focus、Tab/Shift+Tab containment、inert 背景、Escape、scroll lock 和退出后 focus restoration。
- **来源 ID：** UIUX-005、CV-41。

### A11Y-002 — 语义色 token 造成广泛低于 AA 的小字号对比度（High）

- **置信度与证据依据：** 很高；`client/src/index.css:18-34`、`client/src/components/features/SettingsModal.tsx:300-365,438-447`、`client/src/pages/Network.tsx:538-542,670-688`、`client/src/components/ui/MisakaStatusBadge.tsx:21-33`。验证比值约 1.80:1–4.05:1。
- **触发与影响：** 状态、错误、进度、诊断和设置中的 10–14 px 文本；低视力用户难以读取关键状态。
- **修复方向：** 按 light/blue surface 定义经过验证的 foreground/background pair，禁止把亮状态色直接当小字号文本色，并自动测试实际配对。
- **来源 ID：** UIUX-010、CV-44。

### A11Y-003 — 自定义 settings switch 没有可访问名称和状态（Medium）

- **置信度与证据依据：** 很高；`client/src/components/features/SettingsModal.tsx:394-428,526-540`。
- **触发与影响：** 屏幕阅读器或语音控制操作设置；空 button 无 label、`role=switch` 或 `aria-checked`，无法识别用途和当前状态。
- **修复方向：** 优先使用带可见 label 的 native checkbox；否则提供 switch role、checked state 和关联说明。
- **来源 ID：** UIUX-011、CV-42。

### A11Y-004 — Settings、Scan、Join 和 ACGN 核心字段缺少程序化 label（Medium）

- **置信度与证据依据：** 很高；`client/src/components/features/SettingsModal.tsx:472-500`、`client/src/components/features/ScanModal.tsx:332-350`、`client/src/pages/Join.tsx:192-215`、`client/src/pages/ACGN.tsx:117-134`。
- **触发与影响：** 屏幕阅读器/语音用户填写表单；placeholder 或邻近文本不构成关联 label。
- **修复方向：** 添加 `<label for>`/`id`，错误使用 `aria-invalid` 与描述关系。
- **替换文案：** ACGN label：“实验体编号，范围 1–20001”。
- **来源 ID：** UIUX-011、CV-43。

### A11Y-005 — ACGN 输入移除唯一可见 focus indicator（Medium）

- **置信度与证据依据：** 很高；`client/src/pages/ACGN.tsx:123-133` 使用 `focus:outline-none`，没有共享替代 focus ring。
- **触发与影响：** 键盘导航到该输入；用户无法知道当前 focus 位置。
- **修复方向：** 应用共享 focus ring，并在所有背景上验证可见性。
- **来源 ID：** UIUX-011、CV-45。

### A11Y-006 — 导航嵌套交互控件、重复 tab stop，并缺少当前位置/展开状态（Medium）

- **置信度与证据依据：** 高；`client/src/components/layout/TopNav.tsx:120-144,198-229`、`client/src/pages/Terms.tsx:65-71`、`client/src/pages/Privacy.tsx:68-74`、`client/src/App.tsx:24-32`。
- **触发与影响：** 键盘或辅助技术跨页面导航；button 嵌在 link 中导致重复停止和浏览器差异，无 `aria-current`、菜单展开状态、main landmark 或 skip target。
- **修复方向：** 直接把 `Link` 样式化为按钮；添加 `aria-current`、`aria-expanded/controls`、单一 main 和 skip link。
- **来源 ID：** UIUX-012。

### A11Y-007 — 重要/icon 控件只有约 20–32 px 触摸区域（Medium）

- **置信度与证据依据：** 很高；`client/src/components/layout/TopNav.tsx:169-176,198-204`、`client/src/components/features/LoginCard.tsx:235-243`、`client/src/components/features/SettingsModal.tsx:215-221`、`client/src/components/features/QRModal.tsx:154-162`、`client/src/pages/Network.tsx:333-341,674-680`、`client/src/components/ui/MisakaButton.tsx:25-45`。
- **触发与影响：** 手机单手操作 regenerate、settings、menu、close 等；容易漏点或误触。
- **修复方向：** 图标视觉尺寸可保持，但 coarse pointer 上提供至少 44×44 px hit area。
- **来源 ID：** UIUX-014、CV-53。

### A11Y-008 — 无限移动 lore 内容没有键盘/触摸可用的暂停控制（Medium）

- **置信度与证据依据：** 高；`client/src/components/features/ActivityStream.tsx:54-57`、`client/src/index.css:410-427`。
- **触发与影响：** 键盘/触摸用户阅读移动内容；当前只在 hover/`focus-within` 暂停，但内容没有可 focus 的暂停目标。
- **修复方向：** 适当场景改为静态，或提供明确 pause/resume；coarse pointer 和 reduced-motion 默认停止。
- **来源 ID：** UIUX-020。

## TEST

> 本节严重度表示测试与测试基础设施风险，不等同于已经证明的生产缺陷严重度。

### TEST-001 — 固定延时 cancellation 测试依赖 scheduler（Medium）

- **置信度与证据依据：** 高；`client/tests/unit/transfer-cancel-send-loop.test.ts:28-31,74-85` 使用 4 ms fake encryption 和固定 25 ms 等待；整套曾在 0 chunk 处失败，单跑及 10 次复跑通过。
- **触发与影响：** 并行 suite 调度延迟；正确实现也可失败，使基线间歇变红并掩盖真实回归。
- **修复方向：** 使用 observed-send deferred/barrier；fake channel 观察第一块后再 cancel，并设置有界 timeout。
- **来源 ID：** TEST-001。

### TEST-002 — Server child 清理缺少可靠 finally/await，SIGKILL fallback 会被 process.exit 截断（Medium）

- **置信度与证据依据：** 很高（结构）；`server/tests/_harness.mjs:34-53`、`server/tests/ws-auth.test.mjs:35-58`。
- **触发与影响：** setup/case 抛错或子进程拒绝 SIGTERM；main 后立即 `process.exit()`，unref 的 3 秒 SIGKILL 没机会运行，可能遗留 stale server。
- **修复方向：** 所有 spawn 脚本在 `finally` await 终止；grace period 后同步可达的 SIGKILL，并在退出前确认 child exit。
- **来源 ID：** TEST-002、CV-65。

### TEST-003 — 固定端口 readiness 可连接 stale listener（Medium）

- **置信度与证据依据：** 高；`server/tests/ws-auth.test.mjs:29-38,180-201` 使用固定端口、spawn `tsx`、只轮询 health，不 race child exit 或验证 run nonce。
- **触发与影响：** 旧进程已占端口或新 child 启动失败；测试可能对错误进程运行并假绿，也可能随 suite 顺序/负载超时。
- **修复方向：** 直接运行已构建 `server/dist/index.js`，使用 OS 分配端口，readiness race child exit，并校验每次运行的 nonce/build identity。
- **来源 ID：** TEST-002、CV-66。

### TEST-004 — Wrong-passcode E2E 可提前 return 而没有提交错码（Medium）

- **置信度与证据依据：** 很高；`client/tests/e2e/qr-invite.spec.ts:91-108` 在离开 join 或少于六个输入时成功返回。
- **触发与影响：** 意外重定向、prompt 缺失、token 消费或 embedded-passcode 回归；名为 wrong-passcode 的测试从未测试错码仍为绿。
- **修复方向：** 固定创建不嵌码 invite，断言留在 join 且恰有六格，提交已知错值；任何前置偏离都 fail。
- **来源 ID：** TEST-003、CV-64。

### TEST-005 — Transfer E2E 只断言完成文字，不验证文件产物（Medium）

- **置信度与证据依据：** 很高；`client/tests/e2e/transfer.spec.ts:116-122,164-186` 只统计“已完成”，多文件用例不检查顺序或内容。
- **触发与影响：** 提前完成、截断、错文件、错路径、错序或下载交付损坏；测试仍可通过。
- **修复方向：** 提供确定性 receiver sink，比较 filename/path、size、order 和 SHA-256；状态文字仅作次级断言。
- **来源 ID：** TEST-004、CV-67。

### TEST-006 — OPFS 回归测试重写理想顺序而未执行生产编排（Medium）

- **置信度与证据依据：** 很高；`client/tests/unit/transfer-deliver-after-write.test.ts:101-136`、`client/tests/unit/transfer-opfs-resume-deliver.test.ts:117-135` 手工组合步骤，未驱动 `client/src/store/network.ts:1363-1435,1745-1793`。
- **触发与影响：** 生产 handler 先 delivery 后 write、分支谓词或 resume 获取路径被破坏；手写测试仍绿。
- **修复方向：** 提取/驱动真实 receive handler，延迟 OPFS 写并断言最后一写 resolve 前绝不 delivery，resume 必须从 OPFS 交付。
- **来源 ID：** TEST-005、CV-62。

### TEST-007 — WS 4001/4002 恢复链没有可执行行为测试（Medium）

- **置信度与证据依据：** 很高；`client/tests/unit/signaling-auth-recovery.test.ts:62-68` 明确不触发 close handler，`client/tests/ui-contract.test.mjs:105-111` 仅检查源码片段。
- **触发与影响：** close-code dispatch、handler 生命周期、缓存清理、重新注册或 fresh AUTH 回归；AGENTS.md 关键契约仍显示绿色。
- **修复方向：** fake WebSocket 加真实 auth store/fetch mock，分别触发 4001/4002，断言清 session、只注册一次、新 socket 使用新 token AUTH。
- **来源 ID：** TEST-006、CV-63。

### TEST-008 — TURN-disabled 测试因未注入自动凭据而空洞通过（Medium）

- **置信度与证据依据：** 很高；`client/tests/unit/turn-config-propagation.test.ts:43-61,78-85` 只 seed 手工 server，生产 `client/src/lib/webrtc.ts:108-118` 总是追加自动 TURN。
- **触发与影响：** 缓存自动凭据后关闭 TURN；关键隐私/成本契约已坏，但命名测试仍绿。
- **修复方向：** 先填充自动凭据，再关闭 TURN，断言无任何 `turn:`/`turns:`；同时断言无 TURN 时 force-relay 被拒。
- **来源 ID：** TEST-007、CV-22。

### TEST-009 — Receiver-pause 测试把不可逆丢块当正确且不经过 control plane（Medium）

- **置信度与证据依据：** 很高；`client/tests/unit/transfer-receiver-pause.test.ts:86-118` 明确断言暂停时 chunk 被丢弃，未执行 `client/src/store/network.ts:749-823,1616-1648` 或最终完成。
- **触发与影响：** 生产 pause/resume 永久缺块；测试却把该行为固化为期望。
- **修复方向：** 通过成对 channel/store 暂停在途块，断言 coherently stop、missing repair 和最终 byte-exact completion，并覆盖双方 cancel 清理。
- **来源 ID：** TEST-008、CV-32。

### TEST-010 — E2E 清理吞掉失败并可复用任意本地 server（Medium）

- **置信度与证据依据：** 很高；`client/tests/e2e/transfer.spec.ts:21-23`、`client/tests/e2e/qr-invite.spec.ts:17-19`、`client/tests/e2e/offline-recovery.spec.ts:20-22`、`client/playwright.config.ts:49-61`。
- **触发与影响：** cleanup 返回 401/429/500 或本地端口已有非 E2E/旧服务；session 泄漏污染后续测试，或整套对错误实现运行。
- **修复方向：** cleanup 必须 HTTP 200 且校验 `{released}`；每 worker 隔离 backend，或校验 test-mode/build nonce 后才复用。
- **来源 ID：** TEST-009。

### TEST-011 — Offline reconnect 和 “从未 reconnecting” 断言是瞬时/空洞的（Medium）

- **置信度与证据依据：** 很高；`client/tests/e2e/offline-recovery.spec.ts:68-70` 只检查 URL，`client/tests/e2e/transfer.spec.ts:125-130` 只在完成后采样一次。
- **触发与影响：** reconnect handler no-op、永久离线或短暂错误 banner；测试仍可通过。
- **修复方向：** 断言可观察 peer/PC 状态迁移和恢复通信；在保护区间前安装 DOM/status observer，期间出现错误状态即 fail。
- **来源 ID：** TEST-010。

### TEST-012 — QR render 断言可在空 canvas 上通过（Medium）

- **置信度与证据依据：** 很高；`client/tests/e2e/qr-invite.spec.ts:46-50` race 两个立即 `isVisible()`，canvas 早于最终 QR image 可见。
- **触发与影响：** 编码失败或画布空白；仅可见性仍让测试通过。
- **修复方向：** 等待非空 `data:image/png`，或检查/解码 canvas pixels，并与复制的 invite 内容比较。
- **来源 ID：** TEST-011。

### TEST-013 — Source-regex “contract” 提供行为假保障并阻碍重构（Medium）

- **置信度与证据依据：** 很高；`client/tests/ui-contract.test.mjs:28-70,97-111` 依赖 CSS/JSX/调用文本。
- **触发与影响：** dead/unreachable 文本可通过，等价格式化可失败；不证明 timing、cleanup、交互或结果。
- **修复方向：** 只保留真正静态 invariant；行为契约改为 component/store/integration 测试。
- **来源 ID：** TEST-012。

### TEST-014 — Shutdown 与 WebSocket abuse 边界没有可执行覆盖（Medium）

- **置信度与证据依据：** 很高；`server/src/index.ts:98-140`、`server/src/ws.ts:10-19,91-99`，现有测试不引用 shutdown message、1001、message-too-large、三 strike 或 1009。
- **触发与影响：** shutdown flush/通知、close code、size strike 或 block cap 回归；测试无失败。
- **修复方向：** dist-based SIGTERM 集成测试验证 message、1001、及时退出和快照；加入大小边界、三 strike 与 block-cap 用例。
- **来源 ID：** TEST-014。

### TEST-015 — `ws-block` 名称/注释承诺超出实际断言（Low）

- **置信度与证据依据：** 很高；`server/tests/ws-block.test.mjs:11-17,43-47,165-176` 只覆盖 SDP，且名为 suppressed 的 case 实际断言新 session 被重新介绍。
- **触发与影响：** ICE/ICE_END block 或 session replacement 语义回归；维护者误以为已有相反覆盖。
- **修复方向：** 双向参数化 SDP/ICE/ICE_END，拆分并重命名旧 session suppression 与新 session introduction。
- **来源 ID：** TEST-015。

### TEST-016 — “1 GiB stress test” 无内存预算/完整性断言且不进 CI（Low）

- **置信度与证据依据：** 很高；`server/tests/stress-1gb.test.mjs:89-93,143-147` 无条件打印勾，`server/package.json:11-14` 未纳入普通测试，`docs/PROGRESS.md:155` 仍引用结果。
- **触发与影响：** 内存超过文档目标或数据错误；脚本仍 exit 0 并被当作通过。
- **修复方向：** 改名为 benchmark，或在 `--expose-gc` 下加入容差预算、byte/checksum 与专用 CI。
- **来源 ID：** TEST-016。

## QUALITY

### QUALITY-001 — Terminal transfer/chat/session 状态没有有界保留策略（Medium）

- **置信度与证据依据：** 高；`client/src/lib/transfer.ts:194-207,410,688-694`、`client/src/lib/db.ts:77-86`、`client/src/store/network.ts:1829-1836`、`docs/PROGRESS.md:83-84`。
- **触发与影响：** 长期发送、聊天和重连；terminal DB row、数组、receive session 与 active scan 持续增长，消耗存储并拖慢恢复。
- **修复方向：** 定义单一 terminal retention/pruning 契约；无历史功能时成功/取消即删除，否则按时间/数量索引和测试清理。
- **来源 ID：** HYGIENE-001、CV-38。

### QUALITY-002 — 每个 chunk 都 await 一个无操作的异步 `flushRecord`（Low）

- **置信度与证据依据：** 很高；`client/src/lib/transfer.ts:286-295,386-398`。
- **触发与影响：** 大文件发送；产生数千个无意义 Promise/microtask 边界，并向维护者暗示不存在的 sender persistence 契约。
- **修复方向：** 删除函数和调用；只在建立真实持久化行为与测试后重新引入。
- **来源 ID：** HYGIENE-002。

### QUALITY-003 — 死 compatibility branch、fallback、TODO 和 definition-only export 模糊真实契约（Low）

- **置信度与证据依据：** 高；`client/src/pages/Network.tsx:970-1046` 把强类型 store 转为 `unknown`，保留 optional fallback 和 TODO。
- **触发与影响：** 重构 network、TURN 或协议；维护者面对多套表面和不可达路径，增加漂移与错误选择。
- **修复方向：** 删除不可达 cast/fallback/TODO 和无消费者 API；若为公共/test hook，则建立明确消费者、测试和唯一协议类型。
- **来源 ID：** HYGIENE-003。

### QUALITY-004 — 生成的 Playwright report 未忽略（Low）

- **置信度与证据依据：** 很高；`client/playwright-report/` 为未跟踪生成目录，`.gitignore:13-14` 忽略 test results/coverage 但未覆盖该目录。
- **触发与影响：** 本地运行 E2E；生成报告可能被误提交，制造 review 噪声。
- **修复方向：** 添加准确 ignore 规则；在用户确认适当时移除本地生成物。本审计未删除它。
- **来源 ID：** HYGIENE-004。

### QUALITY-005 — 进度/测试文档对路径、持久化和 TURN identifier 的说明陈旧（Low）

- **置信度与证据依据：** 很高；`docs/PROGRESS.md:75,132,177`、`client/tests/unit/nat-classify.test.ts:1`。
- **触发与影响：** 开发者按文档定位测试或设计运维；不存在路径、“无持久化”和旧 identifier 说法导致错误判断。
- **修复方向：** 更新或删除过期说明，并让关键架构/测试路径由可执行验证或近源码文档维护。
- **来源 ID：** HYGIENE-004。

### QUALITY-006 — 手工 Playwright 脚本导入未声明的传递包且没有 npm 入口（Low）

- **置信度与证据依据：** 很高；`client/tests/manual-test.mjs:5` 导入 `playwright`，`client/package.json` 只直接声明 `@playwright/test`。
- **触发与影响：** package manager 或 Playwright 依赖布局变化；当前可工作的手工命令在干净安装后可能失效。
- **修复方向：** 从 `@playwright/test` 导入 `chromium`，或直接声明 `playwright`；增加文档化 `test:manual` script。
- **来源 ID：** HYGIENE-005。

## CONFIG

### CONFIG-001 — 推荐 Caddy 部署未配置 proxy trust，所有用户折叠为代理 IP（High）

- **置信度与证据依据：** 很高；`deploy/docker-compose.prod.yml:8-13` 未设置 trust，`deploy/Caddyfile.example:16-17` 总是反向代理，`server/src/config.ts:9-25` 默认不信任代理。
- **触发与影响：** 按推荐模板部署；HTTP/WS 客户端都被归因到 Caddy 容器，跨用户共享 API rate、节点上限和 TURN 控制。
- **修复方向：** 为准确的一跳拓扑配置 trust，边缘清洗转发头，并用代理拓扑集成测试验证真实客户端 IP。
- **来源 ID：** MBS-003、DEPLOY-003、CV-14。该项与 `SECURITY-005` 不重复：本项是默认模板折叠；后者是启用 trust 后 WS 解析不安全。

### CONFIG-002 — Production Compose 遗漏 TURN/security secret 和明确耐久 app state（Medium）

- **置信度与证据依据：** 高；`deploy/docker-compose.prod.yml:8-13,31-38`、`server/src/config.ts:58-95,113-125`、`server/Dockerfile:22-26`、`README.md:105-112`。
- **触发与影响：** 按 README 启动生产 Caddy Compose；自动 TURN/安全变量无法注入，`SERVER_SECRET` 不稳定，`/app/data` 仅依赖匿名 volume 生命周期。
- **修复方向：** 显式 env_file/secret mapping、生产启动校验、命名/绑定 `/app/data` volume 及备份/保留说明。
- **来源 ID：** MBS-017、DEPLOY-003、CV-15。

### CONFIG-003 — 文档化 root Docker quickstart 在干净检出下失败（Medium）

- **置信度与证据依据：** 很高；`docker-compose.yml:8-12` 强制一个根目录环境文件，`README.md:88-96` 没有先创建；定向 `docker compose config` 确定失败。
- **触发与影响：** 新用户照最短文档执行；服务无法启动。
- **修复方向：** 支持时将 env file 设为可选/默认安全，或在首条 Compose 命令前明确复制示例并列出必需 secret。
- **来源 ID：** MBS-018、DEPLOY-002、CV-16。

### CONFIG-004 — Server 环境文件示例、bootstrap、production start 和 Docker 入口不一致（Medium）

- **置信度与证据依据：** 很高；`server/src/bootstrap.ts:1-5`、`server/package.json:7-10`、`server/Dockerfile:27-28`、`server/.env.example:1-14`。
- **触发与影响：** 用户复制 server 相邻示例后运行 dev/start/Docker；不同入口读取不同或不读取 env，静默使用默认端口、session、origin、TURN/security 设置。
- **修复方向：** 统一启动入口和 env 位置，或所有环境显式使用相同 `--env-file`；移动/修正文档示例。
- **来源 ID：** MBS-018、CONFIG-003。

### CONFIG-005 — 前端 asset base、router base、Pages fallback 和 404 使用不兼容来源（Medium）

- **置信度与证据依据：** 很高；`client/vite.config.ts:7-9`、`client/.env.example:14-15`、`client/src/lib/appBase.ts:1,9-17`、`client/public/404.html:8-15`、`.github/workflows/deploy.yml:32-36`。
- **触发与影响：** subpath build 或 fork/rename Pages repo；assets 可能加载，但 router/redirect 指向错误硬编码路径。
- **修复方向：** 从一个部署 base（优先 Vite `BASE_URL`）派生 asset/router/404，workflow 使用实际 repository name 并加 subpath smoke test。
- **来源 ID：** CONFIG-001。

### CONFIG-006 — Runtime config precedence 与注释契约相反（Medium）

- **置信度与证据依据：** 很高；`client/src/config.ts:1-3,44-57` 成功 fetch 后整体覆盖 host 注入值，`client/public/config.json` 总含官方 endpoint。
- **触发与影响：** host 注入私有 backend/config；加载 JSON 后被覆盖，用户连接到 operator 未预期服务。
- **修复方向：** 先快照 injected values，把 JSON 合并到其下；schema 校验、保留 app base，并加优先级测试。
- **来源 ID：** CONFIG-002。

### CONFIG-007 — 安全/成本数值环境变量接受 NaN、部分字符串和病态 interval（Medium）

- **置信度与证据依据：** 很高；`server/src/config.ts:38,42,54-55,70-95,105-110,130-135`、`server/src/ratelimit.ts:4-13`、`server/src/turn.ts:90-105,218-270,413-425`、`server/src/persist.ts:195-200`。
- **触发与影响：** 部署把 rate、TURN cap/threshold 或 interval 配成垃圾/零/部分数字；比较可因 `NaN` fail open，timer 可接近 busy loop。
- **修复方向：** 启动时对完整环境做 finite/range schema validation，并用变量名明确 fail fast。
- **来源 ID：** MBS-016、CONFIG-005。

### CONFIG-008 — PR CI 不构建客户端 production bundle（Medium）

- **置信度与证据依据：** 很高；`.github/workflows/test.yml:48-58` 只 typecheck/test，`.github/workflows/deploy.yml:32-36` 合并后才 build；当前审计构建通过。
- **触发与影响：** Vite/Rollup/PostCSS/Tailwind 仅构建期回归；PR 绿色但合并部署失败。
- **修复方向：** PR CI 加 `npm run build`，并覆盖相关 config/test TypeScript。
- **来源 ID：** CONFIG-004。

### CONFIG-009 — Docker metadata 暴露 8080，而 runtime/Compose 使用 9080（Low）

- **置信度与证据依据：** 很高；`server/Dockerfile:27`、`server/src/config.ts:5-7`、`docker-compose.yml:5-12`、`deploy/docker-compose.prod.yml:5-13`。
- **触发与影响：** `docker run -P` 或读取 image metadata 的 probe/tool；发布/探测错误端口。
- **修复方向：** 将 `EXPOSE` 改为 9080，或统一实际默认端口。
- **来源 ID：** MBS-018、HYGIENE-006。

## 被拒绝、合并或调整的主题

- **无 Critical。** Scanner 的任意导航和 script scheme sink 保留为 `SECURITY-006` High；脚本是否执行依赖浏览器/CSP 和用户扫描前置。传输存储竞态保留为 `BUG-011` High 数据完整性风险；隐私相关原始 Critical 合并为 `UX-COPY-001` High。
- **没有静默删除最终校准项。** QR 扫描线覆盖保留为 `UX-MOTION-002` Low；平板导航、ACGN 行和 320 px QR 几何分别保留为 `UX-LAYOUT-004`、`UX-LAYOUT-005`、`UX-LAYOUT-006` Medium，并明确缺少目标运行截图；QR passcode 风险说明保留为 `UX-COPY-007` Low。
- **IP 上限和 QR token 不再过度合并。** 一次性 token 事务属于 `BUG-003`；夸大删除范围和无法腾出容量属于 `UX-COPY-002`。二者证据、修复和文案边界不同。
- **WebSocket 风险已拆分。** Transport 缓冲前大小限制为 `SECURITY-002`，每 socket rate/backpressure 为 `SECURITY-003`，依赖公告为 `SECURITY-004`；升级依赖或设置 `maxPayload` 不能单独消除另两项。
- **代理风险已拆分。** `SECURITY-005` 是启用 trust 时 WS 解析可受伪造 XFF；`CONFIG-001` 是推荐 Caddy 模板未启用 trust 而折叠所有客户端。
- **清理/保留风险已拆分。** `BUG-018` 是完成 OPFS 后文件名和 terminal cleanup 缺失；`QUALITY-001` 是 transfer/chat/session 的长期无界保留。
- **测试基础设施已拆分。** `TEST-002` 是 child 终止/finally；`TEST-003` 是固定端口与 stale readiness。`TEST-005` 是 E2E 产物缺失；`TEST-006` 是 OPFS 单测未执行生产编排。
- **无障碍复合项已拆分。** Settings switch、表单 label 和 ACGN focus 分别为 `A11Y-003`、`A11Y-004`、`A11Y-005`，因为修复语义和回归测试不同。
- **Scrypt verifier “主认证绕过”不作为独立安全漏洞。** 当前证据没有证明绕过既有 identity hash 与在线 rate/lock；同步 scrypt 的确定性可用性问题保留为 `SECURITY-013` High。设计/注释一致性可并入 `QUALITY-003`。
- **纯审美诉求未计为问题。** 额外 crossfade、layout interpolation、hamburger timing、IP prompt entrance、孤立 stats 卡等未与任务或无障碍失败绑定。
- **过宽主张被拒绝。** “所有短 modal 永久裁切”“copy success feedback 总被裁切”“hero decode 持续空白”“全局 scrollbar 不可见”均缺足够证据；只保留有直接证据的具体根因。
- **基线相关误报已调整。** 当前没有确定性红测试基线、损坏的 production build、invalid/extraneous dependency tree、已跟踪 build/report junk 或缺失 `runTest` wrapper。保留的是 timing flake、CI build 缺口、child/readiness 风险和未忽略的本地报告目录。
- **未证明可达的依赖告警不保留。** Node 26 `tsx` warning 不属于当前 Node 20 CI 缺陷；低级 `body-parser`/`qs` 公告未证明应用可达，只有互联网入口的直接 `ws` 公告计入。

## 最终覆盖附录

### Canonical ID 覆盖

| ID 范围 | 数量 | High | Medium | Low | 状态 |
|---|---:|---:|---:|---:|---|
| `SECURITY-001`–`SECURITY-019` | 19 | 14 | 1 | 4 | 全部保留 |
| `BUG-001`–`BUG-031` | 31 | 12 | 17 | 2 | 全部保留 |
| `UX-COPY-001`–`UX-COPY-007` | 7 | 1 | 4 | 2 | 全部保留 |
| `UX-LAYOUT-001`–`UX-LAYOUT-009` | 9 | 1 | 8 | 0 | 全部保留 |
| `UX-MOTION-001`–`UX-MOTION-002` | 2 | 0 | 1 | 1 | 全部保留 |
| `A11Y-001`–`A11Y-008` | 8 | 2 | 6 | 0 | 全部保留 |
| `TEST-001`–`TEST-016` | 16 | 0 | 14 | 2 | 全部保留 |
| `QUALITY-001`–`QUALITY-006` | 6 | 0 | 1 | 5 | 全部保留 |
| `CONFIG-001`–`CONFIG-009` | 9 | 1 | 7 | 1 | 全部保留 |
| **合计** | **107** | **31** | **59** | **17** | **无遗漏、无重复 canonical ID** |

### 原验证 ID 与合并边界

- 原验证范围 `MBS-001`–`MBS-026`、`FT-001`–`FT-031`、`UIUX-001`–`UIUX-022`、`TEST-001`–`TEST-016`、`DEPLOY-001`–`DEPLOY-003`、`CONFIG-001`–`CONFIG-005`、`HYGIENE-001`–`HYGIENE-006` 均在上文各 finding 的“来源 ID”中出现，或在本节的明确调整说明中有归属。
- 同一原验证 ID 可拆到多个 canonical ID：例如 `DEPLOY-003` 分为 `CONFIG-001` 的代理拓扑和 `CONFIG-002` 的生产配置/状态 wiring；`UIUX-003` 分为 `BUG-003` 的 token 事务和 `UX-COPY-002` 的恢复范围/文案。这不是重复计数，而是不同修复边界。
- 多个原验证 ID 可合并到一个 canonical ID：例如 MBS/FT/UIUX 对同一 scanner、session、TURN 或 transfer 根因的重复报告。每个 canonical finding 的“来源 ID”保留了可追溯性。

### 交付完整性结论

- Canonical finding：107/107 已列出。
- 严重度：0 Critical、31 High、59 Medium、17 Low。
- 五个用户目标：全部映射。
- 路径：仅使用审计修订中存在的仓库相对路径。
- 临时文件依赖：无。
- 仓库改动：无。

## 修复完成标准

每个 bug 修复应先加入可失败的复现测试；修改 `client/src/` 或 `server/src/` 后运行 `npm test`；新增功能同时覆盖 happy path 与至少一个 edge case。认证和传输 P0 还必须补真实协议、生命周期和字节级产物断言，不以 source regex 或单纯状态文案代替。
