# Misaka Network 网络状态、信令与 WebRTC 架构审计

## 摘要

- 发现 4 个 P0：`shortId` 可被同一 peer 的第二个 `meta` 覆盖并造成静默文件内容错配；取消路径会立刻删除 cancel signal，使活跃引擎继续发送；旧记录按 `peerNodeId` 自动续传违反 `(peerSessionId, epoch)` 所有权契约；入站传输的异步 continuation 可越过 epoch teardown，把旧身份文件注入新会话。
- 4001/4002 的识别本身正确，但“刷新后恢复的 identity 没有 passCode”和“auth-invalid 不触发 network epoch teardown”使完整恢复契约在常见路径失效。
- WebRTC 只处理已经进入 `have-local-offer` 的 glare，没有覆盖 `createOffer()` 尚未完成的 `makingOffer` 窗口；ICE 配置首次变化也不会触发路径迁移，重启次数上限则没有真正的自动重试调度。
- protocol v2 的正常主路径基本遵守 `transfer-ready`、repair、durable ACK 和接收写入顺序，但零字节分支绕过唯一终态 API，late ACK/repair 生命周期和 ACK 字段校验存在缺口。
- `network.ts` 实际承担至少 11 个责任域，并通过 Zustand singleton、模块级 Map 和互相回调形成隐藏循环；应按 session、peer runtime、negotiation、ICE recovery、router、chat、transfer、artifact、connectivity 等边界渐进拆分。
- 本报告严格只读；按要求未运行 `npm test`、构建、安装或任何 Git 写操作。

## 发现

### [P0] `shortId` 冲突可把一份文件的合法密文静默写入另一份文件

- 位置: `client/src/store/network.ts:3263`、`client/src/store/network.ts:3574`
- 证据:
```ts
if (e.data instanceof ArrayBuffer) {
  const frame = decodeChunkFrame(e.data)
  if (!frame) return
  const transferId = shortIdToTransferId.get(peerSessionId)?.get(frame.shortId)
  if (!transferId) return

  const result = await receiveChunk(
    transferId, frame.index, frame.iv, frame.ciphertext, peerSessionId,
```
```ts
let peerMap = shortIdToTransferId.get(peerSessionId)
if (!peerMap) {
  peerMap = new Map()
  shortIdToTransferId.set(peerSessionId, peerMap)
}
peerMap.set(meta.shortId, meta.transferId)
```
- 影响: 同一 `peerSessionId` 发送 A、B 两个几何相同的合法传输，并故意复用同一个 32 位 `shortId`；B 的 `meta` 覆盖映射后，A 的后续帧会被路由到 B。两份传输使用同一 peer AES key，帧自带的 IV 仍能通过 AES-GCM，因此 B 可能以 A 的内容成功落盘并通过大小校验，形成静默完整性破坏。
- 建议: 注册映射前执行 compare-and-set；若 `(peerSessionId, shortId)` 已指向另一个 live transfer，拒绝新 `meta` 并保留旧映射。无需改动 `CHUNK_FRAME_TAG` 或帧布局；新增“同 peer、不同 transferId、相同 shortId”测试，断言第二个 `meta` 被拒绝且 A 内容不会进入 B。

### [P0] 取消后立即 `forgetTransfer()` 会删除 cancel signal，活跃发送仍可继续

- 位置: `client/src/store/network.ts:1851`、`client/src/store/network.ts:3451`
- 证据:
```ts
engineCancelTransfer(transferId)
void cancelReceive(transferId)
cancelStreamWrite(transferId)
cleanupOPFS(transferId).catch(() => {})
sendingFiles.delete(transferId)
transferSpeedSamples.delete(transferId)
transferDelivery.delete(transferId)
forgetTransfer(transferId)
set(s => ({ transfers: s.transfers.filter(t => t.id !== transferId) }))
```
```ts
if (msg.type === 'transfer-cancel' && typeof msg.transferId === 'string') {
  if (!applyPeerCancel(msg.transferId, owner)) return
  cancelReceive(msg.transferId)
  cancelStreamWrite(msg.transferId)
  cleanupOPFS(msg.transferId).catch(() => {})
  sendingFiles.delete(msg.transferId)
  transferSpeedSamples.delete(msg.transferId)
  transferDelivery.delete(msg.transferId)
  forgetTransfer(msg.transferId)
```
- 影响: `engineCancelTransfer`/`applyPeerCancel` 先在 transfer signal 上设置 `cancelled=true`，但同一同步调用栈随即执行 `forgetTransfer()`，删除 signal 和 live task 注册。仍在 `File.slice()`、加密或 backpressure await 中的 lane 下一次检查 Map 时读不到 `cancelled`，会继续加密并发送余下内容；UI 卡片已经消失，但用户要求取消的数据仍离开设备。
- 建议: cancel 只发信号并保留 task/owner，等待 live engine 以 `TransferCancelledError` 结算后再统一 `forgetTransfer()`；receive cleanup 与 send task cleanup 分离。补 production store 的本地 cancel 和远端 cancel 测试，使用 deferred chunk preparation，断言取消后不再出现新的 chunk frame。此修复不改变 protocol v2 控制消息，只修正其终止语义。

### [P0] legacy resume 按 `peerNodeId` 归属，直接违反 session+epoch 所有权契约

- 位置: `client/src/store/network.ts:3981`
- 证据:
```ts
if (record.direction !== 'recv') continue
const belongs = record.peerSessionId
  ? record.peerSessionId === peerSessionId
  : record.peerNodeId === peerNodeId
if (!belongs) continue
const req = await buildResumeRequest(
  record.transferId,
  record.peerSessionId ? owner : undefined,
)
if (req && dc.readyState === 'open') dc.send(JSON.stringify(req))
```
- 影响: 设备 A 留下一个没有 `peerSessionId` 的旧 active record；同一 identity 的设备 B 与本端建立新 DC 时，因为 A/B 共享 `nodeId`，B 会收到 A 的 `transferId` 和 resume bitmap。调用 `buildResumeRequest(..., undefined)` 还跳过 epoch/owner 校验，泄露另一设备的传输进度并允许错误续传，违反 CLAUDE.md 的“owner 永远不是 peerNodeId”硬契约。
- 建议: 不得自动把 legacy row 绑定到同 nodeId 的新 session；将其标为 `migration-required`/不可自动恢复，只有用户明确选择并经过可信迁移后才写入新的 session owner。所有 resume 调用必须传 `owner`。这会有意停止 pre-owner 记录的透明自动续传，需更新 legacy resume、ownership 和 sibling-device 测试，并在迁移说明中明确兼容性变化。

