# 开发进度追踪

> 本文件由编码 AI 维护。每次会话开始读，结束前更新。
> ☐ 未开始 / ◐ 进行中 / ☑ 已完成。只写「现在到哪了」，不写日志。

## 当前里程碑

**v2 — 生产就绪 & 鲁棒性**

## v1 — MVP（完成）

☑ 信令服务器 / 身份 / 首页 / 网络页 / WebRTC 传输（加密 + 续传） / ACGN / QR 三类 / TURN 设置 / 安全（通行码 hash、黑名单、上报、ToS&Privacy） / 聊天 / GitHub Pages 部署

> 详细模块勾选见 git log d858a4e 之前。代码已落地，未真机验证。

## v2 — 生产就绪 & 鲁棒性

☑ QA bug 修复完成（BUG-1 ~ BUG-8）— 见 docs/archive/bug.md

### 2.6 五轴 QA 整治（2026-05-24）

并行 sub-agent A/B/C/D 修复 + 主 agent 串行收尾。覆盖 ~50 项 P0/P1/P2 + 设计建议。

**A 服务端**：WS `verifyClient` Origin 白名单、5s AUTH grace、scrypt + per-node salt 通行码哈希（兼容老 sha256 迁移）、qr-redeem 限频、qr-token passcode `^\d{6}$`、`/api/register` Origin 校验、per-nodeId 全局暴破冻结（跨 IP）、CF revoke 失败保留+后台重试、attemptLocks 持久化、`PEER_OFFLINE` 反馈、`express.json({limit:'64kb'})`、活动广播订阅化、customIdentifier 不可逆派生+日志脱敏

**B 客户端网络**：移除致命的 `iceCandidatePoolSize=4` + `setConfiguration` 冲突路径（TURN 凭证轮转才真正生效）、TURN 503 指数退避、IPv6-only 分类为 `cone-v6`（不再误报阻断）、`whenSignalingStable` 替代盲跳过、`endOfCandidatesFor` 兼容 Firefox 空 sdpMid、`installIceErrorListener` + `getLastIceError` 诊断、`testTurnServer` listener 清理、`invalidateDetectedNatType` 在 online/visibilitychange 触发

**C 传输/存储**：`prepareReceiveStorage` 三段回退（FSA → OPFS probe → IDB）激活 Chrome FSA 死代码、`cancelReceive` 异步等 in-flight saveChunk、多 lane race 用 sentBitmap 去重（再无重发漏 sent）、dup chunk 短路、`MAX_FILE_SIZE=16GB` sender guard、`QuotaExceededError` 统一捕获、`OPFSReceiveHandle.written` 改 bitmap、OPFS removeEntry 精确匹配、`makeChunkIv` 混入 transferId 哈希、`waitWhilePaused` Promise + signal 替代 200ms 轮询、IDB 范围删替代全表 keys

**D UI/PWA**：离线 peer "立即重连此节点" 按钮、Join 页 IP_LIMITED 内联释放、接收端暂停按钮、群发入口空 drop 区也可达、节点雷达卡键盘可达、单 peer 自动选中 + activeTab guard、ScanModal 失败 toast、LoginCard 通行码 fieldset/legend、MisakaButton disabled 视觉态、SW 预缓存 + UpdateBanner、`formatBytes/Speed` 统一 1024 + 自适应单位、主 toast `role="status" aria-live`

**主 agent 收尾**：types/constants 共享字段、store/network.ts 接 B/C 集成点（NAT invalidate、whenSignalingStable、endOfCandidatesFor、IceErrorListener、prepareReceiveStorage、opfsWrittenCount、PEER_OFFLINE）、store/auth.ts passCode 不入 sessionStorage / BAD_ORIGIN+NODE_FROZEN 文案 / `navigator.locks` 多 tab 互斥、4 store actions（reconnectPeer / pause+resume+cancelReceiveTransfer）、3 新 E2E spec（offline-recovery / qr-invite / receiver-pause）

测试基线：client **176/176** unit + contract 全绿；server **9 个新测试文件 / 25 用例** 全绿；新增 ENV 见 `.env.example`

### 2.1 真机 / 实网端到端验证
- ☑ PC ↔ 手机 QR 扫码加入（已测试）
- ☑ TURN 中继自动下发（Cloudflare Realtime TURN，短时效凭证 + customIdentifier + 防滥用 policy + 1T 熔断 + 持久化）
- ◐ TURN 中继实战验证（CF Token 配置 + 真实公网流量打点未做）
- ◐ ICE 路径实测（host → srflx → relay 优先级；已补前端 ICE 路径可视化，待实网逐项打点）
- ☒ iOS Safari / Android Chrome 兼容真机矩阵（本阶段不做真机矩阵；仅保留通用降级逻辑）

