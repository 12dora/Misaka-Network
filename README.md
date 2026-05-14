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

如果宿主机 `8080` 已被占用，可以临时改用其他端口：

```bash
docker run -d --name misaka-signaling -p 18080:8080 misaka-signaling
```

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

## 自托管部署方案（信令 + TURN）

推荐准备两个域名：

- `signal.example.com`：反向代理到信令服务 `127.0.0.1:8080`
- `turn.example.com`：coturn 中继服务

### 1. 信令服务 HTTPS / WSS

信令服务本身只监听 HTTP + WS，生产环境由 Nginx / Caddy 负责 TLS：

```nginx
server {
  listen 443 ssl http2;
  server_name signal.example.com;

  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
  }
}
```

前端 `config.json` 配置为：

```json
{
  "API_BASE": "https://signal.example.com",
  "WS_URL": "wss://signal.example.com/ws"
}
```

#### Caddy 一键方案（推荐）

仓库已提供生产模板：

- `deploy/docker-compose.prod.yml`
- `deploy/Caddyfile.example`

使用方式：

```bash
cd deploy
cp Caddyfile.example Caddyfile
# 把 Caddyfile 里的 signal.example.com 与 email 改成你的真实值
docker compose -f docker-compose.prod.yml up -d --build
```

验活：

```bash
curl -s https://signal.example.com/api/health
```

预期返回 `{"ok":true,...}`。此时前端 `dist/config.json` 指向：

```json
{
  "API_BASE": "https://signal.example.com",
  "WS_URL": "wss://signal.example.com/ws"
}
```

### 2. coturn 中继服务器

Ubuntu 示例：

```bash
sudo apt update
sudo apt install coturn
sudo systemctl enable coturn
```

`/etc/turnserver.conf` 最小配置：

```conf
listening-port=3478
tls-listening-port=5349
fingerprint
lt-cred-mech
realm=turn.example.com
server-name=turn.example.com
user=misaka:change-this-password
no-multicast-peers
no-cli
```

云防火墙需放行：

- TCP/UDP `3478`
- TCP `5349`
- UDP relay 端口范围（默认较大；可用 `min-port`/`max-port` 收窄）

前端设置页中添加：

```text
turn:turn.example.com:3478?transport=udp
turn:turn.example.com:3478?transport=tcp
turns:turn.example.com:5349?transport=tcp
```

用户名填 `misaka`，密码填 `change-this-password`。

## 文档入口

- 架构总览：`docs/00-overview.md`
- 当前进度：`docs/PROGRESS.md`
- 提示词模板：`docs/PROMPTS.md`
