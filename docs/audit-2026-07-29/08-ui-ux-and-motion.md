# Misaka Network UI/UX、布局与动效审计

## 摘要

- 传输面板的“取消”没有二次确认；一次误触会立即进入取消分支并移除任务，接收端已写入的部分数据也会被清理。这是本次范围内唯一的 P0。
- 扫码器在每轮 `requestAnimationFrame` 中先运行 `BarcodeDetector`、未识别时再运行完整的 `jsQR` 像素分析；在手机上会持续占用 CPU、掉帧和耗电。
- “暂停动态”错误地停止了活动事件订阅，暂停期间到达的真实事件不会补回；这不是单纯暂停动画。
- `/network` 仍硬编码 64px 导航高度，忽略项目已经定义的 `--nav-h-total`；在 `viewport-fit=cover` 的刘海屏 PWA 中，首行会被导航栏覆盖。
- 网络页在 320px 手机和 768px 三栏临界宽度存在可验证的 flex/grid 溢出；移动“底部”操作栏也不是 fixed/sticky，页面滚动后会离开视口。
- 多处可访问性缺陷仍会阻碍实际操作：状态在窄屏变成纯颜色、节点卡的 `aria-label` 覆盖未读数、多个进度条没有可访问名称、若干直接实现的小按钮不足 44px。
- 现有 reduced-motion 基础设施总体完整，但 `Network.tsx` 仍硬编码 smooth scroll；扫描线、按钮扫光和进度条还在动画化 `top`/`left`/`width`，动态列表、骨架屏和开关滑块的反馈也不完整。
- 下述建议均只调整 UI 意图与呈现，不改变 `CHUNK_FRAME_TAG`/帧布局、protocol v2 交付语义、`authedFetch` 重试规则或测试脚本生命周期；涉及传输取消时应保留现有取消协议与清理语义，仅在调用前增加确认。

## 发现

### [P0] 活跃传输可被一次误触立即取消并清理

- 位置: `client/src/pages/Network.tsx:686`
- 证据:

```tsx
<div className="flex gap-1.5 mt-2">
  <MisakaButton variant="pill" size="sm" className="flex-1 text-xs py-1" onClick={() => onPause(t.id)}>⏸ 暂停</MisakaButton>
  <MisakaButton variant="pill" size="sm" className="flex-1 text-xs py-1" onClick={() => onCancel(t.id)}>✕ 取消</MisakaButton>
</div>
```

- 影响: 发送或接收大文件时，“暂停”和“取消”并排且同层级。用户在触屏上误点“取消”会立即调用 `dispatchCancel`；该调用没有确认或撤销期，任务卡同步消失，接收端的部分文件/块清理也随即开始。具体场景：已接收 90% 的 20GB 文件时误触相邻按钮，90% 进度无法从 UI 恢复。
- 建议: 在 `onCancel` 前打开基于 `MisakaDialog` 的确认对话框，明确文件名、方向、已完成百分比和“已接收部分将被删除”；默认焦点放“继续传输”，危险操作使用独立 danger 层级。确认后仍调用现有 `dispatchCancel`，不要改变 protocol v2 的 `transfer-cancel`、所有权校验或后端清理语义；补充发送端和接收端的确认/取消 UI 测试。

### [P1] 扫码循环逐帧串行运行两套解码器

- 位置: `client/src/components/features/ScanModal.tsx:215`
- 证据:

```tsx
async function tick() {
  if (camera.current() !== stream) return
  const found = await scanWithBarcodeDetector()
  if (!found) await scanWithJsQR()
  if (camera.current() !== stream) return
  animRef.current = requestAnimationFrame(tick)
}
```

- 影响: 摄像头画面中没有 QR 时，每轮先创建并运行原生 `BarcodeDetector`，然后又把整帧绘制到 canvas、读取 `ImageData` 并运行 `jsQR`。循环没有最小间隔；在常见 30/60Hz 摄像头与手机上会持续高 CPU、发热、耗电，并与视频和弹窗动画争抢主线程，表现为关闭/输入按钮掉帧。
- 建议: 每个会话只实例化一次 `BarcodeDetector`；原生检测可用时不要把“未识别”当成需要执行 `jsQR` 的错误回退。使用 `requestVideoFrameCallback` 或 150–250ms 节流，并在 `document.hidden`、弹窗 closing 或流停止时暂停。`jsQR` 仅在原生 API 不可用/抛错时启用。

