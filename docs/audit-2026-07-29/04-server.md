# Misaka Network 服务端与部署配置只读审计

## 摘要

- 未发现 P0；确认 10 个 P1、9 个 P2、3 个 P3，共 22 个发现。
- 最先应处理持久化安全边界：`auth-locks.json` 加载失败后认证仍 fail-open；TURN deny/revoke 与暴力锁只标记内存 dirty；关机刷盘失败仍以“安全关闭”及退出码 0 结束。
- TURN 的长期策略存在两个可直接绕过点：session deny 绑定重启后必变的 `sessionId`，每 IP 小时字节账本则完全不持久化；两者都会在重启后丢失约束。
- HTTP body parser 位于 API 限流之前，畸形/超限 JSON 可无限绕过 `api:${ip}` 预算；WebSocket 握手也没有全局或每 IP 的未认证连接上限。
- 会话退出逻辑散落在 HTTP、cleanup 和 WS 中，主动 release/过期清理会跳过 `PEER_LEFT`；这也是 `http.ts`/`turn.ts` 过度集中后已经出现的行为漂移，而不只是风格问题。
- 本报告没有建议改动客户端 transfer frame、协议 v2 delivery semantics、`authedFetch` 的 401 重试、或客户端 TURN `turnSettings.enabled` 契约。修复 session expiry 时必须继续使用 WS 4002，以保留 `onAuthInvalid → 清缓存 → 重注册` 行为。

## 发现

### [P1] JSON body 解析发生在 API 限流之前

- 位置: `server/src/index.ts:50`, `server/src/http.ts:82`, `docker-compose.yml:22`
- 证据:
```ts
app.use(express.json({ limit: '64kb' }))
app.use('/api', router)

// Catch-all for non-API routes — always return JSON
app.all('*', (_req, res) => {
  res.status(404).json({ error: 'NOT_FOUND' })
})
```
```ts
router.use((req: Request, res: Response, next: NextFunction) => {
  const ip = getClientIP(req)
  if (!checkRateLimit(`api:${ip}`, RATE_LIMIT_PER_MIN, RATE_WINDOW_MS)) {
    res.status(429).json({ error: 'RATE_LIMITED', message: '请求过于频繁，请稍后再试' })
    return
  }
  next()
})
```
```yaml
environment:
  NODE_ENV: development
  PORT: 9080
```
- 影响: 攻击者持续向 `/api/register` 发送 `Content-Type: application/json` 的畸形 JSON 或超过 64 KiB 的 body；请求在 `express.json()` 中报错，永远不会进入 `router.use` 的 IP 预算，因此可无上限消耗 body 接收/JSON 解析资源。当前也没有四参数 Express error handler；根 compose 明确设置 `NODE_ENV: development`，此路径会返回 Express 默认的非 JSON 错误页并可能包含解析栈，而不是 API 的稳定 JSON 错误。
- 建议: 把不依赖 body 的 `/api` IP 限流中间件挂到 `express.json()` 之前；在 parser 后增加统一 error handler，把 `entity.parse.failed`/`entity.too.large` 映射为 JSON 400/413，所有环境都不返回栈。扩充 `server/tests/http-abuse-bounds.test.mjs`，覆盖畸形和超限 body 仍计入同一 IP 预算。

### [P1] 认证锁快照加载失败后仍 fail-open，并会覆盖原快照

- 位置: `server/src/persist.ts:455`, `server/src/persist.ts:475`, `server/src/index.ts:103`, `server/src/persist.ts:503`
- 证据:
```ts
try {
  raw = await fs.readFile(locksPath(), 'utf8')
} catch (err) {
  const e = err as NodeJS.ErrnoException
  if (e.code === 'ENOENT') { locksLoadState = 'ok'; return }
  console.error('[persist] load locks failed:', e.message)
  locksLoadState = 'failed'
  return
}
```
```ts
if (!isPlainObject(data) || data.version !== 1
    || !Array.isArray(data.attemptLocks) || !Array.isArray(data.nodeFreezes)) {
  console.warn('[persist] auth-locks.json shape unrecognised, starting fresh')
  locksLoadState = 'failed'
  return
}
```
```ts
try {
  await loadPersistedLocks()
} catch (err) {
  console.error('[boot] persist load (locks) failed:', (err as Error).message)
}
try {
  await loadTurnState()
```
```ts
const run = locksChain.then(async () => {
  const payload: PersistedLocksV1 = {
    version: 1,
    savedAt: Date.now(),
    attemptLocks: Array.from(attemptLocks.entries()).map(([key, lock]) => ({ key, lock })),
    nodeFreezes: Array.from(nodeFreezes.entries()).map(([nodeId, freeze]) => ({ nodeId, freeze })),
```
- 影响: 若 `auth-locks.json` 存在但权限错误、JSON 损坏或 shape 无效，服务仍绑定端口，并用空的 `attemptLocks`/`nodeFreezes` 接受 `/register`、`/release-by-ip` 和 `/qr-redeem`。本应被冻结的 nodeId 第一笔请求即被放行；10 秒后的 flusher 又会把空 Map 写回同一路径，销毁仍可供恢复/排障的原快照。
- 建议: `locksLoadState !== 'ok'` 时让所有通行码验证入口 fail closed；加载失败时禁止 `flushPersistedLocks()` 覆盖文件，并将坏文件隔离为带时间戳的 quarantine 副本。扩充 `server/tests/startup-readiness.test.mjs`：损坏 lock 快照后首个 register 必须拒绝，周期 flusher 不得覆盖原文件。

