# Misaka Network 传输引擎专项审计（2026-07-29）

## 摘要

- `transfer-repair` / `resume.receivedRanges` 会把不可信 RLE 范围逐索引展开；一个合法大小的控制帧即可触发数十亿次循环或巨量数组分配，属于可远程触发的页面级拒绝服务。
- FSA 接收取消使用 `writable.close()` 而非 `abort()`；取消会提交部分内容。若用户选择已有文件，原文件可能被部分传输内容覆盖。
- protocol v2 的 attempt 边界不完整：`transfer-ready.shortId` 未校验、ready 状态跨 attempt 残留、`transfer-done.bytes` 未验证，零字节发送甚至在没有 `transfer-done` 时直接宣称 `saved`。
- legacy v1 的预提交缓冲既会在超过 32 帧时静默丢片，也会在文件完全落入缓冲时吞掉完成信号；小文件和大文件分别可稳定卡死。
- 接收后端准备只去重“同时进行”的调用，不缓存已提交结果，也不检查取消/epoch 后的陈旧结果；延迟到达的重复 `meta` 可重复打开 writable、覆盖句柄或在取消后遗留句柄。
- 并发重复分片没有 per-index in-flight 去重，终止路径也不等待 `inflightSaves`；同时到达的同索引帧可重复写入，并在 IDB 终止清理之后重新制造孤儿 chunk。
- `activeWork` 的注册机制在生产代码中没有任何 probe 注册者，更新横幅的 reload guard 因此在真实传输期间仍返回空闲。
- 本审计严格按要求未运行测试、构建或安装；结论来自目标源码、实际调用方和现有测试的只读交叉核查。

## 发现

### [P0] 不可信范围会被无界展开，单条控制消息即可耗尽内存或锁死主线程

- 位置: `client/src/lib/transfer.ts:565`；`client/src/lib/chunk-bitmap.ts:138`
- 证据:

```ts
  const indexes: number[] = []
  if (Array.isArray(req.missingRanges)) {
    for (const range of req.missingRanges) {
      if (!Array.isArray(range) || range.length !== 2) continue
      const [start, length] = range
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length)) continue
      if (start < 0 || length <= 0 || length > MAX_TOTAL_CHUNKS) continue
      for (let i = start; i < start + length; i++) indexes.push(i)
    }
  }
```

```ts
export function rangesToBitmap(
  ranges: ReadonlyArray<readonly [number, number]>,
  totalChunks: number,
): Uint8Array<ArrayBuffer> {
  const buf = newBitmap(totalChunks)
  for (const [start, length] of ranges) {
    const end = Math.min(start + length, totalChunks)
    for (let i = Math.max(0, start); i < end; i++) bitmapSet(buf, i)
  }
  return buf
}
```

- 影响: 拥有当前传输会话的对端发送 `missingRanges: [[0, 4294967295]]` 时，代码会先尝试向 `indexes` 压入约 42 亿个数字，尚未到 `task.requeue()` 的实际 `totalChunks` 边界就已 OOM。`resume.receivedRanges` 也可携带大量重复的全范围区间，使 `rangesToBitmap()` 重复扫描同一约 6.6 万位 bitmap 数千次，造成数亿次主线程循环。两条路径都处理 DataChannel 上的不可信 JSON。
- 建议: 新增一个统一的 `validateAndNormalizeRanges(ranges, totalChunks)`：限制 range 数量，要求两个值均为 safe integer，先裁剪到 `[0,totalChunks)`，排序并合并重叠区间，再以 O(`totalChunks / 8 + rangeCount`) 写 bitmap。`applyRepairRequest()` 不应构造索引数组，应让 send task 直接消费已规范化区间。为单个超大范围、重复全范围、负数/小数/溢出端点补充拒绝服务回归测试。

### [P0] 取消 FSA 接收会提交部分文件，并可能覆盖用户原文件

- 位置: `client/src/lib/transfer.ts:2279`
- 证据:

```ts
export function cancelStreamWrite(transferId: string) {
  const handle = writeHandles.get(transferId)
  if (handle) {
    handle.writable.close().catch(() => {})
    writeHandles.delete(transferId)
  }
}
```

