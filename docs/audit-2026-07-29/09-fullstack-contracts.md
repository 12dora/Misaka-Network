# Misaka Network 全栈契约与会话生命周期审计

## 摘要

- `POST /api/release` 并未真正撤销会话：token 仍可使用，节点/IP 配额仍被占用，channel 中也保留幽灵成员；客户端注释所承诺的 `PEER_LEFT` 不会发生。
- 服务端执行的是“注册后固定绝对到期”，而 UI/总览写的是“30 分钟无活动/断线后保留”；活跃大文件传输跨过期限时会收到 4002，客户端按硬契约换 session epoch 并拆除传输。
- `connect()`、`disconnect()` 和 QR admission 并发时没有统一代际/取消机制：迟到的注册响应可以在用户退出后重新登录，混合参数的去重还可能丢失一次性 grant。
- 已登录用户切换 QR 身份后触发 IP 满恢复时，客户端优先提交旧 session 的 Bearer；服务端据此释放旧身份，而不是弹窗所称的“当前节点编号与通行码”身份。
- QR 的 `file`/`channel` 类型没有端到端协议实现；服务端始终创建 `type: 'node'`，`cid` 未被 Join 页读取，写入 `misaka.join` 的文件元数据也没有消费者。
- `/api/transfer-done` 没有客户端 HTTP 调用方；protocol v2 的同名消息只在 DataChannel 内发送，因此公开统计的 `totalTransfers`/`totalBytes` 不会随真实传输增长。
- 多个失败路径缺少截止时间或丢失服务端错误分类；黑洞网络可永久卡住接入/WS，QR 锁定和限流只显示“接入失败”，设置页还会产生重叠轮询。
- `docs/00-overview.md` 对 TURN 隐私边界、设置项和存储后端有明显漂移，其中“文件本体不经服务器”与已实现的 TURN relay 相冲突。

## 发现

### [P1] `/api/release` 未撤销 token，且绕过 channel 离场清理

- 位置: `client/src/store/auth.ts:330`、`server/src/http.ts:451`、`server/src/store.ts:126`
- 证据:

```ts
// client/src/store/auth.ts
// 3. release the server-side session last — that is what makes the
//    server drop us from the cluster channel and tell peers PEER_LEFT.
await fetch(apiUrl('/api/release'), {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ token: session.token }),
}).catch(() => {})
```

```ts
// server/src/http.ts
const session = findSessionByToken(parsed.data.token)
if (session) {
  if (session.socket) {
    unmarkSocket(session.socket)
    session.socket.close()
    session.socket = null
  }
  session.lastSeen = Date.now()
}
res.status(204).end()
```

```ts
// server/src/store.ts
for (const s of nodes.values()) {
  if (s.token !== token) continue
  if (isSessionExpired(s, now)) return null
  return s
}
```

- 影响: 用户点击“断开”后，服务端没有 `nodes.delete(sessionId)`、没有从 `channels` 删除 session，也没有向同 channel 的设备发送 `PEER_LEFT`。已复制/泄露的旧 token 在绝对 TTL 前仍可调用 `/api/turn-credentials` 或重新 WS AUTH；原会话继续占用 `MAX_NODES`/`MAX_NODES_PER_IP`，其他设备的雷达保留幽灵 peer。由于 handler 先把 `session.socket` 置为 `null`，随后 WS `close` 回调的 `session.socket !== ws` guard 还会跳过正常离场路径。
- 建议: 提取唯一的 `terminateSession(session, { revoke: true, notify: true })`，按顺序执行 `PEER_LEFT` 广播、channel 删除、socket index 清理、socket 关闭、`nodes.delete` 和 TURN/session 级撤销；`/release`、`/release-by-ip` 与 WS/清理任务共用。新增真实服务端集成测试，断言 release 后旧 token 的 Bearer/WS AUTH 均失败、peer 收到 `PEER_LEFT`、IP slot 立即释放；现有 `client/tests/unit/network-epoch.test.ts` 只 mock 了成功响应，不能证明服务端已撤销。

### [P1] 绝对会话到期会拆除活跃传输，却被文档和 UI 描述为“无活动”回收

- 位置: `server/src/http.ts:300`、`server/src/ws.ts:308`、`client/src/lib/signaling.ts:140`、`client/src/components/features/LoginCard.tsx:370`、`docs/00-overview.md:63`
- 证据:

```ts
// server/src/http.ts
// Absolute, never extended by reconnects.
expiresAt: now + SESSION_TTL_MS,
```

```ts
// server/src/ws.ts
if (isSessionExpired(session, now)) {
  try { ws.close(4002, 'SESSION_EXPIRED') } catch { /* already gone */ }
  return
}
```

```ts
// client/src/lib/signaling.ts
if (e.code === 4001 || e.code === 4002) {
  serverShutdown = true
  dispatch(authInvalidHandlers, undefined, 'authInvalid')
  return
}
```

```tsx
// client/src/components/features/LoginCard.tsx
<p className="text-[10px] text-[var(--text-on-white-2)] text-center mt-3 font-kanji">
  ⓘ 30 分钟无活动会话自动释放
</p>
```

```md
<!-- docs/00-overview.md -->
- 30 分钟会话保留（断线后 30min 内可恢复）
```

- 影响: 一个从注册后第 29 分钟开始、持续超过 1 分钟的大文件传输，即使双方持续发心跳和 DataChannel 数据，WS 仍在固定 deadline 后以 4002 关闭。客户端必须遵守硬契约 `4001/4002 → onAuthInvalid → clearSession → re-register`；新 token/sessionId 会结束旧 network epoch，而 protocol v2 的传输 owner 是 `(peerSessionId, epoch)`，所以在途任务、PC/DC 和重试源会被拆除。用户看到的却是“无活动才释放”，无法预判这一中断。
- 建议: 不要削弱现有 4001/4002 恢复和 protocol v2 owner 检查。优先增加到期前、保持同一 `sessionId` 的受控续期/换 token 机制，并在无活跃传输时完成；若安全策略必须坚持绝对 30 分钟，则 UI/文档改为“接入后固定 30 分钟”，在开始可能跨期的传输前明确阻止或提示。此修复会触及 `server/tests/session-expiry.test.mjs`、`client/tests/unit/signaling-auth-recovery.test.ts`、`client/tests/unit/network-epoch.test.ts` 以及 protocol v2 传输生命周期测试，必须显式更新而不能绕过。

### [P1] 迟到的注册响应可在显式退出后重新建立会话

- 位置: `client/src/store/auth.ts:246`、`client/src/store/auth.ts:325`、`server/src/http.ts:252`、`server/src/http.ts:317`
- 证据:

```ts
// client/src/store/auth.ts
if (connectInFlight) return connectInFlight
connectInFlight = (async () => {
  try {
    await doConnect(get, set, options)
  } finally {
    connectInFlight = null
  }
})()
```

```ts
// client/src/store/auth.ts
const { session } = get()
try { endSession() } catch (err) { console.warn('[auth] session teardown failed', err) }
sessionStorage.removeItem('misaka.session')
releaseNodeIdLock()
set({ session: null, isConnected: false, error: null })
```

```ts
// server/src/http.ts
const sessionId = nanoid(16)
const token = randomBytes(32).toString('hex')
// scrypt is async now (SECURITY-013), so the admission checks above are no
// longer atomic with the insert below — two concurrent registers for the
// same nodeId could both have passed.
const pcRecord = await newPassCodeRecord(passCode)
```

```ts
// server/src/http.ts
nodes.set(sessionId, session)
```

```ts
// server/src/http.ts
res.json({ sessionId, token, expiresAt: session.expiresAt, resumed: false })
```

- 影响: 背景 `authedFetch` 遇到 401 后开始 `/api/register`，用户在 scrypt/网络响应尚未完成时点击“断开”。`disconnect()` 不等待、不取消 `connectInFlight`，先把本地状态清空且只 release 旧 token；新注册随后返回，`doConnect()` 在第 136–139 行重新写入 sessionStorage 并把 `isConnected` 设为 `true`。结果是用户明确退出后又被“复活”为在线状态，且新服务端会话从未被 release。
- 建议: 为 auth 操作增加单调 generation 和 `AbortController`；`doConnect` 在每个 `await` 后验证 generation，退出时先使 generation 失效并 abort 注册。若响应已越过服务端 commit 点，客户端应立即用返回的新 token 调用真正撤销会话的 release。新增“401 re-auth in flight + disconnect + late 200”单元/集成测试。

### [P1] IP 满恢复在已有 session 时可能释放错误身份