### 2.2 多对等节点（multi-peer）
- ☑ NodeRadar 同时管理 N 个 PeerConnection（Map 隔离，已实现）
- ☑ TransferChannel 向多节点 fanout 同一文件（sendFileToAll + UI 按钮）
- ☑ peer 状态机：online / connecting / reconnecting / transferring / offline / unauthorized
- ☑ 单 peer 失败不影响其他（per-nodeId Maps 隔离）

### 2.3 传输容错
- ☑ DataChannel 断开自动重协商（ICE restart，最多 3 次，含 full reconnect 降级）
- ☑ 续传从对端真实 chunk bitmap 拉取（sender 接收 ResumeRequest 后使用 peerReceivedChunks）
- ☑ 取消 / 暂停 / 恢复 三按钮 + 传输信号机
- ☑ 大文件流式写盘（File System Access API + Blob 拼接降级）
- ☑ 1GB 文件内存压测（server/tests/stress-1gb.test.mjs）— sender +1.6MB / streaming +0MB / Blob 组装峰值 1.7GB

### 2.4 信令服务器加固
- ◐ 自托管部署（已补 Caddy + docker-compose 生产模板与 /api/health；实际服务器部署未做）
- ☑ /api/metrics（real CPU + peak concurrent + uptime）
- ☑ 异常退出通知对端（SERVER_SHUTDOWN + WS 1001 关闭码）
- ☑ 通行码暴力穷举集成测试（server/tests/brute-force.test.mjs）

### 2.5 容错 UI
- ☑ ConnectionDiagnostics（peer info bar 显示 reconnecting / offline 状态 + 诊断提示）
- ☑ 失败提示人话化（humanizeError 函数 + TaskPanel 友好错误消息）
- ☑ 网络切换自动重连（window.online 事件触发 doConnect）
- ☑ 聊天消息送达状态（WhatsApp 风格：⏳ 发送中 / ✓ 已发送 / ✓✓ 已送达 / ↺ 重试）
- ☑ 重连系统提示（断线时 "⚠ 连接中断"，恢复时 "✓ 连接已恢复"，放弃时 "连接已断开"）

### 2.6 NAT 穿透增强
- ☑ STUN 池扩展至 10 个服务器（bundlePolicy max-bundle + iceCandidatePoolSize 4）
- ☑ SIGNAL_ICE_END 端到端候选结束信令（加快对端 ICE agent 收敛）
- ☑ ICE disconnected 5s 主动重启（不等浏览器 30s failed 超时）
- ☑ ICE restart 指数退避（1/2/4/8/16s，最多 5 次，超过降级 full reconnect）
- ☑ NAT 类型检测卡（Settings → TURN 标签：open/cone/symmetric/blocked）
- ☑ nat-classify.ts 纯逻辑分离 + 18 个单元测试（client/tests/nat-classify.test.mjs）
- ☑ SIGNAL_ICE_END 集成测试（server/tests/signaling-end.test.mjs）

## v3 — 打磨 & 沉浸感

### 3.1 NodeRadar 可视化
- ☒ 不做（保留当前列表式节点雷达，优先可靠传输与清晰操作）

### 3.2 传输历史
- ☒ 不做（双方退出 session 即销毁，不保留历史记录）

### 3.3 PWA
- ☑ Service Worker（app shell 离线）
- ☑ Manifest + 图标
- ☑ Installable 提示
- ☑ Background Sync 评估（当前不接入：实时 WebRTC/WS 会话不适合离线排队语义）

### 3.4 主题 & 视觉
- ☒ 不做主题系统 / 字体子集化（保留现有单一视觉风格）

### 3.5 彩蛋 & 沉浸
- ☑ 关键编号（10032 / 9982 / 20001）特殊提示
- ☑ 妹妹语录穿插 ActivityStream
- ☑ 音效（扫码 / 完成 / 错误，可关）
- ☑ ACGN 世界观长文 + 时间线

### 3.6 i18n（可选）
- ☒ 不做多语言系统
- ☑ 文案一致性修复：核心操作界面统一中文；ACGN / 世界观内容保留必要日文氛围

