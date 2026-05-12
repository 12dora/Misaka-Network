# 07 · 信令服务器

## 职责

只做三件事：
1. 节点注册与会话管理
2. WebRTC 信令转发（SDP/ICE）
3. 网络统计与活动事件广播

**绝不**：存文件、记录传输内容、长期保存用户数据。

## 技术

- Node.js 20+ / TypeScript
- `ws` 库
- Express 仅做 REST 路由
- 全内存（Map）

## 目录

```
server/src/
  index.ts       启动入口
  http.ts        REST 路由
  ws.ts          WebSocket 信令
  store.ts       内存数据结构
  stats.ts       统计收集
  activity.ts    活动流广播
  cleanup.ts     30min 清理
  types.ts       共享类型
```

## REST 接口

```ts
POST /api/register
  req: { nodeId, passCode }
  200: { token, expiresAt, resumed }
  409: { error: "NODE_OCCUPIED" }
  423: { error: "NODE_LOCKED", unlockAt }

POST /api/release
  req: { token }   →  204

POST /api/verify-passcode
  req: { targetNodeId, passCode, sourceToken }
  200: { ok: true }
  401: { error: "WRONG_PASSCODE", attemptsLeft }

GET  /api/stats
  resp: {
    onlineNodes, totalTransfers, totalBytes,
    activeChannels, uptimeLongestMs, cpuLoadPercent,
  }

GET  /api/qr-token     // Authorization: Bearer <token>
  resp: { qrToken, expiresAt }   // 5min 有效，单次使用

POST /api/qr-redeem
  req:  { qrToken, myNodeId, myPassCode }
  200:  { targetNodeId, channelId }
```

## WebSocket `/ws?token=xxx`

### Client → Server

```ts
{ t: 'JOIN_CHANNEL', channelId }
{ t: 'LEAVE_CHANNEL' }
{ t: 'CONNECT_REQ',  targetNodeId }
{ t: 'SIGNAL_SDP',   targetNodeId, sdp }
{ t: 'SIGNAL_ICE',   targetNodeId, candidate }
{ t: 'PING' }
{ t: 'BLOCK',        nodeId }
```

### Server → Client

```ts
{ t: 'WELCOME',        myNodeId, sessionExpiresAt }
{ t: 'CONNECT_REQ_IN', fromNodeId, requestId }
{ t: 'SIGNAL_SDP',     fromNodeId, sdp }
{ t: 'SIGNAL_ICE',     fromNodeId, candidate }
{ t: 'PEER_JOINED',    node: { nodeId, joinedAt } }
{ t: 'PEER_LEFT',      nodeId }
{ t: 'ACTIVITY',       event: ActivityEvent }
{ t: 'PONG' }
{ t: 'ERROR',          code, message }
```

## 内存数据结构

```ts
export const nodes    = new Map<number, NodeSession>();
export const channels = new Map<string, Set<number>>();
export const qrTokens = new Map<string, QrTokenRecord>();
export const stats = { totalTransfers: 0, totalBytes: 0, startedAt: Date.now() };

interface NodeSession {
  nodeId: number;
  passCodeHash: string;
  token: string;
  socket: WebSocket | null;
  lastSeen: number;
  channelId: string | null;
  blockedIds: Set<number>;
  failedAttempts: number;
  lockedUntil: number;
  joinedAt: number;
}
```

## 清理任务（每 60s）

- `nodes`：`socket===null && now-lastSeen>30min` → 删
- `qrTokens`：过期 → 删
- `channels`：空集合 → 删

## 部署

Fly.io / Railway / Render。端口 8080。环境变量：
- `PORT`
- `STUN_ONLY=true` 禁用 WebSocket 中继
- `MAX_NODES` 节点上限

## 资源限制

```ts
const LIMITS = {
  MAX_NODES_PER_IP: 5,
  MAX_CHANNELS_PER_NODE: 3,
  MAX_MESSAGE_SIZE: 64 * 1024,
  RATE_LIMIT_PER_MIN: 60,
};
```

## 安全

- 所有 WS 消息 zod 校验
- 信令转发前校验源/目标在同一 channel
- 通行码错误累计触发锁定
- 日志不打 passCode、SDP 内容