- 位置: `client/src/store/auth.ts:260`、`client/src/pages/Join.tsx:64`、`client/src/components/features/IpFullPrompt.tsx:71`、`server/src/http.ts:354`
- 证据:

```ts
// client/src/pages/Join.tsx
auth.setNodeId(joinInfo.targetNodeId)
auth.setPassCode(passCode)
```

```ts
// client/src/pages/Join.tsx
await auth.connect({ admissionGrant: data.admissionGrant })
```

```ts
// client/src/store/auth.ts
const { session, identity } = get()
if (session?.token) {
  headers.Authorization = `Bearer ${session.token}`
} else {
  body = JSON.stringify({ nodeId: identity.nodeId, passCode: identity.passCode })
}
```

```tsx
// client/src/components/features/IpFullPrompt.tsx
<p className="font-kanji text-sm text-[var(--text-on-white)] mb-5">
  本机 IP 同时最多允许 10 个节点。可验证当前节点编号与通行码，并仅释放此 IP 上同一身份的会话；
  其他身份的节点不会被删除。
</p>
```

```ts
// server/src/http.ts
const caller = findSessionByToken(token)
if (!caller) { res.status(401).json({ error: 'UNAUTHORIZED' }); return }
scopeNodeId = caller.nodeId
scopePassHash = caller.passCodeHash
```

- 影响: 设备当前以身份 A 登录，随后打开身份 B 的 QR 链接；Join 页已经把 `identity` 改成 B，但旧 `session` 仍是 A。若注册 B 命中 `IP_LIMITED`，弹窗声称“验证当前节点编号与通行码，并仅释放同一身份”，实际客户端优先发 A 的 Bearer，服务端据此删除该 IP 上所有 A 身份会话。具体错误结果是用户为接入 B 而确认恢复，却把自己其它 A 设备踢下线。
- 建议: `releaseAllFromIp` 必须显式接收并显示 release scope。QR 身份切换时只能提交 B 的 `{ nodeId, passCode }` proof；或先让用户确认“释放旧身份 A”。服务端响应增加 `releasedNodeId`/不可逆 scope 标识供客户端校验，测试覆盖“session=A、identity=B、IP_LIMITED”。

### [P1] 严格 Origin 模式下服务端仍把不同 scheme 当成同源

- 位置: `client/src/components/features/joinLink.ts:87`、`server/src/origin.ts:84`
- 证据:

```ts
// client/src/components/features/joinLink.ts
if (url.protocol !== 'http:' && url.protocol !== 'https:') {
  return { ok: false, reason: 'BAD_SCHEME' }
}
if (url.username || url.password) {
  return { ok: false, reason: 'HAS_CREDENTIALS' }
}
if (!origin || url.origin !== origin) {
  return { ok: false, reason: 'FOREIGN_ORIGIN' }
}
```

```ts
// server/src/origin.ts
const xfProto = typeof h['x-forwarded-proto'] === 'string' ? h['x-forwarded-proto'] : undefined
const scheme = xfProto || (typeof (h as { encrypted?: unknown }).encrypted !== 'undefined' ? 'https' : 'http')
return origin === `${scheme}://${host}` || origin === `https://${host}` || origin === `http://${host}`
```

- 影响: 在配置显式 `ALLOWED_ORIGINS` 的私有 HTTPS 部署中，请求实际目标为 `https://host` 时，`Origin: http://host` 仍通过 `/register`、`/qr-token`、`/qr-redeem` 的 guard；客户端加入链接校验却正确地把这两个 origin 视为不同。也就是说运维选择“严格模式”后，服务端授权面仍比客户端/浏览器同源模型更宽。
- 建议: 从可信代理信息或 TLS socket 得到唯一外部 scheme，只比较精确的 `${scheme}://${host}`；不要同时无条件接受 http 和 https。增加 strict-mode HTTP 与 WS 对称测试，覆盖同 host/异 scheme 必须拒绝。

### [P2] `connect()` 去重忽略 admission grant 参数，破坏 QR 单次提交事务

- 位置: `client/src/store/auth.ts:62`、`client/src/store/auth.ts:246`、`server/src/http.ts:274`
- 证据:

```ts
// client/src/store/auth.ts
interface ConnectOptions {
  admissionGrant?: string
}
```

```ts
// client/src/store/auth.ts
if (connectInFlight) return connectInFlight
```