### 3.7 性能
- ☑ 路由级懒加载 + bundle 拆分
- ☑ Lighthouse 90+（2026-05-14 实测 desktop：首页 Performance 99）
- ☑ 大文件 hash 走 Web Worker

## 当前会话焦点

TURN 自动下发落地：服务端按 sessionId 申请 Cloudflare 短时效凭证（默认 5 min TTL），客户端 prefetch + 自动续期。所有防滥用 enforcement 在服务端（deny list / 每 IP 字节 + 频率 / 1T 月度熔断 / CF revoke），客户端只是消费方。状态持久化到 `data/turn-state.json`（原子写）。Settings 中继 tab 顶部展示自动 TURN 状态 + 月度用量进度条；手工 TURN 列表保留。待完成：CF Token 真实配置 + 端到端流量验证。

## 已知问题

- TURN 与自托管链路仍缺真实公网验证（含域名证书签发、80/443 入站、防火墙、coturn relay 可达性）
- ICE 三场景（host/srflx/relay）尚未实测；已支持复制诊断文本留痕（节点/信道/ICE路径/采集时间/状态）
- Service Worker 当前仅做 app shell + 静态资源离线缓存；`/api` 与 `/ws` 不缓存（实时信令与会话语义保持在线优先）
- PWA 图标当前使用 `favicon.svg` 作为 manifest icon（`purpose: any maskable`）；后续如需商店级上架可再补 192/512 位图资源
- File System Access API 仅在 Chromium 系浏览器可用，Safari/Firefox 使用 OPFS 磁盘缓存替代（相同效果）
- OPFS 写入可能因磁盘配额不足失败 → 自动降级 IndexedDB + Blob 内存组装
- Lighthouse 已完成 desktop 实测；移动端与弱网分数仍建议后续补测（当前项仅以 desktop 达标闭环）
- QR token 单次使用：同一复制链接完成一次接入后再次打开会提示过期 / 已使用，需要重新生成 QR
- 浏览器通知依赖用户授权；若用户拒绝，仍可正常收发文件，仅不弹系统通知
- 页脚规范：各页面底部仅保留 `© Master Huang · Misaka Network` 与 GitHub 链接；设置页 About 同步保持一致
- 页脚组件化：Home / ACGN 复用同一 `AppFooter` source，后续统一改版仅需改一处
- 不做项：NodeRadar Canvas 可视化、传输历史、多主题、多语言完整 i18n、移动端真机兼容矩阵

## 决策记录（精简）

