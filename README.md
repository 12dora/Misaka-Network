# 御坂网络 · Misaka Network

浏览器内 P2P 文件传输 Web App（React + WebRTC + Node.js Signaling）。

## 项目背景

这个项目是一个「零注册、低门槛、强隐私」的跨设备文件传输实验：  
用户只需输入节点编号与 6 位通行码，即可在浏览器内完成设备间直连传输。

设计灵感来自《某科学的超电磁炮》中的“妹妹网络”设定，采用和风海报风格视觉表达。

## 项目介绍

核心目标：

- 文件本体端到端直传（WebRTC DataChannel）
- 服务器仅负责信令，不存储文件
- 支持断线重连与断点续传
- 信令服务器自动下发 Cloudflare TURN 短时效凭证（含防滥用 + 1T 月度熔断）；保留用户手工 TURN
- 支持强制 relay 测试

当前状态：

- v1/v2 核心功能完成
- PWA 基础能力完成（SW + Manifest + 安装提示）
- 性能项已完成 desktop Lighthouse 实测（首页 Performance 99）
- 测试基线已加固：服务端集成脚本统一 `runTest` 退出守卫，CI 不再因悬挂句柄被卡住
- 剩余主要工作为实网验证闭环（ICE 三场景、TURN 公网可达）

## 主要功能

- 节点注册与接入（nodeId + passcode）
- QR 邀请加入（含链接接入）
- 多 peer 同时在线与群发
- 文件传输（加密、暂停/恢复/取消）
- 大文件接收写盘（File System Access / OPFS / IndexedDB 降级）
- 会话消息与文件卡片下载
- 网络诊断（信道类型、ICE 路径与时间戳、诊断一键复制）

## 技术栈

- 前端：React 18 + TypeScript + Vite + Tailwind + Zustand
- 传输：WebRTC DataChannel + 应用层 AES-GCM
- 后端：Node.js + Express + ws（信令）
- 部署：静态前端 + Docker 化信令 + 可选 coturn

## 仓库结构

```text
misaka-network/
├── client/                         # 前端
├── server/                         # 信令服务
├── deploy/                         # 生产部署模板（Caddy / coturn）
├── docs/                           # 精简文档入口
│   └── archive/                    # 历史/低频文档归档
└── README.md
```

## 本地开发

1) 启动信令服务

```bash
cd server
npm install
cp .env.example .env        # 可选：不建也能跑，全部走默认值
npm run dev
```

默认：`http://localhost:9080`，WS：`ws://localhost:9080/ws`

`npm run dev`、`npm start` 和 Docker 镜像 CMD 共用同一个入口 `src/bootstrap.ts`，
按下列顺序加载环境文件（**先命中者生效；已存在于进程环境中的变量始终优先**）：

1. `$MISAKA_ENV_FILE`
2. `server/.env`
3. 仓库根 `.env`（与 `docker-compose.yml` 的 `env_file` 同一份）

全部可配项见 [`server/.env.example`](./server/.env.example)。集成测试与 Playwright
故意直接启动 `dist/index.js`（`npm run start:raw` 是同一入口），不读任何 `.env`，
避免开发者的本地文件污染测试。

2) 启动前端

```bash
cd client
npm install
npm run dev
```

默认：`http://localhost:5173`（开发代理 `/api` `/ws` 到 `9080`）

## 使用方法（最短路径）

1. 设备 A 打开首页，输入节点编号和通行码接入网络  
2. 设备 B 扫描 A 的 QR（或打开复制链接）  
3. 在网络页选择目标节点并发送文件  
4. 接收端确认并下载文件

## 部署方法

### A. 信令服务（Docker，快速）

根目录执行，干净检出即可直接跑（根 `.env` 是**可选**的）：

```bash
docker compose up -d --build
```

需要 Cloudflare 自动 TURN、或需要 `SERVER_SECRET` 跨重启保持稳定时，先建密钥文件：

```bash
cp .env.example .env
# 至少填：SERVER_SECRET（openssl rand -hex 32）
#         TURN_CF_KEY_ID / TURN_CF_API_TOKEN / TURN_CF_ACCOUNT_TAG（启用自动 TURN 时）
docker compose up -d --build
```

查看状态：

```bash
docker compose ps
docker compose logs -f signaling
```

> 这套栈把 9080 直接发布到宿主机，前面没有反向代理，因此 `TRUST_PROXY=0`：
> 服务端忽略 `X-Forwarded-For`，否则每条 per-IP 防线都能被伪造头绕过。

### B. 生产 HTTPS/WSS（Caddy）

