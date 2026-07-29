# Misaka Network 客户端支撑库审计报告

## 摘要

- `authedFetch` 的“一次 401 后重认证并只重试一次、第二次 401 抛出 `AuthRequiredError`”主流程符合硬契约，但失败收尾直接改 Zustand 状态，绕过了节点锁释放等集中清理。
- TURN 的“未保存偏好”与“明确关闭”被 `loadTurnSettings()` 合并成同一个值；仅打开设置弹窗就会把默认值持久化，从而静默关闭原本启用的自动 TURN。
- TURN 清理不能撤销在途刷新，且凭证请求没有截止时间：注销后状态可被旧请求复活，单个挂起请求也能让此后所有刷新永久卡死。
- TURN 对永久拒绝仍无限退避轮询，并且明确关闭中继后仍会申请自动凭证；这会制造无效请求并消耗服务端签发限额/预算状态。
- NAT 探测没有请求代际保护，旧网络上的慢探测可覆盖新网络结果；`createDataChannel()` 又位于清理边界之外，异常时会泄漏刚创建的 `RTCPeerConnection`。
- 运行时 URL 校验只检查 scheme，允许 fragment/query/凭据等无法被当前拼接和 `WebSocket` 调用安全消费的配置，单个合法语法但语义无效的配置即可使接入完全失败。

## 发现

### [P1] `authedFetch` 的终止失败路径绕过集中会话清理

- 位置: `client/src/lib/api.ts:58`；`client/src/store/auth.ts:306`
- 证据:
```ts
if (res.status === 401) {
  useAuthStore.setState({ session: null, isConnected: false })
  sessionStorage.removeItem('misaka.session')
  throw new AuthRequiredError()
}
clearSession() {
  sessionStorage.removeItem('misaka.session')
  releaseNodeIdLock()
  set({ session: null, isConnected: false })
},
```
- 影响: 已持有 Web Locks 节点锁的标签页遇到第二次 401 时，`api.ts` 只清状态和 `sessionStorage`，不会调用 `releaseNodeIdLock()`。该标签页已显示为未接入，但另一个标签页仍会被判定为“该节点编号已在本浏览器的另一个标签页接入”，直至原标签页刷新或关闭。直接 `setState` 也绕开了以后可能加入集中清理动作的唯一入口。
- 建议: 在 auth store 增加一个不向服务端再次发送释放请求、但会释放节点锁并结束本地网络 epoch 的 `invalidateSession()`，让 `authedFetch` 两个终止分支统一调用它。必须保留硬契约：首次 401 只重试一次，第二次 401 仍抛 `AuthRequiredError`。扩展 `client/tests/unit/authedFetch.test.ts`，断言集中清理动作被调用；同时在 `client/tests/unit/network-cleanup.test.ts` 覆盖网络 epoch 和节点锁收尾。

### [P1] 仅打开设置弹窗就会把“隐式自动 TURN 开启”变成“明确关闭”

- 位置: `client/src/lib/turn.ts:102`；`client/src/components/features/SettingsModal.tsx:128`；`client/src/lib/webrtc.ts:129`
- 证据:
```ts
const raw = localStorage.getItem(STORAGE_KEY)
if (raw) return JSON.parse(raw) as TurnSettings
return { servers: [], enabled: false, forceRelay: false }
useEffect(() => {
  saveTurnSettings(turnSettings)
}, [turnSettings])
export function isRelayAllowed(): boolean {
  if (loadTurnSettings().enabled) return true
  return !hasStoredTurnPreference()
}
```
- 影响: 新用户没有 `misaka.turnServers` 时，`isRelayAllowed()` 将“无记录”解释为允许自动 TURN；但打开设置弹窗后，挂载 effect 立即保存 `enabled:false`。同一个用户没有操作开关，运行态就从“允许自动 TURN”变为“禁止全部 TURN”，现有连接还会收到配置变更。对称 NAT 用户随后重连或 ICE restart 时会失去唯一可用的 relay 路径。
- 建议: 将持久化模型改成显式三态（未设置/启用/禁用），或让弹窗只在用户实际修改后保存；不要用 UI 默认值代表“无偏好”。这项修复必须继续遵守 `turnSettings.enabled` 关闭时 auto/manual TURN 都不得加入 PC 的硬契约。为 `client/tests/unit/settings-turn-gating.test.tsx` 增加“只打开并关闭设置不改变 relay 策略”，并更新 `client/tests/unit/turn-config-propagation.test.ts` 覆盖三态。