- ws 而非 socket.io；chunk 64KB；设计 token 走 CSS vars + Tailwind extend
- 服务端全内存，无持久化；速率限制滑动窗口；上报保留 1h
- chunk 加密：iv(12B) + ciphertext 单帧；DataChannel 文本头 + 二进制体双消息
- ECDH 在 DataChannel open 后第一帧交换，30s 超时
- 对等发现：identity-scoped cluster — channelId = `cluster-<nodeId>-<SHA-256(passcode).slice(0,16)>`，仅同 nodeId+passcode 的设备相互可见。允许多设备共享同一身份（手机/电脑同时在线）
- 路由身份分离：每个 WS session 持有唯一 sessionId（nanoid 16），nodeId 用于显示与聚类，sessionId 用于 WebRTC 信令与 DataChannel 路由
- 自动建链：WELCOME 后客户端自动发 JOIN_CLUSTER；服务端在 PEER_JOINED 中标记 shouldInitiate，仅"新到达者"主动发 SDP offer，避免 glare
- 取消 CONNECT_REQ / verify-passcode：cluster 内成员同身份天然互信，不再二次握手
- DataChannel 必须显式设置 `binaryType='arraybuffer'`：默认 'blob' 会让接收端 `instanceof ArrayBuffer` 校验失败，文件 chunk 整段被静默丢弃
- DataChannel onopen 必须处理"已 open"竞态：answerer 侧通过 `pc.ondatachannel` 拿到的 channel 可能已在监听器附加前完成 open；附加前先比较 `dc.readyState`
- 聊天发送策略：即使 DC 暂未 open 也立即写入本地 chatMessages（用户操作必有反馈），同时把序列化后的 payload 入队，dc.onopen 中 flush
- ChannelMessage 增加 direction: 'sent' | 'recv' | 'system'，UI 右对齐展示自己发的消息、左对齐对方
- WebRTC 改用 trickle ICE：createOffer / createAnswer / ICE restart 在 setLocalDescription 后立即返回 SDP，候选通过 onicecandidate → SIGNAL_ICE 流式发送。原先等 `iceGatheringState === 'complete'` 的实现误用 `{ once: true }`，第一次 `new → gathering` 状态变化触发后监听器被自动移除，后续 `complete` 永远收不到 → 握手挂起 15s → "DataChannel 打开超时"
- store.init() 必须幂等（模块级 `initialized` flag）：React 18 StrictMode 开发态会让 useEffect 双调用，第二次会重复 onMessage 注册导致每个信令被处理两次，引发并发 setRemoteDescription/setLocalDescription 触发 `Called in wrong state: stable`
- signaling.doConnect 在 readyState === CONNECTING 时也直接 return，并把 socket 引用绑到 onopen 闭包里（用局部 `sock` 变量而不是模块级 `ws`），避免重连/重试期间老 ws 的 onopen 引到刚替换的新 ws 上调用 send，触发 "Still in CONNECTING state"
- 前端配置三级：public/config.json + window.__MISAKA_CONFIG__ + VITE_ env
- GitHub Pages：VITE_BASE 控制 base path；404.html + sessionStorage 恢复路径
- 聊天复用 DataChannel，JSON 文本 type='chat'，不新增协议
- ICE restart：最多 3 次 ICE restart 后 fallback 到 full reconnect（新 PC + 新 DC）
- 续传：sender 使用 ResumeRequest 中 peer 上报的 receivedChunks 作 skipSet，不再信任本地乐观记录
- 传输控制：transferSignals Map 提供 per-transfer 的 pause/cancel 信号，send loop 轮询
- 大文件写入：优先 File System Access API 流式写盘 → OPFS 磁盘缓存（Chrome 86+/Safari 15.2+/Firefox 111+）→ 老旧浏览器降级 IndexedDB + Blob 组装
- 网络切换重连：监听 window.online 事件直接调用 doConnect()，复用现有指数退避
- 信令关闭通知：SERVER_SHUTDOWN 消息 + WS 1001 关闭码，客户端标记 serverShutdown 阻止重连
- 1GB 压测：sender 流式路径 heapUsed +1.6MB（安全）；接收端流式写盘 +0MB（安全）；Blob 组装降级峰值 RSS 1.7GB（仅 Safari/Firefox 降级路径，可用）
- OPFS 磁盘缓存：利用 navigator.storage.getDirectory() 在接收时逐 chunk 落盘，完成后 getFile() 获取引用而非常驻内存。OPFS 所有现代浏览器均支持，替换了 IndexedDB + Blob 全量组装的降级路径，避免 10GB 文件撑爆 JS heap
- 接收文件手动下载：deliverCompletedFile 不再调用 triggerDownload，改为在 chatMessages 插入 type='file' 的消息（含 fileName/fileSize/downloadUrl 字段）；ChannelChat 对 type='file' 消息渲染文件卡片 + "↓ 下载"按钮；点击后触发下载并 revokeObjectURL，按钮变为"✓ 已下载"
- v3 沉浸：特殊节点 9982 / 10032 / 20001 在登录卡展示 lore hint；ActivityStream 每 45s 注入一条妹妹语录；设置面板增加音效开关，扫码 / 完成 / 错误音效由 WebAudio 合成且默认开启
- v3 性能：路由改 React.lazy + Suspense；Vite manualChunks 拆出 react / qr / hash；整文件 SHA-256 优先交给 module worker，失败时降级主线程分块 hash
- ICE 观测增强：连接成功后从 `pc.getStats()` 读取 nominated `candidate-pair`，在 Network 信息栏展示 `localType/proto → remoteType/proto`（如 `host/udp → host/udp`、`srflx/udp → srflx/udp`、`relay/tcp → relay/tcp`），用于 host → srflx → relay 实测留痕
- PWA 起步：新增 `public/sw.js` 并在 `main.tsx` 注册；采用 app shell 缓存与导航离线回退（`index.html`），静态资源走缓存优先，`/api` 与 `/ws` 始终直连网络
- PWA 安装链路：新增 `manifest.webmanifest` 并在 `index.html` 挂载；TopNav 监听 `beforeinstallprompt/appinstalled`，在可安装时显示「安装应用」入口
- Background Sync 评估结论：暂不接入。当前核心是实时信令 + DataChannel 直连，离线队列重放易引入会话时序歧义；保留为后续“非实时任务”能力再评估
- Lighthouse 达标实测：使用 `vite preview` + Lighthouse desktop preset 对首页跑分；首屏提速主要来自两点——`index.html` 字体请求收敛（移除非首屏 serif 字体）与 Home 首图 `fetchPriority=\"high\" + eager`，最终首页 Performance 99（LCP 0.8s / FCP 0.4s）
- 自托管部署模板化：新增 `deploy/docker-compose.prod.yml` 与 `deploy/Caddyfile.example`，支持 HTTPS/WSS 反代 + 自动证书；服务端新增 `/api/health` 作为容器健康检查与上线验活入口
- ICE 实测支撑增强：Peer 增加 `icePathMeasuredAt`，Network 信息栏展示采集时间，并提供“复制诊断”按钮，输出可直接用于 host/srflx/relay 实测记录
- TURN 模板化：新增 coturn docker compose 与 `turnserver.conf.example`（含端口段、凭据、realm、external-ip），降低中继上线门槛
- DataChannel 监听器幂等防护：新增 `configuredDataChannels`（WeakSet）确保同一 channel 只绑定一次，消除重连竞态下重复绑定风险
- 消息送达状态：`ChannelMessage.status` 字段（sending/sent/delivered/failed）；`outgoingQueue` 由 `queuedMessageIds` Map 追踪入队 msgId，flush 时统一标 sent；接收方收到 chat 后发 `msg-ack`，发送方收 ack 后标 delivered；断线清理时未发出的消息标 failed；UI 显示 ⏳/✓/✓✓/↺ 重试图标
- 重连系统消息策略：ICE disconnected（前状态 transferring）→ 在 chatMessages 插入 "⚠ 连接中断" 系统消息；DC onopen（有历史聊天记录）→ 插入 "✓ 连接已恢复"；ICE restart 耗尽 → 插入 "连接已断开" + failPendingMessages
- NAT 纯逻辑分层：nat.ts（浏览器入口，依赖 RTCPeerConnection）与 nat-classify.ts（纯函数，无 DOM 依赖，可在 Node 测试环境中直接 import）分开，解决 tsx 无法解析 @/ alias 的测试限制
- SIGNAL_ICE_END：候选收集结束（onicecandidate e.candidate === null）时通过信令服务器转发给 peer；接收方调用 `pc.addIceCandidate({ candidate: '' })` 通知 ICE agent 对端已停止收集，加快连接性检测收敛
- QR join：`/join` 以链接 `id` 覆盖本机 nodeId，`c` 存在时 base64 解码为通行码并自动注册；`c` 缺失或错误时停在通行码输入卡片，不再要求先返回首页注册
- 接收卡片去重：`deliverCompletedFile` 以 `transferId` 去重，防止同一传输在并发回调下重复插入 file 消息
- 未读与通知：`unreadByPeer` 记录每节点消息/文件未读数；收到文件时若页面在后台且通知权限已授权，触发系统 Notification
- 部署标准化：根目录新增 `docker-compose.yml`，后端新增多阶段 `server/Dockerfile`；README 统一提供前后端部署步骤与 `config.json` 运行时后端地址配置方案
- TURN 自动下发安全模型：客户端零 enforcement（可被 hook 绕过），所有黑名单/字节配额/熔断在服务端内存维护；CF 短时效凭证（默认 300s）是 revoke 失败的兜底，配合 CF revoke API 做主动吊销。`customIdentifier=misaka-${sessionId}` 用于 CF Analytics 按用户细粒度查询。API Token 仅从 env 读取、绝不进日志或响应
- TURN 防滥用 policy 全部 env 可配（单 session 字节上限 / 每 IP 字节 + 签发频率 / 全局月度 1T 90% 熔断 / 凭证 TTL / 轮询周期 / 封禁时长）；pessimistic byte 估算 + Analytics 校准双路径（Analytics 有 1~5 min 延迟，pessimistic 走零延迟快路径）
- TURN 状态持久化：`server/data/turn-state.json` 原子写（writeFile .tmp + rename），10s 节流批量写 + 关键事件即时写 + 关停 graceful flush。仅 TURN 数据持久化；nodes / channels / qrTokens / reports 维持原内存策略
- 部署密钥：`TURN_CF_KEY_ID / TURN_CF_API_TOKEN / TURN_CF_ACCOUNT_TAG` 走根目录 `.env`（已加入 .gitignore），compose 用 `env_file` 引用；`.env.example` 仅占位提示