```ts
// server/src/http.ts
if (admissionRecord) {
  if (admissionRecord.used
    || admissionRecord.expiresAt < Date.now()
    || admissionRecord.admissionGrant !== parsed.data.admissionGrant) {
    res.status(400).json({ error: 'INVALID_ADMISSION_GRANT' })
    return
  }
  admissionRecord.used = true
}
```

- 影响: 普通 401 re-auth 的 `connect()` 已在飞行时，QR 流程调用 `connect({ admissionGrant })` 会直接复用前一个 Promise，grant 根本不会进入请求。若普通注册成功，QR 页面可能导航成功但邀请仍未消费，可被另一设备继续兑换；若前一个调用使用旧 identity，则页面甚至会以错误身份显示为已连接。当前 `auth-connect-dedupe.test.ts` 只测试“单独传 grant”和“三个无参调用”，没有覆盖混合参数并发。
- 建议: 去重 key 至少包含 identity 与 admissionGrant；更稳妥的是将 QR commit 作为不可与普通 re-auth 合并的操作，并用 auth generation 串行化身份切换。增加 `connect()` 与 `connect({ admissionGrant })` 交错顺序的两组测试，并保持服务端 `qr-admission.test.mjs` 的原子消费语义。

### [P2] 4001 同时表示“token 失效”和“未及时 AUTH”，客户端却一律重注册

- 位置: `server/src/ws.ts:220`、`server/src/ws.ts:267`、`client/src/lib/signaling.ts:134`
- 证据:

```ts
// server/src/ws.ts
const authTimer = setTimeout(() => {
  if (session) return
  try { ws.close(4001, 'AUTH_TIMEOUT') } catch { /* already gone */ }
}, WS_AUTH_GRACE_MS)
```

```ts
// client/src/lib/signaling.ts
if (e.code === 4001 || e.code === 4002) {
  serverShutdown = true
  dispatch(authInvalidHandlers, undefined, 'authInvalid')
  return
}
```

- 影响: 浏览器标签在 WS open 后被调度暂停、主线程阻塞或设备休眠超过 `WS_AUTH_GRACE_MS` 时，服务端发 4001 `AUTH_TIMEOUT`；原 token 可能完全有效，但客户端清缓存并创建新 session。反复发生会累积断线 session、消耗 IP slot，并切换 network epoch。4001 还用于“首帧非 AUTH”，两种协议错误与凭证错误被混成同一恢复动作。
- 建议: 保留 CLAUDE.md/AGENTS.md 的硬契约“4001/4002 必须触发 auth invalid”，不要直接改变其客户端含义；把纯超时改为新的 transient close code（例如 4003），客户端对 4003 使用同 token 有界重连。相应更新 `server/tests/ws-origin.test.mjs`，同时保持 `server/tests/ws-auth.test.mjs`、`client/tests/unit/signaling-auth-recovery.test.ts` 和 `client/tests/ui-contract.test.mjs` 对 4001/4002 的现有断言。

### [P2] HTTP 注册和 WS 建连都没有应用层截止时间

- 位置: `client/src/store/auth.ts:80`、`client/src/lib/signaling.ts:118`、`server/src/ws.ts:220`
- 证据:

```ts
// client/src/store/auth.ts
const res = await fetch(apiUrl('/api/register'), {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    nodeId: current.nodeId,
    passCode: current.passCode,
    ...(options.admissionGrant ? { admissionGrant: options.admissionGrant } : {}),
  }),
})
```

```ts
// client/src/lib/signaling.ts
if (ws?.readyState === WebSocket.OPEN
  || ws?.readyState === WebSocket.CONNECTING) return
const sock = new WebSocket(wsUrl())
ws = sock
```

```ts
// server/src/ws.ts
// AUTH grace starts only after the server accepted the WS connection.
const authTimer = setTimeout(() => {
  if (session) return
  try { ws.close(4001, 'AUTH_TIMEOUT') } catch { /* already gone */ }
}, WS_AUTH_GRACE_MS)
```