- 影响: 用户在 FSA 模式接收文件、保存目标选择了一个已有文件，然后在传输 10% 时点击取消；`close()` 会提交 writable 中的部分内容，目标文件变成截断/稀疏的未完成传输，原文件内容不可恢复。该函数还立即丢弃句柄且不等待 `close()`，关闭失败后没有可重试的清理入口。
- 建议: 将 API 改成 `async cancelStreamWrite()`，优先 `await handle.writable.abort()` 以丢弃未提交修改，只在明确不支持 `abort()` 的环境使用经过风险处理的后备方案；操作完成后再删除 map 条目。所有取消和 epoch teardown 调用方必须 await 或统一纳入 teardown promise，并增加“取消不会提交/覆盖既有文件”的 FSA mock 回归测试。

### [P1] v1 预提交缓冲溢出后静默丢片，且协议没有 repair 可恢复

- 位置: `client/src/lib/transfer.ts:1144`；`client/src/lib/transfer.ts:1442`
- 证据:

```ts
// BUG-011: at most this many pre-commit frames are held per transfer. 32 ×
// 252 KB ≈ 8 MB — enough to cover a legacy (v1) sender that starts blasting
// the moment it has sent `meta`, without giving a hostile peer an unbounded
// memory sink. Overflow is safe: the repair/resume path re-requests them.
const MAX_BUFFERED_PRECOMMIT_FRAMES = 32
```

```ts
  if (session.backend === null) {
    if (session.buffered.length < MAX_BUFFERED_PRECOMMIT_FRAMES
      && !session.buffered.some(f => f.index === index)) {
      session.buffered.push({ index, iv, encrypted })
    }
    return
  }
```

- 影响: v1 发送方按既定语义在 `meta` 后立即发送一个大于约 8 MB 的文件；接收方仍在等待 FSA picker 或 OPFS 准备时，第 33 帧起被无声丢弃。CLAUDE.md 明确规定 v1 没有 `transfer-repair`，发送方又已把这些片标为发送，因此接收计数永远达不到 `totalChunks`，UI 长期卡住且没有自动恢复。
- 建议: 对 v1 使用可持久化的 staging backend（例如先写 IDB/OPFS，再迁移或交付），不得静默丢帧；若无法保证容量，应在接收前明确拒绝/取消 v1 大文件，而不是依赖 v2-only repair。保留 v2 的 `transfer-ready` barrier。新增“picker 延迟 + 33 个以上 legacy 帧”的测试，并显式锁定 v1/v2 不同语义。

### [P1] 缓冲回放吞掉完成结果和写入错误，完整小文件仍会永久卡住

- 位置: `client/src/lib/transfer.ts:1393`
- 证据:

```ts
async function flushBufferedChunks(session: ReceiveSession) {
  if (session.buffered.length === 0) return
  const queued = session.buffered.slice().sort((a, b) => a.index - b.index)
  session.buffered.length = 0
  for (const frame of queued) {
    try {
      await persistChunk(session, frame.index, frame.iv, frame.encrypted, session.peerSessionId)
    } catch (err) {
      console.warn('[transfer] buffered chunk replay failed', frame.index, err)
    }
  }
}
```

- 影响: 一个不超过 32 片的 v1 文件在 backend 准备完成前全部到达时，回放会令 `receivedCount === totalChunks`，但 `persistChunk()` 的 `{ done: true }` 被丢弃，调用方之后也不会再收到 chunk 来触发 `deliverCompletedFile()`，文件已落盘却永远不交付。若某片解密、配额或磁盘写入失败，错误同样只写日志，`prepareReceiveBackend()` 仍返回 `ok: true` 并继续发送 ready。
- 建议: 让 `flushBufferedChunks()` 返回结构化结果（至少 `{ completed, error }`），首个持久化错误立即向上传播；`prepareReceiveBackend()` / 调度层必须在 `completed` 时走同一个 `finalizeReceive()` 终止入口，在错误时发送 reject/cancel。增加“所有片均在 commit 前到达”和“缓冲回放写失败”两个测试。

### [P1] 后端准备仅去重并发调用，不具备已提交幂等性或取消后的陈旧结果保护

- 位置: `client/src/lib/transfer.ts:1353`
- 证据:

```ts
  const key = preparationKey(owner, meta.transferId)
  const inFlight = backendPreparations.get(key)
  if (inFlight) return inFlight

  const task = (async (): Promise<PrepareBackendResult> => {
    const selected = await selectWritableBackend(meta)
    const rejection = checkBackendOOMGuard(meta.size, selected)
```

