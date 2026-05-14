# 御坂网络 · MISAKA NETWORK

浏览器内 P2P 文件传输 Web APP（React + WebRTC + Node.js Signaling）。

## 仓库结构

```text
misaka-network/
├── client/                 # 前端（Vite + React）
├── server/                 # 信令服务（Node.js + ws + express）
├── docs/                   # 设计/架构/进度文档
├── docker-compose.yml      # 后端 Docker 快速部署
└── README.md
```

## 本地开发（前后端）

1) 启动后端

```bash
cd server
npm install
npm run dev
```

默认监听 `http://localhost:8080`，WebSocket 为 `ws://localhost:8080/ws`。

2) 启动前端（新终端）

```bash
cd client
npm install
npm run dev
```

默认访问 `http://localhost:5173`。开发模式下 Vite 已代理 `/api` 和 `/ws` 到 `8080`。

## 后端 Docker 快速部署（推荐）

### 方式 A：docker compose（一条命令）

在仓库根目录执行：

```bash
docker compose up -d --build
```

查看状态与日志：

```bash
docker compose ps
docker compose logs -f signaling
```

停止：

```bash
docker compose down
```

默认会映射宿主机 `8080:8080`。

### 方式 B：纯 docker 命令

```bash
docker build -t misaka-signaling ./server
docker run -d --name misaka-signaling -p 8080:8080 \
  -e PORT=8080 \
  -e MAX_NODES=10000 \
  -e RATE_LIMIT_PER_MIN=60 \
  misaka-signaling
```

## 前端部署（静态托管）

前端是纯静态资源，构建后可部署到 Nginx / Cloudflare Pages / Vercel / GitHub Pages。

```bash
cd client
npm install
npm run build
```

产物在 `client/dist/`。

### 运行时配置（关键）

前端会读取 `client/public/config.json`（构建后位于 `dist/config.json`），用它指向线上后端：

```json
{
  "API_BASE": "https://your-domain.com",
  "WS_URL": "wss://your-domain.com/ws"
}
```

这样无需重新打包前端即可切换后端地址。

## 生产部署建议

1. 后端用 Docker 部署在云主机（开放 `8080` 或置于反向代理后）。
2. 前端部署静态站点。
3. 生产环境必须使用 HTTPS + WSS（浏览器 WebRTC/权限相关特性更稳定）。

## 文档入口

- 架构总览：`docs/00-overview.md`
- 当前进度：`docs/PROGRESS.md`
- 提示词模板：`docs/PROMPTS.md`