### [P0] 入站传输异步工作可跨 epoch 复活旧身份文件与状态

- 位置: `client/src/store/network.ts:3260`、`client/src/store/network.ts:3598`、`client/src/store/network.ts:3637`
- 证据:
```ts
dc.onmessage = async (e) => {
  if (!stillCurrent()) return
  const owner = ownerFor(peerSessionId)
```
```ts
const prepared = await prepareReceiveBackend({
  transferId: meta.transferId,
  fileName: meta.fileName,
  totalChunks: meta.totalChunks,
  size: meta.fileSize,
}, owner).catch((err) => ({
  ok: false,
  rejection: { reason: 'no-writable-backend', message: String(err) },
}))
```
```ts
useNetworkStore.setState(s => {
  if (s.transfers.some(t => t.id === meta.transferId)) return s
  return {
    transfers: pruneTerminalTransferCards([...s.transfers, {
      id: meta.transferId, direction: 'recv' as const,
      peerSessionId, peerNodeId,
      fileName: meta.fileName, fileSize: meta.fileSize,
```
- 影响: 旧身份收到 `meta` 后，FSA/OPFS/IDB 准备尚未完成时发生 logout、token change 或新 `WELCOME.sessionId`。入口处的唯一 `stillCurrent()` 已经过期，后续 await 后没有复核；旧 promise 会在新 epoch 中重新插入旧 peer/file 卡片、聊天和通知，甚至完成旧文件并生成下载 URL。teardown 又可能看不到尚未创建的 card，导致晚创建的 backend/DB row 逃逸清理，构成跨身份数据暴露。
- 建议: DataChannel receipt 时冻结 `{epoch, gen, pc, dc}`，把 AbortSignal/attempt identity 贯穿 meta、chunk finalization 和 backend preparation；每个 await 后、每个 store/chat/sound/ACK 副作用前复核。stale continuation 只能清理由该 exact owner 创建的 backend/row，禁止发布 UI。backend preparation key 需包含 epoch。补 deferred backend、deferred finalize、deferred outbound send 三组 epoch 测试；保持 `finalizeReceive()` 唯一终态和 `(peerSessionId, epoch)` 所有权契约。

### [P1] 刷新后 4001/4002 自动重注册会固定使用空通行码

- 位置: `client/src/store/auth.ts:153`、`client/src/store/auth.ts:345`
- 证据:
```ts
const cached = sessionStorage.getItem('misaka.identity')
if (cached) {
  const data = JSON.parse(cached) as { nodeId: number; createdAt: number }
  return { nodeId: data.nodeId, passCode: '', createdAt: data.createdAt }
}
```
```ts
onAuthInvalid(() => {
  const store = useAuthStore.getState()
  store.clearSession()
  void store.connect()
})
```
- 影响: 用户成功接入后刷新页面，session token 恢复但 passCode 被有意丢弃；随后服务端重启或 session GC 令 WS 返回 4002。handler 清 token 后用 `passCode:''` 请求 `/api/register`，真实服务端的六位数字校验固定返回 400，CLAUDE.md 的“4001/4002 → clear cached session → re-register”链路中断。现有 auth recovery mock 不校验请求体，因此会假绿。
- 建议: 若保留硬契约，应由服务端签发可撤销、限用途的 opaque re-registration proof，并随 Session 缓存，用专用恢复端点换新 token，而不是持久化明文六位码。若产品改为要求重新输入，则必须明确修改 CLAUDE.md 契约和相关测试，并在 passCode 为空时进入 `credentials-required`，不要发必败请求。

### [P1] auth-invalid 不触发 network epoch teardown，页面卸载后旧密钥与传输继续存活

- 位置: `client/src/store/auth.ts:348`、`client/src/store/network.ts:1515`
- 证据:
```ts
onAuthInvalid(() => {
  const store = useAuthStore.getState()
  store.clearSession()
  void store.connect()
})
```
```ts
unsubscribeSignaling.push(onSessionEnd(() => {
  useNetworkStore.getState().destroy()
}))
```
- 影响: 用户曾建立 PC/DC 后离开 Network 页面，随后收到 4002。`clearSession()` 不 dispatch `onSessionEnd`，而 network 只对显式 session end 做 teardown；旧 PC/DC、ECDH key 和传输继续属于死 token。若 HTTP re-register 得到新 token，旧 epoch 要到页面再次调用 `init(newToken)` 才被清除，期间身份边界已失效。
- 建议: 增加模块级 `onSessionInvalid`/auth-epoch coordinator，在 clear/re-register 之前同步结束旧 network epoch，但不要依赖页面挂载。把 token→network lifecycle 协调放到应用根级或独立 composition root。新增“Network 页面未挂载、WS 4002”测试，断言旧 PC/DC/key/transfer 立即清理，再允许 fresh-token 连接。

### [P1] auth 操作没有统一 generation，注销或身份修改可被迟到注册响应反转