```ts
    const session = receiveSessions.get(meta.transferId)
    if (session) {
      session.backend = selected
      session.storageMode = selected === 'idb' ? 'indexeddb' : 'stream'
      await flushBufferedChunks(session)
    }
    return { ok: true, mode: selected }
```

- 影响: `meta` 本来就会从多个 lane 重复到达。若后到的副本发生在第一个 preparation 已从 map 删除之后，函数不会复用 `session.backend`，会再次打开 FSA picker/OPFS writable，并覆盖 `writeHandles` / `opfsHandles` 中的旧句柄。另一条确定竞态是 preparation 等待 picker 时用户取消：`receiveSessions` 被删除后，picker 仍可成功并把句柄写入 map；上述代码因 `session` 不存在而跳过绑定，却仍返回 `ok: true`，留下无主 writable。
- 建议: 将 preparation 状态放入 `ReceiveSession`，包含 immutable meta、owner 的完整 `(peerSessionId, epoch)`、attempt token、promise 和 committed result。若 backend 已提交，直接返回同一结果；每个 await 后重新验证 session 身份/token，发现取消或 epoch 变化时先 abort/删除刚选中的 backend，再返回明确拒绝。测试应覆盖“错开完成的重复 meta”和“picker pending 时取消/换 epoch”。

### [P1] 并发重复分片可同时进入写路径，终止时也不会等待这些操作

- 位置: `client/src/lib/transfer.ts:1439`；`client/src/lib/transfer.ts:1617`
- 证据:

```ts
  // P1-4: duplicate-chunk fast path.
  if (bitmapHas(session.received, index)) return

  if (session.backend === null) {
    if (session.buffered.length < MAX_BUFFERED_PRECOMMIT_FRAMES
      && !session.buffered.some(f => f.index === index)) {
      session.buffered.push({ index, iv, encrypted })
    }
    return
  }

  return persistChunk(session, index, iv, encrypted, peerSessionId, callbacks)
```

```ts
export async function finalizeReceive(transferId: string): Promise<FinalizeResult> {
  const session = receiveSessions.get(transferId)
  if (!session) throw new Error('No receive session')
  if (session.finalized) throw new Error('Transfer already finalized')

  if (session.receivedCount !== session.totalChunks) {
```

- 影响: 两个 lane 同时送达同一 index 时，两次调用都可在第一次 durable write 设置 bitmap 之前通过 fast path，并各自解密/写入。若其中一个是最后缺片，另一条较慢的 IDB 写可能在 `finalizeReceive()` 已 assemble 并 `deleteChunks()` 后才执行，从而重新创建孤儿 chunk；若两个合法密文解出不同的同长度内容，最终内容还取决于竞态写入顺序。现有 duplicate 测试只顺序 `await`，没有覆盖并发。
- 建议: 为 session 增加 per-index `processing` bitmap / promise map：第一条帧占有 index，后续重复帧复用或直接等待该 promise；失败时在 finally 释放占有位。`finalizeReceive()` 在进入 backend close/assemble 前还应 drain `inflightSaves` 并重新核对 bitmap/count。新增 `Promise.all(receiveChunk(sameIndex...))` 与“慢重复写跨 finalize”的测试。

### [P1] 零字节 v2 发送在未收到 durable ACK 时直接宣称 `saved`

- 位置: `client/src/lib/transfer.ts:794`
- 证据:

```ts
  if (file.size === 0) {
    callbacks?.onProgress?.(1, 1)
    callbacks?.onDeliveryState?.('queued')
    callbacks?.onDeliveryState?.('delivered')
    callbacks?.onDeliveryState?.('saved')
    await updateTransfer(transferId, { status: 'completed' })
    return { state: 'saved', acked: false, legacyPeer }
  }
```

- 影响: v2 接收端可能无法准备 backend、明确 reject，或 DataChannel 在 meta 后断开；发送端仍立即显示“已保存”并释放源 `File`。这直接违反 CLAUDE.md 的硬契约：“Only `transfer-done` promotes a send from `delivered` to `saved`”。现有 `transfer-zero-byte.test.ts:55-65` 反而把 `{ state: 'saved', acked: false }` 锁定为期望。
- 建议: v2 零字节也必须等待 `transfer-ready`，随后等待接收端现有零字节分支发送的 `transfer-done(bytes: 0)` 才进入 `saved`；超时只能返回 `delivered`。v1 最高仍为 `delivered`。更新 `transfer-zero-byte.test.ts`、`transfer-protocol-version.test.ts` 和 delivery-state 测试，二进制 frame 布局无需改变。

