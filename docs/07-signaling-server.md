# 07 · 信令服务器

## 职责

只做三件事：
1. 节点注册与会话管理
2. WebRTC 信令转发（SDP/ICE）
3. 网络统计与活动事件广播

**绝不**：存储文件、记录传输内容、长期保存用户数据。

## 技术选型

- Node.js 20+ / TypeScript
- `ws` 库（轻量 WebSocket）
- Express 仅用于 REST 路由
- 数据全部内存存储（Map）

## 目录结构（server/）

```
server/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts           # 启动入口
│   ├── http.ts            # REST 路由
│   ├── ws.ts              # WebSocket 信令处理
│   ├── store.ts           # 内存数据结构
│   ├── stats.ts           # 统计收集
│   ├── activity.ts        # 活动流广播
│   ├── cleanup.ts         # 30 分钟清理任务
│   └── types.ts           # 共享类型
└── README.md
```

## REST 接口

### POST `/api/register`
注册或恢复节点。
```ts
// req
{ nodeId: number, passCode: string }
// resp 200
{ token: string, expiresAt: number, resumed: boolean }
// resp 409
{ error: "NODE_OCCUPIED" }
// resp 423
{ error: "NODE_LOCKED", unlockAt: number }
```

### POST `/api/release`
主动释放节点。
```ts
// req
{ token: string }
// resp 204
```

### POST `/api/verify-passcode`
他人验证你的通行码（连接前置步骤）。
```ts
// req
{ targetNodeId: number, passCode: string, sourceToken: string }
// resp 200
{ ok: true }
// resp 401
{ error: "WRONG_PASSCODE", attemptsLeft: number }
```

### GET `/api/stats`
公开统计数据。
```ts
// resp
{
  onlineNodes: number,
  totalTransfers: number,    // 累计
  totalBytes: number,
  activeChannels: number,
  uptimeLongestMs: number,
  cpuLoadPercent: number,    // 装饰用
}
```

### GET `/api/qr-token`
生成一次性 QR 接入 token。
```ts
// req（带 Authorization: Bearer <token>）
// resp
{ qrToken: string, expiresAt: number }   // 5 分钟有效，单次使用
```

### POST `/api/qr-redeem`
扫码后兑换接入。
```ts
// req
{ qrToken: string, myNodeId: number, myPassCode: string }
// resp 200
{ targetNodeId: number, channelId: string }
```

## WebSocket 协议

连接：`/ws?token=xxx`

### 客户端 → 服务端

```ts
// 加入批次
{ t: 'JOIN_CHANNEL', channelId: string }

// 离开批次
{ t: 'LEAVE_CHANNEL' }

// 请求连接对方
{ t: 'CONNECT_REQ', targetNodeId: number }

// 信令转发（SDP）
{ t: 'SIGNAL_SDP', targetNodeId: number, sdp: object }

// 信令转发（ICE）
{ t: 'SIGNAL_ICE', targetNodeId: number, candidate: object }

// 心跳
{ t: 'PING' }

// 屏蔽某节点
{ t: 'BLOCK', nodeId: number }
```

### 服务端 → 客户端

```ts
// 接入确认
{ t: 'WELCOME', myNodeId: number, sessionExpiresAt: number }

// 收到连接请求
{ t: 'CONNECT_REQ_IN', fromNodeId: number, requestId: string }

// 对方信令
{ t: 'SIGNAL_SDP', fromNodeId: number, sdp: object }
{ t: 'SIGNAL_ICE', fromNodeId: number, candidate: object }

// 节点状态变化
{ t: 'PEER_JOINED', node: { nodeId, joinedAt } }
{ t: 'PEER_LEFT', nodeId: number }

// 活动流广播
{ t: 'ACTIVITY', event: ActivityEvent }

// 心跳响应
{ t: 'PONG' }

// 错误
{ t: 'ERROR', code: string, message: string }
```

## 内存数据结构

```ts
// store.ts
export const nodes = new Map<number, NodeSession>();
export const channels = new Map<string, Set<number>>();  // channelId → nodeIds
export const qrTokens = new Map<string, QrTokenRecord>();
export const stats = {
  totalTransfers: 0,
  totalBytes: 0,
  startedAt: Date.now(),
};

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

## 清理任务

每 60 秒：
- 扫描 `nodes`，删除 `socket === null && now - lastSeen > 30min`
- 扫描 `qrTokens`，删除过期 token
- 扫描 `channels`，删除空集合

## 部署

- Fly.io / Railway / Render 都可
- 暴露端口 8080
- 环境变量：
  - `PORT` 端口
  - `STUN_ONLY=true` 强制只用 STUN，禁用 WebSocket 中继（运营选项）
  - `MAX_NODES` 节点上限（防滥用）

## 资源限制

```ts
const LIMITS = {
  MAX_NODES_PER_IP: 5,
  MAX_CHANNELS_PER_NODE: 3,
  MAX_MESSAGE_SIZE: 64 * 1024,   // 信令消息上限
  RATE_LIMIT_PER_MIN: 60,         // 每个节点每分钟消息数
};
```

## 安全

- 所有 WebSocket 消息 JSON 校验（zod）
- 信令转发前校验源节点与目标节点在同一 channel
- 通行码错误累计，触发锁定
- 日志不打印 passCode、SDP 内容

## 实现优先级

1. REST `/register` `/release`
2. WebSocket 鉴权 + JOIN/LEAVE
3. CONNECT_REQ + 通行码验证
4. SIGNAL_SDP / SIGNAL_ICE 转发
5. `/stats` + 活动流广播
6. QR token 接口
7. 清理任务
8. 限流与防护
