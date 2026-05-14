# 06 · WebRTC 传输与断点续传

## 连接建立流程

```
A 发起连接 B：
1. A 向信令服务器查 B 是否在线
2. A 发 CONNECT_REQ（带自己 nodeId）
3. B 弹窗「输入通行码授权 A 接入」（A 输 B 的通行码）
4. 通行码通过 → 信令允许双方交换 SDP/ICE
5. offer/answer/ICE 协商
6. DataChannel 建立 → 数据传输
```

## ICE 配置

```ts
const config: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    ...userTurnServers,   // 用户设置中添加，默认空
  ],
  iceTransportPolicy: 'all',
};
```

ICE 自动选最优 candidate：host > srflx > relay。前端从 `pc.getStats()` 读 selectedCandidatePair 显示信道类型。

## 数据分片

```ts
const CHUNK_SIZE = 64 * 1024;

interface MetaMessage {
  type: 'meta';
  transferId: string;
  fileName: string;
  fileSize: number;
  fileHash: string;     // 整文件 hash（续传匹配）
  totalChunks: number;
  mime: string;
}

interface ChunkMessage {
  type: 'chunk';
  transferId: string;
  index: number;
  total: number;
  data: ArrayBuffer;    // binary 发送
  checksum: string;     // SHA-256(chunk)
}

interface AckMessage {
  type: 'ack';
  transferId: string;
  index: number;        // 已成功接收
}
```

## 流控

```ts
const HIGH_WATER_MARK = 16 * 1024 * 1024;
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
// 数据库：misaka-transfers v1

// store: transfers（主键 transferId）
interface TransferRecord {
  transferId: string;
  direction: 'send' | 'recv';
  peerNodeId: number;
  fileName: string;
  fileSize: number;
  fileHash: string;
  totalChunks: number;
  receivedChunks: number[];
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
1. 接收方读 IndexedDB 找 status='active' 任务
2. 接收方发 RESUME_REQUEST { transferId, receivedChunks }
3. 发送方重发 receivedChunks 之外的 index
4. 完成全部 chunk：
   - 拼接 → Blob
   - 验证整文件 hash
   - 下载（或 File System Access API）
   - 清 chunks store
```

整文件 hash 流式计算（避免大文件爆内存）：`hash-wasm` 或 `SubtleCrypto` + 分块读取。

## 备用传输路径

优先级：
1. WebRTC + host candidate（局域网）
2. WebRTC + STUN（穿透）
3. WebRTC + TURN（仅当用户配置）
4. WebSocket 中继（信令服务器转发，v3 再做）

WebSocket 降级触发：ICE 10s 无 candidate pair 选定 → 通知信令进入 relay mode，chunk 经服务端转发。**注意**：增加服务器带宽成本，UI 需显著提示。

## 应用层加密

WebRTC DataChannel 默认 DTLS。为兜底「端到端」，建立 DataChannel 后再做 ECDH 密钥交换 + AES-GCM：

```ts
// 每个 chunk 独立 IV
const iv = crypto.getRandomValues(new Uint8Array(12));
const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, chunkData);
// 发送 [iv (12B)] + [encrypted]
```

即使将来退化为 WebSocket 中继，服务器也无法解密。

## 性能目标

- 局域网 ≥ 50 MB/s
- 公网 STUN ≥ 5 MB/s
- TURN 受服务器带宽限制
- 断点续传恢复 < 2s