### [P1] TURN session deny 绑定会变化的 sessionId，无法跨重启约束同一身份

- 位置: `server/src/turn.ts:140`, `server/src/http.ts:252`, `server/src/persist.ts:56`
- 证据:
```ts
const customIdentifier = deriveCustomIdentifier(sessionId)

// SECURITY-010: durable denial. Checked before the cache so a session that
// was revoked for abuse cannot keep replaying its cached grant.
if (isDenied(`ip:${ip}`, now)) return { ok: false, reason: 'IP_BANNED' }
if (isDenied(`cid:${customIdentifier}`, now)) return { ok: false, reason: 'SESSION_BANNED' }
```
```ts
const sessionId = nanoid(16)
const token = randomBytes(32).toString('hex')
```
```ts
// SECURITY-010: durable denial. Keys are `ip:<ip>` and `cid:<customIdentifier>`
// so both axes survive a restart (sessionIds do not, customIdentifiers do —
// they are derived by HMAC from sessionId with SERVER_SECRET).
```
- 影响: 默认 `TURN_IP_BAN_STRIKES=3` 时，第一次滥用只留下 `cid:<oldCustomIdentifier>`。进程重启后 session 不持久化，用户重新 `/register` 得到新的随机 `sessionId`，因而得到新的 customIdentifier；旧的 24 小时 deny 不命中，同一身份可立即重新领取 TURN 凭据。现有 `server/tests/turn-deny-state-machine.test.mjs:42` 把 IP strikes 设为 1，恰好掩盖了默认配置下的路径。
- 建议: 增加重启后稳定的 TURN principal（例如服务端 HMAC 后的 identity tuple），deny 使用 `principal:<id>`；customIdentifier 只负责 Cloudflare credential 关联/revoke。更新 `issueCredentials` 的参数及测试，但不改变客户端 TURN 开关契约。新增默认 strikes=3、单次 abuse、flush/reload、重新注册后仍被拒绝的测试。

### [P1] 安全状态跃迁只标记 dirty，外部动作和响应先于落盘

- 位置: `server/src/turn.ts:963`, `server/src/turn.ts:977`, `server/src/persist.ts:398`, `server/src/http.ts:222`
- 证据:
```ts
 * order. Each step is persisted locally before the next one runs, so no
 * external-provider outcome can lose the accounting or the ban — the audit does
 * NOT require a single atomic transaction across Cloudflare, it requires that a
 * failure at any step leaves a retryable local record.
```
```ts
async function handleAbusiveCredential(cid: string, active: ActiveCredential, actualBytes: number) {
  console.warn(`[turn] abuse: ${redactCustomIdentifier(cid)} used ${actualBytes} bytes (cap ${TURN_MAX_BYTES_PER_SESSION}), settling + denying + revoking`)
  settleCredentialUsage(active, actualBytes)
  applyDeny(cid, active.ip, 'SESSION_BYTES_EXCEEDED')

  const ok = await revokeCustomIdentifier(cid)
```
```ts
export function startPersistFlusher() {
  if (flushTimer) return
  flushTimer = setInterval(() => {
    flushTurnState().catch(() => { /* logged inside */ })
    flushPersistedLocks().catch(() => { /* logged inside */ })
  }, TURN_PERSIST_INTERVAL_SEC * 1000)
```
```ts
if (!lock) {
  lock = { attempts: 0, lockedUntil: 0, lastAttemptAt: now }
  attemptLocks.set(lockKey, lock)
}
lock.attempts++
lock.lastAttemptAt = now
```
- 影响: `settleCredentialUsage()`、`applyDeny()`、`revokePending` 和暴力锁跃迁都只改内存。具体地，abuse poll 写入 deny 后立即调用 Cloudflare revoke，或第 3 次错误请求返回 423；若进程在默认 10 秒 flusher 前崩溃，deny/pending/lock 均不在磁盘。失败 revoke 会失去重试记录，成功 revoke 的滥用者也可在重启后重新签发，暴破者则立刻获得新的尝试窗口。
- 建议: 提供 `flushSecurityState()` 的可等待严格边界：TURN 的 settle+deny 在 provider revoke 前强制持久化，失败后的 `revokePending` 再强制持久化；达到 `MAX_ATTEMPTS` 或设置 `frozenUntil` 时在 423 响应前写入。周期合并刷盘仍可保留给非关键增量。扩充 `turn-deny-state-machine`、`persist-locks` 测试，模拟安全跃迁后、周期 tick 前重启。

### [P1] 关机强制刷盘错误被吞掉，进程仍报告成功退出

