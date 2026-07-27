# 审计修复完成矩阵（2026-07-27）

本文件是 `CODE_AUDIT_2026-07-27.md` 与 `AUDIT_REPAIR_HANDOFF.md` 的最终收口记录。
原审计的 107 项以及交接复核新增/未完成项均已落到实现、测试、部署校验或明确的运维约束中；
交接文档中的“未开始 / 未修复”状态以本文件为准。

## 完成矩阵

| 范围 | 审计项 / 交接项 | 最终状态与证据 |
|---|---|---|
| Wave 1 | 交接文档列出的 47 项 | 已完成；认证、会话 epoch、WS 边界、基础 UI/a11y、部署基线由根测试套件持续覆盖。 |
| Wave 2 服务端 | SECURITY-008/009/010/017；BUG-022/023/024/025 | 已完成；TURN 公开/运维状态分层、持久状态 fail-closed、供应商 deadline、撤销重试、分页与并发配额均有集成测试。 |
| Wave 2 客户端传输 | SECURITY-007/015；BUG-011~021/027；QUALITY-001/002；TEST-006/009 | 已完成；接收端落盘确认、repair/resume、完整性校验、单终态 API 与下载产物生命周期均有单元及真实 E2E 字节校验。浏览器不提供 blob 下载完成事件，因此点击下载后不再按固定计时器删除惰性 OPFS 文件；用户确认已保存后显式释放。未确认副本可能保留到清除站点数据，此行为已在隐私页披露。 |
| Wave 3 QR / 邀请 | SECURITY-011；BUG-003；UX-COPY-002 | 已完成；二维码/分享 URL 只携带不透明 token，`c` 通行码参数在生成、扫描和 Join 入口均被移除/拒绝；验证通行码后签发一次性 admission grant；兑换采用 reserve/commit，注册失败可安全重试；E2E 解码实际渲染的 QR 图像并完成接入，同时保留错误口令和 admission 拒绝测试。 |
| Wave 3 网络 UI | BUG-019 UI；QUALITY-003；UX-COPY-004/005/006；A11Y-007 余项 | 已完成；状态、导航、传输结果与广播 fan-out 文案均以真实 store/协议状态为准，并补齐移动端标签与可访问交互。 |
| 客户端复核余项 | 对话框原值还原/栈顶 Escape、IpFullPrompt Escape、TURN 重试与全程 deadline、lazy/update 重试、TURN URL 校验、ActivityStream、ACGN 对比度、768–800px 导航、PWA 提示、组件集成测试 | 已完成；对应组件/模块测试覆盖 happy path 与边界场景。 |
| 测试基础设施 | TEST-002/003/004/005/010/011/012/013/015/016 及 TEST-014 余项 | 已完成；集成测试统一运行已构建 server、每脚本独立临时持久目录、确认式子进程清理、关机测试、WS 限制/阻塞测试、严格 E2E 清理、真实 QR 与字节级下载断言、测试源码 typecheck、压力测试与定期 CI 工作流。 |
| Wave 4 真实披露 | UX-COPY-001 | 已完成；Privacy、Terms、About 按实际 Cloudflare/TURN/IP 处理和本地/服务端持久化行为披露，不再承诺不存在的“纯点对点/不接触 IP/自动删除”。 |
| 部署复核 1–8 | 数据卷迁移、CDN 真实 IP、自动 TURN 凭据、单一 base、Caddy 日志、分支保护、代理验证、过时进度文档 | 已完成；具名卷固定名称并提供迁移文档；独立 CDN 拓扑文档；自动 TURN 缺凭据启动失败；只保留 `VITE_BASE`；Caddy 日志有界；记录 required-check 运维步骤；验证脚本严格检查状态并覆盖 `/ws`；文档与实现同步。 |
| CONFIG-008 余项 | 客户端测试与配置源码未纳入类型检查 | 已完成；`typecheck:config`、`typecheck:tests` 已加入脚本及 CI。 |
| 传输压力证明 | TEST-015/016 的大文件与内存预算 | 已完成实现和 CI 编排；本地以 16 MiB 样本验证校验和与内存预算，月度专用工作流运行 256 MiB 档。未把未执行的 1 GiB 本地基准标记为已运行。 |

## 独立复核 1–12