- 位置: `client/src/store/auth.ts:67`、`client/src/store/auth.ts:136`、`client/src/store/auth.ts:246`
- 证据:
```ts
async function doConnect(get: AuthGet, set: AuthSet, options: ConnectOptions = {}) {
  const current = get().identity
  set({ isLoading: true, error: null, ipFullPrompt: false })

  const ownsLock = await acquireNodeIdLock(current.nodeId)
```
```ts
const session: Session = { token: data.token, sessionId: data.sessionId, expiresAt: data.expiresAt }
sessionStorage.setItem('misaka.session', JSON.stringify(session))
set({ session, isConnected: true, isLoading: false })
```
```ts
if (connectInFlight) return connectInFlight
connectInFlight = (async () => {
  try {
    await doConnect(get, set, options)
  } finally {
    connectInFlight = null
  }
})()
```
- 影响: `/register` 在途时用户执行 `disconnect()`，或修改 nodeId/passCode。旧请求返回后仍无条件提交：前者会让明确注销的用户重新登录且新 token 未被 release；后者会让 UI identity 是 B、server session/lock 实际属于 A。`connectInFlight` 还会把不同 identity/admissionGrant 的请求错误合并。
- 建议: 用单一 auth operation state machine + monotonic generation/AbortController 串行 register、replace、disconnect；请求记录 identity revision 和 grant，提交前 compare-and-swap。被 supersede 的成功响应必须 best-effort release 新 token。不同 grant/identity 不得共享 promise。补 connect×disconnect、in-flight identity change、plain connect×grant connect 三类 deferred 测试。

### [P1] 未持久化 TURN 偏好时，`enabled:false` 仍允许自动 TURN

- 位置: `client/src/lib/webrtc.ts:125`
- 证据:
```ts
function hasStoredTurnPreference(): boolean {
  try { return localStorage.getItem(TURN_SETTINGS_STORAGE_KEY) !== null } catch { return false }
}
export function isRelayAllowed(): boolean {
  if (loadTurnSettings().enabled) return true
  return !hasStoredTurnPreference()
}

function currentTurnServers(): RTCIceServer[] {
  if (!isRelayAllowed()) return []
  return [...getAutoTurnIceServers(), ...getTurnIceServers()]
}
```
- 影响: 新浏览器中 `loadTurnSettings()` 返回 `enabled:false`，但 storage key 尚不存在；只要服务端已下发 auto TURN，`buildIceConfig()` 仍包含 `turn:` URL并可能实际 relay。代码把“没有记录”解释成“默认允许”，直接违反 CLAUDE.md/AGENTS.md 的 `turnSettings.enabled` 总闸门契约。
- 建议: WebRTC 层只依赖一个语义明确的 settings API，`enabled` 必须是 auto/manual 共用总闸门；若产品默认确实要开，应把默认 settings/迁移写成 `enabled:true`，而不是绕过字段。删除 duplicated storage key 判断，更新 `turn-config-propagation.test.ts` 中固化“无记录例外”的用例，并覆盖默认迁移。

### [P1] perfect negotiation 缺少 `makingOffer` 窗口，稳定状态下仍可发生 glare

- 位置: `client/src/store/network.ts:2762`、`client/src/lib/webrtc.ts:278`
- 证据:
```ts
if (sdp.type === 'offer') {
  if (pc.signalingState === 'have-local-offer') {
    if (isPolite(fromSessionId)) {
      await pc.setLocalDescription({ type: 'rollback' } as RTCSessionDescriptionInit)
    } else {
      return
    }
  }
  const answer = await createAnswer(pc, sdp, () => isPeerConnectionAttemptCurrent(attempt))
```
```ts
export async function createOffer(
  pc: RTCPeerConnection,
  isCurrent?: () => boolean,
) {
  const offer = await pc.createOffer()
  assertNegotiationCurrent(isCurrent)
  await pc.setLocalDescription(offer)
```
- 影响: 双方同时 ICE restart；B 的 `pc.createOffer()` 尚未 resolve，`signalingState` 仍为 `stable`，此时收到 A 的 offer。B 不把它识别为 collision，先走 answer；稍后 B 的本地 offer resolve，在已经变化的 signaling state 上 `setLocalDescription(offer)` 抛错，当前代码可把 peer 标为 offline。现有 glare 测试只覆盖已进入 `have-local-offer` 的 rollback。
- 建议: 实现标准 perfect-negotiation 状态 `makingOffer`、`isSettingRemoteAnswerPending`、`ignoreOffer`；`offerCollision = incomingOffer && (makingOffer || !readyForOffer)`。所有普通 offer、ICE restart 和 config migration 必须进入同一 per-PC negotiation serializer。新增 deferred `createOffer` + inbound offer，以及 impolite ignore/rollback failure 测试。

### [P1] live ICE 配置首次变化不会触发 restart，失败配置还被记成已应用

- 位置: `client/src/lib/webrtc.ts:228`
- 证据:
```ts
const cfg = buildIceConfig()
const signature = iceConfigSignature(cfg)
const changed: RTCPeerConnection[] = []
for (const pc of pcs) {
  if (pc.connectionState === 'closed') continue
  const previous = appliedIceSignature.get(pc)
  appliedIceSignature.set(pc, signature)
  if (previous !== undefined && previous !== signature) changed.push(pc)
```
```ts
try {
  pc.setConfiguration(live)
} catch (err) {
  wlog('webrtc', 'setConfiguration failed', err)
}
```
- 影响: PC 以 STUN-only 或 TURN credential A 构造，随后首次拿到 credential B/首次开启 forceRelay；`previous===undefined` 令函数返回空 `changed`，network 不触发 ICE restart，新增 relay 不参与当前 gathering，已选路径也不迁移。若 `setConfiguration` 抛错，signature 已提前提交，后续同配置不再被识别为待应用。
- 建议: `createPeerConnection()` 构造时记录实际初始 signature，或首次 apply 与 `pc.getConfiguration()` 比较；只在 `setConfiguration` 成功后提交 signature，并仅把“成功应用且真实变化”的 PC 返回给 migration。更新当前“第一次只建 baseline”的测试，增加首次真实变化和失败后重试。

### [P1] ICE restart 的“最大次数”没有自动重试调度