### [P1] `clearAutoTurn()` 无法阻止在途请求在注销后复活 TURN 状态

- 位置: `client/src/lib/turn.ts:202`；`client/src/lib/turn.ts:266`
- 证据:
```ts
inFlight = fetchAutoTurnOnce()
const result = await inFlight
if (result) {
  autoTurn = result
  failureAttempts = 0
  scheduleNextRefresh()
export function clearAutoTurn() {
  autoTurn = null
  lastFailReason = null
  failureAttempts = 0
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null }
```
- 影响: WebSocket 打开后开始凭证请求，用户随即注销；`destroy()` 调用 `clearAutoTurn()`，但请求不能取消、也没有 generation 校验。旧请求稍后成功时会重新写入 `autoTurn` 并重新启动刷新定时器。结果是本应 session-scoped 的凭证和后台任务在注销后复活；定时刷新最终还可能通过 `authedFetch` 的无 token 重认证路径把用户重新接入。
- 建议: 为自动 TURN 状态增加 epoch/generation，并为在途请求保存 `AbortController`。`clearAutoTurn()` 必须先递增 epoch、abort 请求、清 timer；刷新结果提交前核对 epoch。增加覆盖“刷新挂起 → clear → 旧请求成功”的回归测试，并在 `client/tests/unit/network-cleanup.test.ts` 断言注销后没有凭证和定时器复活。

### [P1] 挂起的自动 TURN 请求会永久锁死所有后续刷新

- 位置: `client/src/lib/turn.ts:165`；`client/src/lib/turn.ts:196`
- 证据:
```ts
async function fetchAutoTurnOnce(): Promise<AutoTurnState | null> {
  let resp: Response
  try {
    resp = await authedFetch('/api/turn-credentials')
export async function refreshAutoTurn(): Promise<RTCIceServer[]> {
  if (isE2eHostIceOnly()) return []
  if (inFlight) return (await inFlight)?.iceServers ?? []

  inFlight = fetchAutoTurnOnce()
```
- 影响: captive portal、失效代理或半开连接使 `/api/turn-credentials` 永不 settle 时，`inFlight` 永远非空，`finally` 永远无法清除它。之后的预热、到期刷新和 ICE restart 全部等待同一个死 Promise；对称 NAT 节点即使网络恢复也拿不到新 relay 凭证，除非整页重载。
- 建议: 给每次凭证请求传入带明确截止时间的 `AbortSignal`，超时归入可重试失败并释放 `inFlight`；超时应短于凭证 stale window 的可用余量。增加“fetch 永不 resolve → 超时释放 inFlight → 下一次刷新成功”的 fake-timer 测试。

### [P1] NAT 探测缺少代际保护，旧网络结果可覆盖新网络结果

- 位置: `client/src/lib/nat.ts:49`；`client/src/lib/nat.ts:112`
- 证据:
```ts
export function invalidateDetectedNatType() {
  setDetectedNatType('unknown')
}
const result = classifyNat(candidates)
// P1: stash the latest type so buildIceConfig can switch to relay
// automatically when we're behind a symmetric NAT — without this the
// user had to manually toggle "强制使用 TURN" in Settings.
setDetectedNatType(result.type)
return result
```
- 影响: Wi-Fi 上的自动探测接近 8 秒截止时，用户切到蜂窝网络触发 `invalidateDetectedNatType()` 和新探测；新探测先得到 `cone`，旧 Wi-Fi 探测随后得到 `symmetric` 并无条件覆盖。`buildIceConfig()` 因而在新网络上错误强制 relay，或反向错误允许本应 relay 的连接，造成连接失败或不必要的中继。
- 建议: 每次 `detectNatType()` 和 `invalidateDetectedNatType()` 都递增 generation；探测只在 generation 仍为当前值时发布结果，并关闭/abort 被取代的 PC。增加两个 deferred probe 乱序完成的测试，断言只有最后启动的探测可更新共享 NAT 状态。