| # | 复核发现 | 修复与回归证据 |
|---|---|---|
| 1 | QR / 分享 URL 泄露六位通行码 | URL 只含一次性 token；生成端不再提供嵌入口令选项，扫描与 Join 入口显式拒绝 `c` 参数。`scan-join-link.test.ts` 与真实 QR E2E 覆盖。 |
| 2 | 固定 30 秒清理惰性 OPFS 产物可能截断下载 | 下载开始后不再计时删除；仅在用户明确确认浏览器已保存后释放。组件测试将时间推进 10 分钟仍可用，并验证显式释放。 |
| 3 | IP 满额恢复文案暗示宽泛释放且未显示真实数量 | 恢复仍严格限定同一身份，UI 显示服务端实际 `released` 数量；零释放时不自动重试并给出明确结果。组件 happy/zero 测试覆盖。 |
| 4 | TURN 诊断各阶段独立计时，可能突破总 deadline | 从诊断开始只创建一个绝对截止时间，建连与候选收集共享剩余预算；慢 `createOffer` + 收集回归证明总计在 5 秒边界结束。 |
| 5 | TURN URL / 凭据校验过宽 | 只接受结构完整的 `turn:` / `turns:` URL、合法端口和唯一 `transport=udp\|tcp`；缺用户名或凭据的服务器不会进入 RTC 配置。恶意/畸形输入矩阵测试覆盖。 |
| 6 | 集成脚本可能被旧监听器误判 ready，且子进程注册/清理不统一 | 每脚本随机实例 nonce、API 响应绑定、readiness 同时监听子进程退出；所有 spawned-server 脚本使用跟踪式 `spawn`。EADDRINUSE 旧监听器回归连续三次通过。 |
| 7 | 多文件、文件夹和广播 E2E 只看 UI 完成态 | 接收端捕获每个实际 `File`，按顺序断言安全文件名、字节数和 SHA-256；普通多选保持选择顺序，文件夹按相对路径稳定排序，两名广播接收者分别校验。 |
| 8 | QR E2E 绕过真实图像 | 测试读取渲染后的 PNG，以 `jsQR` 解码后验证 URL 无 `c`，再由全新浏览器上下文完成 admission 入网；错误口令仍单独覆盖。 |
| 9 | 初始 WebRTC 可永久停在 `checking`，离线恢复选择到旧节点 | 离线 E2E 绑定新会话节点。首连从 PC 创建起受限时看门狗约束，覆盖 ICE 未进入 `checking` 及 ICE 已连接但 ECDH/AES 未完成两种停滞；只由确定性的 polite 一侧发起 ICE restart，失败后暴露真实重连入口。手动重连的 fresh offer 会让未加密的离线/重连 answerer 丢弃旧 PC generation，避免保留卡死的 SCTP/ECDH。单测与连续三轮完整 E2E 覆盖。 |
| 10 | 可离线枚举的裸 SHA-256 通行码身份值 | 改为以 `SERVER_SECRET` 为密钥、带域分隔的 HMAC-SHA-256；会话内验证仍用随机盐 scrypt。测试证明结果不同于裸 SHA-256，隐私披露同步。 |
| 11 | Compose 中 CDN 可信代理注释与部署文档不一致 | 注释与拓扑文档统一为发布 CIDR 白名单、Caddy `{client_ip}` 覆盖转发头、信令端 `TRUST_PROXY=1`。Compose 展开和脚本语法通过。 |
| 12 | UpdateBanner 测试只测辅助逻辑，未覆盖实际组件激活 | 实际渲染组件：active-worker 注册时禁用更新；waiting worker 发送 `SKIP_WAITING`，且仅在 `controllerchange` 后刷新。组件集成测试通过。 |

## 第二轮独立复核 1–7

| # | 复核发现 | 最终修复与证据 |
|---|---|---|
| 1 | 初始离线恢复仍可能永久卡住或双边 glare | 双端从 PC 创建即进入同一限时观察，但只有 polite 一侧发送 restart；epoch、generation、PC identity、信令与 AES 状态全程守卫。`new`、`checking`、ICE-connected/ECDH-stalled、restart throw/无效、成功清理及 stale epoch 均有单测。连续完整 E2E 暴露并修复 answerer 旧 generation 后，最终 3×8/8。 |
| 2 | 测试 harness watchdog 直接退出，可能遗留子进程 | watchdog、成功与异常统一走幂等异步 finalizer：终止并等待已跟踪子进程、清理自有持久目录，再退出；5 秒 unref 强杀只作 finalizer 卡死后备。fixture 证明 watchdog 超时后子 PID 已不存在。 |
| 3 | TURN URL 解析仍接受畸形 authority/query/hostname | 只接受完整 `turn:`/`turns:` authority、合法 DNS/IPv4/方括号 IPv6、1–65535 端口，以及唯一精确的 `transport=udp|tcp`；拒绝编码分隔符、空/重复 query、空 DNS label、下划线、非法连字符与越界 label。诊断和设置 gating 均使用真实解析器测试。 |
| 4 | 广播多文件缺少每个接收者的顺序与内容证明 | 接收者之间并行、单个接收者内按 picker 顺序串行发送；E2E 向两名接收者广播两个不同文件，分别精确断言有序 `{name,size,sha256}`，发送端断言四个独立终态。 |
| 5 | `SERVER_SECRET` 弱值/缺失及原始文本密钥语义不明确 | 生产启动强制恰好 64 个十六进制字符（32 decoded bytes）；开发/测试缺失时生成随机值并警告。HMAC 使用 decoded key，custom identifier 采用域分隔 HMAC；测试覆盖缺失/弱值拒绝、同 key 稳定和轮换变化，文档要求协调停机/排空后全实例同步轮换。 |
| 6 | 根 Compose 在 clean checkout 下与生产 secret/TURN 默认冲突 | 根栈明确为 development，`TURN_AUTO_ENABLED` 默认 false，`.env` 可选；生产 Compose 继续 fail-closed。已在无 `.env` 条件下实际执行 build/up，等待 `/api/health`，容器内断言两个环境值后 down；default/false/true 展开均验证。 |
| 7 | CDN 指引暗示提高 `TRUST_PROXY` hop 数 | README、生产 Compose 和代理验证脚本统一为：Caddy 仅信任已发布 CDN CIDR，使用已验证 `{client_ip}` 覆盖转发头，信令端保持 `TRUST_PROXY=1`；不再提供提高 hop 数建议。 |

