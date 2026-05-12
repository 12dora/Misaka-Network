# 05 · 登录与身份

## 核心概念

零注册系统。每个用户拥有一个临时「节点身份」，由：
- **节点编号** `nodeId`：1~20001 的整数
- **通行码** `passCode`：6 位数字字符串

## 身份生成

### 客户端生成（首次访问）
```ts
function generateIdentity(): Identity {
  // 优先从 sessionStorage 恢复
  const cached = sessionStorage.getItem('misaka.identity');
  if (cached) return JSON.parse(cached);
  
  return {
    nodeId: randomInt(1, 20001),
    passCode: String(randomInt(0, 999999)).padStart(6, '0'),
  };
}
```

### 编号冲突
- 向服务端发起「占位请求」：`POST /register { nodeId, passCode }`
- 服务端检测冲突：
  - 若 `nodeId` 已被其他节点占用且通行码不同 → 返回 `409 NODE_OCCUPIED`
  - 客户端 nodeId + 1 重试，最多 5 次后弹出「请手动选择编号」

### 通行码作用
1. **保护节点身份**：他人无法用同样的 nodeId 接入（除非知道通行码）
2. **建立连接验证**：A 想连 B，必须知道 B 的通行码
3. **会话恢复**：在 30 分钟内用同样的 nodeId + passCode 可恢复会话

## 会话管理

### 客户端

```ts
// sessionStorage（标签页关闭即清除）
{
  "misaka.identity": {
    "nodeId": 10032,
    "passCode": "485291",
    "createdAt": 1715515200000
  },
  "misaka.session": {
    "token": "<服务端下发的会话 token>",
    "expiresAt": 1715517000000
  }
}
```

### 服务端

内存 KV（重启即清，符合「零持久化」原则）：

```ts
const nodes = new Map<number, NodeSession>();

interface NodeSession {
  nodeId: number;
  passCodeHash: string;     // SHA-256(passCode)
  token: string;
  socketId: string | null;   // 当前 WebSocket 连接 ID
  lastSeen: number;
  blockedIds: Set<number>;
  channelId: string | null;  // 当前所在批次
}
```

### 30 分钟保留机制

- `socketId === null` 表示已断开
- 后台定时任务（每分钟）扫描：
  - `lastSeen` 超过 30 分钟 → 删除整条记录
  - `lastSeen` 未超时 → 保留，允许同样的 nodeId + passCode 恢复

## 接口

### POST `/api/register`
```ts
// req
{ nodeId: number, passCode: string }

// resp 200
{ token: string, expiresAt: number }

// resp 409
{ error: "NODE_OCCUPIED" }
```

### POST `/api/release`
```ts
// req
{ token: string }
// 用户主动断开时调用，标记 socketId = null
```

### WebSocket `/ws?token=xxx`
建立长连接后才能使用信令功能。

## 安全

- 通行码服务端只存 hash，不存明文
- 通行码错误 3 次锁定该 nodeId 5 分钟（防爆破）
- token 有效期 30 分钟，每次活动续期
- 通行码生成避免易猜测组合（如全 0、连号等可选择性禁用）

## UI 文案

| 场景 | 文案 |
|---|---|
| 生成中 | 正在分配节点编号... |
| 冲突 | 该节点编号已被其他实验体占用 |
| 通行码错误 | 通行码验证失败 (剩余 2 次) |
| 锁定 | 检测到异常接入尝试，节点已临时锁定 |
| 会话恢复 | 检测到 30 分钟内的活跃节点，已恢复连接 |
| 会话过期 | 节点信息已从网络中释放 |

## 实现优先级

1. 客户端身份生成 + sessionStorage
2. 服务端注册接口
3. WebSocket 鉴权
4. 30 分钟保留 + 定时清理
5. 防爆破锁定
