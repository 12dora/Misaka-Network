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
- ☐ TURN 中继实装（部署 coturn，Fly.io 或自托管）
- ☐ ICE 路径实测（host → srflx → relay 优先级）
- ☐ iOS Safari / Android Chrome 兼容（BarcodeDetector 降级、IndexedDB 配额、AES-GCM）

### 2.2 多对等节点（multi-peer）
- ☐ NodeRadar 同时管理 N 个 PeerConnection
- ☐ TransferChannel 向多节点 fanout 同一文件
- ☐ peer 状态机：disconnected / connecting / ready / transferring / error
- ☐ 单 peer 失败不影响其他

### 2.3 传输容错
- ☐ DataChannel 断开自动重协商（ICE restart）
- ☐ 续传从对端真实 chunk bitmap 拉取，而非从 0
- ☐ 取消 / 暂停 / 恢复 三按钮 + 状态机
- ☐ 大文件流式写盘（File System Access API + Blob 拼接降级）
- ☐ 1GB 文件内存压测

### 2.4 信令服务器加固
- ☐ 部署到 Fly.io / Railway（HTTPS + WSS）
- ☐ /api/metrics（节点数、活跃信道、QPS）
- ☐ 异常退出通知对端（CLOSE + reason）
- ☐ 通行码暴力穷举集成测试

### 2.5 容错 UI
- ☐ ConnectionDiagnostics（candidate 列表、当前路径、RTT）
- ☐ 失败提示人话化（提示开 TURN 等）
- ☐ 网络切换（Wi-Fi → 4G）自动重连

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
- ☐ 关键编号（10032 / 9982 / 20001）特殊提示
- ☐ 妹妹语录穿插 ActivityStream
- ☐ 音效（扫码 / 完成 / 错误，可关）
- ☐ ACGN 世界观长文 + 时间线

### 3.6 i18n（可选）
- ☐ 中 / 日 / 英
- ☐ 设计 token 术语表分语言

### 3.7 性能
- ☐ 路由级懒加载 + bundle 拆分
- ☐ Lighthouse 90+
- ☐ 大文件 hash 走 Web Worker

## 当前会话焦点

待 v2 启动。建议优先：2.1 真机验证 + 2.4 部署信令到 Fly.io。

## 已知问题

- TURN 中继未实际部署测试
- QR 扫码加入流程需真机端到端测试
- 接收端 DataChannel 监听器有重复绑定风险（已用 addEventListener 规避，待复核）

## 决策记录（精简）

- ws 而非 socket.io；chunk 64KB；设计 token 走 CSS vars + Tailwind extend
- 服务端全内存，无持久化；速率限制滑动窗口；上报保留 1h
- chunk 加密：iv(12B) + ciphertext 单帧；DataChannel 文本头 + 二进制体双消息
- ECDH 在 DataChannel open 后第一帧交换，30s 超时
- 对等发现：SHA-256(passcode).slice(0,16) 作 channel；QR 可覆盖
- 前端配置三级：public/config.json + window.__MISAKA_CONFIG__ + VITE_ env
- GitHub Pages：VITE_BASE 控制 base path；404.html + sessionStorage 恢复路径
- 聊天复用 DataChannel，JSON 文本 type='chat'，不新增协议