- 位置: `client/src/store/network.ts:3853`
- 证据:
```ts
iceRestartAttempts.set(peerSessionId, attempts + 1)
const offer = await pc.createOffer({ iceRestart: true })
if (!pcStillCurrent()) return
await pc.setLocalDescription(offer)
if (!pcStillCurrent()) return
sendLocalOffer(peerSessionId, pc, pc.localDescription!.toJSON())
} catch {
  if (attemptCurrent) {
    useNetworkStore.setState(s => ({
      peers: s.peers.map(p => p.sessionId === peerSessionId
```
- 影响: 第一轮 `createOffer`/`setLocalDescription` 因瞬时状态错误失败，catch 只把 UI 置 offline；或 restart offer 发出后 answer 丢失，PC 卡在 `have-local-offer`。代码既没有 answer deadline，也不再次调度 `attemptIceRestart`，浏览器通常不会重复发同一个 `failed` state-change，剩余次数永远不执行，连接只能靠用户 focus/manual reconnect。
- 建议: 每轮 restart 建立 answer/ICE recovery deadline；失败或超时后在 epoch/gen/PC identity 仍 current 时调度下一轮，达到上限后 exact teardown + rebuild 或 terminal offline。与 negotiation serializer 共用锁。补“首轮 createOffer 拒绝后自动第二轮”和“offer 无 answer 超时终止”测试。

### [P1] 同 sessionId 重连后，健康 DataChannel 会永久停在 `reconnecting`

- 位置: `client/src/store/network.ts:1335`、`client/src/store/network.ts:1381`
- 证据:
```ts
const { sessionId, nodeId, joinedAt } = msg.peer
set(s => {
  const exists = s.peers.find(p => p.sessionId === sessionId)
  if (exists) return s
```
```ts
if (dcAlive) {
  set(s => ({
    peers: s.peers.map(p =>
      p.sessionId === sid ? { ...p, status: 'reconnecting' as const } : p,
    ),
  }))
  break
}
```
- 影响: peer 的 WS 短断但 P2P DC 仍 open，本端在 `PEER_LEFT` 标记 reconnecting；同 token 重连会保留相同 sessionId 并重新广播 `PEER_JOINED`，但已有 row 直接返回，状态不恢复。下一次 focus/online/pageshow 的 recovery sweep 只因 status 是 reconnecting 就拆掉仍健康的 PC/DC，可中断聊天或文件传输。
- 建议: `PEER_JOINED` 对 existing row 必须读取 exact PC/DC/AES 状态；若加密通道仍有效，恢复 online/connectedPeers 并禁止重协商；否则才进入 connecting/initiate。新增 `live DC → PEER_LEFT → same-session PEER_JOINED → recoverConnections` 测试。

### [P1] 旧 ECDH timeout 可删除新 generation 的 resolver

- 位置: `client/src/store/network.ts:1963`、`client/src/store/network.ts:4030`
- 证据:
```ts
const timeout = setTimeout(() => {
  ecdhResolvers.delete(peerSessionId)
  reject(new Error('加密协商超时'))
}, ENCRYPTION_TIMEOUT_MS)
ecdhResolvers.set(peerSessionId, () => {
  clearTimeout(timeout)
  ecdhResolvers.delete(peerSessionId)
  resolve()
})
```
```ts
ecdhResolvers.delete(sessionId)
connectingPeers.delete(sessionId)
remoteInitiatingPeers.delete(sessionId)
```
- 影响: generation A 正在等待 ECDH，10 秒后手动重连，cleanup 只删 resolver、不清 A 的本地 timeout；generation B 写入同 key 的新 resolver。A 的 30 秒 timer 到点后无条件删除 B resolver，B 随后的 `ecdh-pub` 无法唤醒等待者，健康重连最终也报加密协商超时。
- 建议: resolver entry 保存 `{generation, timer, resolve, reject}`；cleanup 必须 clear timer 并以 AbortError settle exact waiter；timeout 删除前比较 entry identity/generation。新增旧 generation timer 晚于新 resolver 的 fake-timer 测试。

### [P1] 零字节接收绕过 `finalizeReceive()`，留下 active row 与 backend 句柄

- 位置: `client/src/store/network.ts:3664`
- 证据:
```ts
if (meta.totalChunks === 0 && meta.fileSize === 0) {
  const emptyFile = new File([new Blob([], { type: meta.mime })], meta.fileName, { type: meta.mime })
  const url = URL.createObjectURL(emptyFile)
  appendFileChat(peerSessionId, meta.fileName, 0, url)
  playSound('complete')
  useNetworkStore.setState(s => ({
    transfers: s.transfers.map(t =>
      t.id === meta.transferId ? { ...t, progress: 1, status: 'completed' as const } : t,
    ),
```
```ts
sendDurableAck(peerSessionId, meta.transferId, 0)
peerMap.delete(meta.shortId)
forgetTransfer(meta.transferId)
```
- 影响: `prepareReceiveBackend()` 已经提交 FSA/OPFS/IDB，但零字节特判只创建内存 File 并 `forgetTransfer()`；它不关闭 backend、不把 DB row 置 completed、不执行 exact OPFS cleanup。活跃记录会被后续 resume scan 误认为可恢复，句柄/条目可持续到 tab 结束。这直接违反 CLAUDE.md 的“`finalizeReceive()` 是三后端唯一 terminal API”契约。
- 建议: 删除手写终态，零字节也调用 `deliverCompletedFile()`/`finalizeReceive()`；通过现有 `deliveredTransfers` 幂等锁处理多 lane 重复 `meta`。更新 zero-byte、三 backend finalization、resume row retirement 测试。

### [P1] ACK timeout 过早销毁 task，late `done`/repair 无法满足 v2 语义