### [P1] URL 配置只验证 scheme，允许当前消费者无法处理的 URL

- 位置: `client/src/config.ts:52`；`client/src/config.ts:173`；`client/src/lib/signaling.ts:124`
- 证据:
```ts
function isWsUrl(v: unknown): v is string {
  if (typeof v !== 'string' || v === '') return false
  try {
    const u = new URL(v)
    return u.protocol === 'ws:' || u.protocol === 'wss:'
  } catch {
    return false
  }
}
return cfg.API_BASE ? `${cfg.API_BASE}${path}` : path
const sock = new WebSocket(wsUrl())
```
- 影响: `WS_URL="wss://signal.example/ws#fragment"` 会通过校验，但 `new WebSocket()` 禁止 fragment 并同步抛错，信令接入完全中止；`API_BASE="https://api.example/base?tenant=1"` 同样通过校验，之后拼成 `https://api.example/base?tenant=1/api/register`，实际请求路径不是 `/api/register`。这两种配置都由当前校验器明确接受。
- 建议: 对 API/WS 分别验证可消费的 URL 结构：禁止 username/password/hash；WS 明确处理或禁止 query；API 明确规定 path-prefix 语义并用 URL API 连接路径，而不是字符串拼接。给 `client/tests/unit/config-precedence.test.ts` 增加 fragment、query、凭据、尾斜杠和 path-prefix 用例，并验证最终 `apiUrl()`/`wsUrl()`。

### [P2] 永久性 TURN 拒绝仍会无限指数退避轮询

- 位置: `client/src/lib/turn.ts:177`；`client/src/lib/turn.ts:215`
- 证据:
```ts
if (!resp.ok) {
  try {
    const body = await resp.json() as AutoTurnResponse
    lastFailReason = body.reason ?? `HTTP_${resp.status}`
  } catch {
    lastFailReason = `HTTP_${resp.status}`
  }
  return null
}
// P1-2: schedule an exponential-backoff retry so we recover on our own.
scheduleFailureRetry()
```
- 影响: 服务端明确返回 `DISABLED`、`NOT_CONFIGURED`、`GLOBAL_QUOTA_EXCEEDED`、`IP_BANNED` 或 `SESSION_BANNED` 时，客户端仍按 5/10/20/40/60 秒并永久每 60 秒请求。部署未配置 TURN 时，每个在线标签页都会持续制造无意义认证请求；被封禁会话也不会停止。
- 建议: 让失败结果携带 `retryable` 与可选 `retryAt`。仅网络错误、5xx/`CF_ERROR` 等瞬态错误进入短退避；永久配置/封禁/全局停用停止 timer，限流按服务端时间或较长冷却重试。扩展 `client/tests/unit/turn-backoff-on-failure.test.ts`，分别覆盖瞬态与终止原因。

### [P2] 明确关闭 TURN 后仍会申请自动凭证

- 位置: `client/src/lib/turn.ts:196`；`client/src/store/network.ts:1492`；`server/src/turn.ts:212`
- 证据:
```ts
export async function refreshAutoTurn(): Promise<RTCIceServer[]> {
  // Playwright's paired Chromium contexts are intentionally host-only. Do
  // not hit /turn-credentials or arm background retries in that environment.
  if (isE2eHostIceOnly()) return []
  if (inFlight) return (await inFlight)?.iceServers ?? []

  inFlight = fetchAutoTurnOnce()
// Prefetch auto TURN once authed. Server may reply 503 if disabled —
// that's fine, we just fall back to STUN + manual TURN. Re-fetch on
// every reconnect because credentials are short-lived.
void refreshAutoTurn().then(servers => {
state.ipIssuanceHistory.push(issuanceRecord)
```
- 影响: localStorage 已明确保存 `enabled:false` 时，每次信令重连仍调用 `/api/turn-credentials`。虽然 `buildIceConfig()` 最终不把凭证加入 PC，服务端仍记录一次签发、占用每 IP 每小时签发次数，并建立 pessimistic-byte reservation；大量选择关闭中继的客户端可提前耗尽 TURN 限额。
- 建议: `refreshAutoTurn()` 在明确持久化禁用时直接清 timer 并返回空数组；若设置页需要诊断，可提供命名清晰的显式 `force` 参数且只由用户手势调用。增加“stored enabled=false 时零凭证请求、无 timer”的测试；继续保持硬契约中关闭总开关后 auto/manual 都不进入 PC。

