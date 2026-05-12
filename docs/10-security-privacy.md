# 10 · 安全与隐私

## 核心承诺

1. 文件本体永不上服务器（除非用户启用 TURN 中继，且 TURN 也无法解密）
2. 服务端仅短期存节点元数据（30min 会话）
3. 服务端不记录传输内容、文件名、IP
4. 端到端加密（DTLS + 应用层 AES-GCM）

## 加密层级

### Layer 1: DTLS（WebRTC 默认）
DataChannel 自带，运营商/中间人无法窥探。

### Layer 2: 应用层 AES-GCM

建立 DataChannel 后立刻 ECDH 协商密钥：

```ts
async function setupE2EE(dc: RTCDataChannel): Promise<CryptoKey> {
  const myKeys = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey']
  );
  const myPub = await crypto.subtle.exportKey('raw', myKeys.publicKey);
  dc.send(JSON.stringify({ type: 'ecdh-pub', pub: bufToBase64(myPub) }));

  const peerPubBuf = await waitFor('ecdh-pub');
  const peerPub = await crypto.subtle.importKey(
    'raw', base64ToBuf(peerPubBuf), { name: 'ECDH', namedCurve: 'P-256' }, false, []
  );
  return crypto.subtle.deriveKey(
    { name: 'ECDH', public: peerPub }, myKeys.privateKey,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}
```

每 chunk 用独立 IV 加密：发送 `[iv (12B)] + [encrypted]`。

## 通行码保护

- 服务端只存 SHA-256 hash
- 错误 3 次锁定 nodeId 5min
- 锁定期间该节点所有连接请求拒绝
- 定时任务自动解锁

## 黑名单

```ts
// localStorage key: misaka.blocklist
{ blocked: [{ nodeId, reason, blockedAt }] }
```

- 屏蔽后该 nodeId 的连接请求自动拒绝
- 屏蔽决策同步到服务端（仅当前会话有效）

## 上报机制

「上报至树形图设计者」：用户右键节点 → 上报 → 选择原因（垃圾文件 / 恶意内容 / 骚扰 / 其他）。服务端只记录 时间 + 源/目标 nodeId + 原因，**不记录内容**。同一节点多次被上报触发短期 IP 限速。**不做内容审核**。

## 数据最小化

服务端保留：
- ✓ 节点编号、通行码 hash、最后活跃时间、当前批次 ID
- ✓ 聚合统计计数器（不关联具体用户）
- ✗ IP（仅短期内存，重启即清）
- ✗ 文件名 / 内容 / 用户行为日志

## 日志策略

只记录：
- 错误堆栈（不含用户输入）
- 启动/关闭事件
- 资源限制触发（仅 nodeId）
- 性能指标（聚合）

绝不记录：SDP / ICE / 通行码（哪怕 hash）/ 文件元数据 / IP。

## 服务条款要点

```
1. 非商业 fan-made 项目
2. 用户对传输内容负完全责任
3. 服务方不存储/审查/恢复文件
4. 不得用于违法内容
5. 不提供可用性保证
6. 通行码丢失无法找回
7. 30min 无活动会话自动清除
```

## 隐私政策要点

收集：临时节点元数据（30min）/ 聚合统计 / 错误日志（不含个人信息）。

不收集：真实身份 / 文件内容或元数据 / IP（无持久日志）/ Cookie。

不分享：任何数据，与任何第三方。

## 已知风险与缓解

| 风险 | 缓解 |
|---|---|
| 通行码爆破 | 3 次锁定 5min |
| 节点编号枚举 | 编号不等于地址，必须通行码才能建连 |
| DDoS 信令 | 限流 + 节点上限 + Cloudflare |
| 滥用传播违规 | 通行码门槛 + 黑名单 + 上报 |
| TURN 流量被监听 | 应用层 AES-GCM 兜底 |