- 影响: 在 captive portal、丢弃 SYN/Upgrade 响应的防火墙或半开代理下，`fetch('/api/register')` 可长期不 settle，使 `isLoading=true` 和 `connectInFlight` 一直占用，用户无法重试；WS 可永久停在 `CONNECTING`，`doConnect()`/`reconnectNow()` 又因 guard 拒绝替换它。服务端 AUTH grace 只在 connection 回调之后启动，无法覆盖握手黑洞。
- 建议: 注册使用 `AbortController` 加明确 deadline，并把 timeout 映射为可重试错误；WS 为每个 `sock` 增加 connect watchdog，超时后仅关闭该确切 socket 并进入已有指数退避。测试覆盖“永不 resolve 的 fetch”和“永不 open/error/close 的 WebSocket”。

### [P2] 手动注册丢失 `NETWORK_FULL` 与 `SERVER_BUSY` 的可操作错误

- 位置: `client/src/store/auth.ts:121`、`server/src/http.ts:72`、`server/src/http.ts:243`
- 证据:

```ts
// client/src/store/auth.ts
if (!res.ok) {
  set({ isLoading: false, error: '接入失败，请稍后重试' })
  return
}
```

```ts
// server/src/http.ts
res.status(503).json({ error: 'SERVER_BUSY', message: '服务器繁忙，请稍后再试' })
```

```ts
// server/src/http.ts
res.status(503).json({ error: 'NETWORK_FULL', message: '御坂网络已达容量上限' })
```

- 影响: 网络总容量已满与 scrypt 工作队列暂时繁忙都返回 503，但前者应等待节点释放/换服务端，后者适合短暂退避重试；客户端把两者都显示成同一句“接入失败”。维护者无法从用户截图判断原因，用户会对容量满状态反复点击并增加全局 API/scrypt 压力。
- 建议: 所有非 2xx 先安全解析 `{ error, message }`，按稳定 `error` code 映射 zh-CN 文案和重试策略；为 `NETWORK_FULL` 禁用立即重试并提示容量，`SERVER_BUSY` 使用带抖动退避。增加每个服务端 register error code 的客户端契约表测试。

### [P2] QR 兑换把冻结、限流、来源拒绝等服务端状态压成“接入失败”

- 位置: `client/src/pages/Join.tsx:78`、`server/src/http.ts:634`
- 证据:

```ts
// client/src/pages/Join.tsx
if (err.error === 'QR_REQUIRES_PASSCODE' || err.error === 'WRONG_PASSCODE') {
  setStatus('needs-passcode')
} else {
  setStatus('error')
  setErrorMsg(err.error === 'INVALID_QR_TOKEN'
    ? 'QR 码已过期或已被使用' : '接入失败')
}
```

```ts
// server/src/http.ts
res.status(429).json({ error: 'RATE_LIMITED', message: 'QR 兑换请求过于频繁，请稍后再试' })
```

```ts
// server/src/http.ts
res.status(423).json({ error: 'NODE_LOCKED', reason: 'NODE_FROZEN', unlockAt: frozen.until })
```

- 影响: 同一 IP 达到 QR 专用限流时，客户端不显示等待提示；node 被全局冻结时也不显示 `unlockAt`。两者均落入不可恢复的 error 页，只提供“返回首页”，用户无法判断何时可重试，重复扫码/刷新还会继续占用 global 与 QR 两层限流。403 `BAD_ORIGIN`、400 `INVALID_INPUT` 也同样失去分类。
- 建议: Join 使用与 `auth.doConnect` 相同的统一错误 decoder，至少分别处理 `RATE_LIMITED`、`NODE_LOCKED`（含 reason/unlockAt）、`BAD_ORIGIN`、`INVALID_QR_TOKEN`、`WRONG_PASSCODE`；服务端错误 shape 建共享类型或契约测试，避免两条接入路径继续漂移。

### [P2] TURN 总开关关闭时，设置页仍可签发并消耗服务端配额

- 位置: `client/src/components/features/SettingsModal.tsx:445`、`server/src/http.ts:496`、`server/src/turn.ts:190`
- 证据:

```tsx
// client/src/components/features/SettingsModal.tsx
{turnStatus?.available && !autoTurnActive.active && (
  <MisakaButton
    disabled={issuing}
    onClick={async () => {
      const servers = await refreshAutoTurn()
```

```ts
// server/src/http.ts
const result = await issueCredentials(session.sessionId, session.ip)
```