- 位置: `server/src/persist.ts:382`, `server/src/index.ts:160`
- 证据:
```ts
export function flushTurnState(force = false): Promise<void> {
  if (!loaded) return Promise.resolve()
  if (!force && !dirty) return turnChain
  dirty = false
  const run = turnChain.then(async () => {
    try {
      await writeFileAtomic(statePath(), JSON.stringify(state))
    } catch (err) {
      dirty = true   // mark dirty again so we retry next tick
      console.error('[persist] write failed:', (err as Error).message)
```
```ts
await Promise.allSettled([flushTurnState(true), flushPersistedLocks()])

// 4. Stop accepting new connections, then exit
httpServer.close(() => {
  console.log('信令服务器已安全关闭')
  process.exit(0)
})
```
- 影响: SIGTERM 时若持久目录只读、权限变化或磁盘已满，两个 flush 都在内部记录日志后 resolve；`Promise.allSettled` 看不到失败，随后打印“已安全关闭”并 `exit(0)`。money-critical monthly tally、deny、revokePending 或暴力锁实际未写入，但容器编排会把它识别为正常终止。
- 建议: 周期 flush 可继续记录错误并重试，但 `force=true`/shutdown 必须使用会 reject 的 strict flush API；任一安全快照失败时退出非 0，并明确打印哪个文件未持久化。扩充 `server/tests/shutdown.test.mjs`，用不可写目录/注入写失败断言非 0，不能出现“安全关闭”。

### [P1] 优雅关机在刷盘完成后才停止接收请求

- 位置: `server/src/index.ts:152`
- 证据:
```ts
stopCleanupTask()
stopTurnPollers()
stopTurnRevokeRetry()
stopPersistFlusher()
await Promise.allSettled([flushTurnState(true), flushPersistedLocks()])

// 4. Stop accepting new connections, then exit
httpServer.close(() => {
  console.log('信令服务器已安全关闭')
```
- 影响: 已认证 token 在 SIGTERM 后、快照序列化期间仍可调用 `/api/turn-credentials` 或触发新的失败通行码请求，因为 listener 仍开放且没有 `shuttingDown` middleware。若新变更发生在本次 `JSON.stringify` 之后，它不会进入刚写完的快照；随后 `httpServer.close` 完成并退出，可能留下已由 Cloudflare 签发但本地未记录的 credential，或丢失新锁。
- 建议: 收到信号后第一时间设置拒绝新业务请求的 app gate，并立即调用 `httpServer.close()` 停止新连接；等待在途请求完成后再做最终严格 flush。对 keep-alive 请求也必须在 `shuttingDown` 时返回 503。扩充 `shutdown.test.mjs`，在慢写入窗口内并发请求并断言未受理或已进入最终快照。

### [P1] 未认证 WebSocket 连接没有全局或每 IP 上限

- 位置: `server/src/ws.ts:211`
- 证据:
```ts
export function setupWS(wss: WebSocketServer) {
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    let session: NodeSession | null = null
    let oversizeViolations = 0
    const bucket = new RateBucket()
    // Only one ERROR reply per second while a socket is over budget — the
    // reply itself must not become the amplification.
    let lastRateNoticeAt = 0
```
```ts
const authTimer = setTimeout(() => {
  if (session) return  // raced an AUTH right before the timer fired; no-op
  try { ws.close(4001, 'AUTH_TIMEOUT') } catch { /* already gone */ }
}, WS_AUTH_GRACE_MS)
authTimer.unref?.()
```
- 影响: 每个成功 upgrade 都会先分配 socket、listener、token bucket 和 timer，之后才等待 AUTH；`MAX_NODES` 只限制 HTTP 注册 session，不限制这里的匿名连接。攻击者持续建立无 Origin 的原生 WS 连接，并在默认 5 秒内不 AUTH，即可让并发匿名连接数随握手速率增长，耗尽文件描述符/内存；发送 close frame 也不是即时 `terminate()`，无法充当连接容量控制。
- 建议: 在 upgrade/connection 前增加全局和 per-IP 的 pending-auth 上限，AUTH 成功后转入已认证配额，close/error 时原子释放；超限在握手阶段返回 429/503。必要时给 AUTH timeout 增加短暂 terminate backstop。扩充 `ws-auth.test.mjs`/`ws-limits.test.mjs`，验证 pending 计数和释放。

### [P1] `TRUST_PROXY=true` 允许客户端伪造所有 per-IP 身份

- 位置: `server/src/config.ts:71`, `server/src/index.ts:24`
- 证据:
```ts
function parseTrustProxy(raw: string | undefined): number | boolean | string {
  if (raw === undefined || raw === '' || raw.toLowerCase() === 'false' || raw === '0') return false
  if (raw.toLowerCase() === 'true') return true
  if (/^\d+$/.test(raw)) return parseInt(raw, 10)
  return raw
}
export const TRUST_PROXY = parseTrustProxy(process.env.TRUST_PROXY)
```
```ts
app.set('trust proxy', TRUST_PROXY)
```
```ts
setTrustProxyFn(app.get('trust proxy fn'))
```
- 影响: 生产运维若使用常见布尔配置 `TRUST_PROXY=true`，Express/WS 会信任代理链中的任意地址。直接访问服务的攻击者每次轮换 `X-Forwarded-For`，即可轮换 `req.ip`/WS IP，绕过 API rate limit、`MAX_NODES_PER_IP`、暴破锁以及 TURN 每 IP 发行/字节上限。
- 建议: production 启动时拒绝 boolean `true`，只允许 `false/0`、明确的正整数 hop count 或经编译验证的 CIDR/preset；先 `trim()` 再解析。保留 Caddy 模板的 `TRUST_PROXY=1`。更新 `config-validation`、`trust-proxy` 和 `ws-trust-proxy` 测试。

### [P1] TURN 全局轮询可重叠并用旧结果回退 kill-switch