- 位置: `client/src/store/network.ts:3379`、`client/src/store/network.ts:3714`
- 证据:
```ts
if (msg.type === 'transfer-repair' && typeof msg.transferId === 'string') {
  const requeued = applyRepairRequest(msg, owner)
  if (requeued < 0) await restartSendForRepair(msg.transferId, peerSessionId, owner)
  return
}
if (msg.type === 'transfer-done' && typeof msg.transferId === 'string') {
  if (markTransferAcked(msg.transferId, owner)) {
    transferDelivery.set(msg.transferId, 'saved')
    sendingFiles.delete(msg.transferId)
  }
```
```ts
if (hasLiveSendTask(transferId)) return
const file = sendingFiles.get(transferId)
const record = await getTransfer(transferId)
if (!file || !record) return
const lanes = await ensureTransferLanes(peerSessionId)
void runSendEngine(lanes, file, transferId, peerNodeId, peerSessionId, record, undefined, owner)
```
- 影响: 大文件 finalize 超过 ACK timeout 后 task 已删除。第 61 秒到达的合法 `transfer-done` 因 `markTransferAcked` 返回 false，永远不能把状态升到 saved，源 File 长期滞留；同样时序的 repair 会创建第二 engine，并丢掉 `missingRanges`（`peerBitmap` 为 `undefined`），可能为缺一块重传整份多 GB 文件，还违反“repair 进入同一 live task，绝不启动第二 engine”的硬契约。
- 建议: 将 task 的“active sending”和“dormant awaiting late control”分开；在 saved/cancel/epoch 前保留可 repair 的 task/source。`transfer-done` 的 durable state 接纳应与 waiter 唤醒解耦；late repair 仍操作原 task。若必须重建，至少把 missingRanges 转成 skip bitmap，不能整文件重发。更新 ACK-timeout、late-done、pause 超过 timeout 的 repair 测试。

### [P1] resume 在控制帧或 engine 失败后仍以成功结束，卡片假装传输中

- 位置: `client/src/store/network.ts:1805`、`client/src/store/network.ts:3736`
- 证据:
```ts
resumeTransfer(transferId)
set(s => ({
  transfers: s.transfers.map(t =>
    t.id === transferId ? { ...t, status: 'transferring' as const } : t),
}))

if (t && t.direction === 'recv') {
  try { dc.send(JSON.stringify({ type: 'transfer-resume', transferId })) } catch { /* ignore */ }
  const repair = buildRepairRequest(transferId)
  if (repair) {
    try { dc.send(JSON.stringify(repair)) } catch { /* ignore */ }
```
```ts
try {
  const outcome = await engineSendFileParallel(/* ... */)
  transferDelivery.set(transferId, outcome.state)
  if (outcome.state === 'saved' || outcome.legacyPeer) sendingFiles.delete(transferId)
} catch (err) {
  if (!(err instanceof TransferCancelledError)) {
    console.warn('[net] resume send failed', transferId, err)
  }
}
```
- 影响: precondition 看到 DC open 后，channel 在实际 `send` 时关闭；两次异常被吞，receiver 本地已解除 pause 并把卡片改成 transferring，但 sender 仍 paused且没收到 repair。发送侧 engine 失败也被 `runSendEngine` 吞掉，公开 action resolve，卡片同样永久假“传输中”。
- 建议: resume 做成事务：控制帧成功/engine 接管后才提交 UI 状态；失败恢复 paused 或调用统一 `failOutboundTransfer`，并抛结构化 `TransferResumeError`。初发、resume、repair 共用同一 terminal callbacks 和 chat/UI 收尾。补 channel 在 precondition 后关闭、engine reject 两个测试。

### [P1] `transfer-ready.shortId` 与 `transfer-done.bytes` 完全未校验

- 位置: `client/src/store/network.ts:3363`、`client/src/store/network.ts:3384`
- 证据:
```ts
if (msg.type === 'transfer-ready' && typeof msg.transferId === 'string') {
  markReceiverReady(msg.transferId, owner)
  return
}
```
```ts
if (msg.type === 'transfer-done' && typeof msg.transferId === 'string') {
  if (markTransferAcked(msg.transferId, owner)) {
    transferDelivery.set(msg.transferId, 'saved')
    sendingFiles.delete(msg.transferId)
  }
  return
}
```
- 影响: 同一合法 owner 的旧 attempt/lane 发来 wrong-shortId `transfer-ready`，仍解除当前 transfer 的 ready barrier；buggy 或恶意 receiver 发 `{transfer-done, bytes:0}`，sender 仍标 saved 并释放唯一 retry source。owner 校验不能替代 attempt 和声明大小校验，当前实现会把“durably written”语义降级为“同 peer 发过一个字符串 ID”。
- 建议: send task 记录当前 `shortId`、declared `fileSize` 和 attempt token；ready 必须严格匹配 active shortId/attempt，done.bytes 必须是 safe integer 且等于 fileSize，之后才能推进状态。新增 wrong-shortId、wrong-bytes、stale-attempt ACK 测试，不改变 wire format。

### [P1] answerer 接受任意 DataChannel label，可覆盖 primary 或无限增长 lane

- 位置: `client/src/store/network.ts:2719`
- 证据:
```ts
pc.ondatachannel = (e) => {
  if (!isPeerConnectionAttemptCurrent(createdAttempt)) return
  if (e.channel.label.startsWith('misaka-transfer-')) {
    const lanes = transferLanes.get(fromSessionId) ?? []
    const existing = lanes.find(l => l.label === e.channel.label)
    if (existing) {
      const idx = lanes.indexOf(existing)
      try { existing.close() } catch { /* ignore */ }
      lanes[idx] = e.channel
    } else {
      lanes.push(e.channel)
```
```ts
} else {
  dataChannels.set(fromSessionId, e.channel)
  notifyPrimaryChannel(fromSessionId)
}
setupDataChannel(e.channel, createdAttempt)
```
- 影响: peer 创建任意非 transfer label（如 `foo`）就覆盖 `dataChannels` 的 primary，原主通道仍开着但控制面改路由到错误 channel；创建无限多个唯一 `misaka-transfer-*` label 则持续增长数组、listener 和 SCTP stream。一个错误或恶意 peer 可中断 ECDH/chat/transfer 控制并耗尽资源。
- 建议: 只接受 exact `misaka` 与 `misaka-transfer-0..TRANSFER_LANE_COUNT-1`；未知、越界、重复 primary 立即 close。合法替换必须校验 generation 并显式关闭旧 channel。新增 unknown label、超界 lane、duplicate primary 测试。

### [P1] chunk 失败只删 demux，不终止接收后端或通知发送端

