# 开发进度追踪

> 本文件由编码 AI 维护。每次会话开始读，结束前更新。
> ☐ 未开始 / ◐ 进行中 / ☑ 已完成。只写「现在到哪了」，不写日志。

## 当前里程碑

**v2 — 生产就绪 & 鲁棒性**

## v1 — MVP（完成）

☑ 信令服务器 / 身份 / 首页 / 网络页 / WebRTC 传输（加密 + 续传） / ACGN / QR 三类 / TURN 设置 / 安全（通行码 hash、黑名单、上报、ToS&Privacy） / 聊天 / GitHub Pages 部署

> 详细模块勾选见 git log d858a4e 之前。代码已落地，未真机验证。

## v2 — 生产就绪 & 鲁棒性

☑ QA bug 修复完成（BUG-1 ~ BUG-8）— 见 docs/bug.md

### 2.1 真机 / 实网端到端验证
- ☐ PC ↔ 手机 QR 扫码加入（同 LAN、跨 NAT、Chrome/Safari/Firefox 矩阵）
- ☐ TURN 中继实装（部署 coturn，自托管）
- ☐ ICE 路径实测（host → srflx → relay 优先级）
- ☐ iOS Safari / Android Chrome 兼容（BarcodeDetector 降级、IndexedDB 配额、AES-GCM）

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
- ☐ 部署到 Railway / 自托管（HTTPS + WSS）
- ☑ /api/metrics（real CPU + peak concurrent + uptime）
- ☑ 异常退出通知对端（SERVER_SHUTDOWN + WS 1001 关闭码）
- ☑ 通行码暴力穷举集成测试（server/tests/brute-force.test.mjs）

### 2.5 容错 UI
- ☑ ConnectionDiagnostics（peer info bar 显示 reconnecting / offline 状态 + 诊断提示）
- ☑ 失败提示人话化（humanizeError 函数 + TaskPanel 友好错误消息）
- ☑ 网络切换自动重连（window.online 事件触发 doConnect）

## v3 — 打磨 & 沉浸感

### 3.1 NodeRadar 可视化
- ☐ Canvas 极坐标雷达（替换列表）
- ☐ 距离 = ICE RTT，角度 = 节点编号 mod 360
- ☐ 扫描线（节制，不走赛博风）
- ☐ Hover peer 详情卡

### 3.2 传输历史
- ☐ IndexedDB schema：transfers 表
- ☐ Network 页「历史」Tab
- ☐ 再传 / 查看本地副本 / 删除
- ☐ 隐私开关：关闭记录

### 3.3 PWA
- ☐ Service Worker（app shell 离线）
- ☐ Manifest + 图标
- ☐ Installable 提示
- ☐ Background Sync 评估

### 3.4 主题 & 视觉
- ☐ 浅 / 深 / 妹妹色三主题
- ☐ 设置面板主题切换
- ☐ Reduced-motion 兼容
- ☐ 字体子集化

### 3.5 彩蛋 & 沉浸
- ☑ 关键编号（10032 / 9982 / 20001）特殊提示
- ☑ 妹妹语录穿插 ActivityStream
- ☑ 音效（扫码 / 完成 / 错误，可关）
- ☑ ACGN 世界观长文 + 时间线

### 3.6 i18n（可选）
- ☐ 中 / 日 / 英
- ☐ 设计 token 术语表分语言

### 3.7 性能
- ☑ 路由级懒加载 + bundle 拆分
- ◐ Lighthouse 90+（已做性能侧拆包 / worker；需浏览器 Lighthouse 实测）
- ☑ 大文件 hash 走 Web Worker

## 当前会话焦点

网络收敛修复：接收文件卡片去重（单文件单卡片）；节点雷达未读提示与单节点自动展开会话（含动画）；文件接收浏览器通知；全站页脚仅保留作者 Master Huang 与 GitHub 链接。

接收文件改为手动下载：文件接收完成后不再自动触发浏览器下载，而是在聊天框插入文件卡片（显示文件名 + 大小 + "↓ 下载"按钮），点击后才开始下载，下载后按钮变为"✓ 已下载"。

## 已知问题

- TURN 中继未实际部署测试
- QR 扫码加入流程需真机端到端测试
- 接收端 DataChannel 监听器有重复绑定风险（已用 addEventListener 规避，待复核）
- File System Access API 仅在 Chromium 系浏览器可用，Safari/Firefox 使用 OPFS 磁盘缓存替代（相同效果）
- OPFS 写入可能因磁盘配额不足失败 → 自动降级 IndexedDB + Blob 内存组装
- Lighthouse 90+ 尚未在真实浏览器环境跑分，仅完成代码侧优化与生产构建验证
- QR token 单次使用：同一复制链接完成一次接入后再次打开会提示过期 / 已使用，需要重新生成 QR
- 浏览器通知依赖用户授权；若用户拒绝，仍可正常收发文件，仅不弹系统通知
- 页脚规范：各页面底部仅保留 `© Master Huang · Misaka Network` 与 GitHub 链接；设置页 About 同步保持一致

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
- QR join：`/join` 以链接 `id` 覆盖本机 nodeId，`c` 存在时 base64 解码为通行码并自动注册；`c` 缺失或错误时停在通行码输入卡片，不再要求先返回首页注册
- 接收卡片去重：`deliverCompletedFile` 以 `transferId` 去重，防止同一传输在并发回调下重复插入 file 消息
- 未读与通知：`unreadByPeer` 记录每节点消息/文件未读数；收到文件时若页面在后台且通知权限已授权，触发系统 Notification
