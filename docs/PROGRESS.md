# 开发进度追踪

> **本文件由编码 AI 维护**。每次会话开始时读取，结束前更新。
> 
> 规则：保持简洁。每个模块用 ☐/◐/☑ 标记。不要写长篇日志，只写「现在到哪了」。

## 当前里程碑

**MVP v1**

## 整体进度

### 项目初始化
- ☐ 信令服务器项目脚手架（Node.js + ws）
- ☐ 前端项目脚手架（Vite + React + TS + Tailwind）
- ☐ 设计 token 配置（颜色/字体/间距）
- ☐ 基础 UI 组件库（MisakaButton/Card/Input）
- ☐ 路由配置

### 信令服务器（参考 07-signaling-server.md）
- ☐ REST `/api/register`
- ☐ REST `/api/release`
- ☐ REST `/api/verify-passcode`
- ☐ REST `/api/stats`
- ☐ WebSocket 鉴权与 JOIN_CHANNEL
- ☐ SIGNAL_SDP / SIGNAL_ICE 转发
- ☐ 活动流广播
- ☐ QR token 接口（/api/qr-token, /api/qr-redeem）
- ☐ 30 分钟会话清理任务
- ☐ 限流与防护

### 身份系统（参考 05-auth-identity.md）
- ☐ 客户端身份生成
- ☐ sessionStorage 持久化
- ☐ 编号冲突重试
- ☐ 通行码错误锁定
- ☐ 会话恢复

### 首页（参考 02-pages-home.md）
- ☐ TopNav
- ☐ LoginCard（未登录态）
- ☐ LoginCard（已登录态）
- ☐ StatsDashboard
- ☐ ActivityStream
- ☐ QuickJoin

### 网络页（参考 03-pages-network.md）
- ☐ 三栏布局框架
- ☐ NodeRadar
- ☐ TransferChannel（拖拽 + 选择文件）
- ☐ TaskPanel
- ☐ 接收确认 Modal
- ☐ 移动端 Tab 布局

### WebRTC 传输（参考 06-webrtc-transfer.md）
- ☐ Peer connection 工厂
- ☐ DataChannel 建立
- ☐ 文件分片发送
- ☐ chunk 接收 + ACK
- ☐ 整文件 hash 校验
- ☐ IndexedDB 进度持久化
- ☐ 断点续传
- ☐ AES-GCM 应用层加密

### ACGN 页（参考 04-pages-acgn.md）
- ☐ 静态文案
- ☐ 角色卡片
- ☐ 妹妹语录生成器
- ☐ 实验体编号查询
- ☐ 致敬声明页脚

### QR 系统（参考 08-qr-system.md）
- ☐ QR 生成（节点 QR）
- ☐ 显示我的 QR 弹窗
- ☐ 扫码 UI（BarcodeDetector）
- ☐ jsQR 降级
- ☐ 自动接入流程
- ☐ 文件 QR
- ☐ 批次 QR

### TURN 设置（参考 09-turn-settings.md）
- ☐ 设置页 UI
- ☐ TURN 配置 localStorage
- ☐ 连接测试功能
- ☐ 集成到 ICE 配置

### 安全（参考 10-security-privacy.md）
- ☐ 通行码 hash
- ☐ 节点锁定机制
- ☐ 黑名单 localStorage
- ☐ 上报接口
- ☐ ToS / Privacy 页

## 当前会话焦点

> （此处由编码 AI 在每次开始时填写本次要做的具体任务）

## 已知问题

> （此处由编码 AI 记录待解决的 bug 或技术债，每条一行）

## 决策记录

> （此处记录关键技术决策，每条一行）

例如：
- 2026-05-12: 采用 ws 而非 socket.io，减少依赖
- 2026-05-12: chunk size 定为 64KB，平衡内存与吞吐