### [P1] “暂停动态”会丢失暂停期间的真实事件

- 位置: `client/src/components/features/ActivityStream.tsx:39`
- 证据:

```tsx
const motionStopped = paused || reducedMotion || coarsePointer

useEffect(() => {
  if (!session || motionStopped) return
  return onMessage((msg) => {
    if (msg.t === 'ACTIVITY') addActivity(msg.event as ActivityEvent)
  })
}, [session, addActivity, motionStopped])
```

- 影响: 点击“暂停动态”会卸载 `onMessage` 订阅，而不仅是停止自动滚动。具体场景：用户暂停 2 分钟阅读旧事件，其间发生节点加入和文件传输；恢复后这些事件不会补回，活动流给出错误的网络历史。同时 45 秒语录定时器仍继续添加内容，按钮语义前后不一致。
- 建议: 让消息订阅只依赖 `session` 和 `addActivity`，始终接收数据；`paused` 仅控制自动滚动和可选的视觉进入动画。若产品需要“冻结视图”，将新事件放入缓冲区并显示“有 N 条新动态”，恢复时一次性合入。进入/合入动画必须通过 `useReducedMotion` 或现有 CSS 媒体查询禁用。

### [P1] 网络页绕过安全区导航高度契约

- 位置: `client/src/pages/Network.tsx:1061`
- 证据:

```tsx
return (
  <div className="pt-16 flex flex-col" style={{ background: 'var(--bg-primary)', minHeight: '100dvh' }}>
    <div className="hidden md:grid gap-6 p-6"
      style={{ minHeight: 'calc(100dvh - 64px - 73px)' }}>
    <div className="md:hidden flex flex-col"
      style={{ minHeight: 'calc(100svh - 64px)' }}>
```

- 影响: `index.css` 已定义 `--nav-h-total = 64px + safe-area-inset-top`，但本页三处仍使用裸 64px。由于 `client/index.html` 使用 `viewport-fit=cover`，在约 390×844 的刘海屏 iPhone 独立 PWA 中，节点/信道/任务标签会有约 47–59px 落在固定导航栏下方，页面高度计算也多出同样的偏差。
- 建议: 根容器改用 `.pt-nav`；所有高度公式使用 `var(--nav-h-total)`，例如 `calc(100svh - var(--nav-h-total))`。桌面公式中也不要重复写 64px。增加带非零 `safe-area-inset-top` 的样式/截图回归测试。

### [P1] 聊天输入缺少 `min-w-0`，在 320px 与 768px 临界布局溢出

- 位置: `client/src/pages/Network.tsx:385`
- 证据:

```tsx
<div className="border-t p-3 flex gap-2">
  <input
    className="misaka-focus-ring flex-1 px-3 py-2 rounded-lg text-sm font-kanji focus:outline-none"
    style={{ border: '1px solid var(--border-card)', fontSize: '16px' }}
  />
  <MisakaButton variant="primary" size="sm" onClick={handleSend}>发送</MisakaButton>
</div>
```

- 影响: flex 子项 `<input>` 保留 intrinsic/min-content 宽度。320px 手机上，频道卡实际宽度约 288px，输入行内宽约 264px；768px 刚进入桌面三栏时，中栏约 232px，输入行内宽仅约 208px。输入框、8px 间距和“发送”按钮之和无法收缩，产生横向溢出；全局 `body { overflow-x: hidden }` 会把右侧内容静默裁掉。
- 建议: 给 input 加 `min-w-0 w-0 flex-1`，给发送按钮加 `shrink-0`；必要时在 320px/窄中栏改为可换行或纵向布局。以 320×568 和 768×1024 两个视口增加布局回归。

