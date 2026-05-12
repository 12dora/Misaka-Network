# 06 · WebRTC 传输与断点续传

## 连接建立流程

```
A 发起连接 B：
  1. A 通过信令服务器查询 B 是否在线 + 获取 B 的通行码验证机会
  2. A 向 B 发送 connect_request（带自己的 nodeId）
  3. B 收到通知，弹出「请输入通行码授权 A 接入」（A 输入 B 的通行码）
  4. 通行码验证通过 → 信令服务器允许 A、B 交换 SDP/ICE
  5. WebRTC offer/answer/ICE 协商
  6. DataChannel 建立 → 进入数据传输
```

## ICE 配置

```ts
const config: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    // TURN 由用户在设置中添加（默认空）
    ...userTurnServers,
  ],
  iceTransportPolicy: 'all',  // 不强制中继
};
```

## 信道选择

ICE 自动选择最优 candidate，优先级：
1. host candidate（局域网直连）
2. srflx candidate（STUN 公网穿透）
3. relay candidate（TURN 中继，需用户配置）

前端从 `pc.getStats()` 读取 selectedCandidatePair，显示当前信道类型。

## 数据分片

```ts
const CHUNK_SIZE = 64 * 1024;  // 64 KB

interface ChunkMessage {
  type: 'chunk';
  transferId: string;
  index: number;
  total: number;
  data: ArrayBuffer;  // 通过 DataChannel binary 发送
  checksum: string;   // SHA-256(chunk)
}

interface MetaMessage {
  type: 'meta';
  transferId: string;
  fileName: string;
  fileSize: number;
  fileHash: string;     // 整文件 hash（用于续传匹配）
  totalChunks: number;
  mime: string;
}

interface AckMessage {
  type: 'ack';
  transferId: string;
  index: number;  // 已成功接收的 chunk index
}
```

## 流控

```ts
const HIGH_WATER_MARK = 16 * 1024 * 1024;  // 16 MB
const LOW_WATER_MARK = 4 * 1024 * 1024;

async function sendChunk(dc: RTCDataChannel, data: ArrayBuffer) {
  while (dc.bufferedAmount > HIGH_WATER_MARK) {
    await new Promise(r => {
      dc.bufferedAmountLowThreshold = LOW_WATER_MARK;
      dc.onbufferedamountlow = () => r(undefined);
    });
  }
  dc.send(data);
}
```

## 断点续传

### IndexedDB Schema

```ts
// 数据库名：misaka-transfers
// 版本：1

// store: transfers
interface TransferRecord {
  transferId: string;       // 主键
  direction: 'send' | 'recv';
  peerNodeId: number;
  fileName: string;
  fileSize: number;
  fileHash: string;
  totalChunks: number;
  receivedChunks: number[]; // 已接收的 chunk index 列表
  status: 'active' | 'paused' | 'completed' | 'failed';
  createdAt: number;
  updatedAt: number;
}

// store: chunks
// key: `${transferId}:${index}`
// value: ArrayBuffer
```

### 续传流程

```
重连后：
  1. 接收方读取 IndexedDB 找到 status='active' 的任务
  2. 接收方向发送方发 RESUME_REQUEST { transferId, receivedChunks }
  3. 发送方从 receivedChunks 之外的 index 重新发起
  4. 接收方完成所有 chunk 后：
     - 拼接 chunks → Blob
     - 验证整文件 hash
     - 触发下载（或写入 File System Access API）
     - 删除 chunks store 中的记录
```

### 文件 hash 计算

```ts
async function hashFile(file: File): Promise<string> {
  const stream = file.stream();
  // 流式计算 SHA-256，避免大文件爆内存
  // 可用 hash-wasm 或 SubtleCrypto + 分块读取
}
```

## 备用传输路径

### 优先级

```
1. WebRTC + host candidate（局域网）
2. WebRTC + STUN（穿透）
3. WebRTC + TURN（仅当用户配置了 TURN）
4. WebSocket 中继（信令服务器转发，性能差但保底）
```

### WebSocket 降级

当 ICE 超时（默认 10 秒无 candidate pair 选定）：
- 通知信令服务器进入「relay mode」
- 客户端将 chunk 通过 WebSocket 发到服务端
- 服务端转发给目标客户端

**注意：** WebSocket 中继会增加服务器带宽成本，需要在 UI 显著提示用户。

## 加密层

WebRTC DataChannel 默认 DTLS 加密，但为了「端到端」彻底性：

```ts
// 应用层再加 AES-GCM
// 密钥由 ECDH 在 WebRTC 建立后双方协商
// 每个 chunk 用独立的 IV
```

这样即使将来 WebRTC 退化为 WebSocket 中继，文件内容服务器也无法解密。

## 性能指标目标

- 局域网传输：≥ 50 MB/s
- 公网 STUN：受带宽限制，≥ 5 MB/s
- TURN 中继：受服务器带宽限制
- 断点续传恢复延迟：< 2s

## 实现优先级

1. WebRTC offer/answer 基础流程
2. DataChannel 文件分片传输
3. 整文件 hash + chunk hash 校验
4. IndexedDB 进度持久化
5. 断点续传
6. AES-GCM 应用层加密
7. WebSocket 降级（最低优先级，v3 再做）