```ts
// server/src/turn.ts
state.activeCredentials[customIdentifier] = active
state.ipIssuanceHistory.push(issuanceRecord)
state.monthlyUsage.pessimisticBytesObserved += pessimisticBytes
state.monthlyUsage.bytesObserved = Math.max(
  state.monthlyUsage.cfBytesObserved,
  state.monthlyUsage.pessimisticBytesObserved,
)
```

- 影响: `turnSettings.enabled` 为 false 时，“下发中继凭证”按钮仍显示且可点击。服务端会创建 Cloudflare reservation、增加每 IP 签发次数与悲观月度字节，但客户端总开关随后阻止这些 ICE server 被用于连接。具体结果是用户在“TURN 已关闭”状态下消耗小时额度/月度熔断预算却得不到任何连接收益。
- 建议: 按钮条件加入 `turnSettings.enabled`，关闭时不调用 `refreshAutoTurn`；若关闭动作发生在 credential 已签发后，明确清理本地 credential，并视服务端 API 能力决定是否 revoke。添加设置页测试：master off 时不得触发 credential endpoint，master on 才允许。

### [P2] TURN 状态轮询可在慢请求下无限重叠

- 位置: `client/src/components/features/SettingsModal.tsx:80`、`server/src/http.ts:526`
- 证据:

```ts
// client/src/components/features/SettingsModal.tsx
const tick = async () => {
  setTurnStatusState(prev => (prev === 'idle' ? 'running' : prev))
  const s = await fetchTurnStatus()
  if (cancelled) return
```

```ts
// client/src/components/features/SettingsModal.tsx
void tick()
const id = window.setInterval(tick, 10_000)
return () => { cancelled = true; window.clearInterval(id) }
```

```ts
// server/src/http.ts
router.get('/turn-status', (req, res) => {
  res.set('Cache-Control', 'no-store')
  const audience = classifyTurnStatusAuth(req.headers.authorization)
  if (audience === 'invalid') { res.status(401).json({ error: 'UNAUTHORIZED' }); return }
  if (audience === 'operator') { res.json(getOperatorTurnStatus()); return }
  res.json(getPublicTurnStatus())
})
```

- 影响: API 连接被代理黑洞、单次 `fetchTurnStatus()` 超过 10 秒时，interval 不检查 in-flight，每 10 秒再创建一个 fetch。设置弹窗保持打开 10 分钟即可积累约 60 个 pending Promise/请求；恢复网络后它们同时完成并向服务端形成突发流量，旧响应还可能覆盖较新的状态。unmount 的 `cancelled` 只阻止 setState，不会 abort 请求。
- 建议: 改为“本次 settle 后再 `setTimeout` 下一次”的串行轮询，或增加 in-flight guard；每次请求带 deadline/AbortSignal，tab 切换和 modal unmount 时 abort。测试使用永不 resolve 的 `fetchTurnStatus`，断言任意时刻最多一个调用。

### [P2] HTTP 传输统计端点没有客户端上报方

- 位置: `client/src/store/network.ts:3752`、`server/src/http.ts:564`
- 证据:

```ts
// client/src/store/network.ts
function sendDurableAck(peerSessionId: string, transferId: string, bytes: number) {
  const dc = dataChannels.get(peerSessionId)
  if (dc?.readyState !== 'open') return
  dc.send(JSON.stringify({ type: 'transfer-done', transferId, bytes }))
}
```

```ts
// server/src/http.ts
stats.totalTransfers++
stats.totalBytes += parsed.data.bytes ?? 0
broadcast({ type: 'transfer', nodeId: session.nodeId, message: `御坂 ${session.nodeId} 号完成一次传输` })
res.status(204).end()
```

- 影响: 仓库内没有 `/api/transfer-done` 的客户端调用；protocol v2 的同名 `transfer-done` 是 receiver→sender DataChannel durable-write ACK，服务端永远看不到。完成任意数量真实传输后，`/api/stats` 的 `totalTransfers` 和 `totalBytes` 仍保持初始值，首页统计与 activity 广播不反映实际使用。
- 建议: 在 v2 durable ACK 被 ownership-check 并成功把 sender 状态提升到 `saved` 后，独立、best-effort 地 POST telemetry（失败不得改变交付状态）；避免把 HTTP 204 与 protocol v2 ACK 混为一体。更新统计/限流测试并保留 CLAUDE.md 的 v2 规则：只有 DataChannel durable ACK 可以决定 `saved`。

### [P2] `file`/`channel` QR 只是 URL 标签，没有端到端服务端语义