### [P1] 删除 TURN 服务器没有确认且立即持久化

- 位置: `client/src/components/features/SettingsModal.tsx:128`
- 证据:

```tsx
useEffect(() => {
  saveTurnSettings(turnSettings)
}, [turnSettings])

function handleDelete(id: string) {
  setTurnSettings(s => ({ ...s, servers: s.servers.filter(srv => srv.id !== id) }))
}
```

- 影响: 点击服务器行的“删除”会直接从列表移除，并由 effect 立即写入本地存储。具体场景：用户误删唯一一个包含不可重新获取凭据的 TURN 配置，关闭弹窗后没有撤销入口；在对称 NAT 下，后续节点连接可能全部失败。
- 建议: 使用嵌套 `MisakaDialog` 确认，展示服务器 URL 并默认聚焦“保留”；或先提供 5–10 秒可撤销 toast，再持久化删除。危险按钮不要与“测试/编辑”使用完全相同的 pill 层级。补充取消、确认和唯一可用 TURN 被删除时的测试；不改变 `turnSettings.enabled` 对自动/手工 TURN 的既有契约。

### [P1] 移动“底部操作栏”不是固定或粘滞元素

- 位置: `client/src/pages/Network.tsx:805`
- 证据:

```tsx
<div
  className="flex items-center justify-around"
  style={{
    height: 'calc(96px + env(safe-area-inset-bottom))',
    paddingBottom: 'env(safe-area-inset-bottom)',
    background: 'rgba(14,42,107,0.92)',
    backdropFilter: 'blur(12px)',
  }}
>
```

- 影响: 该栏没有 `position: fixed`、`sticky`、`bottom` 或 z-index，只是移动 flex 容器的普通末尾子项。390×844 手机上，滚动到页脚、NAT 警告或软键盘触发外层页面滚动后，“任务/信道/QR”会随文档离开视口；而 `.misaka-notify` 又始终按“底部有固定 96px 栏”预留空间，造成可见空隙与实际遮挡模型不一致。
- 建议: 将操作栏设为 `position: sticky; bottom: 0`（若只需在 Network 容器内）或 `fixed`（若需始终可见），使用明确 z-token，并让唯一滚动区域拥有确定的 `height/min-height: 0`。保留 `safe-area-inset-bottom`，同步调整内容底部占位和通知偏移。

### [P2] 页面 toast 的层级高于所有 `MisakaDialog`

- 位置: `client/src/pages/Network.tsx:1193`
- 证据:

```tsx
<div
  className="misaka-toast-region"
  style={{ position: 'fixed', left: 0, right: 0, bottom: 0, pointerEvents: 'none', zIndex: 120 }}
>
  <div className="misaka-toast fixed left-1/2 -translate-x-1/2 z-[120] ...">
```

- 影响: `MisakaDialog` 固定使用 z-index 100，而本页 toast 使用 120，也没有 `.misaka-notify` 的 `body[data-dialog-open]` 隐藏规则。具体场景：复制诊断后 2.4 秒内打开设置或 QR，toast 会盖在 modal 内容/操作上方，破坏模态层的视觉和交互层级。
- 建议: 复用 `.misaka-notify`，把页面 toast 放在 `--z-notify`（90），或在 `data-dialog-open` 时隐藏/排队；移除局部 `z-[120]`。通知层只应高于页面内容、低于对话框。

### [P2] 通用对话框没有为刘海和 Home Indicator 保留安全区

- 位置: `client/src/components/ui/MisakaDialog.tsx:130`
- 证据:

```tsx
backdropClassName = 'flex items-center justify-center p-4',

// QRModal
width: 'min(360px, 100% - 8px)',
maxHeight: '90svh',
overflowY: 'auto',
```