- 位置: `server/src/turn.ts:451`, `server/src/config.ts:180`, `server/src/config.ts:196`, `server/src/turn.ts:1090`
- 证据:
```ts
const globalPoller = setInterval(() => {
  pollGlobalUsage().catch(err => console.error('[turn] global poll error:', err.message))
}, TURN_GLOBAL_POLL_SEC * 1000)
```
```ts
export const TURN_ABUSE_POLL_SEC = readInt('TURN_ABUSE_POLL_SEC', 30, { min: 1 })
export const TURN_GLOBAL_POLL_SEC = readInt('TURN_GLOBAL_POLL_SEC', 120, { min: 1 })
```
```ts
export const TURN_CF_TIMEOUT_MS = readInt('TURN_CF_TIMEOUT_MS', 8000, { min: 200, max: 120_000 })
```
```ts
state.monthlyUsage.cfBytesObserved = total
state.monthlyUsage.pessimisticBytesObserved = activePessimistic
state.monthlyUsage.bytesObserved = Math.max(total, activePessimistic)
state.monthlyUsage.usageSource = 'cloudflare'
state.monthlyUsage.lastCfSyncAt = Date.now()
delete state.monthlyUsage.lastCfSyncErrorCode
```
```ts
// A fresh authoritative sync can also CLEAR a kill switch that tripped on a
// stale pessimistic over-count: if real effective bytes are back below the
// threshold, re-enable issuance instead of staying dead until month roll.
const limit = TURN_GLOBAL_MONTHLY_BYTES_LIMIT * (TURN_GLOBAL_THRESHOLD_PCT / 100)
if (state.monthlyUsage.killSwitchActive && state.monthlyUsage.bytesObserved < limit) {
  state.monthlyUsage.killSwitchActive = false
  state.monthlyUsage.killSwitchTriggeredAt = 0
  console.warn(`[turn] global kill switch CLEARED after CF sync (${state.monthlyUsage.bytesObserved} < ${limit} bytes, month ${state.monthlyUsage.monthKey})`)
}
```
- 影响: 合法配置可设 `TURN_GLOBAL_POLL_SEC=1`、`TURN_CF_TIMEOUT_MS=8000`。poll A 查询较早的 `until` 后延迟 7 秒；poll B 查询较晚时间并先返回较高用量、触发 kill-switch；随后 A 以较低旧 total 覆盖状态，甚至执行清除分支重新开放签发。初始 2 秒 poll 也可与 interval 重叠。
- 建议: 给 global 和 per-identifier poll 各自加 single-flight/mutex，上一轮未完成时跳过 tick；写结果时比较 sweep generation/`until`，拒绝旧 generation 覆盖新状态。新增乱序 provider 响应测试，断言 monthly total 和 kill-switch 只能按最新 sweep 前进。

### [P1] 每 IP 小时字节账本在重启时清零

- 位置: `server/src/turn.ts:674`, `server/src/persist.ts:81`
- 证据:
```ts
// Rolling per-IP ledger of CF-CONFIRMED actual relayed bytes, folded from
// credentials as they expire. In-memory only (a restart resets it, which only
// briefly loosens this SECONDARY per-IP cap; the persisted global monthly kill
// switch is the primary money defence). We fold `cfActualBytes` — NOT the
// pessimistic estimate — so a P2P session that relayed ~0 bytes contributes 0
// and can never false-positive a legitimate user who reconnects frequently.
interface IpByteLedgerEntry { ip: string; bytes: number; at: number }
let ipByteLedger: IpByteLedgerEntry[] = []
```
```ts
export interface TurnState {
  version: 1
  monthlyUsage: MonthlyUsage
  activeCredentials: Record<string, ActiveCredential>   // keyed by customIdentifier
  ipIssuanceHistory: IssuanceRecord[]                   // ring buffer, oldest first
  denyList: Record<string, DenyEntry>
}
```
- 影响: 同一 IP 的两个 credential 在一小时内各产生大量已确认 relay bytes，过期/revoke 后 active 记录被删除，只剩 `ipByteLedger`；服务重启会把账本清零。该 IP 的 `ipIssuanceHistory` 仍低于默认 60，且前两次 session abuse 尚未达到默认 3 次 IP ban，因此可立即再次领取 credential，绕过 10 GiB/hour/IP 上限。
- 建议: 把带 `at` 的小时 ledger 纳入 `TurnState` 新版本，加载时校验并裁剪一小时前条目；迁移旧 v1 时初始化空 ledger但记录一次明确告警。扩充 `turn-ip-hourly-cap.test.mjs`，在达到 cap 后 flush/reload，断言同一 IP 仍被拒绝。

### [P2] HTTP/cleanup 会话退出绕过频道清理和 `PEER_LEFT`

