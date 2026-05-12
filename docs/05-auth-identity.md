# 05 · 登录与身份

## 核心概念

零注册。每个用户拥有临时「节点身份」：
- **节点编号** `nodeId`：1~20001 整数
- **通行码** `passCode`：6 位数字字符串

## 客户端身份生成

```ts
function generateIdentity(): Identity {
  const cached = sessionStorage.getItem('misaka.identity');
  if (cached) return JSON.parse(cached);
  return {
    nodeId: randomInt(1, 20001),
    passCode: String(randomInt(0, 999999)).padStart(6, '0'),
  };
}
```

**编号冲突**：`POST /api/register` 返回 `409 NODE_OCCUPIED` 时 `nodeId+1` 重试，最多 5 次后弹窗让用户手动选编号。

## 通行码作用

1. 保护节点身份（他人无法用同 nodeId 接入）
2. 建立连接验证（A 连 B 必须知道 B 的通行码）
3. 会话恢复（30min 内同 nodeId+passCode 可恢复）

## 会话存储

### 客户端 sessionStorage（标签页关闭即清）

```ts
{
  "misaka.identity": { nodeId: 10032, passCode: "485291", createdAt: 1715515200000 },
  "misaka.session":  { token: "<服务端 token>", expiresAt: 1715517000000 }
}
```

### 服务端内存 KV（重启即清）

```ts
interface NodeSession {
  nodeId: number;
  passCodeHash: string;      // SHA-256(passCode)
  token: string;
  socketId: string | null;
  lastSeen: number;
  blockedIds: Set<number>;
  channelId: string | null;
}
```

## 30 分钟保留机制

- `socketId === null` 表示已断开
- 后台每分钟扫描：
  - `lastSeen > 30min` → 删除记录
  - 未超时 → 保留，允许同 nodeId+passCode 恢复

## 接口

```ts
POST /api/register
  req:  { nodeId, passCode }
  200:  { token, expiresAt }
  409:  { error: "NODE_OCCUPIED" }

POST /api/release
  req:  { token }
  // 主动断开时调用，标记 socketId=null

WS /ws?token=xxx
  // 建立长连接后才能用信令
```

## 安全

- 通行码服务端只存 SHA-256 hash
- 错误 3 次锁定该 nodeId 5min（防爆破）
- token 30min 有效，每次活动续期
- 通行码生成避免易猜测组合（全 0、连号等可选禁用）

## UI 文案

| 场景 | 文案 |
|---|---|
| 生成中 | 正在分配节点编号... |
| 冲突 | 该节点编号已被其他实验体占用 |
| 通行码错误 | 通行码验证失败 (剩余 N 次) |
| 锁定 | 检测到异常接入尝试，节点已临时锁定 |
| 会话恢复 | 检测到 30 分钟内的活跃节点，已恢复连接 |
| 会话过期 | 节点信息已从网络中释放 |