- 影响: backdrop 四边固定 16px，而 QR/扫描弹窗允许占 90svh。393×852 的 iPhone 14 Pro 上，90svh 居中的理论上边距约 43px，小于约 59px 的顶部安全区；QR 右上角关闭按钮及其 44px 扩展点击区会进入刘海/状态栏区域，底部操作在横屏也可能贴住 Home Indicator。
- 建议: `MisakaDialog` 默认使用 `padding-top: max(1rem, var(--safe-top))` 与 `padding-bottom: max(1rem, var(--safe-bottom))`，并把 panel 最大高度定义为减去这两侧 padding 后的可用 `100svh`。由通用 primitive 统一处理，不要让每个 modal 重复计算。

### [P2] 完成态传输卡在 768px 三栏右侧溢出

- 位置: `client/src/pages/Network.tsx:729`
- 证据:

```tsx
{t.direction === 'send' && (
  <MisakaButton className="ml-auto text-xs py-1 px-3"
    onClick={() => onResendToPeer(t.peerSessionId)}>
    再发文件给此节点
  </MisakaButton>
)}
{t.direction === 'send' && getTransferDeliveryState(t.id) !== 'saved' && (
  <span className="ml-auto font-kanji text-[10px]">等待对方保存确认</span>
)}
```

- 影响: 发送已完成但尚未收到 `transfer-done` 时，同一条不换行 flex 行同时渲染状态、“再发文件给此节点”和“等待对方保存确认”。在 768px 三栏布局中右栏固定至少 220px，卡片扣除 padding 后约 188px；两个不可有效压缩的中文操作/提示加状态远超可用宽度，被全局横向裁剪。
- 建议: 完成态改为 `flex flex-wrap`；把“等待对方保存确认”放在独占整行的说明区，主操作下一行 `w-full` 或短化为“再发”。确保 v2 的 `delivered → saved` 文案语义不变，并覆盖 768px 与 1024px。

### [P2] 状态填充色被用作小号文字/白字底色，低于 AA

- 位置: `client/src/index.css:21`
- 证据:

```css
--surface:       #FFFFFF;
--state-success: #00C28A;
--state-warn:    #FFB23D;
--state-danger:  #E83A5A;
```

```tsx
<span style={{ color: 'var(--state-danger)' }} className="font-mono text-xs">✗ 失败</span>
```

- 影响: 静态计算得到 `--state-danger`/白色为 4.05:1，`--state-success`/白色为 2.31:1；Settings 的白字/`--state-warn` 徽章仅 1.80:1。它们用于 10–12px 文本时低于 WCAG AA 4.5:1。失败提示、下载成功提示和 NAT 徽章在强光或低视力场景下难以辨认。
- 建议: 浅色表面文字统一改用 `--state-*-on-light`；蓝底使用 `--state-*-on-blue`。填充徽章要么采用经验证的深色背景配白字，要么使用浅色 tint 配 `NAT_TYPE_LABEL.*.textColor`。将这些实际用法加入现有 contrast 测试，而不仅测试 token 定义。

### [P2] 320–389px 顶栏状态退化为纯颜色且没有可访问名称

- 位置: `client/src/components/layout/TopNav.tsx:225`
- 证据:

```tsx
<span className="h-8 inline-flex items-center gap-1.5 text-xs font-mono ...">
  <span
    style={{
      width: 8, height: 8, borderRadius: '50%',
      background: !isConnected || networkStatus === 'offline' ? 'var(--text-muted)'
        : networkStatus === 'transferring' ? 'var(--accent-cyan)'
        : networkStatus === 'online' ? 'var(--state-success)' : 'var(--state-warn)',
    }}
  />
  <span className="hidden xs:inline">{isConnected ? networkStatusLabel(networkStatus) : '未接入'}</span>
</span>
```

- 影响: `xs` 从 390px 才生效；320–389px 时状态文字被 `display:none`，只剩 8px 彩色圆点。视觉用户只能靠颜色区分“未接入/在线/传输/重连”，屏幕阅读器也没有可读状态名称。
- 建议: 不要在窄屏从可访问树移除文字；可用 `sr-only xs:not-sr-only` 保留名称，并在父元素增加 `role="status"`、`aria-live="polite"` 与明确 `aria-label`。视觉上再配合不同图形/符号，避免颜色单独编码状态。

### [P2] 节点卡的 `aria-label` 覆盖了未读数量