### [P1] ready barrier 未按 shortId/attempt 隔离，旧 ACK 可解锁新一次发送

- 位置: `client/src/lib/transfer.ts:127`；`client/src/lib/transfer.ts:1051`
- 证据:

```ts
export interface ReadyMessage {
  type: 'transfer-ready'
  transferId: string
  /** Echoed so the sender can drop an ACK for a superseded attempt. */
  shortId: number
}
```

```ts
const receiverReadyWaiters = new Map<string, (ready: boolean) => void>()
const receiverReadyFlags = new Set<string>()

export function markReceiverReady(transferId: string, owner: TransferOwner | undefined): boolean {
  if (!assertTransferOwner(transferId, owner)) return false
  receiverReadyFlags.add(transferId)
  const settle = receiverReadyWaiters.get(transferId)
  receiverReadyWaiters.delete(transferId)
  settle?.(true)
  return true
}
```

- 影响: 接口明确用 `shortId` 区分 superseded attempt，但实际 dispatcher 只传 `transferId`，waiter/flag 也只按 transferId 建键。第一次 attempt 的延迟 ready 可以解锁使用新 shortId 的第二次 attempt；而 successful send 路径没有清理 `receiverReadyFlags`，同 ID retry 会立即越过“backend committed”屏障。每次发送还会留下 ready flag / owner 直到整个 epoch，长会话持续增长。
- 建议: 以 `(transferId, shortId, peerSessionId, epoch)` 作为 ready attempt key；`markReceiverReady()` 必须接收并严格比较 `shortId`，新 attempt 注册前清除旧 attempt 状态，send 的成功、超时、reject、cancel 和异常 finally 均统一清理 ready/owner。同步修改 network dispatcher 与 protocol-version/delivery tests；保持 `CHUNK_FRAME_TAG` 和既定 frame 布局不变。

### [P1] `transfer-done.bytes` 完全未验证，错误 ACK 仍会释放发送源

- 位置: `client/src/lib/transfer.ts:150`；`client/src/lib/transfer.ts:539`
- 证据:

```ts
export interface DoneMessage {
  type: 'transfer-done'
  transferId: string
  bytes: number
}
```

```ts
export function markTransferAcked(transferId: string, owner: TransferOwner | undefined): boolean {
  if (!assertTransferOwner(transferId, owner)) return false
  const task = sendTasks.get(transferId)
  if (!task) return false
  if (owner && task.peerSessionId !== owner.peerSessionId) return false
  task.acked = true
  const notify = task.notifyAck
  task.notifyAck = undefined
  notify?.()
  return true
}
```

- 影响: 对端发送 `{type:"transfer-done", transferId, bytes:0}`（包括实现错误、截断后的错误 ACK）时，一个非空文件仍被提升为 `saved`；store 随后删除唯一 retry source。消息甚至无需提供 `bytes`，因为调用链从未把它交给 `markTransferAcked()`。
- 建议: 将整个 `DoneMessage` 传入 ACK handler，验证 `bytes` 是 safe integer 且严格等于 send task 的 `file.size`，同时验证 attempt/epoch；不匹配时拒绝 ACK、保留源文件并报告协议错误。增加 missing/negative/oversize/mismatch bytes 测试。

### [P1] DataChannel 保持 open 但不再排空时，发送会无限挂起

- 位置: `client/src/lib/transfer.ts:1815`；`client/src/lib/transfer.ts:999`
- 证据:

```ts
export function waitForBuffer(dc: RTCDataChannel): Promise<void> {
  return new Promise(resolve => {
    if (dc.readyState !== 'open' || dc.bufferedAmount <= HIGH_WATER_MARK) {
      resolve()
      return
    }
    let settled = false
```

```ts
    dc.addEventListener('bufferedamountlow', onLow)
    dc.addEventListener('close', onDead)
    dc.addEventListener('error', onDead)
  })
}
```