```bash
cd deploy
cp Caddyfile.example Caddyfile
# 修改域名与邮箱
cp .env.example .env
# 必填 SERVER_SECRET；启用自动 TURN 时还要填 TURN_CF_* 三件套
docker compose -f docker-compose.prod.yml up -d --build
```

`SERVER_SECRET` 缺失时 `docker compose ... up` 会直接报错退出，而不是静默用随机值启动
（随机值会让 Cloudflare customIdentifier 每次重启都变，revoke 重试永久失效）。

健康检查：

```bash
curl -s https://signal.example.com/api/health
```

#### 代理信任与真实客户端 IP

拓扑固定为**恰好一跳**：`internet → caddy → signaling:9080`。signaling 容器只 `expose`
不 `ports`，唯一入口是 Caddy。对应两处配置必须成对存在：

| 位置 | 作用 |
|---|---|
| `deploy/Caddyfile.example` | 先 `request_header -X-Forwarded-For / -X-Real-IP / -Forwarded` 丢弃客户端自带的转发头，再 `header_up X-Forwarded-For {http.request.remote.host}` 写入真实 TCP 对端；HTTP 与 `/ws` 升级共用同一个 `reverse_proxy` 块 |
| `deploy/docker-compose.prod.yml` | `TRUST_PROXY: "1"` —— 恰好信任这一跳 |

任何一边缺失都会出问题：只设 `TRUST_PROXY` 不清洗头 → 客户端可伪造 IP；只清洗头不设
`TRUST_PROXY` → 全部用户折叠成 Caddy 容器的 IP，共享 API 限流、节点上限与 TURN 配额。
在 Caddy 前面再加 CDN / LB 时，必须同步提高跳数**并**让外层也重写转发头。

上线后验证：

```bash
cd deploy
./verify-proxy-trust.sh https://signal.example.com          # 伪造 XFF 不应换来新配额 → 期望 429
./verify-proxy-trust.sh https://signal.example.com --fresh  # 换一个网络执行 → 期望 200
docker compose -f docker-compose.prod.yml logs -f caddy     # 访问日志里的 remote_ip 应是真实客户端 IP
```

若 Caddy 访问日志里每条请求都是 `172.x` 网关地址，说明宿主机多了一层 NAT，
per-IP 防护在修好之前都不可信。

### C. TURN 中继（推荐：Cloudflare 自动下发）

信令服务器可自动按 session 申请 Cloudflare Realtime TURN 短时效凭证下发给客户端，**所有防滥用、配额、熔断都在服务端 enforce**，客户端为纯消费方。

1. **拿凭证**：Cloudflare Dashboard → Realtime → TURN，建一个 TURN Key，记下：
   - Key ID
   - API Token（权限至少 `TURN:Edit` + `Account Analytics:Read`）
   - Account Tag（侧栏 Account ID）

2. **配置 `.env`**（仓库已 gitignore；根栈用根 `.env.example`，Caddy 生产栈用 `deploy/.env.example`）：

   ```env
   SERVER_SECRET=...            # openssl rand -hex 32，必须跨重启稳定
   TURN_CF_KEY_ID=...
   TURN_CF_API_TOKEN=...
   TURN_CF_ACCOUNT_TAG=...
   ```

3. **运行**（`docker-compose.yml` 已内置全部可调阈值）：

   ```bash
   docker compose up -d --build
   ```

   验证：

   ```bash
   curl -s http://localhost:9080/api/turn-status | jq
   ```

#### 防滥用策略（全部 env 可配，默认值在 docker-compose.yml）

| 变量 | 默认 | 含义 |
|---|---|---|
| `TURN_AUTO_ENABLED` | `true` | 总开关 |
| `TURN_CREDENTIAL_TTL_SEC` | `300` | 凭证有效期（短=即使 revoke 失败也兜底） |
| `TURN_MAX_BYTES_PER_SESSION` | 1 GiB | 单 session 累计字节超额 → revoke |
| `TURN_MAX_BYTES_PER_HOUR_PER_IP` | 10 GiB | 单 IP 一小时悲观字节上限 |
| `TURN_MAX_ISSUE_PER_HOUR_PER_IP` | 60 | 单 IP 一小时签发次数 |
| `TURN_GLOBAL_MONTHLY_BYTES_LIMIT` | 1 TiB | CF 免费额度上限（按 UTC 月份重置） |
| `TURN_GLOBAL_THRESHOLD_PCT` | `90` | 达到全局阈值 % 即熔断停止下发 |
| `TURN_REVOKE_ALL_ON_KILL` | `false` | 熔断时是否批量 revoke 所有活动凭证 |
| `TURN_ABUSE_POLL_SEC` | `30` | 按 customIdentifier 查 CF Analytics 周期 |
| `TURN_GLOBAL_POLL_SEC` | `120` | 全局月度用量查询周期 |
| `TURN_REVOKE_RETRY_INTERVAL_MS` | `60000` | 失败的 CF revoke 调用重试间隔 |