- 位置: `client/src/pages/Network.tsx:115`
- 证据:

```tsx
role="button"
tabIndex={0}
aria-label={`选择御坂 ${peer.nodeId} 号节点`}
aria-pressed={isSelected}
```

```tsx
<span title={`未读消息 ${unread.message}，未读文件 ${unread.file}`}>
  {Math.min(99, unread.message + unread.file)}
</span>
```

- 影响: `aria-label` 会替换节点卡的全部子内容作为可访问名称，因此卡内状态、session 后缀和未读徽章不会被读出。具体场景：两个同 nodeId 设备都有消息时，屏幕阅读器用户听到两个相同的“选择御坂 N 号节点”，无法知道哪一个有未读消息。
- 建议: 构造包含 `sidTag`、连接状态和未读细分数量的 `aria-label`，或用 `aria-labelledby`/`aria-describedby` 组合可见字段；未读变化可放入邻近的 polite live region，避免覆盖用户正在阅读的内容。

### [P2] 多个传输进度条没有可访问名称

- 位置: `client/src/components/ui/MisakaProgressBar.tsx:9`
- 证据:

```tsx
<div
  className={`relative overflow-hidden rounded-full ${className}`}
  role="progressbar"
  aria-valuenow={Math.round(pct)}
  aria-valuemin={0}
  aria-valuemax={100}
>
```

- 影响: primitive 只暴露数值，不接受 `aria-label`/`aria-labelledby`。TaskPanel 同时有多个文件时，屏幕阅读器依次只报告“进度条 42%”“进度条 67%”，无法判断各自对应哪个文件或发送/接收方向。
- 建议: 为 `MisakaProgressBar` 增加 `label` 或透传标准 div ARIA 属性；TaskPanel 用文件名和方向生成名称，例如“接收 photo.zip 的进度”。高频更新可设置合适的 `aria-valuetext` 或按整数变化节流，避免过度播报。

### [P2] 下载完成后的释放操作点击区远小于 44px

- 位置: `client/src/components/features/DownloadArtifactActions.tsx:46`
- 证据:

```tsx
<button
  type="button"
  disabled={releasing}
  onClick={() => { void confirmSaved() }}
  className="text-[10px] underline decoration-dotted disabled:opacity-60"
  style={{ border: 0, padding: 0, background: 'transparent' }}
>
  {releasing ? '释放中…' : '确认已保存并释放临时副本'}
</button>
```

- 影响: 该按钮是 10px 字号、零 padding，也没有 `.tap-target`；粗指针下实际高度约一行文字，远低于项目自己的 44px 标准。用户在手机上很难准确点击；误触该动作又会删除站点保留的临时副本。
- 建议: 使用 `MisakaButton`，或至少增加 `min-h-11 px-2 tap-target` 并保留清晰焦点样式。由于动作会释放临时数据，文案应继续强调“浏览器保存完成后”，并考虑二次确认/短暂撤销。

### [P2] 设置页签缺少标准键盘交互与 roving tabindex

- 位置: `client/src/components/features/SettingsModal.tsx:300`
- 证据:

```tsx
<button
  role="tab"
  aria-selected={tab === t.id}
  className="flex-1 py-2.5 text-center font-kanji text-xs"
  onClick={() => setTab(t.id)}
>
```

- 影响: 三个 `role="tab"` 都保留默认 `tabIndex=0`，没有 `aria-controls`/tabpanel id，也没有左右/Home/End 键处理。键盘用户必须 Tab 三次穿过标签，方向键不会切换；这与控件声明的 tab 语义不一致。
- 建议: 实现 roving tabindex（仅选中页签为 0，其余为 -1）、ArrowLeft/Right、Home/End，给内容加 `role="tabpanel"` 与双向 id 关联。页签点击/键盘切换时保留当前表单值。

### [P2] Network 的脚本滚动无视 reduced-motion

- 位置: `client/src/pages/Network.tsx:199`
- 证据:

```tsx
bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
```

```tsx
inputRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
```