### [P2] TURN 设置读取只做 JSON cast，合法 JSON 也能让连接路径崩溃

- 位置: `client/src/lib/turn.ts:102`；`client/src/lib/turn.ts:117`
- 证据:
```ts
const raw = localStorage.getItem(STORAGE_KEY)
if (raw) return JSON.parse(raw) as TurnSettings
return { servers: [], enabled: false, forceRelay: false }
export function getTurnIceServers(): RTCIceServer[] {
  const t = loadTurnSettings()
  if (!t.enabled) return []
  return t.servers
    .filter(s =>
```
- 影响: `misaka.turnServers` 为合法 JSON `{"enabled":true}` 时，cast 成功但 `servers` 是 `undefined`；下一次构建 ICE 配置执行 `t.servers.filter` 即抛 `TypeError`，无法建立任何 PeerConnection。值为 `null` 时甚至会在 `t.enabled` 处立即崩溃。用户只能手工清站点数据恢复。
- 建议: 在持久化边界做逐字段 schema 校验和版本迁移：`servers` 必须为数组，布尔字段必须为 boolean，每个 server 再复用 URL/凭据校验；无效记录应记录一次诊断并回退安全默认值。增加 null、缺字段、错误数组元素和旧版本记录测试。

### [P2] TURN 与音效设置写入未处理 `localStorage` 异常

- 位置: `client/src/lib/turn.ts:110`；`client/src/lib/sound.ts:26`
- 证据:
```ts
export function saveTurnSettings(settings: TurnSettings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  // The `enabled` flag, manual server list, and `forceRelay` flag all feed
  // into RTCConfiguration. Notify so live PCs can rebuild their config.
  emitTurnConfigChange()
}
export function setSoundEnabled(enabled: boolean) {
  localStorage.setItem(STORAGE_KEY, String(enabled))
}
```
- 影响: sandboxed iframe、浏览器存储策略或配额错误使 `setItem` 抛 `SecurityError`/`QuotaExceededError` 时，打开 TURN 设置的挂载 effect 会抛出 React effect 异常；点击音效开关也会同步抛错，UI 不更新。相同模块的读取路径已经捕获异常，写入路径却没有等价降级。
- 建议: 两个写 API 都捕获 StorageError，并返回可观察的成功/失败结果；运行态仍应使用内存中的设置，UI 显示“本次有效但无法保存”。TURN 只有在运行态设置更新成功后才发配置变更，持久化失败不应阻断连接配置应用。

### [P2] NAT 探测在清理边界之外创建 DataChannel

- 位置: `client/src/lib/nat.ts:71`
- 证据:
```ts
const pc = new RTCPeerConnection({
  iceServers: isE2eHostIceOnly() ? [] : stunServers,
})
// Need at least one m-line so the browser actually gathers.
pc.createDataChannel('nat-probe')
try {
  let timeout: ReturnType<typeof setTimeout> | null = null
} finally {
  pc.close()
}
```
- 影响: 浏览器暴露 `RTCPeerConnection` 但因企业策略、WebRTC 硬化或 DataChannel 不可用而让 `createDataChannel()` 抛错时，函数在进入 `try/finally` 前退出，刚创建的 PC 不会 `close()`。每次自动恢复或用户重试都会再泄漏一个 ICE agent。
- 建议: PC 构造成功后的所有操作都放进同一个 `try/finally`；`createDataChannel`、offer 和 local description 任一失败都必须关闭 PC。增加 `createDataChannel` 同步抛错并断言 `close()` 被调用的测试，与现有 `nat-deadline.test.ts` 并列。

### [P2] TURN 状态轮询没有超时或取消，挂起请求会不断叠加