`TURN_BAN_DURATION_SEC` 仍存在于 `config.ts`，但当前没有生效的封禁执行路径，
compose 模板不再设置它；不要依赖它做防护。

#### 持久化与备份

服务端把 TURN 状态（月度字节、活动凭证、签发历史）与暴破锁/冻结快照原子写到
`TURN_PERSIST_DIR`，重启不丢。其余数据（节点 / 会话 / 上报）维持现有内存策略。

| 栈 | `/app/data` 落点 |
|---|---|
| 根 `docker-compose.yml` | 绑定挂载 `./data`（已 gitignore，方便直接查看/备份） |
| `deploy/docker-compose.prod.yml` | 命名卷 `misaka_data`（**不是**匿名卷，`down`/重建镜像都不丢） |

命名卷备份 / 恢复：

```bash
docker run --rm -v misaka_data:/data -v "$PWD:/backup" \
  alpine tar czf /backup/misaka-data-$(date +%F).tar.gz -C /data .

docker run --rm -v misaka_data:/data -v "$PWD:/backup" \
  alpine sh -c 'cd /data && tar xzf /backup/misaka-data-YYYY-MM-DD.tar.gz'
```

保留策略：这些文件不含任何用户内容，只有计数器、不可逆派生的 TURN identifier 和
按 IP 归档的滥用状态。**按 IP 的记录属于个人数据**，建议每日快照 + 7~30 天保留，
存放位置不要对外可读；丢失备份的后果是月度熔断计数与封锁状态归零，不是数据损坏。

#### 用户手工 TURN

设置 → 中继 tab 顶部展示自动 TURN 状态 + 月度用量进度条；下方手工添加的 TURN 始终生效（与自动下发并存）。

### C2. 备选：自托管 coturn

```bash
cd deploy
cp turnserver.conf.example turnserver.conf
# 修改 external-ip / realm / user
docker compose -f docker-compose.turn.yml up -d
```

防火墙需放行：

- `3478/tcp+udp`
- `5349/tcp`
- `49160-49200/udp`（与模板一致）

### D. 前端静态部署

```bash
cd client
npm install
npm run build
```

将 `client/dist/` 部署到静态托管（GitHub Pages / Nginx / Cloudflare Pages）。

#### 部署 base（单一来源）

「应用挂在哪个路径」只有一个来源：**`VITE_BASE`**。`client/vite.config.ts` 把它交给
Vite 的 `base`，随后三处全部由它派生，不再各写各的：

| 派生物 | 来源 |
|---|---|
| `dist/index.html` 里的 asset / manifest / favicon URL | Vite `base` |
| React Router `basename` 与所有对外绝对链接（QR 邀请、扫码跳转） | `import.meta.env.BASE_URL` → `client/src/lib/appBase.ts` |
| `dist/404.html` 的 SPA 回退跳转目标 | 构建期把 `%BASE_URL%` 替换为同一个 base（`vite.config.ts` 的 `misaka-base-aware-404` 插件） |

- 不设 → `./`：相对 asset，路由按站点根处理。适合自定义域名或自托管根路径。
- `VITE_BASE=/my-repo/` → GitHub Pages 项目站点子路径。

GitHub Pages 工作流不需要手填：`.github/workflows/deploy.yml` 先跑
`actions/configure-pages`，用它输出的真实 `base_path`（仓库名，自定义域名时为 `/`）
生成 `VITE_BASE`，构建后再断言 404 跳转目标与 asset 前缀一致。仓库改名或 fork 都不用改代码。

本地验证子路径构建：

```bash
cd client
VITE_BASE=/subpath-smoke/ npm run build:subpath
grep "var base" dist-subpath-smoke/404.html      # → /subpath-smoke/
grep -o '"/subpath-smoke/assets/[^"]*"' dist-subpath-smoke/index.html | head
```

CI 每个 PR 都跑同一套断言（`.github/workflows/test.yml` 的 `client-build` job）。

#### 运行时后端地址

`dist/config.json` 运行时配置示例：

```json
{
  "API_BASE": "https://signal.example.com",
  "WS_URL": "wss://signal.example.com/ws"
}
```