- 影响: 新消息/传输以及移动端输入框聚焦都会强制平滑移动，即使操作系统设置了 `prefers-reduced-motion: reduce`。项目已提供 `scrollIntoViewSafely`，但本页两处绕过了它；前者还会在高频传输状态变化时反复移动聊天区。
- 建议: 两处统一使用 `scrollIntoViewSafely` 或 `scrollBehavior()`；聚焦用 `block:'nearest'` 优先避免不必要的视口移动。保持 CSS reduced-motion 规则作为兜底。

### [P2] 动效系统动画化 `top`、`left` 和 `width`

- 位置: `client/src/index.css:421`
- 证据:

```css
@keyframes scan-line {
  0%   { top: 0%; opacity: 1; }
  100% { top: calc(100% - 2px); opacity: 0; }
}
@keyframes btn-sweep {
  0%   { left: -60%; opacity: 1; }
  100% { left: 120%; opacity: 0; }
}
```

```tsx
style={{ width: `${pct}%`, transition: 'width 150ms linear' }}
```

- 影响: 扫描线无限动画 `top`，按钮扫光动画 `left`，每个传输进度条持续改变 `width`；这些属性需要布局/绘制，而不是仅合成 transform/opacity。扫码器本身已高负载，多任务传输又会同时更新多条进度，低端手机会出现可见卡顿。
- 建议: 扫描线固定在顶部并动画 `transform: translateY(...)`；扫光固定位置后动画 `translateX`；进度填充宽度保持 100%，用 `scaleX(pct)` 和 `transform-origin:left`。建议 120–180ms linear/standard easing；现有 reduced-motion 媒体查询继续把时长压到近零。

### [P3] 开关滑块声明了 transform transition，却只改变 `left`

- 位置: `client/src/components/ui/MisakaSwitch.tsx:66`
- 证据:

```tsx
<span
  className="absolute top-0.5 w-5 h-5 rounded-full bg-white transition-transform"
  style={{ left: checked ? 'calc(100% - 22px)' : '2px' }}
/>
```

- 影响: `transition-transform` 不会动画 `left`，所以轨道颜色平滑变化时，白色滑块会瞬间跳到另一侧。用户快速切换 TURN/音效时，位置与颜色反馈不同步，状态变化显得断裂。
- 建议: 固定 `left:2px`，以 `transform: translateX(16px)` 表示开启，使用 `transition-transform duration-150 ease-out`；disabled 状态不动。全局 reduced-motion 规则已能自动禁用该 transition，也可用 `useReducedMotion` 做渲染级保护。

### [P3] 活动流和传输列表没有项目进入/退出动画

- 位置: `client/src/components/features/ActivityStream.tsx:105`
- 证据:

```tsx
{activities.map(event => (
  <div key={event.id} className="flex-shrink-0 flex items-center gap-2 ...">
```

```tsx
{transfers.map(t => (
  <MisakaCard key={t.id} padding="sm">
```

- 影响: 新活动被插到横向列表开头时，已有 pill 瞬间位移；达到 20 条上限时尾项无提示消失。传输新增、取消、完成/失败时，卡片和相邻内容也直接跳变，用户难以定位“刚发生了什么”，尤其多任务并行时。
- 建议: 项目进入使用 `opacity 0→1` + `translateY(6px)`，160–220ms ease-out；退出使用 opacity + `scale(.98)`，120–160ms ease-in，并在真正移除前保留短暂 presence 状态。状态完成/失败可做一次 160ms badge 背景/图标微反馈。`useReducedMotion` 为 true 时直接渲染最终状态，不延迟数据移除。

### [P3] 首次统计加载的骨架是静态色块

- 位置: `client/src/components/features/StatsDashboard.tsx:151`
- 证据:

```tsx
{showSkeleton ? (
  <span
    className="inline-block w-24 h-9 rounded align-middle"
    style={{ background: 'var(--surface-tint)' }}
    aria-label="加载中"
  />
) : (
```