## 第三轮独立复核 1–2

| # | 复核发现 | 最终修复与证据 |
|---|---|---|
| 1 | 旧 PeerConnection 的延迟 ICE/数据通道回调可能把新 generation 误报为已连接或已恢复 | ICE 统计、DataChannel open/close/message、ECDH 导入/导出后的异步续体全部绑定 network epoch、peer generation、精确 PC 与精确主/传输通道 identity；`connectedPeers`、online 和“连接已恢复”只在当前主通道完成 AES 握手后发布。回归测试覆盖统计 await 中替换 PC，以及 DataChannel 已 open 但 ECDH 导出失败两条边界。 |
| 2 | 合法但非规范文本形式的方括号 IPv6 TURN 地址被拒绝 | 方括号 authority 仍受严格字符、分隔符、端口与 query 约束，但 IPv6 合法性改为 WHATWG 语义解析，不再要求规范化后的 hostname 与输入逐字相等。测试接受 leading-zero、完整展开和 IPv4-mapped IPv6，继续拒绝错误压缩、越界 IPv4 tail 与缺失右括号。 |

## 第四轮独立复核 1–3

| # | 复核发现 | 最终修复与证据 |
|---|---|---|
| 1 | 旧 answerer 的 DataChannel 与双方旧 PC 的 ICE 回调可污染新 generation | 引入统一的 peer attempt identity：network epoch、peer roster/session、单调 generation 与精确 PeerConnection identity。offerer/answerer 的 ICE、answerer `ondatachannel`、ICE 状态与 DataChannel 生命周期回调均捕获 originating attempt；任何 map 写入或信令发送前必须仍为当前 attempt。测试替换 PC 后主动触发旧 `ondatachannel`、双方旧 `onicecandidate`，证明当前通道和信令均不变。 |
| 2 | TURN、密钥与 SDP await 后的旧 continuation 可发送过期 SDP，旧失败还可覆盖新成功状态 | outbound/inbound negotiation、glare rollback、offer/answer/apply、pending ICE、path migration、ICE restart 与 reconnect catch/final state mutation 统一复用 attempt predicate，并在每个 await 后复验。WebRTC SDP helper 在内部每个浏览器 API await 后也执行 guard。延迟 key/offer/answer/set-description 与 stale reconnect rejection 测试证明旧 attempt 不能发送或把新连接标为离线。 |
| 3 | 旧 ECDH import/derive 可在 cleanup 与新 keypair 后覆盖 worker cryptoPool | WebCrypto 结果先落局部变量；import、derive 后及 commit/register 前均验证 `peerStates` 仍指向捕获 state 且 keypair identity 未变。延迟 import 与延迟 derive 两条测试在 cleanup + 新 generation 完成后释放旧 promise，证明 worker pool 只注册当前 AES key。offerer 的 guarded ICE watchdog 也提前到 key generation 前安装，停滞 WebCrypto 仍在 8s restart + 8s reobserve 后进入可操作离线态。 |

## 第五轮独立复核 1

| # | 复核发现 | 最终修复与证据 |
|---|---|---|
| 1 | 旧 negotiation 后排队的 SDP/ICE 在 cleanup 后才开始执行，会把 replacement PC 误当成原目标 | 每个入站 SDP/ICE 在收到并入队时即捕获 network epoch、per-peer signaling incarnation、peer generation、精确 originating PC（若存在）及当前 local-offer token。cleanup/reconnect/PC abandon 会推进 incarnation、清除 offer token并脱离旧 queue tail；旧 promise 无法取消，但其所有 receipt stamp 均失效。answer 必须仍匹配原 PC 与 offer token；ICE 匹配原 PC，并在存在 local-offer token 时同时绑定该 token；无 PC 的同 incarnation ICE 仍可在 offer 前合法缓冲。settled tail 仅在仍为 map 当前值时自删，避免 queue map 无界保留。测试覆盖阻塞旧 handler 后排队 answer+ICE、replacement 后释放；同 PC 新 offer token；合法同 incarnation ICE；offer 前无 PC ICE；以及最终 queue count 归零。 |