- 位置: `client/src/store/network.ts:3317`
- 证据:
```ts
} catch (err) {
  const errStr = err instanceof Error ? err.message : String(err)
  console.warn('[net] receiveChunk failed', errStr)
  failTransferRecord(transferId, errStr)
  playSound('error')
  appendSystemChat(peerSessionId, `接收失败：${errStr}`)
  shortIdToTransferId.get(peerSessionId)?.delete(frame.shortId)
}
```
- 影响: AES-GCM 校验失败、非法明文长度、quota 或 FSA/OPFS 写错误后，UI 虽标失败，但 ReceiveSession、active DB row、partial chunks、writable 和 owner 仍存活；发送端也没收到 cancel/reject，会继续发送余下数据并等待 ACK timeout。重复失败传输可累积句柄和 origin quota。
- 建议: 抽出幂等 `abortInboundTransfer()`：先发送明确失败/cancel 控制，再等待 `cancelReceive` drain，关闭 FSA、精确清理 OPFS、清 signal/owner/demux 并持久化 failed。chunk catch、本地 cancel、peer cancel 共用它。补 decrypt、长度、quota/write failure 的双端 teardown 测试。

### [P1] durable ACK 是一次性 best-effort，主通道短断会永久丢失 saved 确认

- 位置: `client/src/store/network.ts:3753`
- 证据:
```ts
function sendDurableAck(peerSessionId: string, transferId: string, bytes: number) {
  const dc = dataChannels.get(peerSessionId)
  if (dc?.readyState !== 'open') return
  try {
    dc.send(JSON.stringify({ type: 'transfer-done', transferId, bytes }))
  } catch { /* the sender's ACK timeout covers this */ }
}
```
- 影响: 最后一块从仍开放的 transfer lane 到达，但 primary 在 `finalizeReceive()` 期间关闭；文件已 durable、receiver row 已 completed，函数却直接 return，且没有 pending ACK 队列。sender 最终只到 delivered 并长期保留源 File，重连后双方状态仍不一致。
- 建议: 建立 owner/epoch-scoped `pendingDurableAcks`；只有 `dc.send()` 成功才删除，并在 primary open + ECDH ready 时重发。若跨 reload 也要求一致，应持久化 receipt。补“finalize 时 primary closed，重连后补发 done”测试；仍需保持只有真实 `finalizeReceive()` 成功才入队 ACK。

### [P1] v1 文件若全部在 backend 提交前缓冲，完成事件永远不会触发

- 位置: `client/src/store/network.ts:3314`、`client/src/store/network.ts:3598`
- 证据:
```ts
const result = await receiveChunk(
  transferId, frame.index, frame.iv, frame.ciphertext, peerSessionId,
  callbacks,
)

if (result?.done) await deliverCompletedFile(transferId, peerSessionId)
```
```ts
const prepared = await prepareReceiveBackend({
  transferId: meta.transferId,
  fileName: meta.fileName,
  totalChunks: meta.totalChunks,
  size: meta.fileSize,
}, owner).catch((err) => ({
```
- 影响: v1 sender 不等待 ready。一个不超过预提交缓冲上限的小文件可在 backend prepare 完成前全部到达；prepare 内部回放后 `receivedCount===totalChunks`，但 network 唯一 completion trigger 只读取 live `receiveChunk()` 的 `result.done`。prepare 返回后仅建卡/ACK，已没有下一帧触发终态，文件永久卡在 0%/transferring。
- 建议: backend preparation 的编排结果必须返回 replay 后的 `{received,total,done}`，或提供受 owner/epoch 校验的 completion query；network 创建 card 后若 done，立即走唯一 `deliverCompletedFile()`。新增“完整 v1 小文件全部预提交缓冲”的 store 集成测试。

### [P2] `reconnectNow()` 没有 socket ownership，旧 close 或 PING 异常会破坏恢复

- 位置: `client/src/lib/signaling.ts:100`、`client/src/lib/signaling.ts:134`
- 证据:
```ts
if (ws && (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED)) {
  ws = null
}
if (ws?.readyState === WebSocket.OPEN) {
  try { ws.send(JSON.stringify({ t: 'PING' })) } catch { /* reconnect below */ }
  return
}
doConnect()
```
```ts
sock.onclose = (e) => {
  stopHeartbeat()
  dispatch(disconnectHandlers, undefined, 'disconnect')
  if (e.code === 4001 || e.code === 4002) {
    serverShutdown = true
    dispatch(authInvalidHandlers, undefined, 'authInvalid')
    return
  }
```
- 影响: OPEN 但半死的 socket 在 PING 时抛错，函数注释说 reconnect，实际无条件 return；CLOSING socket 被置 null 后新 socket 已 open，旧 socket 的迟到 close 又会停止新 heartbeat、广播 disconnect，甚至用旧 4001/4002 清当前 auth。恢复状态因此可永久卡住或误伤新连接。
- 建议: 建立 socket generation/attempt；所有 callback 首行检查 `ws===sock`/generation。统一 `detachAndClose` 后才替换；OPEN PING 抛错时关闭 current socket并立即/退避重连。heartbeat 也按 socket ownership 管理。新增两个时序测试：OPEN+send throws，以及 CLOSING old close after new open。

### [P2] 首页统计轮询允许旧响应覆盖新响应

- 位置: `client/src/store/home.ts:67`
- 证据:
```ts
async fetchStats() {
  set({ statsLoading: true, statsStatus: get().statsHasData ? 'ready' : 'loading' })
  try {
    const res = await fetch(apiUrl('/api/stats'))
    if (res.ok) {
      const data = await res.json() as NetworkStats
      set({
        stats: data,
        statsStatus: 'ready',
        statsLastUpdated: Date.now(),
```
```ts
} finally {
  set({ statsLoading: false })
}
```
- 影响: 调用方每 10 秒触发一次且有手动重试。请求 A 卡 12 秒，B 在第 10 秒发出并先返回新快照；A 随后用旧数据覆盖 B，并写入更晚的 `statsLastUpdated`，把旧数据标成最新。任一旧请求的 finally 还会在新请求仍进行时清掉 loading。
- 建议: 使用 AbortController 取消前一请求，或 monotonic requestId 只允许 latest request 提交状态和 finally；把 fetch phase 建模为 discriminated union，并单独保留 lastGoodData。补两个 deferred 逆序测试：old-success-after-new-success、old-error-after-new-success。