- 影响: 首次网络较慢时，七个静止矩形与未绘制/空值占位非常相似，没有持续加载反馈；用户无法判断页面仍在请求还是已经卡住。
- 建议: 增加仅作用于 `background-position` 或伪元素 `transform` 的 1.2–1.6s shimmer，或轻量 opacity pulse；为整个统计区提供一次 `role="status"` 的“正在加载统计”。`useReducedMotion` 为 true 时保留静态骨架并关闭 shimmer。

### [P3] reduced-motion 下从设置跳转法律页仍固定等待 180ms

- 位置: `client/src/components/features/SettingsModal.tsx:683`
- 证据:

```tsx
<MisakaButton variant="pill" size="sm" fullWidth
  onClick={() => { modal.requestClose(); window.setTimeout(() => navigate('/tos'), 180) }}>
  服务条款
</MisakaButton>
<MisakaButton variant="pill" size="sm" fullWidth
  onClick={() => { modal.requestClose(); window.setTimeout(() => navigate('/privacy'), 180) }}>
```

- 影响: `useModalExit` 在 reduced-motion 下会立即关闭弹窗，但这里仍留下 180ms 的空等待；普通模式下该常量也与 hook 内部 `EXIT_MS` 重复，未来动画时长调整会导致提前跳页或多余停顿。
- 建议: 让 `useModalExit` 提供 `requestClose({ afterClose })`/`onExited`，导航由真实退出完成事件触发；reduced-motion 时同步执行。不要在调用方复制 180ms。

### [P3] Terms 与 Privacy 重复实现了已有卡片 primitive

- 位置: `client/src/pages/Terms.tsx:13`
- 证据:

```tsx
<div
  className="rounded-2xl p-6 space-y-4 font-kanji text-sm leading-relaxed"
  style={{ background: 'var(--surface)', color: 'var(--text-on-white)' }}
>
```

- 影响: `Privacy.tsx:13` 存在相同实现，但两页绕过 `MisakaCard` 的边框、阴影、padding token。以后调整 `.misaka-card` 的半径、边框或高对比主题时，法律页不会同步，当前视觉也已经与其他白色内容卡不同。
- 建议: 两页改用 `MisakaCard padding="md"`，仅保留排版类；若法律页确实需要无阴影变体，应给 `MisakaCard` 增加明确 variant，而不是复制任意样式。

## 附录: 已核查但结论为无问题的区域

- `MisakaDialog` 已统一使用 portal、`role="dialog"`、`aria-modal`、焦点圈定、背景 inert、滚动锁和焦点恢复；嵌套 `IpFullPrompt` 的栈处理也能恢复外层弹窗。除安全区 padding 外未发现新的焦点陷阱。
- `QRModal` 与 `ScanModal` 已使用 `min(..., 100% - 8px)`、`maxHeight` 和内部滚动，320px 宽度下不再由固定最小宽度产生横向溢出；QR 可复制失败时也有可选中的链接与正常流反馈。
- modal 进入/退出已有 opacity/transform 动画，`useModalExit` 在 reduced-motion 下会取消 180ms 等待；全局 `prefers-reduced-motion` 也覆盖 transition、循环漂浮、扫描线和滚动行为。
- Home/ACGN 的移动与桌面 hero 已使用 `--nav-h-total`，短屏 hero 有独立压缩规则；Terms/Privacy 同样正确预留顶部导航和底部安全区。
- App 级路由已有 `page-enter`，前进导航会复位滚动并移动主内容焦点；本次范围内未发现页面进入动画绕过 reduced-motion。
- `MisakaButton`、`MisakaSwitch`、LoginCard 的图标按钮以及 modal 关闭按钮大多已通过 44px coarse-pointer 规则、可见焦点和正确 label 处理；问题集中在少数直接实现的 text/icon button。
- StatsDashboard 已区分首次加载、失败、陈旧数据并提供重试；ActivityStream 也有空状态折叠和 reduced-motion/coarse-pointer 的显式暂停入口。
- 服务条款与隐私政策的 CJK 正文、列表和底部链接在 320px 宽度可自然换行，未发现不可滚动表格、长 URL 或固定宽度导致的裁剪。