## 第六轮独立复核 1

| # | 复核发现 | 最终修复与证据 |
|---|---|---|
| 1 | 无 PC 时先到的 ICE/EOC 会在本地 fallback 创建新 generation 后被提前灌入尚无 remoteDescription 的 outbound PC；candidate 失败并丢失，EOC 则直接丢弃 | offer 前 ICE 改为按 network epoch、signaling incarnation 与 pending-remote negotiation token 分组暂存；候选携带的 ICE ufrag 优先与成功安装的远端 SDP ufrag匹配，无 ufrag 时由一次性 negotiation token 约束，本地 fallback 的第一份 offer token 也会绑定对应组。outbound offer 路径不再 drain；只有远端 SDP 成功安装并复验 epoch/incarnation/generation/精确 PC 后，才按顺序应用匹配候选并最后应用 EOC。匹配组一次性退休，显式 ufrag mismatch 保留给后续匹配 SDP，cleanup/invalidation/epoch teardown 同步清除。确定性回归覆盖 ICE+EOC 先到、7 秒本地 fallback 先建 PC、remoteDescription 前零应用、后续匹配 answer 恰好按 candidate→EOC 应用一次；另覆盖 mismatch 后续匹配、cleanup 失效且零残留、普通 inbound offer 后即时 ICE/EOC。 |

## 第七轮独立复核 1–3

| # | 复核发现 | 最终修复与证据 |
|---|---|---|
| 1 | 已建立 PC 的 ICE restart 候选在新 SDP 前到达时仍会被灌入旧 remoteDescription | 入站候选在 receipt time 解析精确 `usernameFragment`，并按 `sdpMid` / `sdpMLineIndex` 对照当前远端 SDP 的 session/media ICE ufrag；不同或在 pending restart 中未知的候选与 EOC 不触碰旧 ICE generation。匹配 restart SDP 成功安装并复验 epoch/incarnation/generation/精确 PC 后，才按 candidate→EOC 顺序恰好 drain 一次。回归先证明旧实现会在 SDP 前应用 `restart-candidate,eoc`，修复后 SDP 前为零、之后有序一次；旧 generation 的显式同 ufrag候选仍可即时应用。 |
| 2 | 单一 pending batch 会在第一份 SDP 删除其他 ufrag，并把无 ufrag候选错误泄漏到不相关 SDP | pending ICE 改为每 peer 的有界 group map，key 包含 signaling incarnation、negotiation token 与显式 ICE ufrag；无 ufrag候选/EOC 在接收时绑定当前显式 group，否则进入一次性 token group。SDP parser 同时支持 session-level 与多 `m=` section ufrag，逐候选按 mid/m-line 匹配；只 drain 已安装 SDP 匹配的 group，显式 mismatch 保留给后续 SDP。每 peer 最多 8 group、每 group 最多 256 candidate，cleanup/epoch 清零。测试覆盖 A/B 分两份 SDP 依次 drain、explicit+absent 不串组、audio/video 双 ufrag SDP、group/candidate 上限及 epoch 清理。 |
| 3 | 离线恢复完整套件曾出现 replacement peer 未上线 | 独立基线 frozen-source recovery 5/5；修复后首次 10 次运行期间发生源码 HMR，trace 明确记录热更新并导致页面网络状态重载，该 8/10 结果作废。停止编辑、全新进程从零重跑后 10/10（2.0 分钟）。因此没有证据把先前 22/24 直接归因于本轮 pending ICE；但其候选代际错误已由确定性单测直接复现和修复，最终完整 E2E 另按 3×8 与连续三套 8/8 验证。 |

## 第八轮独立复核 1–4