- 位置: `client/src/lib/turn.ts:275`；`client/src/components/features/SettingsModal.tsx:83`
- 证据:
```ts
export async function fetchTurnStatus(): Promise<TurnStatusResponse | null> {
  try {
    const resp = await fetch(apiUrl('/api/turn-status'))
    if (!resp.ok) return null
    return await resp.json() as TurnStatusResponse
  } catch {
    return null
  }
}
void tick()
const id = window.setInterval(tick, 10_000)
return () => { cancelled = true; window.clearInterval(id) }
```
- 影响: `/api/turn-status` 请求在代理中挂起 60 秒时，10 秒 interval 会并行启动约六个请求；关闭弹窗只停止新 interval，既不 abort 已有 fetch，也不释放其闭包。长时间打开设置会累积未完成请求并让状态停在旧值。
- 建议: `fetchTurnStatus(signal)` 接受调用方 signal，并设置内部 deadline；轮询用“本次完成后再排下一次”的递归 timeout，保证最多一个在途请求。effect cleanup 必须 abort 当前请求。

### [P2] 音频上下文构造失败会形成未处理的 Promise rejection

- 位置: `client/src/lib/sound.ts:5`；`client/src/lib/sound.ts:52`
- 证据:
```ts
function getAudioContext(): AudioContext | null {
  const AudioCtor = window.AudioContext ?? (window as any).webkitAudioContext
  if (!AudioCtor) return null
  const w = window as typeof window & { __misakaAudio?: AudioContext }
  if (!w.__misakaAudio) w.__misakaAudio = new AudioCtor()
  return w.__misakaAudio
}
export async function playSound(event: SoundEvent) {
  if (!isSoundEnabled()) return
  const ctx = getAudioContext()
  if (!ctx) return
```
- 影响: 浏览器存在 `AudioContext` 构造器但因策略或资源上限使 `new AudioCtor()` 抛错时，`playSound()` 变成 rejected Promise。传输完成/错误等调用方均以 fire-and-forget 方式调用，因而产生全局 `unhandledrejection`，同时没有禁用音效或向用户降级。
- 建议: 在 `getAudioContext()` 捕获构造异常并返回结构化失败，`playSound()` 保证 never-reject 或要求所有调用方显式处理；首次失败后缓存“不可用”状态，避免每个传输事件重复构造和重复报错。

### [P2] 通知 tag 只使用文件名，会合并不同传输的可操作提醒

- 位置: `client/src/lib/notify.ts:24`
- 证据:
```ts
export function notifyIncomingFile({ peerNodeId, fileName, fileSize }: IncomingFileNotice) {
  if (typeof window === 'undefined' || !('Notification' in window)) return
  if (document.visibilityState === 'visible') return
  if (Notification.permission !== 'granted') return

  const title = peerNodeId ? `御坂 ${peerNodeId} 号发送了文件` : '收到新文件'
  const body = `${fileName} · ${formatBytes(fileSize)}`
  try {
    new Notification(title, { body, tag: `misaka-file-${fileName}` })
```
- 影响: 后台标签页先后从两个节点收到同名 `report.pdf` 时，两条通知拥有同一 tag；浏览器会以后一条替换/合并前一条。通知在传输开始时承担“尽早拒绝大文件”的作用，用户最终只看到一个来源，可能漏掉另一条正在接收的传输。
- 建议: `IncomingFileNotice` 增加 `transferId`（或至少 peer session + transfer id），使用稳定且每次传输唯一的 tag；保留同一传输重发时去重。增加两个不同 transfer、同文件名的通知测试。

### [P3] 关闭音效不会释放已创建的 `AudioContext`

- 位置: `client/src/lib/sound.ts:8`；`client/src/lib/sound.ts:26`
- 证据:
```ts
const w = window as typeof window & { __misakaAudio?: AudioContext }
if (!w.__misakaAudio) w.__misakaAudio = new AudioCtor()
return w.__misakaAudio
export function setSoundEnabled(enabled: boolean) {
  localStorage.setItem(STORAGE_KEY, String(enabled))
}
```
- 影响: 用户启用音效试听一次后再关闭，运行中的 `AudioContext` 仍永久挂在 `window.__misakaAudio`，直到标签页销毁；关闭设置并未释放音频设备/调度资源，移动端会继续保留不必要的音频上下文。
- 建议: 关闭音效时 `suspend()` 或 `close()` 上下文并删除缓存；若选择 `close()`，下次启用时重新创建。页面生命周期终止时也执行同一清理，并测试 enable → play → disable 的 context 状态。