```ts
      if (Date.now() > deadline) return
      await waitForBuffer(dc)
```

- 影响: NAT/无线网络进入半开状态时，`readyState` 可长期保持 `open`，`bufferedAmount` 高于阈值，但既不触发 `bufferedamountlow`，也不触发 close/error。`waitForBuffer()` 没有 timer 或 cancel signal，因此 lane loop 永不 settle；`drainLanes()` 的 30 秒 deadline 位于这个无限 await 之后，实际上无法生效，发送卡片会永久停在中间状态。
- 建议: `waitForBuffer()` 接受 deadline/AbortSignal，并注册超时后清理三个 listener、以结构化 timeout 失败；lane loop 和 drain 共用同一取消/超时策略。`drainLanes()` 不应静默 `return` 后宣称 delivered。扩展 `transfer-waitbuffer-close.test.ts`，覆盖“open 且永不发事件”的 fake timer 场景。

### [P1] sender 对 skip/sent bitmap 的并集计数错误，所有片已覆盖仍会报“未送达”

- 位置: `client/src/lib/transfer.ts:718`；`client/src/lib/transfer.ts:756`
- 证据:

```ts
  const sentBitmap = bitmapFromRecord(record)
  let sent = bitmapPopcount(skipBitmap)
```

```ts
  task.applyPeerBitmap = (bitmap: Uint8Array) => {
    const copyLen = Math.min(skipBitmap.length, bitmap.length)
    for (let i = 0; i < copyLen; i++) skipBitmap[i] |= bitmap[i]
    sent = Math.max(sent, bitmapPopcount(skipBitmap))
  }
```

- 影响: live sender 已发送低位 10 片，随后收到 resume bitmap，表明对端从前一次 attempt 持有另外 10 个高位片；真实覆盖集合是 20 片，但 `Math.max(10,10)` 仍为 10。`acquireChunk()` 会正确跳过两个 bitmap 中的全部 20 片，末尾 `sent < totalChunks` 却按少算的数量抛出“分片未送达”。从旧 sender record 恢复非空 `sentBitmap` 时，初始计数也完全忽略它。
- 建议: 维护一个明确的 `coveredBitmap = sentBitmap OR skipBitmap` 和对应 O(1) 计数；每次 set/clear 仅在 union 位发生 0↔1 时调整计数。增加 disjoint/overlap peer bitmap、旧 record bitmap、repair clear 后重发三组测试。

### [P1] 未知 transferId 被视为已授权并创建状态，可被控制帧无限灌满

- 位置: `client/src/lib/transfer.ts:387`；`client/src/lib/transfer.ts:1915`
- 证据:

```ts
export function assertTransferOwner(transferId: string, owner: TransferOwner | undefined): boolean {
  const rec = transferOwners.get(transferId)
  if (!rec) return true
  if (!owner) return false
  return rec.peerSessionId === owner.peerSessionId && rec.epoch === owner.epoch
}
```

```ts
export function applyPeerPause(transferId: string, owner: TransferOwner | undefined): boolean {
  if (!assertTransferOwner(transferId, owner)) return false
  pauseTransfer(transferId)
  return true
}
```

- 影响: 任意已连接 peer 连续发送不同的 `{type:"transfer-pause", transferId:"x-N"}` 时，未知 ID 通过 ownership 检查，`pauseTransfer()` 为每个 ID 在 `transferSignals` 新建永久条目；`transfer-resume` 同样如此，未知 `transfer-ready` 还会填充 `receiverReadyFlags`。注释所称“unknown control message is a no-op”与实际行为相反，可导致 epoch 内无界内存增长。
- 建议: 分离“首次注册 owner”和“对已有 transfer 执行控制”的 API；所有 peer-driven control handler 对未知 transfer 必须返回 false，且要求存在匹配方向的 send task / receive session。限制 transferId 长度也应在所有控制消息统一入口执行。增加未知 pause/resume/ready 不改变任何 registry 的测试。

### [P1] 终止清理吞掉 IDB 失败后仍销毁恢复状态

- 位置: `client/src/lib/transfer.ts:1665`
- 证据:

```ts
  await deleteChunks(transferId).catch(() => {})
  const cleanup = backend === 'opfs' && opfsEntryName
    ? async () => { await removeOPFSEntry(transferId, opfsEntryName).catch(() => {}) }
    : undefined
  await updateTransfer(transferId, { status: 'completed' }).catch(() => {})
  receiveSessions.delete(transferId)
  transferSignals.delete(transferId)
  clearTransferOwner(transferId)
  clearReceiverReady(transferId)
  void pruneTerminalTransfers().catch(() => {})
```

- 影响: IDB 在 `updateTransfer(status:"completed")` 时短暂失败，函数仍返回成功并删除 session/owner；原 row 保持 `active`，下次启动会把它列为可续传，但 IDB chunks 可能已在前一行删除，形成 bitmap 声称完整、磁盘却无数据的 ghost resume。反过来，`deleteChunks()` 失败也被吞掉，完成传输的 chunks 会占用配额。
- 建议: 把 terminal record 转换与 chunk 清理放进可恢复、可重试的终止阶段；至少必须先可靠持久化 terminal 状态，再删除内存 session，失败则向调用方报告并保留恢复/清理句柄。不要对关键不变量使用空 catch；记录 cleanup-pending 状态并在启动时重试。补充 update/delete 分别失败的 fault-injection 测试。

### [P1] 生产代码从未注册 active-work probe，reload guard 实际恒为空闲

- 位置: `client/src/hooks/activeWork.ts:17`；`client/src/components/features/UpdateBanner.tsx:51`
- 证据:

```ts
const probes = new Set<Probe>()
const listeners = new Set<() => void>()
```

```ts
export function hasActiveWork(): boolean {
  for (const probe of probes) {
    try {
      if (probe()) return true
    } catch {
      return true
    }
  }
  return false
}
```

```tsx
export default function UpdateBanner({ onReload = () => window.location.reload() }: Props = {}) {
  const [available, setAvailable] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [reloading, setReloading] = useState(false)
  const [activationError, setActivationError] = useState(false)
  const busy = useActiveWork()
```

- 影响: 全仓生产源码只消费 `useActiveWork()` / `hasActiveWork()`，没有调用 `registerActiveWorkProbe()`；只有单元测试手工注册。因此即使 WebRTC 传输或握手正在进行，`probes` 仍为空，更新横幅允许 `window.location.reload()`，直接中止 DataChannel、worker 操作和未完成写入。现有测试验证了 registry 本身，却没有验证 network 层实际接线。
- 建议: 在 network store 生命周期中注册一个稳定 probe，读取 send tasks、receive sessions、pending handshake/transfer card 的真实状态，并在 teardown 时注销；开始/结束关键工作时调用 `notifyActiveWorkChanged()`，轮询仅作后备。增加挂载真实 network store 后 UpdateBanner 被阻止 reload 的集成单测。

### [P1] AES-GCM 未认证 transfer/shortId/index，合法密文可被重路由而不报错

- 位置: `client/src/workers/crypto.worker.ts:55`；`client/src/lib/transfer.ts:1483`
- 证据:

```ts
      const result = await crypto.subtle[op](
        { name: 'AES-GCM', iv: new Uint8Array(iv) },
        key,
        data,
      ) as ArrayBuffer
```

```ts
    const decrypted = await decryptChunk(iv, encrypted, peerSessionId)

    const expected = expectedChunkLength(session.fileSize, index)
    if (decrypted.byteLength !== expected) {
      throw new Error(`分片 ${index} 长度非法（${decrypted.byteLength}，应为 ${expected}）`)
    }
```

- 影响: 把某个完整长度 chunk 的 `{iv,ciphertext}` 原样放入另一个完整长度 index（或同一 peer session 的另一个同几何 transfer）时，GCM tag 仍验证成功；接收端随后按未认证的 frame header `index` 写入错误偏移。由于 whole-file hash 已停用且长度相同，最终文件可被静默错序/污染并通过 size gate。
- 建议: 把 `protocolVersion + transferId + shortId + index + expectedPlaintextLength` 编码为确定性 AAD，并在 worker 的 encrypt/decrypt 两侧传入 `additionalData`。这会改变加密语义但无需改变硬契约中的 `CHUNK_FRAME_TAG = 0x01` 或二进制布局；为兼容现有 v1/v2 peer，应通过新协议版本/能力协商启用，而非单边切换。更新 frame/crypto/delivery/cross-transfer replay 测试。

### [P2] 每个 chunk 重复计算相同 SHA-256 域前缀