### [P2] 失败聊天重试会把同一个 msgId 再次入队并重复投递

- 位置: `client/src/store/network.ts:615`、`client/src/store/network.ts:1725`
- 证据:
```ts
function queueOutgoing(peerSessionId: string, payload: string, msgId?: string) {
  const q = outgoingQueue.get(peerSessionId) ?? []
  q.push({ payload, msgId })
  outgoingQueue.set(peerSessionId, q)
  if (msgId) {
    const ids = queuedMessageIds.get(peerSessionId) ?? new Set<string>()
    ids.add(msgId)
```
```ts
} else {
  queueOutgoing(peerSessionId, payload, msgId)
  startQueuedDelivery(peerSessionId)
}
```
- 影响: 一条离线消息已在 queue；flush 时 channel 关闭，原 item 被保留且 UI 置 failed；用户点一次 retry，Set 虽去重 id，但数组仍 push 第二份 payload。下次 DC open 会对同一 id 执行两次 `send`，接收端又没有按 id 幂等，聊天出现两条重复消息。
- 建议: queue 按 `(peerSessionId,msgId)` upsert/拒绝重复，或 retry 前替换旧 item；接收端同时按 id 幂等。补“failed flush → 一次/多次 retry → reconnect”测试，断言 sender send 一次、receiver append 一次。

### [P2] 过宽的 JSON catch 静默吞掉所有合法协议处理异常

- 位置: `client/src/store/network.ts:3330`、`client/src/store/network.ts:3465`
- 证据:
```ts
if (typeof e.data === 'string') {
  try {
    const msg = JSON.parse(e.data)
    if (msg.type === 'hello') {
      setPeerProtocolVersion(peerSessionId, msg.v)
      return
    }
```
```ts
if (msg.type === 'resume') {
  await handleResumeRequest(msg as ResumeRequest, peerSessionId, owner)
  return
}
// ... all remaining control handlers ...
} catch { /* not JSON */ }
```
- 影响: 合法 `resume` 进入 `handleResumeRequest`，其中 `ensureTransferLanes` 因 channel 超时拒绝；异常被误当成“不是 JSON”静默吞掉。双方没有 failure card、peer reject 或有上下文日志，续传永久卡住。ECDH、meta 和其他 async handler 的异常也同样被抹掉。
- 建议: 只用窄 try/catch 包 `JSON.parse`，随后交给 typed control router；每类 handler 返回结构化结果或独立 catch，dispatcher 统一记录 peer/type/transferId，并更新失败状态/反馈 peer。补 resume/metadata handler rejection 测试并断言无 unhandled、也不静默。

### [P2] `PEER_OFFLINE` 把信令离线错误写成 P2P transport 离线

- 位置: `client/src/store/network.ts:1459`、`client/src/store/network.ts:1658`
- 证据:
```ts
case 'PEER_OFFLINE': {
  const sid = msg.targetSessionId
  set(s => ({
    peers: s.peers.map(p =>
      p.sessionId === sid ? { ...p, status: 'offline' as NodeStatus } : p,
    ),
  }))
  break
}
```
```ts
const targets = get().peers
  .filter(p => p.status !== 'offline')
  .map(p => p.sessionId)
if (targets.length === 0) throw new Error('没有可用的目标节点')
```
- 影响: peer 的 WS 已掉线但加密 DC 仍 open；本端一次 ICE/config signaling 获得 `PEER_OFFLINE` 后把 transport status 改 offline。随后群发直接过滤该仍可 P2P 接收的 peer，出现“没有可用目标节点”或漏发，而同文件的 `PEER_LEFT` 分支又明确承认 WS 离线时 DC 可以继续活着。
- 建议: 拆分 `signalingPresence`、ICE/DC/encryption state，`Peer.status` 只由 selector 推导；群发以 exact `dc.readyState==='open' && hasAESKey(sessionId)` 等能力判断目标。新增“WS offline + encrypted DC open”群发测试。

### [P2] 删除 peer UI 时未统一处理下载 artifact，Blob/OPFS 可能失去释放入口

- 位置: `client/src/store/network.ts:143`、`client/src/store/network.ts:1744`
- 证据:
```ts
function retireDownloadArtifact(url: string) {
  const lifecycle = artifactLifecycleByUrl.get(url)
  if (lifecycle?.started) return
  void releaseDownloadArtifact(url)
}
```
```ts
blockPeer(sessionId) {
  wsSend({ t: 'BLOCK', sessionId })
  set(s => {
    const { [sessionId]: _omit, ...rest } = s.chatMessages
    return {
      peers: s.peers.filter(p => p.sessionId !== sessionId),
      chatMessages: rest,
```
- 影响: 未点击的 OPFS/Blob 文件卡被 block 时，chat 直接删除但不调用 retire，object URL、registry entry 和 OPFS cleanup closure 永久无人触达；已点击 artifact 在 epoch teardown 时 `retireDownloadArtifact` 又直接 return，随后 chat 被清空，确认释放的 UI 入口也消失。大文件可跨 logout/identity 长期占用 origin storage。
- 建议: 抽 `DownloadArtifactRegistry`，peer/epoch teardown 必须显式转移或释放所有 artifact。未 started 的立即 revoke+cleanup；started 的移入 epoch 外、可见的 pending-download tray，保留用户确认完成/放弃入口，不能简单定时删除慢下载。`blockPeer` 同时清 unread/staged File/sending state。补 block、logout-before-click、logout-after-click 三类测试。

### [P2] 注册失败后仍持有 Web Lock，其他标签页被误判冲突