### [P3] `secureRandomInt` 对大于 32 位空间的区间会无限循环

- 位置: `client/src/lib/passcode.ts:30`
- 证据:
```ts
const range = max - min + 1
if (range === 1) return min
// Largest multiple of `range` that fits in 2^32; anything at or above it is
// re-drawn. The expected number of draws is < 2 for any sane range.
const limit = Math.floor(UINT32_SPACE / range) * range
const buf = new Uint32Array(1)
for (;;) {
  crypto.getRandomValues(buf)
  if (buf[0] < limit) return min + (buf[0] % range)
}
```
- 影响: 调用 `secureRandomInt(0, 0x1_0000_0000)` 时 `range` 大于 `2^32`，`limit` 变成 0，任何 `Uint32` 值都不可能小于 0，主线程进入无限 CSPRNG 循环。当前通行码和节点编号范围安全，但导出的通用函数没有兑现其文档中的任意整数区间语义。
- 建议: 明确拒绝 `range > 2^32` 及非 safe-integer 边界，或实现基于 53 位安全整数的多字 rejection sampling。增加边界 `2^32`、`2^32+1` 和 unsafe integer 测试。

### [P3] `useCardIn` 是无调用方、无测试的死抽象

- 位置: `client/src/hooks/useCardIn.ts:3`
- 证据:
```ts
export function useCardIn(threshold = 0.15) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new IntersectionObserver(
    observer.observe(el)
    return () => observer.disconnect()
```
- 影响: 全仓库检索只有该定义，没有任何 import 或调用；因此这段 IntersectionObserver 生命周期不会进入产物，也没有测试保护。维护者若修复其兼容性或调整动画阈值，不会改变任何用户行为，却容易误以为卡片入场动画由这里统一管理。
- 建议: 若现有页面不计划采用它，删除该文件；若它应成为统一入口，则替换当前页面内联观察逻辑并补充无 `IntersectionObserver` 时直接显示内容的降级测试。不要保留“看似公共、实际无人使用”的双轨实现。

## 附录: 已核查但结论为无问题的区域

- `client/src/lib/api.ts`：已静态核对现有 `authedFetch` 测试；Bearer header、首次 401 后重认证、只重试一次、第二次 401 抛 `AuthRequiredError` 的硬契约本身成立，问题仅在终止清理入口。
- `client/src/hooks/useCameraStream.ts`：controller 的 generation、late-stream stop、顺序重采集和 dispose 行为与 `scan-camera-lifecycle.test.ts`、`scan-modal-camera-switch.test.tsx` 一致，未发现轨道泄漏。
- `client/src/hooks/useReducedMotion.ts`、`useModalExit.ts`：MediaQueryList 新旧监听 API 均有对称 cleanup；退出 timer 有卸载清理和双关闭保护。
- `client/src/lib/appBase.ts`、`client/src/App.tsx`、`client/src/main.tsx`：构建 base、Router basename、public asset、404 回跳和 service worker URL 使用同一来源；指定的根路径/子路径测试场景一致。
- `client/src/lib/nat-classify.ts`：已核对 host/srflx 分组、IPv6-only 分支及现有分类测试；对浏览器产生的正常候选未发现可证明的误分类。
- `client/src/lib/turn.ts` TURN 单服务器诊断：setup deadline、listener 清理和 PC close 路径完整，现有 typed-result 测试覆盖主要异常分支。
- `client/src/lib/passcode.ts`：应用实际使用的 6 位通行码与 1–20001 节点区间使用 CSPRNG rejection sampling，无模偏差。
- `client/src/lib/notify.ts`：能力检测、页面可见性、permission 状态和构造异常均有防护；除 tag 冲突外未发现权限绕过。
- `client/src/constants.ts`、`client/src/types.ts`、`client/src/data/lore.ts`、`client/src/lib/e2e-ice.ts`：对照调用方和边界条件后未发现本审计范围内的确定性缺陷。
- 按审计硬规则未运行 `npm test`、构建、安装或任何 Git 命令；结论来自逐行静态核查、调用链和现有测试源码。