| # | 复核发现 | 最终修复与证据 |
|---|---|---|
| 1 | 未来 ICE group 的 receipt 已入队但尚未 materialize 时，前一份 SDP drain 会提前退休共享 negotiation token，导致下一份 SDP 无法 drain | 每个候选/EOC receipt 在同步入队前持有 negotiation-token reservation，queue handler 的 `finally` 统一释放；token 只有在既无 materialized group、也无 receipt reservation 时才可退休。确定性回归按 candidate A → 阻塞 SDP A → 入队 candidate B/EOC → 释放 A → SDP B 的顺序，证明 A 与 B 只在各自匹配 SDP 后应用，B 的 EOC 紧随 B 且恰好一次。 |
| 2 | 携带未知 `sdpMid` / `sdpMLineIndex` 的候选会按全局共享 ufrag 回退，从而误灌入旧 BUNDLE SDP | 候选只要提供 media locator，每个提供的 locator 都必须存在且 ufrag 一致；仅完全不带 locator 时允许全局 ufrag membership。回归使用旧 SDP 仅含 audio、新候选定位 future video 且共享 ufrag，证明候选保持缓冲，直到新 SDP 真正出现 video locator 才应用；已有 audio/video 及 BUNDLE 共享 ufrag路径继续通过。 |
| 3 | established group 绑定旧 local-offer token 后，本地 restart 会使 matching polite-glare remote offer 在 rollback 后仍无法 drain | 成功完成 polite rollback 后，只对同 epoch/incarnation、同 remote negotiation token、显式 ufrag 且所有 media locator 均匹配 incoming remote offer 的 group 重绑定当前 receipt local-offer token；普通 answer-bound group 不放宽。回归覆盖 candidate/EOC → local TURN migration restart → matching colliding offer，证明 rollback 后 candidate→EOC 恰好一次。 |
| 4 | pending group/candidate 达上限时静默淘汰最旧已接受数据 | 容量策略改为保留最旧 8 个 group 与每组最旧 256 个 candidate，拒绝新 overflow；按 peer 累计 `groupDrops` / `candidateDrops` 并输出带 kind/limit 的明确诊断，cleanup/invalidation/epoch 同步清除。回归证明第 1 group/candidate 可被匹配 SDP drain，第 9 group 与第 257 candidate 未进入队列，overflow 可查询且有 warning。 |

## 第九轮独立复核 1–2

| # | 复核发现 | 最终修复与证据 |
|---|---|---|
| 1 | cleanup/epoch 清零 negotiation counter 后会复用同一 numeric token；旧 detached queue tail 的 `finally` 可释放或退休 replacement 的同号 reservation | reservation identity 改为 peer 范围内的 `network epoch + signaling incarnation + token` 精确键，并随 receipt 固化；release 只操作 receipt 自己的 identity，retirement 在检查 group/reservation 前先要求 receipt epoch/incarnation 仍为当前值。两个确定性回归分别在 cleanup replacement 与 session-id epoch change 后复用 token：旧 blocker 后排队旧 candidate/EOC，新 blocker 后持有 replacement candidate/EOC reservation，释放旧 tail 后 replacement reservation 仍为 2；释放新 blocker 后归零，matching SDP 最终只应用 replacement candidate→EOC 一次。 |
| 2 | 显式 group 内 `usernameFragment` 缺失的 candidate 在 glare rebind/drain 中被无条件视为匹配，绕过 mid/m-line | capture、即时应用、polite-glare rebind 与 drain 共用同一 compatibility predicate：显式 ufrag 保持严格 locator 匹配；缺 ufrag 但带 locator 时，每个 locator 必须存在、彼此解析到同一 ufrag，且显式 group ufrag 必须一致；完全不带 locator 仅在同 group negotiation binding 已证明时接受。回归证明 audio-only SDP B 不消费 future-video candidate/EOC，后续含 video 的 SDP B 才按序 drain；另证明冲突 mid+index 保留，而同 group 的 locator-less candidate 合法应用，EOC 等待最后一个兼容 candidate 后只发一次。 |

## 第十轮独立复核 1–2

| # | 复核发现 | 最终修复与证据 |
|---|---|---|
| 1 | established audio-only SDP 与 future-video candidate 共享全局 ufrag 时，candidate 会因 locator 不兼容而缓冲，但 EOC 仅按 group/global ufrag 判断并提前应用 | EOC handler 先定位与 receipt 的 epoch/incarnation/token/key 完全一致的 pending group，并复用统一 candidate compatibility predicate 检查其中每个候选；只要 group ufrag/token 或任一 locator 仍不兼容，便只幂等记录 `endOfCandidates=true`。全部兼容时不单独发送 EOC，而是调用统一 drain，保证候选按 receipt 顺序应用后再发送恰好一个 EOC。established-PC 回归证明 audio-only B 下 future-video B candidate/EOC 均不提前应用，matching video SDP 后得到 candidate→EOC；混合 current-audio + future-video 及重复 EOC 回归证明 current candidate 可立即应用，但两个 EOC 都等待 future candidate，最终仍只发送一次。 |
| 2 | 同机 Chromium E2E 隐式依赖公网 STUN DNS；TURN 在测试后端明确关闭时仍请求凭据，导致冻结源码完整套件分别出现 22/24、23/24，失败集中在 offline replacement 与普通单文件连接 readiness | Trace 显示 `/api/turn-credentials` 503，Cloudflare、Google、QQ、MiWiFi、Nextcloud 等全部公网 STUN 查询均报 Chromium 701 host lookup error。未采用重试至绿；新增仅在 Vite development、精确 `misaka-playwright-v1` 前后端 nonce 且显式 flag 同时匹配时生效的 host-candidate-only 模式。该模式使实际 peer config 为 `iceServers=[]`、policy=`all`；host-only NAT routine 仍然运行，但以 `iceServers=[]` 探测而不查询公网 STUN；自动 TURN fetch/retry 不启动；手动 TURN diagnostics 也在该精确模式内以明确的 `TEST_MODE_BLOCKED` 结果短路，不创建 relay-only PC 或发起 DNS/网络请求。生产构建即使误带变量也不激活。现有 auth E2E 每轮从真实浏览器动态读取 `buildIceConfig()`，同时校验 `/api/ready` 后端 nonce、前端 nonce、零外部 ICE URL 与非 relay-only policy。精确 nonce及 mismatch 单测通过；冻结源码后 offline 10/10、四类 transfer 各三轮 12/12、完整三轮 24/24。第三次旧配置尝试在相同 offline 症状再次出现后主动中止（1 pass、1 interrupted、22 not run），保留为失败证据而非计入通过结果。 |

