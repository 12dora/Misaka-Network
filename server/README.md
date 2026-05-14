# 信令服务器

Node.js + Express + ws。只负责身份注册、WebSocket 信令、活动统计和 QR token 兑换，不保存文件内容。

详细协议见 `../docs/archive/07-signaling-server.md`。

## 本地运行

```bash
cd server
npm install
npm run dev
```

默认监听：

- HTTP API：`http://localhost:8080/api`
- WebSocket：`ws://localhost:8080/ws`

## Docker 运行

仓库根目录：

```bash
docker compose up -d --build
```

如果 `8080` 被占用，可直接运行镜像并映射到其他端口：

```bash
docker build -t misaka-signaling ./server
docker run -d --name misaka-signaling -p 18080:8080 misaka-signaling
```

## 环境变量

```bash
PORT=8080                # 容器/进程内监听端口
MAX_NODES=10000          # 全局节点上限，0 或未设置表示不限制
RATE_LIMIT_PER_MIN=60    # API 每分钟限流
```

## 自托管生产部署

生产建议：

- 信令服务跑在 Docker 内部端口 `8080`
- 反向代理提供 HTTPS / WSS
- coturn 单独部署，作为 WebRTC 中继

### Caddy 反向代理（推荐）

仓库已提供模板：

- `../deploy/docker-compose.prod.yml`
- `../deploy/Caddyfile.example`

步骤：

```bash
cd deploy
cp Caddyfile.example Caddyfile
# 修改 signal.example.com 与 email
docker compose -f docker-compose.prod.yml up -d --build
```

健康检查：

```bash
curl -s https://signal.example.com/api/health
```

返回 `ok: true` 说明信令服务与反代链路正常。

### Nginx 反向代理示例

```nginx
server {
  listen 443 ssl http2;
  server_name signal.example.com;

  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
  }
}
```

前端 `config.json`：

```json
{
  "API_BASE": "https://signal.example.com",
  "WS_URL": "wss://signal.example.com/ws"
}
```

### coturn 最小部署

```bash
sudo apt update
sudo apt install coturn
sudo systemctl enable coturn
```

`/etc/turnserver.conf`：

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

开放端口：

- TCP/UDP `3478`
- TCP `5349`
- UDP relay 端口范围（可通过 `min-port` / `max-port` 收窄）

前端设置页填写：

```text
turn:turn.example.com:3478?transport=udp
turn:turn.example.com:3478?transport=tcp
turns:turn.example.com:5349?transport=tcp
```

用户名：`misaka`

密码：`change-this-password`

### coturn Docker 模板

仓库根目录 `deploy/` 已包含：

- `docker-compose.turn.yml`
- `turnserver.conf.example`

启动步骤：

```bash
cd deploy
cp turnserver.conf.example turnserver.conf
# 修改 external-ip / realm / user
docker compose -f docker-compose.turn.yml up -d
```

注意放行端口：

- `3478/tcp+udp`
- `5349/tcp`
- `49160-49200/udp`（与模板 `min-port/max-port` 对应）

## 关键约束

- 所有业务数据在内存中，服务重启即清空
- 不记录文件名、文件内容、SDP 内容
- 信令服务器不转发文件本体；TURN 中继也无法解密应用层 AES-GCM 数据