- 位置: `client/src/components/features/QRModal.tsx:21`、`client/src/components/features/joinLink.ts:39`、`client/src/pages/Join.tsx:29`、`server/src/http.ts:604`、`docs/00-overview.md:68`
- 证据:

```ts
// client/src/components/features/QRModal.tsx
const params = new URLSearchParams({ type, id: String(nodeId), t: qrToken })
if (type === 'file' && fileSessionId) params.set('fid', fileSessionId)
if (type === 'channel' && channelId) params.set('cid', channelId)
```

```ts
// client/src/components/features/joinLink.ts
const ALLOWED_TYPES = new Set(['node', 'file', 'channel'])
```

```ts
// server/src/http.ts
const emptyBody = z.object({}).strict().safeParse(req.body ?? {})
if (!emptyBody.success) { res.status(400).json({ error: 'INVALID_INPUT' }); return }
```

```ts
// server/src/http.ts
const record: QrTokenRecord = {
  token: qrToken,
  ownerNodeId: ownerSession.nodeId,
  type: 'node',
  channelId,
```

```ts
// client/src/pages/Join.tsx
const joinInfo = useMemo(() => ({
  type: params.get('type') ?? 'node',
  targetNodeId: Number(params.get('id')),
  qrToken: params.get('t') ?? '',
  fileSessionId: params.get('fid'),
}), [params])
```

```ts
// client/src/pages/Join.tsx
sessionStorage.setItem('misaka.join', JSON.stringify({
  targetNodeId: data.targetNodeId,
  channelId: data.channelId,
  type: joinInfo.type,
  fileSessionId: joinInfo.fileSessionId,
}))
```

```md
<!-- docs/00-overview.md -->
- **v2 移动 + 容错**：三类 QR 扫码 + 移动端适配 + 断点续传 + TURN 自配置
```

- 影响: QRModal 可以生成/标注“文件 QR”“批次 QR”，parser 也允许 `type=file|channel`，但服务端拒绝任何携带类型/资源绑定的 body 并始终保存 `type:'node'`。Join 页完全不读取 `cid`；`fileSessionId` 只写入 `sessionStorage['misaka.join']`，仓库内没有读取者。扫描这两类链接的具体结果与普通 node QR 相同：只进入 identity cluster，不会打开指定文件或批次。总览却宣称 v2 已有“三类 QR 扫码”。
- 建议: 要么暂时从 props、parser allow-list、徽标和文档删除未实现类型；要么定义服务端签名绑定的 `{ type, resourceId }`，兑换时返回并验证该绑定，客户端在 Network 页消费一次后删除。不能继续信任可篡改的 query `fid/cid`。新增 node/file/channel 各自 happy path 与“替换资源 ID”拒绝测试。

### [P2] TURN relay 已实现，但总览仍声称文件本体不经服务器

- 位置: `docs/00-overview.md:5`、`docs/00-overview.md:61`、`client/src/components/features/SettingsModal.tsx:670`、`server/src/turn.ts:114`
- 证据:

```md
<!-- docs/00-overview.md -->
- 端到端：WebRTC P2P，文件本体不经服务器
```

```md
<!-- docs/00-overview.md -->
- 服务器只做信令，永不存储文件
```

```tsx
// client/src/components/features/SettingsModal.tsx
文件在浏览器之间端到端加密传输；直连失败时，流量可能经过服务器自动下发的
Cloudflare TURN 或你配置的中继。
```

```ts
// server/src/turn.ts
export async function issueCredentials(sessionId: string, ip: string): Promise<IssueResult> {
  if (!TURN_AUTO_ENABLED) return { ok: false, reason: 'DISABLED' }
  if (!turnConfigured()) return { ok: false, reason: 'NOT_CONFIGURED' }
}
```

- 影响: TURN 不解密文件，但它确实中继文件密文流量；“本体不经服务器”会让部署者和用户误判带宽、元数据暴露面及 Cloudflare/自托管 TURN 的第三方处理边界。README 和设置页已经承认 relay，只有总览仍给出绝对否定。
- 建议: 改为“文件不由信令服务器存储；能直连时端到端直传，直连失败时端到端加密流量可能经 TURN 中继”。同时区分“内容不可读”与“流量不经过第三方”。

### [P3] 总览列出的设置项和存储实现均已漂移