## 第十一轮独立复核 1–2

| # | 复核发现 | 最终修复与证据 |
|---|---|---|
| 1 | pending group 虽按候选 media locator 匹配，但 drain 生成的空 candidate 总是落到 PeerConnection 第一条 m-line，future-video EOC 会错误结束 audio；同 BUNDLE group 的多 media 也只能发一个 EOC | `SIGNAL_ICE_END` 协议新增可选的空 candidate media locator；本地 gathering 完成时按 local SDP 每条 m-line 发送一个 `{candidate:'',sdpMid,sdpMLineIndex}`，服务端严格校验并原样转发。receipt 与 pending group 保留并按 locator 去重多个 EOC marker；drain 先按序应用 matching candidates，再对每个已匹配 media 应用各自 marker 恰好一次。旧客户端无 locator 的 frame 继续走第一条 m-line fallback，不把它伪装成全局 marker。单测记录原始 `RTCIceCandidateInit`，证明 future-video 得到 video/1，audio+video BUNDLE 得到 candidate audio→candidate video→EOC audio→EOC video；server integration 证明 locator 跨信令保持。 |
| 2 | exact E2E host-only 模式仍允许 Settings 手动 TURN 诊断创建 relay-only PC 并查询用户输入的外部地址 | `testTurnServerDetailed()` 在 URL/RTCPeerConnection 处理之前复用精确 development+nonce+flag gate，返回显式 `TEST_MODE_BLOCKED` 文案；构造器、DNS 与网络均不触发。单测证明 exact dev 模式构造次数为零；同一变量在 production 环境中仍执行正常 relay diagnostic。带 E2E 变量的 production build 通过，产物仍包含正常 STUN 配置且已消除 test-mode 分支文案。 |

## 第十二轮独立复核 1–3

| # | 复核发现 | 最终修复与证据 |
|---|---|---|
| 1 | media-scoped EOC marker 缺少 ICE generation；audio/A 后 video/B 的 marker 可能沿用最后一个 group hint，candidate-less B restart 也可能提前结束已安装的 A generation | 本地 SDP parser 同时读取 session-level 与每个 `m=` section 的 `a=ice-ufrag`，每条 EOC marker 携带精确 `usernameFragment + sdpMid + sdpMLineIndex`。服务端只接受 1–256 字符的安全 ICE ufrag 字符集并原样转发，CRLF/空白注入被拒绝。receipt 先按 marker 自身 ufrag 建 exact group；显式 B marker 在 SDP B 安装前保持缓冲，不再退回 last-hint A。回归覆盖 audio/A + video/B 分组顺序、candidate-less B 对已安装 A 零影响、session/media ufrag 解析及恶意服务端输入。 |
| 2 | `{mid}`、`{index}` 与 `{mid,index}` 可把同一 m-line 的 EOC 应用三次；预 SDP alias 无法在 SDP 后归一，冲突 locator 在 BUNDLE 共享 ufrag 下仍可能被接受 | 远端 SDP 建立双向 mid/index locator 表。pending 阶段只合并无冲突的已知 alias；SDP 安装后统一 canonicalize 为 `mline:index`，补齐 mid/index 并按 canonical key 去重。提供 mid+index 时两者必须解析到同一 m-line，即使 BUNDLE ufrag 相同也拒绝冲突；未知 future locator 保留等待后续 SDP。回归证明三种等价形态只应用一次，预 SDP alias 可在 SDP 后对齐，audio+index1 冲突 marker 被丢弃。 |
| 3 | Round 12 冻结完整 E2E 的 replacement recovery 低频出现“ICE 已选中 direct host path，但 DataChannel/ECDH 未完成，双方最终 offline”；现有 watchdog 只做 ICE restart，无法替换已卡住的 SCTP association | 未以幸运重跑收口：一次完整套件为 23/24，随后 focused offline 为 9/10，保留失败 trace/snapshot；低开销生命周期观测另跑 20/20，但不作为修复证明。确定性红测把状态压缩为 `ICE=connected + AES=false + watchdog expiry`，旧实现仍调用 `createOffer({iceRestart:true})` 且保留原 PC。现在只由 deterministic polite owner 进行一次完整 PC/session rebuild；answerer 收到 fresh offer 时也替换 stable、connected-but-unencrypted 的旧 PC，AES-ready、手动重连、peer/epoch teardown 清除 one-shot guard。红测转绿；移除全部临时 debug 后，冻结源码 offline recovery 20/20、transfer 12/12、完整套件 24/24。 |