- 位置: `server/src/http.ts:425`, `server/src/http.ts:456`, `server/src/cleanup.ts:33`, `server/src/ws.ts:320`
- 证据:
```ts
const session = findSessionByToken(parsed.data.token)
if (session) {
  if (session.socket) {
    unmarkSocket(session.socket)
    session.socket.close()
    session.socket = null
  }
  session.lastSeen = Date.now()
  broadcast({ type: 'leave', nodeId: session.nodeId, message: `御坂 ${session.nodeId} 号通信终止` })
}
```
```ts
// A superseded socket (a reconnect already re-attached a newer ws to this
// shared session) must NOT tear the session down. Without this guard the
// stale socket's late close nulls session.socket — which now points at the
// live reconnected ws — deletes it from its channel, and broadcasts
// PEER_LEFT, rendering a fully-connected peer invisible/unreachable.
if (session.socket !== ws) return
session.socket = null
session.lastSeen = Date.now()
```
```ts
if (session.socket) {
  unmarkSocket(session.socket)
  try { session.socket.close(4002, 'SESSION_EXPIRED') } catch { /* already gone */ }
  session.socket = null
}
nodes.delete(sessionId)
```
```ts
let released = 0
for (const [sessionId, session] of nodes) {
  if (session.ip !== ip) continue
  if (scopeNodeId !== null && (session.nodeId !== scopeNodeId || session.passCodeHash !== scopePassHash)) continue
  if (session.socket) {
    // Drop the authenticated-socket index entry here rather than relying on
    // the 'close' handler: that handler bails early once session.socket is
    // null, which would otherwise leak the entry (SECURITY-014).
    unmarkSocket(session.socket)
    try { session.socket.close() } catch { /* ignore */ }
    session.socket = null
  }
```
- 影响: A/B 已在同一 cluster。A 调 `/api/release` 时 route 先置 `session.socket=null`，随后 close handler 因 guard 直接返回，不调用频道离开/通知；cleanup 和 `/release-by-ip` 也直接删除成员而不通知。B 保留 stale peer；cleanup 前加入的 C 还会从 channel Set 收到离线 A 的 `PEER_JOINED`，发起无效连接/传输。
- 建议: 抽出唯一 `terminateSession()`/`leaveChannelAndNotify()`，由 WS close、`/release`、`/release-by-ip` 和 cleanup 共用；顺序统一为通知 peers、移除 channel、解除 socket index、关闭/删除 session。过期路径继续使用 4002，不能破坏客户端 `onAuthInvalid` 契约。更新 `register-edge`、`session-expiry` 和 signaling 测试。

### [P2] 慢消费者 grace 只有在后续发送时才会生效

- 位置: `server/src/ws.ts:91`, `server/src/config.ts:101`
- 证据:
```ts
if (buffered >= WS_MAX_BUFFERED_BYTES) {
  const now = Date.now()
  const since = slowConsumerSince.get(ws)
  if (since === undefined) {
    slowConsumerSince.set(ws, now)
  } else if (buffered >= WS_MAX_BUFFERED_HARD_BYTES || now - since >= WS_SLOW_CONSUMER_GRACE_MS) {
    shedSlowConsumer(ws)
  }
  return false
}
```
```ts
export const SESSION_TTL_MS = readInt('SESSION_TTL_MS', 30 * 60 * 1000, { min: 1000, max: 7 * 24 * 60 * 60 * 1000 })
```
- 影响: B 停止读取，A 发送合法 SDP 直到 B 第一次越过 1 MiB soft mark，然后 A 停止。代码只记录时间，没有独立 timer；没有下一帧就永远不会检查 10 秒 grace。B 可保持约 1 MiB 队列、socket、session 和 channel 槽位直到 session TTL（配置允许最长 7 天）。现有 `ws-limits` 测试在 grace 期间持续发送，因此没有覆盖该分支。
- 建议: 首次越过 soft mark 时创建 per-socket unref recheck timer；到期仍高于 soft mark则 `shedSlowConsumer()`，恢复、close、supersede 时清 timer。补“越线后停止发送”的 `ws-limits` 用例。

### [P2] WS rate violation 是会话终身累计而非连续/窗口计数

- 位置: `server/src/ws.ts:191`, `server/src/ws.ts:232`, `server/src/config.ts:101`
- 证据:
```ts
class RateBucket {
  private tokens = WS_MSG_BURST
  private last = Date.now()
  violations = 0

  take(now = Date.now()): boolean {
    const elapsedSec = (now - this.last) / 1000
    if (elapsedSec > 0) {
      this.tokens = Math.min(WS_MSG_BURST, this.tokens + elapsedSec * WS_MSG_RATE_PER_SEC)
      this.last = now
    }
```
```ts
    if (this.tokens < 1) {
      this.violations++
      return false
    }
    this.tokens -= 1
    return true
  }
```
```ts
if (!bucket.take(now)) {
  if (bucket.violations >= WS_MAX_RATE_VIOLATIONS) {
    try { ws.close(1008, 'RATE_LIMITED') } catch { /* already gone */ }
    return
  }
```
```ts
export const SESSION_TTL_MS = readInt('SESSION_TTL_MS', 30 * 60 * 1000, { min: 1000, max: 7 * 24 * 60 * 60 * 1000 })
```
- 影响: 成功消费 token 或长时间完全恢复时从不重置/衰减 `violations`。在合法 `SESSION_TTL_MS=7d` 配置下，客户端每 10 分钟仅发生一次孤立超预算（每次之间 bucket 完全充满），第 200 次仍会被 1008 关闭；这不是注释所称“持续超预算”。
- 建议: 将 violation 做成独立滑动窗口，或在一段无违规时间/成功消息后重置或衰减；保留真正连续 flood 的关闭行为。扩充 `ws-limits.test.mjs`，同时覆盖持续 flood 会关、分散偶发 burst 不累计至关。

### [P2] node freeze 到期会清空仍处于滚动窗口内的失败历史

