# 御坂网络 · MISAKA NETWORK

零注册、强隐私、跨设备的 P2P 文件传输 Web APP，以《某科学的超电磁炮》「妹妹网络」为美学骨架。

## 项目文档导航

所有设计与开发文档在 `docs/` 目录下，**按功能拆分，便于编码 AI 按需读取，避免上下文膨胀**：

| 文档 | 用途 | 何时读取 |
|---|---|---|
| `docs/00-overview.md` | 产品定位、信息架构、技术栈 | 项目启动时必读 |
| `docs/01-design-system.md` | 视觉规范、配色、术语对照表 | 写 UI 时读取 |
| `docs/02-pages-home.md` | 首页页面规格 | 开发首页时读取 |
| `docs/03-pages-network.md` | 网络页（核心传输页）规格 | 开发网络页时读取 |
| `docs/04-pages-acgn.md` | ACGN 世界观页规格 | 开发 ACGN 页时读取 |
| `docs/05-auth-identity.md` | 登录/身份/会话机制 | 实现登录时读取 |
| `docs/06-webrtc-transfer.md` | WebRTC 连接、分片、断点续传 | 实现传输时读取 |
| `docs/07-signaling-server.md` | 信令服务器接口与数据结构 | 实现服务端时读取 |
| `docs/08-qr-system.md` | QR 扫码三种类型设计 | 实现 QR 功能时读取 |
| `docs/09-turn-settings.md` | TURN 用户自配置说明 | 实现设置页时读取 |
| `docs/10-security-privacy.md` | 加密、通行码、黑名单 | 实现安全特性时读取 |
| `docs/PROGRESS.md` | **开发进度追踪（编码 AI 自动维护）** | 每次会话开始/结束时读写 |
| `docs/PROMPTS.md` | **给编码 AI 的提示词模板** | 启动编码会话时使用 |

## 目录结构

```
misaka-network/
├── README.md                 # 本文件
├── docs/                     # 所有设计文档（拆分式）
├── server/                   # 信令服务器（Node.js）
│   └── README.md             # 服务端说明
└── client/                   # 前端 Web APP
    └── README.md             # 前端说明
```

## 快速开始

1. 阅读 `docs/00-overview.md` 了解产品
2. 阅读 `docs/PROMPTS.md` 获取编码 AI 的启动提示词
3. 第一次编码会话：让 AI 读 `docs/00-overview.md` + `docs/PROGRESS.md`，然后让它选择从哪个模块开始
4. 每次会话结束前，让 AI 更新 `docs/PROGRESS.md`

## 设计原则

- **零服务端文件存储**：文件本体永不上服务器
- **零注册**：节点编号 + 通行码即用
- **TURN 自托管**：默认不启用，用户在设置中手动配置
- **世界观沉浸**：所有 UI 文案符合原著设定