## 第十三轮独立复核 1–2

| # | 复核发现 | 最终修复与证据 |
|---|---|---|
| 1 | 加密会话 rebuild 的 `.catch()`（`scheduleInitialIceRecovery` 内、connected-but-unencrypted 分支，`client/src/store/network.ts` ~2960–3020 行）在拒绝发生时才动态重读 `networkEpoch` / `peerGeneration(peerSessionId)`。由于是"事后现读"，这两个检查对自身永远为真——迟到的拒绝因此可能误伤已经接管该 peer 的更新/手动连接；若 `initiateWebRTC()` 在从未创建替换 PC 前就拒绝（例如信令一直未就绪），该分支的 `if (replacement)` 完全不成立，peer 就永久停在 `connecting`，没有 watchdog 也没有可操作的重试入口 | rebuild 一启动就冻结自身身份：`const rebuildTask = initiateWebRTC(peerSessionId)` 之后立即同步读取 `{ peerSessionId, epoch: networkEpoch, gen: peerGeneration(peerSessionId) }`（`initiateWebRTC` 在第一次 `await` 之前就同步 bump 了 generation，见其自身"registered SYNCHRONOUSLY"注释，因此这一刻读到的正是这次 rebuild 专属的世代号）。`.catch()` 只依据这份冻结快照判断陈旧性，新增 `isRebuildRecoveryCurrent(attempt)`（复用 `isPeerGenerationAttemptCurrent`，再加 `!hasAESKey` 判断），永不在回调里重读全局变量。若该次尝试仍然当前且已存在替换 PC，复用既有的 `markInitialIceRecoveryFailed`（PC 绑定终态路径）；若从未创建 PC，新增的、PC 无关的终态函数 `markPeerRecoveryTerminal(peerSessionId)` 把 `markInitialIceRecoveryFailed` 原本内联的"清 watchdog + 置 offline + 退出 connectedPeers"逻辑抽出来直接调用，使 peer 到达同样可操作的 `offline`，不再要求先有一个 PC 才能比对身份。`markInitialIceRecoveryFailed` 自身则改为先做 PC 绑定的 `isInitialIceRecoveryCurrent` 校验，再委托给这个共享终态函数，其余四处既有调用方行为不变。 |
| 2 | `blockPeer()`（`client/src/store/network.ts` ~1744–1768 行）拆除 PC 并调用 `cleanupPeerConnection()`，但从未清除一次性守卫 `initialEncryptedSessionRebuilds`。`cleanupPeerConnection()` 本身不能代为清除——rebuild 分支的写法是先 `add()` 再调用 `cleanupPeerConnection()` 拆旧 PC 建新 PC，若把清除塞进 `cleanupPeerConnection()`，守卫会在刚设上的下一行就被抹掉，一次性语义直接失效。旧实现下，`blockPeer()` 之后同一 sessionId 的重新加入永远读到陈旧的守卫，下一次进入 connected-but-unencrypted 状态时会被短路直接判 `offline`，不会再尝试一次真正的 rebuild | 比照 `PEER_LEFT` 处理器与 `reconnectPeer()` 已有的写法，在 `blockPeer()` 内于 `cleanupPeerConnection()` 之前显式 `initialEncryptedSessionRebuilds.delete(sessionId)`；`cleanupPeerConnection()` 本身保持不变（它已经清理 `disconnectedTimers` / `initialIceRecoveryTimers` 等通用状态，这部分本来就是对的，问题只在守卫集合本身）。 |

新增回归测试（`client/tests/unit/network-negotiation.test.ts`，新增 describe 块，紧跟在 `initial ICE checking recovery` 之后、`BUG-009` 之前）：