- 位置: `client/src/lib/crypto.ts:127`；`client/src/lib/transfer.ts:871`
- 证据:

```ts
async function makeChunkIvAsync(
  prefix: Uint8Array,
  index: number,
  transferId: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const transferIdBytes = new TextEncoder().encode(transferId)
  const input = new Uint8Array(8 + transferIdBytes.length)
  input.set(prefix.subarray(0, 8), 0)
  input.set(transferIdBytes, 8)
  const digest = await crypto.subtle.digest('SHA-256', input)
```

```ts
    const ivForChunk = await makeChunkIv(ivPrefix, i, transferId)
```

- 影响: `SHA-256(prefix || transferId)` 对一个 transfer 的所有 chunk 完全相同，却在 16 GB 上限文件的约 6.6 万个 chunk 中重复执行 6.6 万次，同时重复创建 `TextEncoder`、输入 buffer、digest promise 和主线程 microtask。它直接增加 send hot path 的 CPU/调度开销。
- 建议: 在 send engine 启动时调用一次 `deriveTransferIvPrefix(randomPrefix, transferId)` 得到 8 字节域前缀，chunk 循环只同步拷贝该前缀并写 4 字节 BE index。保持当前 wire IV 字节不变，并用 `transfer-iv-multi-peer.test.ts` / frame tests 验证兼容性。

### [P2] 接收解帧为每个 chunk 复制整段 ciphertext

- 位置: `client/src/lib/transfer.ts:436`
- 证据:

```ts
export function decodeChunkFrame(buf: ArrayBuffer): DecodedChunkFrame | null {
  if (buf.byteLength < CHUNK_FRAME_HEADER_BYTES) return null
  const view = new DataView(buf)
  if (view.getUint8(0) !== CHUNK_FRAME_TAG) return null
  const shortId = view.getUint32(1, false)
  const index = view.getUint32(5, false)
  const iv = new Uint8Array(buf.slice(9, 21)) as Uint8Array<ArrayBuffer>
  const ciphertext = buf.slice(CHUNK_FRAME_HEADER_BYTES)
  return { shortId, index, iv, ciphertext }
}
```

- 影响: 约 252 KB 的每个 SCTP message 都在主线程通过 `slice()` 完整复制 ciphertext，随后该副本才 transfer 给 crypto worker。传输 16 GB 文件时会额外分配并复制接近 16 GB，制造 GC 压力和内存带宽竞争；12 字节 IV 的复制不是问题，payload 复制才是主成本。
- 建议: 将原始 frame `ArrayBuffer` 作为 transferable 直接交给 worker，并传 header offset/length，让 worker 内部解析 IV/ciphertext view；或扩展 crypto worker op 支持带 offset 的 frame。必须继续保持 `[tag][shortId][index][iv][ciphertext]` 硬布局和 `CHUNK_FRAME_TAG` 不变，并补充 transferred/detached buffer 测试。

### [P2] worker replacement 配额按页面生命周期累计，偶发故障最终也会永久耗尽

- 位置: `client/src/lib/cryptoPool.ts:22`；`client/src/lib/cryptoPool.ts:85`
- 证据:

```ts
const MAX_REPLACEMENTS = POOL_SIZE * 2
```

```ts
  if (replacements >= MAX_REPLACEMENTS) {
    console.warn('[cryptoPool] replacement budget exhausted — pool is degraded')
    return
  }
  replacements++
  try {
    const fresh = spawnWorker()
```

- 影响: `replacements` 从不在 replacement 成功处理消息后重置。以 4-worker pool 为例，一个长期开启的 tab 只要累计发生 8 次彼此独立、且每次都成功恢复的 worker OOM/crash，第 9 次起就不再补位；继续发生故障后 pool 最终降为 0，所有后续传输只能要求用户刷新页面。
- 建议: 配额应限制“连续启动失败/短时间 crash loop”，而不是页面终身累计。为新 worker 增加 ready handshake；稳定处理首个 op 或存活超过退避窗口后重置连续失败计数，并使用指数退避/时间窗熔断。增加“间隔成功的多次 crash 可继续恢复”和“模块加载持续失败会熔断”两类测试。

### [P2] `transfer.ts` 同时承载协议、状态机、三种存储和资源注册表，终止不变量无法局部推理

