# 前端 / Client

详细规格见 `../docs/` 各文档。

## 快速开始

```bash
cd client
npm install
npm run dev
```

默认监听 `5173` 端口。

## 推荐目录结构

```
client/
├── package.json
├── vite.config.ts
├── tsconfig.json
├── tailwind.config.js
├── postcss.config.js
├── index.html
├── public/
└── src/
    ├── main.tsx
    ├── App.tsx
    ├── router.tsx
    ├── styles/
    │   ├── globals.css
    │   └── tokens.css       # 设计 token（颜色/字体/间距）
    ├── components/
    │   ├── common/          # MisakaButton/Card/Input/QR 等
    │   ├── home/
    │   ├── network/
    │   └── acgn/
    ├── pages/
    │   ├── HomePage.tsx
    │   ├── NetworkPage.tsx
    │   ├── AcgnPage.tsx
    │   └── SettingsModal.tsx
    ├── stores/              # Zustand
    │   ├── authStore.ts
    │   ├── networkStore.ts
    │   ├── transferStore.ts
    │   └── settingsStore.ts
    ├── services/
    │   ├── signaling.ts     # WebSocket 客户端
    │   ├── webrtc.ts        # WebRTC 封装
    │   ├── transfer.ts      # 分片传输逻辑
    │   ├── crypto.ts        # AES-GCM 应用层加密
    │   ├── qr.ts            # QR 生成/扫码
    │   └── storage.ts       # IndexedDB 封装
    ├── data/
    │   └── lore.ts          # ACGN 页文案数据
    ├── utils/
    │   ├── identity.ts
    │   ├── format.ts
    │   └── hash.ts
    └── types/
        └── index.ts
```

## 配置

### 运行时配置（URL / 部署路径）

配置优先级：`public/config.json` > Vite 环境变量 > 默认值（同源）

| 变量 / 字段 | 说明 |
|-------------|------|
| `VITE_API_BASE` | 信令服务 API 基础 URL，留空则与前端同源 |
| `VITE_WS_URL` | WebSocket URL，留空则自动根据协议推导 |
| `VITE_BASE` | 部署子路径（GitHub Pages 等），通常由 CI 设置 |

本地开发复制 `.env.example` 为 `.env` 后修改；生产静态部署编辑 `public/config.json`。

### 编译时常量（协议参数）

所有硬编码的协议参数（分片大小、超时、STUN 服务器、心跳间隔等）统一在 [`src/constants.ts`](src/constants.ts) 中管理。

## 关键依赖

```json
{
  "react": "^18",
  "react-router-dom": "^6",
  "zustand": "^4",
  "qrcode": "^1",
  "jsqr": "^1",
  "idb": "^8",
  "hash-wasm": "^4"      // 流式 SHA-256
}
```

## 构建

```bash
npm run build
```

输出到 `dist/`，可部署到 Cloudflare Pages / Vercel / 任何静态托管。
