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
- 支持 TURN 自配置与强制 relay 测试

当前状态：

- v1/v2 核心功能完成
- PWA 基础能力完成（SW + Manifest + 安装提示）
- 性能项已完成 desktop Lighthouse 实测（首页 Performance 99）
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
npm run dev
```

默认：`http://localhost:8080`，WS：`ws://localhost:8080/ws`

2) 启动前端

```bash
cd client
npm install
npm run dev
```

默认：`http://localhost:5173`（开发代理 `/api` `/ws` 到 `8080`）

## 使用方法（最短路径）

1. 设备 A 打开首页，输入节点编号和通行码接入网络  
2. 设备 B 扫描 A 的 QR（或打开复制链接）  
3. 在网络页选择目标节点并发送文件  
4. 接收端确认并下载文件

## 部署方法

### A. 信令服务（Docker，快速）

根目录执行：

```bash
docker compose up -d --build
```

查看状态：

```bash
docker compose ps
docker compose logs -f signaling
```

### B. 生产 HTTPS/WSS（Caddy）

```bash
cd deploy
cp Caddyfile.example Caddyfile
# 修改域名与邮箱
docker compose -f docker-compose.prod.yml up -d --build
```

健康检查：

```bash
curl -s https://signal.example.com/api/health
```

### C. TURN 中继（coturn）

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

`dist/config.json` 运行时配置示例：

```json
{
  "API_BASE": "https://signal.example.com",
  "WS_URL": "wss://signal.example.com/ws"
}
```

## 文档入口

- 总览：`docs/00-overview.md`
- 当前进度：`docs/PROGRESS.md`
- 会话模板：`docs/PROMPTS.md`
- 归档文档：`docs/archive/`

## 版权与致谢

- 项目维护与版权：**© Master Huang · Misaka Network**
- 本项目为同人风格技术作品，非商业用途，向原作及相关创作者致敬。