可选 `"APP_BASE"` 字段可在不重新构建的前提下覆盖路由 base（优先级高于 `VITE_BASE`）。

## 测试

### 快速开始

```bash
# 安装所有依赖
npm run install:all

# 运行全部测试（服务端集成 + 客户端单元/契约）
npm test

# 仅服务端
npm --prefix server test

# 仅客户端
npm --prefix client test

# 端到端测试（Playwright，自动启动 server + Vite）
npm run test:e2e

# 人工 Playwright 调试脚本（需自行先跑起 server + Vite）
npm --prefix client run test:manual
```

### 目录结构

```text
├── server/tests/        # 服务端集成测试 (Node.js spawn + fetch + WS)
│   ├── _harness.mjs             # runTest / killChild：强制显式退出，防止悬挂句柄
│   ├── register-edge.test.mjs   # /api/register schema 校验、多设备、Bearer 保护
│   ├── brute-force.test.mjs     # 通行码穷举锁定、IP 上限、速率限制
│   ├── ws-auth.test.mjs         # WS AUTH 4001/4002 关闭码
│   ├── signaling-end.test.mjs   # SIGNAL_ICE_END 转发 + 跨 channel 隔离
│   ├── turn-policy.test.mjs     # TURN 颁发门控 (IP cap / 熔断)
│   ├── turn-lifecycle.test.mjs  # 凭证过期清理、月度滚月
│   ├── turn-http.test.mjs       # /api/turn-status / /api/turn-credentials HTTP 形态
│   └── stress-1gb.test.mjs      # 1GB 文件内存压测 (sender 流式 / 接收写盘)
├── client/tests/unit/           # 客户端 Vitest 单测 (jsdom)
│   ├── nat-classify.test.ts     # NAT 分类纯函数
│   ├── authedFetch.test.ts      # authedFetch 401 自愈状态机
│   ├── transfer-frame.test.ts   # chunk 帧编码 / IV 派生 / AES-GCM round-trip
│   └── network-cleanup.test.ts  # peer 离线清理、重连不残留监听器
├── client/tests/e2e/            # Playwright 端到端 (真实 server + 真实 WebRTC)
│   ├── transfer.spec.ts         # 两 peer 单文件 / 多文件传输 + LAN 重协商抑制
│   └── auth-recovery.spec.ts    # authedFetch 401 自愈 (QR 路径)
├── client/tests/ui-contract.test.mjs   # 前端关键行为源码契约
└── client/tests/manual-test.mjs        # 人工 Playwright 调试入口 (npm run test:manual)
```

> 上面只列出代表性文件，实际用例数以目录为准。

### 查看覆盖率

```bash
cd client
npm run test:unit -- --coverage
# 打开 coverage/index.html
```

### CI

PR 必须通过 `.github/workflows/test.yml` 中全部 job 才能合并：

| Job | 内容 |
|---|---|
| `server-tests` | 服务端构建 + 集成 + TURN 脚本 |
| `client-tests` | `typecheck`（src）+ `typecheck:config`（vite/vitest/playwright 配置）+ 单测/契约 |
| `client-build` | **生产 bundle 构建** + 子路径部署 smoke check（asset / router / 404 base 一致性） |
| `e2e-tests` | Playwright 双 peer 真实 WebRTC |
| `tests-touched-guard` | 改了 `src/` 却没改 `tests/` 的 PR 会被拦截（`[skip-test-guard]` 可放行） |

`client-build` 是 2026-07 补上的：此前 PR 只做 typecheck 与单测，Vite/Rollup/PostCSS/Tailwind
的构建期回归要合并后才在部署工作流暴露。

### 贡献准则

详细的测试纪律 / PR 描述要求 / 测试分层见 [CONTRIBUTING.md](./CONTRIBUTING.md) 与 [CLAUDE.md](./CLAUDE.md)。要点：

- 改动前先跑 `npm test` 建立绿基线，再开工
- 修 bug 必须先写复现失败用例，再改代码
- 服务端集成脚本必须用 `server/tests/_harness.mjs` 的 `runTest` 包裹 `main`，避免悬挂句柄拖死 CI

## 文档入口

- 总览：`docs/00-overview.md`
- 当前进度：`docs/PROGRESS.md`
- 会话模板：`docs/PROMPTS.md`
- 归档文档：`docs/archive/`

## 版权与致谢

- 项目维护与版权：**© Master Huang · Misaka Network**
- 本项目为同人风格技术作品，非商业用途，向原作及相关创作者致敬。