- 位置: `client/src/lib/transfer.ts:1`；`client/src/lib/transfer.ts:651`
- 证据:

```ts
import {
  saveTransfer, updateTransfer, getTransfer, getActiveTransfers,
  saveChunk, getChunk, deleteChunks, getSavedChunkIndexes,
  pruneTerminalTransfers,
  type TransferRecord,
} from './db'
import { encryptChunk, decryptChunk, makeChunkIv, randomIvPrefix } from './crypto'
import * as constants from '@/constants'
const {
  CHUNK_SIZE, HIGH_WATER_MARK, LOW_WATER_MARK,
```

```ts
async function runSendEngine(
  task: SendTask,
  dcs: RTCDataChannel[],
  file: File,
  transferId: string,
```

- 影响: 单文件 2396 行；`runSendEngine()` 从 651 行延续到 992 行，并与十余个 module-global registry、protocol validation、flow control、IDB/FSA/OPFS lifecycle 交织。已验证的 ready flag 遗留、finalize 未 drain、后端 preparation 取消竞态都跨越这些职责边界；维护者无法只在一个资源 owner 中证明“每个 handle/waiter/map entry 恰好清理一次”。这不是格式偏好，而是已产生终止与 attempt 不变量缺口的结构性原因。
- 建议: 保持外部 facade 兼容，按以下边界拆分：

  - `transfer/protocol.ts`：版本、消息类型、meta/control 校验、frame codec（不改变 tag/layout）；
  - `transfer/ownership.ts`：`(peerSessionId, epoch)` owner 与 attempt token；
  - `transfer/send-engine.ts`：send task、repair queue、delivery state；
  - `transfer/flow-control.ts`：buffer wait/drain、deadline/cancel；
  - `transfer/receive-engine.ts`：session、per-index in-flight、固定持久化顺序、统一 finalize；
  - `transfer/storage/{backend,idb,fsa,opfs}.ts`：统一 `prepare/write/finalize/abort` 接口，每个 backend 自己拥有句柄；
  - `transfer/registry.ts`：唯一 terminal teardown，集中释放 owner、ready waiter、task、session 与 backend。

  先用 characterization tests 锁定 CLAUDE.md 的 frame、v2 delivery、owner、durable-order 合同，再逐模块迁移；不要在拆分中顺带改变协议语义。

## 附录: 已核查但结论为无问题的区域

- `validateMetaMessage()` 对 transferId、shortId、文件名、file size、`totalChunks === ceil(fileSize / CHUNK_SIZE)` 的校验，以及 `persistChunk()` 对每片明文长度的校验；未发现绕过既定 16 GB/uint32 几何边界的正常 meta 路径。
- 二进制 chunk frame 的 `CHUNK_FRAME_TAG = 0x01` 和 `[tag:1][shortId:4][index:4][iv:12][ciphertext]` 编解码布局；本报告的建议均明确要求保持该硬合同。
- 成功写路径内部的 `decrypt → validate length → await backend write → set bitmap → persist bitmap → progress` 顺序；问题集中在并发、取消和失败/终止边界，而非该顺序的直线 happy path。
- 已存在 bitmap 的顺序重复分片 fast path、越界 chunk index 拒绝、接收 peerSessionId 检查、known-transfer 的 owner/epoch 比较。
- OPFS 精确 entry 名删除逻辑、调用方对 object URL 的 revoke/延迟 OPFS cleanup 生命周期；未发现前缀误删或普通未点击 artifact 的 URL 永久泄漏。
- `cryptoPool` 的 payload/result transferable 使用和 worker crash 时对该 worker 已登记 pending promise 的 reject；主数据没有在 `postMessage` 两侧重复 structured-clone。
- `db.ts` 的 chunk key range 删除边界、terminal row 年龄/数量裁剪，以及 `activeWork.ts` 自身 listener/interval 的 effect cleanup。
- FSA/OPFS/IDB 三种 backend 的正常完成 size gate、零长度几何、resume wire 同时兼容 flat indexes 与 RLE 的正常输入。
- 现有 transfer 单测覆盖了顺序 duplicate、同时发起的 backend preparation、DataChannel close/error 唤醒、v2 ready/ACK happy path等；本报告指出的缺口均是这些测试未覆盖的错开时序、恶意范围或失败注入。
