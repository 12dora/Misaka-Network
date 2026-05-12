# 10 · 安全与隐私

## 核心承诺

1. 文件本体永不上服务器（除非用户启用 TURN 中继，且 TURN 也无法解密）
2. 服务端仅短期存储节点元数据（30 分钟会话）
3. 服务端不记录传输内容、文件名、IP
4. 端到端加密（DTLS + 应用层 AES-GCM）

## 加密层级

### 层 1：DTLS（WebRTC 默认）
DataChannel 自带 DTLS 加密，运营商/中间人无法窥探内容。

### 层 2：应用层 AES-GCM

```ts
// 建立 DataChannel 后立即进行 ECDH 密钥交换
async function setupE2EE(dc: RTCDataChannel): Promise<CryptoKey> {
  const myKeys = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveKey']
  );
  
  const myPub = await crypto.subtle.exportKey('raw', myKeys.publicKey);
  dc.send(JSON.stringify({ type: 'ecdh-pub', pub: bufToBase64(myPub) }));
  
  const peerPubBuf = await waitFor('ecdh-pub');
  const peerPub = await crypto.subtle.importKey(
    'raw', base64ToBuf(peerPubBuf), { name: 'ECDH', namedCurve: 'P-256' },
    false, []
  );
  
  return crypto.subtle.deriveKey(
    { name: 'ECDH', public: peerPub },
    myKeys.privateKey,
    { name: 'AES-GCM', length: 256 },
    false, ['encrypt', 'decrypt']
  );
}
```

每个 chunk 加密：
```ts
const iv = crypto.getRandomValues(new Uint8Array(12));
const encrypted = await crypto.subtle.encrypt(
  { name: 'AES-GCM', iv }, key, chunkData
);
// 发送 [iv (12B)] + [encrypted]
```

## 通行码保护

- 服务端只存 SHA-256 hash
- 错误 3 次锁定 5 分钟（按 nodeId）
- 锁定期间该节点的所有连接请求拒绝
- 锁定通过定时任务自动解除

## 黑名单

```ts
// localStorage key: misaka.blocklist
{
  blocked: [
    { nodeId: 12345, reason: 'spam', blockedAt: 1715515200 }
  ]
}
```

- 屏蔽后该 nodeId 的所有连接请求自动拒绝
- 屏蔽决策同步到服务端（仅当前会话有效）
- 用户可在设置中查看/解除屏蔽

## 上报机制

「上报至树形图设计者」：
- 用户右键节点 → 上报
- 选择原因：垃圾文件 / 恶意内容 / 骚扰 / 其他
- 服务端记录到日志（仅记录时间、源/目标 nodeId、原因，不记录内容）
- 同一节点被多次上报触发短期 IP 限速

**注意：** 不做内容审核，只做行为限速。

## 数据最小化

服务端记录的最少信息：
```
✓ 节点编号
✓ 通行码 hash
✓ 最后活跃时间
✓ 当前批次 ID
✓ 统计计数器（仅累计数字，不关联到具体用户）
✗ IP 地址（仅短期内存，重启即清，不写日志）
✗ 文件名
✗ 文件内容
✗ 用户行为日志
```

## 日志策略

```
日志只记录：
- 错误堆栈（不含用户输入）
- 启动/关闭事件
- 资源限制触发（仅 nodeId）
- 性能指标（聚合数据）

绝不记录：
- SDP 内容
- ICE candidate
- 通行码（哪怕是 hash）
- 文件元数据
- IP 地址
```

## 服务条款要点

```
1. 本服务为非商业 fan-made 项目
2. 用户对自己传输的内容负完全责任
3. 服务方不存储、不审查、不能恢复任何文件
4. 不得用于传输违法内容
5. 不提供数据可用性保证，传输失败自负
6. 通行码丢失无法找回
7. 30 分钟无活动会话自动清除
```

## 隐私政策要点

```
我们收集：
- 临时节点元数据（30 分钟）
- 聚合统计数据（不可关联到个人）
- 错误日志（不含个人信息）

我们不收集：
- 真实身份信息
- 文件内容或元数据
- IP 地址（不写持久日志）
- Cookie / 跟踪标识

我们不分享：
- 任何数据，与任何第三方
```

## 已知风险与缓解

| 风险 | 缓解 |
|---|---|
| 通行码爆破 | 3 次锁定 5 分钟 |
| 节点编号枚举 | 编号不等于地址，必须通行码才能建连 |
| DDoS 信令服务器 | 限流 + 节点数上限 + Cloudflare |
| 滥用传播违规内容 | 通行码门槛 + 黑名单 + 上报 |
| TURN 流量被监听 | 应用层 AES-GCM 加密兜底 |

## 实现优先级

1. 通行码 hash + 锁定机制
2. 应用层 AES-GCM 加密
3. 黑名单本地存储
4. 上报接口
5. 服务端日志脱敏审查
6. 服务条款/隐私政策页面