- 位置: `docs/00-overview.md:19`、`docs/00-overview.md:27`、`README.md:36`、`client/src/components/features/SettingsModal.tsx:294`
- 证据:

```md
<!-- docs/00-overview.md -->
设置（弹出）    TURN / 主题 / 音效 / 黑名单 / 语言
```

```md
<!-- docs/00-overview.md -->
| 本地存储 | IndexedDB (`idb`) |
```

```md
<!-- README.md -->
- 大文件接收写盘（File System Access / OPFS / IndexedDB 降级）
```

```tsx
// client/src/components/features/SettingsModal.tsx
{([
  { id: 'turn' as const, label: '中继' },
  { id: 'sound' as const, label: '音效' },
  { id: 'about' as const, label: '关于' },
]).map(t => (
```

- 影响: 维护者按总览验收会寻找并不存在的主题、黑名单、语言 tab；同时会误以为接收后端只有 IndexedDB，忽略 README 已列出的 FSA/OPFS/IDB 降级链，进而给出错误的容量和浏览器兼容性判断。
- 建议: 让 `docs/00-overview.md` 只描述当前已交付界面：中继/音效/关于；存储改为 FSA → OPFS → IndexedDB 降级。未交付能力放入明确标注的 roadmap，不与当前信息架构混写。

## 附录: 已核查但结论为无问题的区域

- `authedFetch` 的核心硬契约成立：首次 401 会重新注册并只重试一次，第二次 401 清 session 且抛出同一 `AuthRequiredError` 类型；本报告未建议改变该语义。
- WS 双向消息名和主要字段已逐项对照：`AUTH`、`JOIN_CLUSTER`、`LEAVE_CHANNEL`、`SIGNAL_SDP`、`SIGNAL_ICE`、`SIGNAL_ICE_END`、`PING/PONG`、`BLOCK`、`WELCOME`、`PEER_JOINED`、`PEER_LEFT`、`PEER_OFFLINE`、`ACTIVITY`、`SERVER_SHUTDOWN`、`ERROR` 均存在对应发送/处理方。
- `WELCOME.sessionId/myNodeId/sessionExpiresAt`、register 的 `token/sessionId/expiresAt/resumed`、TURN status/credential 字段在当前消费者与服务端之间类型一致。
- `SIGNAL_ICE_END` 的 optional candidate 与服务端 schema/转发字段一致；未发现 casing 或 EOC 字段名漂移。
- QR token 创建使用 authenticated POST、`Cache-Control: no-store`，URL 不包含 passCode；兑换成功后的 admission grant 在服务端 register commit 点原子消费，失败 admission 可用同一 grant 重试。
- QR 错误通行码会计入 node freeze，达到阈值后 token 被 burn；无效/已用/过期 token 统一返回 `INVALID_QR_TOKEN`，未发现绕过单 token 单次 commit 的直接路径。
- register 的 nodeId 范围、6 位数字 passCode、`admissionGrant` 长度，以及客户端生成/输入约束一致。
- 多设备模型在服务端按 `sessionId` 存储、按 `(nodeId, passCodeHash)` 聚类；WS 同一 token 重连会 supersede 旧 socket，而同 identity 的独立 register 会得到独立 sessionId。
- `release-by-ip` 的无 token路径要求 nodeId+passCode proof，且释放范围同时受调用 IP、nodeId 和 passCodeHash 约束；未发现“无认证清空整个公网 IP”的生产路径。
- TURN credential 成功/失败响应的 `enabled/iceServers/expiresAt/reason` 与当前解析器一致；public `/turn-status` 不泄露 operator 月度额度字段。
- `parseJoinLink` 对 scheme、credentials、exact origin、join route、重复/未知参数、token/id 格式和 fragment 的处理是封闭 allow-list；ScanModal 只导航到其重建的相对路径。
- QRModal 的 `/api/qr-token` 使用 `authedFetch`，因此服务器重启后的 401 可按既定一次重试契约恢复；第二次 401 有独立“会话已失效”文案。
- UpdateBanner 会在 active transfer/work 时禁用刷新，并等待 service worker `controllerchange` 后再 reload；未发现其与服务端契约的功能性冲突。
- README 的 TURN public/operator 状态说明、代理信任拓扑、运行时后端配置和测试脚本 `runTest` 生命周期说明与当前实现一致。