- 位置: `server/src/http.ts:102`, `server/src/config.ts:224`
- 证据:
```ts
function isNodeFrozen(nodeId: number, now: number): { frozen: true; until: number } | { frozen: false } {
  const freeze = nodeFreezes.get(nodeId)
  if (!freeze) return { frozen: false }
  if (freeze.frozenUntil > now) return { frozen: true, until: freeze.frozenUntil }
  // Expired freeze — clear and let the caller proceed normally.
  if (freeze.frozenUntil > 0) {
    freeze.frozenUntil = 0
    freeze.recentFailures = []
  }
  return { frozen: false }
}
```
```ts
export const NODE_FREEZE_THRESHOLD = readInt('NODE_FREEZE_THRESHOLD', 20, { min: 1 })
export const NODE_FREEZE_WINDOW_MS = readInt('NODE_FREEZE_WINDOW_MS', 60 * 60_000, { min: 1000 })
export const NODE_FREEZE_DURATION_MS = readInt('NODE_FREEZE_DURATION_MS', 60 * 60_000, { min: 1000 })
```
- 影响: 合法配置 `DURATION_MS=60000`、`WINDOW_MS=3600000` 下，攻击者触发 20 次失败后等 60 秒；下一次 register 会清空过去一小时全部失败记录，使攻击者重新获得完整的 20 次预算，而不是保留滚动窗口证据。
- 建议: freeze 到期只把 `frozenUntil` 置 0，并按 `NODE_FREEZE_WINDOW_MS` filter 历史；与 cleanup 使用同一 prune helper。扩充 `brute-force-global.test.mjs` 覆盖 duration 小于 window 的配置。

### [P2] `ALLOWED_ORIGINS=` 的“零浏览器来源”承诺未实现

- 位置: `server/src/origin.ts:55`, `deploy/.env.example:36`
- 证据:
```ts
const fromEnv = raw.split(',').map(s => s.trim()).filter(s => s.length > 0 && s !== '*')
cachedList = Array.from(new Set([...DEFAULT_ORIGINS, ...fromEnv]))
return cachedList
```
```sh
# Origin policy:
#   line absent / commented  → public-signaling mode (any browser origin)
#   ALLOWED_ORIGINS=a,b      → strict mode, only those origins
#   ALLOWED_ORIGINS=         → explicit lockdown: NO browser origin allowed
```
- 影响: 生产者按样例设置空字符串，希望只允许 same-origin/非浏览器调用；实际 allowlist 始终加入 `http://localhost:5173`、`127.0.0.1:5173` 等 dev origins。来自这些 origin 的页面仍可跨站访问 `/api/register`、QR 和 WS upgrade，违反明确 lockdown 选择。
- 建议: 区分 unset、`*`、显式空字符串；显式空必须返回 `[]`，仅保留 same-origin 规则。更新 `csrf-origin.test.mjs` 和 `ws-origin.test.mjs` 的空值用例。

### [P2] `/register` 的错误通行码路径从不执行 scrypt 校验

- 位置: `server/src/http.ts:215`, `server/src/http.ts:252`, `server/src/store.ts:160`
- 证据:
```ts
const sameNodeSessions: NodeSession[] = []
for (const s of nodes.values()) {
  if (s.nodeId === nodeId) sameNodeSessions.push(s)
}
const conflict = sameNodeSessions.find(s => s.passCodeHash !== identityHash)
if (conflict) {
  // Failure attributed to (ip, nodeId), NOT to the owner session.
  if (!lock) {
    lock = { attempts: 0, lockedUntil: 0, lastAttemptAt: now }
```
```ts
const sessionId = nanoid(16)
const token = randomBytes(32).toString('hex')
// scrypt is async now (SECURITY-013), so the admission checks above are no
// longer atomic with the insert below — two concurrent registers for the
// same nodeId could both have passed. Re-run the two checks that guard
// shared state after the await, before we publish the session.
const pcRecord = await newPassCodeRecord(passCode)
```
```ts
//   passCodeVerifyHash +   — scrypt(passCode, salt). Per-session 16-byte
//   passCodeSalt             salt. This is the only thing checked when
//                            authenticating an attempt
```
- 影响: 对已占用 nodeId 的每个错误猜测都在 HMAC `passCodeHash` conflict 分支直接返回；唯一的 scrypt 调用位于正确 HMAC 已通过之后。攻击者的在线猜测成本因此只有一次快速 HMAC，scrypt semaphore/参数完全不参与拒绝路径，实际安全性只依赖 IP 锁和 node freeze，与代码及 `passcode-scrypt` 测试描述不符。
- 建议: 为 nodeId 选择稳定的现有 verifier，在判定身份冲突前对候选执行 `verifyAndMaybeUpgrade()`；QR 验证也应复用同一认证服务，HMAC 只用于已认证后的 cluster routing。更新 `passcode-scrypt.test.mjs` 和 `brute-force.test.mjs`，以调用计数/受控队列证明错误 HTTP 尝试实际进入 bounded async scrypt。

### [P2] TURN 快照校验接受负数用量并参与限额计算