- 位置: `client/src/store/auth.ts:71`、`client/src/store/auth.ts:91`
- 证据:
```ts
const ownsLock = await acquireNodeIdLock(current.nodeId)
if (!ownsLock) {
  set({
    isLoading: false,
    error: '该节点编号已在本浏览器的另一个标签页接入。请关闭其他标签页或更换节点编号。',
  })
  return
}
```
```ts
if (res.status === 409) {
  const data = await res.json()
  set({ isLoading: false, error: msg })
  return
}
```
- 影响: Tab A 用错误通行码收到 409、或遇到 423/403/429/5xx/网络异常，所有失败分支都未 release lock；Tab B 即使用正确凭据，也立即收到“另一个标签页已接入”，直到 A 关闭或更换 nodeId，虽然 A 从未成功注册。
- 建议: 把锁封装成 lease，并用 `committed=false` 的 finally；仅 session 成功原子提交后长期持有，所有失败/异常释放 exact lease。与 auth operation generation 一起防止旧 attempt 误释放新锁。补 409、500、fetch reject 后第二个 tab 可获取锁的测试。

### [P2] `network.ts` 混合 11 个责任域，直接剪切会形成至少 6 组循环依赖

- 位置: `client/src/store/network.ts:1213`、`client/src/store/network.ts:3260`
- 证据:
```ts
interface NetworkState {
  wsConnected: boolean
  signalingStatus: SignalingStatus
  mySessionId: string | null
  channelId: string | null
  peers: Peer[]
  selectedSessionId: string | null
  transfers: Transfer[]
  chatMessages: Record<string, ChannelMessage[]>
  pendingFiles: Record<string, PendingFileItem[]>
  connectedPeers: Set<string>
```
```ts
dc.onmessage = async (e) => {
  if (!stillCurrent()) return
  const owner = ownerFor(peerSessionId)
  // binary chunk, hello, ECDH, meta/resume,
  // ready/reject/repair/done, chat/ack,
  // pause/resume/cancel all dispatch here
```
- 影响: 文件同时拥有 session epoch、WS roster、PeerConnection/DC registry、SDP/ICE queue、ICE recovery、TURN/NAT propagation、ECDH、chat、transfer v2、download artifact、UI selector共 11 个域。`setupDataChannel` 反向调用 chat/transfer，chat 又触发 `ensureConnected`，ICE recovery 同时 cleanup/re-initiate/send offer，所有 controller 还直接读写 Zustand singleton；这正是本报告中 stale epoch、漏清 artifact、状态混淆和错误终态难以局部修复的共同维护成本。
- 建议: 保留 `client/src/store/network.ts` 为兼容 barrel，按以下顺序渐进拆分，禁止一次性改协议：
  - `contracts.ts`：`NetworkState` 拆为 session/peer/conversation/transfer/connectivity slices 及公开 error/result types。
  - `selectors.ts`：`deriveNetworkStatus`、`peerDisplayStatus`、retention；把当前 prune helper 的 Map/URL 副作用改为返回 retired IDs。
  - `download-artifacts.ts`：唯一 URL/OPFS artifact registry。
  - `session-scope.ts`：`networkEpoch`、token、owner、ordered disposers；通过 ports 调用各域，不能反向 import store。
  - `peer-runtime.ts`：PC/DC/lane、ECDH waiter、generation/incarnation、`ensureConnected`、exact cleanup；公开窄 `DataChannelProvider`。
  - `negotiation-controller.ts`：SignalReceipt、per-peer queue、pending ICE、offer/answer、perfect negotiation。
  - `ice-recovery.ts`：restart/watchdog/rebuild/foreground recovery；只依赖 PeerRuntime 和 Negotiation ports。
  - `connectivity-controller.ts`：TURN/NAT probe、live config apply、ICE migration。
  - `data-channel-router.ts`：label 白名单、binary/string parse、typed handler dispatch；通过注入连接 chat/transfer。
  - `chat-controller.ts`：outgoing queue、ack、unread、send/retry。
  - `transfer-controller.ts`：staging、send/resume/cancel、v2 controls、demux、delivery state、唯一 terminal callbacks。
  - `signaling-controller.ts`：init/destroy/readiness/WELCOME/roster；`store.ts` 只组合 slices/controllers。
  隐藏循环必须用 `StorePort`、`PeerPresencePort`、`DataChannelProvider`、`ChatProtocolHandler`、`TransferProtocolHandler` 和 `NegotiationPort` 构造注入消除。迁移期间保留现有 import 路径，并逐步搬迁 `network-negotiation`、epoch、protocol v2、receiver pause/repair、durable delivery 测试；不得弱化 frame layout、owner、ready barrier、durable ACK、auth retry 或 TURN gating 契约。

## 附录: 已核查但结论为无问题的区域

- `SIGNAL_SDP`、`SIGNAL_ICE`、`SIGNAL_ICE_END` 已按 peer 串行，并以 epoch/incarnation/generation/PC/localOfferToken receipt 丢弃替换 PC 的旧消息。
- 已经进入 `have-local-offer` 的 glare 路径有确定性的 polite/impolite 分工；polite rollback 后会按 ufrag 重绑 pending ICE。缺口仅是 `makingOffer` 窗口。
- `whenSignalingStable()` 的 listener、AbortSignal 与 timeout cleanup 完整。
- 显式持久化 `turnSettings.enabled=false` 时，auto/manual TURN 当前确实都会被清空；问题限定在“没有持久化记录”的例外分支。
- receive 主路径由 `receiveChunk()` 统一保证 decrypt → durable write → bitmap → persist bitmap → progress；完整性检查和三 backend 正常 `finalizeReceive()` 路径未发现 store 侧逆序。
- receiver pause/resume 会生成 repair，入站 `transfer-pause/resume/cancel` 也会使用 `(peerSessionId, epoch)` 做 ownership check；报告中的缺陷集中在 task 生命周期和 store cleanup。
- `cleanupPeerConnection()` 会 bump generation、在主动 close 前卸载 `dc.onclose`，并清理 pending ICE、disconnect/initial recovery timers 和 connectedPeers。
- signaling handler dispatch 能隔离同步 throw 与异步 rejection；4001/4002 close code 的识别与 `onAuthInvalid` dispatch 本身正确。
- `authedFetch` 的一次 401 retry / double-401 `AuthRequiredError` 不在本次范围内改动，本报告没有提出破坏该契约的建议。
