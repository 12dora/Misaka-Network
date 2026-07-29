# 前端 / Client

详细规格见 `../docs/` 各文档。

## 快速开始

```bash
cd client
npm install
npm run dev
```

默认监听 `5173` 端口。

## 源码导航（`src/`）

```
src/
├── main.tsx              # 入口
├── App.tsx               # 路由 + 壳层（无独立 router.tsx）
├── index.css             # 设计 token + 全局样式（无 styles/ 目录）
├── config.ts             # 运行时配置加载
├── constants.ts          # 协议/传输编译时常量
├── types.ts
├── components/
│   ├── features/         # LoginCard、SettingsModal、QR、Stats 等
│   ├── layout/           # TopNav
│   └── ui/               # MisakaButton / Card / Dialog 等
├── pages/                # Home / Network / ACGN / Join / Privacy / Terms
├── store/                # Zustand：auth / network / home
├── lib/                  # signaling / webrtc / transfer / crypto / api …
├── hooks/
├── copy/zh-CN/           # UI 文案
├── data/lore.ts          # ACGN 静态文案数据
└── workers/crypto.worker.ts
```

## 配置

### 运行时配置（URL / 部署路径）

配置优先级：**host injection（`window.__MISAKA_CONFIG__`）> `public/config.json` > Vite 环境变量 > 默认值**。

| 变量 / 字段 | 说明 |
|-------------|------|
| `VITE_API_BASE` / `API_BASE` | 信令服务 API 基础 URL，留空则与前端同源 |
| `VITE_WS_URL` / `WS_URL` | WebSocket URL，留空则自动根据协议推导 |
| `VITE_BASE` | **唯一**部署子路径（GitHub Pages 等）。没有 `VITE_APP_BASE` / `APP_BASE` |

本地开发复制 `.env.example` 为 `.env` 后修改；生产静态部署编辑 `public/config.json`，或由宿主注入 `window.__MISAKA_CONFIG__`。

### 编译时常量（协议参数）

分片大小、超时、STUN、心跳等硬编码参数统一在 [`src/constants.ts`](src/constants.ts)。

## 关键依赖

```json
{
  "react": "^18",
  "react-router-dom": "^6",
  "zustand": "^4",
  "qrcode": "^1",
  "jsqr": "^1",
  "idb": "^8"
}
```

传输完整性依赖 **AES-GCM 分片**（`lib/crypto.ts` + `lib/transfer.ts`），没有整文件流式 SHA-256 依赖。

## 构建

```bash
npm run build
```

输出到 `dist/`，可部署到 Cloudflare Pages / Vercel / 任何静态托管。