- 位置: `server/src/persist.ts:219`, `server/src/turn.ts:731`
- 证据:
```ts
const issuedAt = finiteNum(raw.issuedAt, 0)
const expiresAt = finiteNum(raw.expiresAt, 0)
const pessimisticBytes = finiteNum(raw.pessimisticBytes, 0)
if (issuedAt === null || expiresAt === null || pessimisticBytes === null) continue
const cred: ActiveCredential = {
  sessionId: raw.sessionId,
  customIdentifier: typeof raw.customIdentifier === 'string' ? raw.customIdentifier : cid,
  ip: raw.ip,
  issuedAt,
  expiresAt,
  pessimisticBytes,
```
```ts
function sumHourlyBytesForIp(ip: string, now: number): number {
  const state = getTurnState()
  const cutoff = now - 60 * 60 * 1000
  let total = 0
  for (const c of Object.values(state.activeCredentials)) {
    if (c.ip === ip && c.issuedAt >= cutoff) total += c.pessimisticBytes
  }
```
- 影响: 语法和 shape 均合法的 `turn-state.json` 可含当前小时、同 IP、`pessimisticBytes: -1000000000000` 的 active credential；加载会通过。该负数抵消真实 active/ledger bytes，使 `hourlyIpBytes >= TURN_MAX_BYTES_PER_HOUR_PER_IP` 为 false，继续签发。
- 建议: 按字段语义校验非负 safe integer、`expiresAt >= issuedAt`、合理字符串长度；任何会降低钱/安全计数的无效条目应令 TURN 状态 fail closed，而不是静默接受。扩充 `startup-readiness`/`turn-policy` 的负数和超 safe-integer fixture。

### [P2] “atomic write” 没有提供断电耐久性

- 位置: `server/src/persist.ts:145`
- 证据:
```ts
async function writeFileAtomic(target: string, payload: string): Promise<void> {
  const tmp = uniqueTmpPath(target)
  try {
    await fs.writeFile(tmp, payload, 'utf8')
    await fs.rename(tmp, target)
```
- 影响: `writeFile`/`rename` 返回后、文件数据或目录项刷入稳定存储前发生断电/内核崩溃，快照可能回退旧版本或消失；最近的 kill-switch、deny、revokePending 和暴力锁因此丢失。rename 保证命名切换原子，但此实现没有 `fsync`，不能保证 crash durability。
- 建议: `fs.open` tmp → write → `FileHandle.sync()` → close → rename → 对父目录 `sync()`；strict security flush 使用该路径。为持久化层增加可注入文件系统测试，验证 sync 顺序；现有 `persist-locks-race` 继续覆盖并发串行化。

### [P2] Docker 运行时以 root 启动 Node

- 位置: `server/Dockerfile:16`
- 证据:
```dockerfile
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
```
```dockerfile
RUN mkdir -p /app/data
VOLUME ["/app/data"]
```
```dockerfile
EXPOSE 9080
```
```dockerfile
CMD ["node", "dist/bootstrap.js"]
```
- 影响: runner 没有 `USER`，因此 Express/ws 进程为容器 root。依赖或服务端若出现 RCE，攻击者可用 root 身份改写应用和 `/app/data`，并在 bind mount 场景创建宿主机 root-owned 文件；权限高于服务实际所需。
- 建议: 构建时将应用和数据目录交给 `node:node`，设置 `USER node`；生产 compose 再加 `read_only: true`（仅数据卷/tmp 可写）与 `cap_drop: ["ALL"]`。增加镜像 smoke check，断言 UID 非 0 且仍能写持久化快照/通过 healthcheck。

### [P3] 固定窗口限流被标成滑动窗口，边界允许近 2 倍突发

- 位置: `server/src/ratelimit.ts:1`
- 证据:
```ts
// Simple in-memory sliding-window rate limiter
const windows = new Map<string, { count: number; resetAt: number }>()

export function checkRateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now()
  const w = windows.get(key)
  if (!w || now > w.resetAt) {
    windows.set(key, { count: 1, resetAt: now + windowMs })
    return true
  }
```
- 影响: `RATE_LIMIT_PER_MIN=60` 时，同一 key 可在旧 `resetAt` 前集中 60 次、边界后再集中 60 次，在极短时间通过近 120 次；QR/TURN 相关复用该 helper 的预算也有同一边界突发。实现并非注释所称 sliding window。
- 建议: 安全敏感入口改为 timestamp ring/sliding counter 或 token bucket；若保留 fixed window，重命名并按 2 倍边界峰值重新设置阈值。增加可控时钟的 boundary 测试。

### [P3] `http.ts` 混合路由、认证状态机与会话生命周期

- 位置: `server/src/http.ts:5`
- 证据:
```ts
import {
  nodes, channels, qrTokens, reports, stats, getOnlineCount, getLongestUptimeMs, countNodesByIp,
  getCpuUsagePercent, findSessionByToken, attemptLocks, attemptKey,
  nodeFreezes, hashPassCodeIdentity, newPassCodeRecord, verifyAndMaybeUpgrade,
  deriveCustomIdentifier, redactCustomIdentifier, ScryptBusyError, unmarkSocket,
} from './store.js'
import { broadcast } from './activity.js'
import { checkRateLimit } from './ratelimit.js'
import { issueCredentials, getPublicTurnStatus, getOperatorTurnStatus, classifyTurnStatusAuth } from './turn.js'
```
- 影响: 764 行文件同时负责 middleware/error boundary、注册/暴破锁、release teardown、stats、TURN、QR 和 report。具体维护损害已出现：HTTP release 与 WS/cleanup 的 teardown 顺序漂移，导致 stale channel；通行码 HMAC/scrypt 的身份与验证职责也分散在同一路由。
- 建议: 保持 API 和 `authedFetch` 合约不变，拆成 `middleware/{origin,rate,error}`、`routes/{register,session,qr,turn,report-stats}`、`services/{passcodeAuth,sessionLifecycle}`。`sessionLifecycle` 成为 HTTP/WS/cleanup 唯一退出实现；`passcodeAuth` 统一 HMAC routing 与 scrypt verification。现有集成测试按路由继续运行。