- `Finding 1: rebuild rejection identity and the no-PC failure path`
  - `reaches the actionable offline state (never stuck at connecting) when initiateWebRTC rejects before creating any PC` —— 让 rebuild 触发时信令恰好掉线（`signalingStatus` 置为非 `online`），使 `initiateWebRTC()` 在 `whenSignalingReady()` 超时后、创建任何 PC 之前就拒绝。
  - `ignores a stale rebuild rejection once a newer, manually-created replacement connection has taken over the peer` —— 用调用计数把 rebuild 自身的 `generateECDHKeyPair()` 冻结在途中，期间手动 `reconnectPeer()` 造出一个更新、仍在协商（ICE 已连接但 AES 未就绪）的替换连接，再放行陈旧 rebuild 的拒绝，断言该拒绝不改变当前 peer 状态、不改变 `connectedPeers`，且替换连接自身的 watchdog 未被误杀（其后 AES 就绪时仍能正常到达 `online`）。
- `Finding 2: blockPeer() must clear the one-shot encrypted-session rebuild guard`
  - `lets recovery arm again after block → rejoin under the same sessionId` —— 让某 peer 先触发一次 rebuild（守卫置位、产生第 2 个 PC），`blockPeer()` 后以同一 sessionId 重新 `PEER_JOINED` 并再次进入 connected-but-unencrypted 状态，断言这次会创建第 4 个（全新一轮 rebuild 的）PC 且状态为 `connecting`，而不是被陈旧守卫短路直接判 `offline`（仅 3 个 PC）。

红→绿证据：把上述三个新测试连同当时未改动的 `network.ts` 逐一验证（临时在 scratchpad 目录下用一份仅撤销本轮三处编辑、其余保持原样的副本替换源码，运行后原样换回，未涉及任何 git 操作）——三项均按预期失败：(a) 状态停在 `connecting` 而非期望的 `offline`；(b) 状态被错误置为 `offline` 而非应保持的 `connecting`；(c) `created.pcs.length` 停在 `3` 而非期望的 `4`。换回本轮修复后的源码，同一批测试连同 `network-negotiation.test.ts`/`network-cleanup.test.ts`/`network-epoch.test.ts` 共 72 个测试全部通过。

## 最终验证

以下命令在最终源码状态执行并通过：

- `npm test`：server 全部 integration/TURN 脚本通过；client 72 个测试文件、**600** 个测试通过（第十三轮新增 3 个）；UI contract 通过。
- `npm --prefix client run test:e2e -- tests/e2e/auth-recovery.spec.ts`：1/1（8.5 秒）；真实浏览器证明前后端 nonce 一致、实际 peer config 无外部 ICE URL且 relay-only 关闭。
- 冻结源码后 `npm --prefix client run test:e2e -- tests/e2e/offline-recovery.spec.ts --repeat-each=20`：首次后台运行因会话/沙箱在两轮之间被回收而被杀掉（trace 的 `error-context.md` 明确显示 `Channel closed` / `page.goto: Target page, context or browser has been closed`，而非真实用例失败），该次结果作废、不计入证据；改为前台单次调用（大超时）重跑到底，**20/20（5.8 分钟）**，期间源码未被编辑。
- 冻结源码后 `npm --prefix client run test:e2e -- tests/e2e/transfer.spec.ts --repeat-each=3`：12/12（1.9 分钟）；单文件、多文件、文件夹、双接收者广播各三轮。
- 冻结源码后 `npm --prefix client run test:e2e -- --repeat-each=3`：单 worker 依次完成三轮完整套件，结果为 8/8、8/8、8/8（24/24，4.0 分钟），包含每轮 ICE 配置/nonce 断言、真实双端 WebRTC、离线恢复、QR 图像入网和接收产物 SHA-256/字节数校验。
- `npm --prefix client run typecheck`
- `npm --prefix client run typecheck:config`
- `npm --prefix client run typecheck:tests`
- `npm --prefix client run build`
- `VITE_E2E_BUILD_NONCE=misaka-playwright-v1 VITE_E2E_HOST_ICE_ONLY=1 npm --prefix client run build`；production 产物仍包含正常 STUN 配置（`Network-*.js`、`index-*.js` 中可见 `stun:`），且 grep `TEST_MODE_BLOCKED` / `misaka-playwright-v1` / `HOST_ICE_ONLY` / `hostIceOnly` 在全部产物中零命中。
- `VITE_BASE=/subpath-smoke/ npm --prefix client run build:subpath`
- `npm run guard:tests-touched`
- `bash -n deploy/verify-proxy-trust.sh`
- `git diff --check`
- 根 Compose 与生产 Compose 配置展开通过；根栈另以无 `.env` 的实际 build/up/health/env/down 验证。

## 运维边界

- GitHub 分支保护中的 required checks 不能由仓库内容自动强制；管理员仍需按文档把新增 job 设为必需检查。
- CDN 前置部署必须采用 `CDN_PROXY_TOPOLOGY.md` 的可信代理/CIDR 方案，不能信任任意客户端提供的转发头。
- 持久卷升级必须先按 `DEPLOYMENT_MIGRATION.md` 迁移；否则旧匿名卷中的 TURN 与滥用状态不会自动出现在新具名卷。