### [P3] `turn.ts` 混合供应商客户端、策略、持久化编排与定时器

- 位置: `server/src/turn.ts:18`
- 证据:
```ts
import { randomBytes, timingSafeEqual } from 'crypto'
import {
  TURN_AUTO_ENABLED, TURN_PROVIDER, TURN_CF_KEY_ID, TURN_CF_API_TOKEN, TURN_CF_ACCOUNT_TAG, TURN_CF_ANALYTICS_API_TOKEN,
  TURN_CREDENTIAL_TTL_SEC,
  TURN_MAX_BYTES_PER_SESSION, TURN_MAX_BYTES_PER_HOUR_PER_IP, TURN_MAX_ISSUE_PER_HOUR_PER_IP,
  TURN_GLOBAL_MONTHLY_BYTES_LIMIT, TURN_GLOBAL_THRESHOLD_PCT, TURN_REVOKE_ALL_ON_KILL,
  TURN_PESSIMISTIC_RATE_BPS,
  TURN_ABUSE_POLL_SEC, TURN_GLOBAL_POLL_SEC, TURN_REVOKE_RETRY_INTERVAL_MS,
  TURN_BAN_DURATION_SEC, TURN_IP_BAN_STRIKES,
```
- 影响: 1117 行文件同时实现 Cloudflare REST/GraphQL schema、deadline、credential cache/dedupe、deny/revoke 状态机、monthly kill-switch、状态 API 和 timer lifecycle。已出现两项跨职责错误：注释声称安全状态已持久化但实际只 `markDirty()`，以及 provider poll 与状态提交没有 single-flight generation。
- 建议: 保留 `issueCredentials`/status 的聚合入口，内部拆为 `turn/provider.ts`（REST/GraphQL/deadline/schema）、`turn/policy.ts`（quota/deny/kill-switch）、`turn/repository.ts`（严格安全事务）、`turn/cache.ts`（secret cache/in-flight dedupe）、`turn/lifecycle.ts`（poll/retry single-flight）、`turn/status.ts`。现有 TURN 测试从聚合入口继续验证，不改变客户端 `turnSettings.enabled` 契约。

## 附录: 已核查但结论为无问题的区域

- `server/src/store.ts` 的 session absolute expiry 由 `findSessionByToken`、WS message loop 和 cleanup 共用；HTTP 过期 token 返回 401，WS 使用 4002，未发现绕过。修复 teardown 时需保留该 4002 契约。
- `server/src/store.ts` 使用异步 `crypto.scrypt`，并有并发/队列上限与 `ScryptBusyError → HTTP 503`；未发现同步 scrypt 阻塞事件循环。问题在于注册拒绝路径没有调用它，而非实现本身阻塞。
- `server/src/ws.ts` 的 transport `maxPayload`、application message limit、SDP/ICE target/channel 校验、block 上限、supersede guard，以及 HTTP/WS 共用 Express trust predicate 的正常 `TRUST_PROXY=0/1` 路径均已核查。
- `server/src/activity.ts` 只向 authenticated socket index 广播，并有每秒预算及 outbound backpressure；未发现匿名 activity 泄露或 O(n²) session 扫描。
- `server/src/turn.ts` 的同 session in-flight issuance dedupe、provider deadline、失败 reservation rollback、revoke retry、分页 identifier analytics 和无 dimensions 的 monthly aggregate 路径已有对应测试，未发现其核心 happy path 失效。
- `server/src/persist.ts` 的同文件 Promise chain 与 unique tmp path 能避免进程内并发 writer 共用 `.tmp`；本报告的持久化问题是 fail-open、关键提交时机、错误传播与 fsync，不重复报告已修复的 writer race。
- `server/src/origin.ts` 的 public wildcard 模式是明确产品选择；本报告只指出显式空字符串 lockdown 与实现不一致，没有把默认公开信令模式本身当作漏洞。
- `server/src/index.ts` 在 bind 前执行 startup config validation 并 await 两份快照；TURN 快照损坏时签发 fail closed。`/health` 在 degraded 模式仍为 200 由 `startup-readiness.test.mjs` 明确固定，本报告没有把该运维取舍重复列为缺陷。
- `deploy/Caddyfile.example` 会删除并重写 forwarded headers，且 production compose 只 expose signaling 给 Caddy；该模板与 `TRUST_PROXY=1` 拓扑一致。
- `server/package.json` 列出的 44 个 `*.test.mjs` 均调用 `_harness.mjs` 的 `runTest`；未发现违反测试脚本显式退出契约的脚本。
- `server/Dockerfile`、根/生产 compose 的端口 9080、TURN 持久目录与生产 `SERVER_SECRET` fail-fast 映射一致；未发现 secret 被硬编码进应用镜像。
- 客户端 transfer frame `CHUNK_FRAME_TAG=0x01`、协议 v2 delivery/ownership/bitmap 顺序和 `authedFetch` 401 重试不在本审计范围内，服务端建议也没有要求改变这些硬契约。
