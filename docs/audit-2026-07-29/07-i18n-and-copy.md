# 御坂网络 zh-CN 与用户文案审计

## 摘要

- 发现 1 项 P1：登录卡片把服务端的“30 分钟绝对会话时限”说成“30 分钟无活动后释放”。持续操作不会续期，当前文案直接违背 `SECURITY-001` 会话契约。
- 传输链路仍会把 `STORAGE_QUOTA_EXCEEDED`、Worker/加密异常、`HTTP 429` 等内部文本原样写入聊天、任务卡或 Toast；底层细节既不中文化，也没有给出恢复动作。
- 离线页、404 页、PWA 名称、无障碍名称、ACGN 页面和二维码相关控件仍有英文、日文或裸缩写；下文给出逐项替换表。
- 普通网络页直接展示 session id 后缀、STUN/TURN/WS、ICE、DTLS、AES-GCM、NAT、TTL 等实现概念；技术细节应保留在显式“技术诊断”区域或控制台，而不是主流程。
- “实验体 / 节点 / 设备 / 对端”及“信道 / 连接”在同一任务流中混用；按 IP 限额的弹窗还把共享公网 IP 错称为“本机”。
- 文案散落在页面、Store、底层库、Service Worker 及服务端事件字符串中；无需引入 i18n 框架，但应建立单一 zh-CN copy 模块、页面元数据表和结构化错误映射。

## 发现

### [P1] 会话时限文案与“绝对 30 分钟”硬契约相反

- 位置: `client/src/components/features/LoginCard.tsx:370`，`server/src/config.ts:96`，`server/src/http.ts:300`
- 证据:

```ts
// client/src/components/features/LoginCard.tsx
<p className="text-[10px] text-[var(--text-on-white-2)] text-center mt-3 font-kanji">
  ⓘ 30 分钟无活动会话自动释放
</p>

// server/src/http.ts
// and enforce. Absolute, never extended by reconnects.
expiresAt: now + SESSION_TTL_MS,
```

- 影响: 用户在第 29 分钟仍持续聊天或传输时，会根据“无活动”理解为会话仍会续期；实际上服务端在注册时一次性写入 `expiresAt`，第 30 分钟后的下一条 WS 消息会触发 `SESSION_EXPIRED`，客户端按既有 4002 鉴权失效路径清会话并重新注册。用户会遭遇未预期的连接重建，进行中的会话上下文也可能被重置。该行为由 `SECURITY-001` 和 `server/tests/session-expiry.test.mjs` 固化，不应为迁就文案而改成滑动过期。
- 建议: 只改文案为“会话自接入起有效 30 分钟，到期后会自动重新接入；连接可能短暂中断。”；保留 `authedFetch` 的单次 401 重试及 WS 4001/4002 → `onAuthInvalid` 契约。新增登录卡片文案单测，并保持 `server/tests/session-expiry.test.mjs` 不变。

### [P2] 底层异常、HTTP 状态和内部错误码会原样进入用户界面

- 位置: `client/src/store/network.ts:2084`，`client/src/pages/Network.tsx:757`，`client/src/lib/transfer.ts:1985`，`client/src/components/features/QRModal.tsx:74`
- 证据:

```ts
transfers: s.transfers.map(t =>
  t.id === transferId ? { ...t, status: 'failed' as const, error: String(e) } : t,
),
appendSystemChat(peerSessionId, `发送失败：${displayName} · ${String((e as Error).message ?? e)}`, 'sent')

export function humanizeError(error: Error | string, channelType?: string): string {
  const msg = typeof error === 'string' ? error : error.message
  // ...
  return msg || '传输失败，请检查网络连接后重试'
}
```

- 影响: 浏览器存储写满时，`StorageQuotaExceededError` 在 `client/src/lib/transfer.ts:2029` 产生 `STORAGE_QUOTA_EXCEEDED`，随后由 `client/src/store/network.ts:3317-3322` 写入任务卡和聊天；加密 Worker 崩溃时会显示 `crypto worker crashed: ...`；复制接入链接遇到限流时，`client/src/pages/Network.tsx:958-972` 会显示 `复制失败：Error: HTTP 429`；QR 弹窗则直接显示 `QR 令牌获取失败（HTTP 429）`。这些是可复现的具体状态，却没有告诉用户释放存储空间、重试或等待限流窗口。
- 建议: 定义稳定的 `UserFacingErrorCode`（如 `storage-full`、`connection-lost`、`encryption-failed`、`rate-limited`、`session-expired`），Store 只保存 code 与可选 `detail`；统一 `toUserMessage(code, context)` 输出行动导向文案。建议对应文案为“设备存储空间不足，请清理空间后重试”“连接已中断，请重新连接后重试”“安全连接建立失败，请重新连接”“操作过于频繁，请稍后再试”。原始异常、HTTP 状态和 Worker 文本只写 `console`，或放进用户主动展开的“技术详情”。为每个 code 补一条映射单测，尤其覆盖存储满和 429。

### [P2] 仍有英文、日文及裸标识符直接面向 zh-CN 用户

- 位置: `client/public/404.html:5`，`client/public/sw.js:74`，`client/src/components/ui/MisakaHeroTitle.tsx:13`，`client/src/data/lore.ts:31`
- 证据:

```html
<title>MISAKA NETWORK</title>
...
<a href="%BASE_URL%">Go to MISAKA NETWORK</a>
```

```ts
return new Response('Offline', { status: 503, statusText: 'Offline' })
```

- 影响: 404 回退、断网响应、PWA 安装面板、导航、读屏名称、二维码流程和 ACGN 内容会在同一 zh-CN 产品中切换到英文或日文；其中 `Offline` 会在离线导航失败时成为整个响应正文，读屏用户还会听到日文 `aria-label`。
- 建议: 按下表替换；品牌或第三方专名可保留原名，但必须补充中文用途。日文装饰若确属视觉品牌，应从可访问名称与功能文案中移除，仅作为 `aria-hidden` 装饰存在。

| file:line | 当前文案 | 建议文案 | 理由 |
|---|---|---|---|
| `client/index.html:10` | `御坂网络 · MISAKA NETWORK` | `御坂网络` | 浏览器标题的英文副标题没有提供额外信息。 |
| `client/index.html:11`、`client/public/manifest.webmanifest:4` | `零注册、强隐私、跨设备的 P2P 文件传输网络` | `无需注册、注重隐私、可跨设备使用的点对点文件传输工具` | 将缩写改为自然中文，并避免“强隐私”这种生硬组合。 |
| `client/public/manifest.webmanifest:2` | `御坂网络 Misaka Network` | `御坂网络` | 该值会进入系统安装确认和应用列表。 |
| `client/public/404.html:5` | `MISAKA NETWORK` | `御坂网络` | 404 页签仍为全英文。 |
| `client/public/404.html:25` | `Go to MISAKA NETWORK` | `前往御坂网络` | 这是构建脚本未执行或跳转被阻止时可见的唯一操作。 |
| `client/public/sw.js:74,91` | `Offline` | `当前处于离线状态，无法加载此内容。恢复网络后请重试。` | 离线失败时会作为响应正文直接展示。 |
| `client/src/components/layout/TopNav.tsx:14` | `ACGN` | `作品设定` | 裸分类缩写无法说明页面内容。 |
| `client/src/components/layout/TopNav.tsx:139` | `MISAKA NETWORK` | `御坂网络` | 与上方中文品牌重复，且造成语言混排。 |
| `client/src/components/ui/AppFooter.tsx:15`、`client/src/components/features/SettingsModal.tsx:668` | `© Master Huang · Misaka Network` | `© 黄老师 · 御坂网络` | 页脚和关于页应使用同一中文署名；若 `Master Huang` 是不可翻译的公开署名，则至少改为 `御坂网络 · 作者：Master Huang`。 |
| `client/src/components/ui/AppFooter.tsx:23`、`client/src/components/features/SettingsModal.tsx:680` | `GitHub` | `查看源代码（GitHub）` | 保留专名，但补足链接动作。 |
| `client/src/components/ui/MisakaHeroTitle.tsx:13` | `とある科学 御坂网络` | `某科学的御坂网络` | 这是图片的读屏名称，不应让 zh-CN 读屏突然切换日语。 |
| `client/src/pages/ACGN.tsx:31` | `実験体ファイル` | `实验体档案` | 日文副标题与中文主标题重复。 |
| `client/src/pages/ACGN.tsx:110` | `おまけ機能` | `彩蛋功能` | 同上。 |
| `client/src/pages/ACGN.tsx:229` | `タイムライン` | `时间线` | 同上。 |
| `client/src/pages/ACGN.tsx:377` | `みさかネットワークについて` | `关于御坂网络` | 同上。 |
| `client/src/pages/ACGN.tsx:308,353` | `全ての御坂妹妹を繋ぐ脳量子波ネットワーク` | 删除该重复日文行，或改为 `连接所有御坂妹妹的脑量子波共享网络` | 同一屏已经紧邻显示中文版本。 |
| `client/src/data/lore.ts:51,60,69,78` | `みさか…`、`ラストオーダー…` | 删除日文注音，或提供中文读音说明 | 这些字段在角色卡右上角直接渲染。 |
| `client/src/data/lore.ts:31,68,88,131` | `Last Order` | `最后之作` | 同一角色在中文内容中反复保留英文名。 |
| `client/src/data/lore.ts:53` | `LV5`、`DNA` | `等级 5`、`遗传信息` | 角色介绍没有必要使用英文等级和生物学缩写。 |
| `client/src/data/lore.ts:85-91,97,102,107` | `20XX/...`、`20XX 春/夏/秋` | `20××年…` | 裸英文占位符应改为中文年份写法。 |
| `client/src/data/lore.ts:111-113` | `P2P 映射`、`NOW`、`DataChannel` | `点对点映射`、`现在`、`加密数据通道` | 三个裸技术标识会一起出现在时间线卡片。 |
| `client/src/pages/ACGN.tsx:393` | `本 APP ... P2P 文件传输工具` | `本应用…点对点文件传输工具` | `APP`、`P2P` 均可自然中文化。 |
| `client/src/components/features/LoginCard.tsx:162,361` | `显示 QR`、`QR 接入` | `显示二维码`、`二维码接入` | 二维码是成熟中文术语。 |
| `client/src/components/features/QRModal.tsx:74,80,115,156-164,193,203,253,327` | `QR 令牌…`、`节点 QR`、`我的接入 QR`、`接入 QR`、`刷新 QR` | `二维码凭证…`、`节点二维码`、`我的接入二维码`、`接入二维码`、`刷新二维码` | 同一弹窗内应完整中文化，并把“令牌”改为用户可理解的“凭证”。 |
| `client/src/components/features/ScanModal.tsx:281,305` | `扫描节点 QR` | `扫描节点二维码` | 弹窗标题和可访问名称都会使用该字符串。 |
| `client/src/components/features/ScanModal.tsx:29,114,119` | `摄像头 API`、`需要 HTTPS 或 localhost 才能使用摄像头` | `摄像头功能`、`需要安全连接（HTTPS）或本机开发地址才能使用摄像头` | 普通错误提示不应只给 API/localhost 裸术语；HTTPS 作为必要条件可保留并加中文解释。 |
| `client/src/pages/Join.tsx:46,86,184` | `无效的 QR 链接`、`QR 码已过期…`、`正在验证 QR 链接` | `无效的二维码链接`、`二维码已过期…`、`正在验证二维码链接` | 扫码落地页仍混用缩写。 |
| `client/src/components/layout/TopNav.tsx:199,339`、`client/src/pages/Network.tsx:92,94,802` | `我的 QR`、`显示我的 QR`、`QR` | `我的二维码`、`显示我的二维码`、`二维码` | 桌面、移动导航和网络空状态均会显示。 |
| `client/src/components/features/ScanModal.tsx:379` | `https://…/join?type=node&id=…` | `粘贴本站生成的接入链接` | 普通用户不需要理解路由和查询参数名。 |
| `client/src/pages/Privacy.tsx:18`、`client/src/pages/Terms.tsx:18` | `Misaka Network` | `御坂网络` | 法律页面已给出中文全名，英文重复无必要。 |
| `client/src/pages/Network.tsx:30` | `${m}m ${s}s` | `${m} 分钟 ${s} 秒` | 连接时长是主界面信息，不应使用裸英文单位。 |
| `client/src/components/features/StatsDashboard.tsx:18,25-28` | `${h}h ${m}m`、`${d}d ${h}h` | `${h} 小时 ${m} 分钟`、`${d} 天 ${h} 小时` | 统计卡的时长单位应遵循 zh-CN。 |

### [P2] 主流程向普通用户暴露协议、候选、后端和会话标识

- 位置: `client/src/pages/Network.tsx:23`，`client/src/pages/Network.tsx:541`，`client/src/components/features/SettingsModal.tsx:416`，`client/src/pages/Privacy.tsx:65`
- 证据:

```tsx
function channelLabel(t: Peer['channelType']) {
  return { direct: '直接信道（局域网）', stun: '标准信道（STUN）', relay: '中继信道（TURN）', ws: '备用信道（WS）' }[t]
}
...
{channelLabel(selectedPeer.channelType)} · DTLS + AES-GCM
...
ICE 路径：{selectedPeer.icePath}
```

- 影响: 用户选择一个设备后会立即看到 session id 后四位、STUN/TURN/WS、DTLS、AES-GCM 和 ICE 路径；网络检测又显示 `srflx`、`IPv6-only`、TTL 等词。普通用户无法据此采取行动，反而会把“重新协商”“候选”“公网映射”理解为故障。复制诊断还包含原始 `peer.status`，技术状态与中文状态文案形成两套口径。
- 建议: 主流程只显示结果与动作；技术值保留在默认折叠的“技术诊断”面板和控制台。具体替换如下。

| file:line | 当前文案 | 建议文案 | 技术细节保留位置 |
|---|---|---|---|
| `client/src/pages/Network.tsx:24` | `直接信道（局域网） / 标准信道（STUN） / 中继信道（TURN） / 备用信道（WS）` | `局域网直连 / 互联网直连 / 服务器协助连接 / 临时备用连接` | 折叠诊断中显示原始 channel type。 |
| `client/src/pages/Network.tsx:136,543` | `#${sessionId.slice(-4)}` | 默认隐藏；同编号多设备时显示 `设备 1 / 设备 2` | 诊断中保留完整 session id，并提供复制按钮。 |
| `client/src/pages/Network.tsx:546` | `DTLS + AES-GCM` | `端到端加密` | “技术诊断”中列出算法。 |
| `client/src/pages/Network.tsx:551-558` | `ICE 路径 / 采集时间 / 复制诊断` | 主卡仅显示 `连接方式`；将三项移入 `技术诊断` | 当前复制内容可原样保留在诊断区。 |
| `client/src/pages/Network.tsx:566` | `正在尝试重新协商连接…` | `正在恢复连接…` | 控制台记录协商阶段。 |
| `client/src/pages/Network.tsx:579,864` | `开启 TURN 中继`、`对称 NAT 且 TURN 中继不可用` | `打开“服务器协助连接”`、`当前网络可能阻止设备直连，请打开服务器协助连接。` | 设置的高级诊断中显示 NAT/TURN 判定。 |
| `client/src/components/features/SettingsModal.tsx:20-29` | `开放（无 NAT）`、`锥型 NAT（IPv6）`、`对称 NAT（需 TURN）`、`UDP 受限` | `可直接连接`、`仅支持新式网络地址`、`需要服务器协助`、`网络限制较严格` | 结果下方的可展开详情显示 NAT/IPv6/UDP。 |
| `client/src/lib/nat-classify.ts:101,122,139,146` | `srflx 候选`、`STUN`、`IPv6-only`、`P2P 直连` | `没有发现可用的公网连接路径`、`网络为仅 IPv6 环境`、`可直接连接` | 原始候选类型和映射数只进诊断详情。 |
| `client/src/components/features/SettingsModal.tsx:420-421` | `${seconds}s · TTL ${ttl}s` | `剩余 ${seconds} 秒 · 有效期 ${ttl} 秒` | 无需额外展示 TTL 缩写。 |
| `client/src/components/features/SettingsModal.tsx:482-620` | `TURN` 开关、强制中继、`turn:`/`turns:` 地址、用户名、密码 | 主设置只保留 `服务器协助连接` 开关；手工服务器表单放入 `高级设置` | 高级设置保留 URL、协议和测试结果。 |
| `client/src/components/features/SettingsModal.tsx:119`、`client/src/lib/turn.ts:317-319` | `WebRTC`、`TURN 诊断`、`端到端测试模式` | `浏览器的设备直连功能`、`服务器协助连接测试`、`自动测试环境` | 控制台/详情中保留 WebRTC、TURN 和测试 code。 |
| `client/src/pages/Privacy.tsx:23-26,44` | `scrypt / HMAC-SHA-256 / IP / TURN` | 主文写“经加盐保护的通行码验证值、不可直接还原的身份标识、网络地址和中继使用记录” | 法律页的“技术详情/术语表”保留算法名和字段名。 |
| `client/src/pages/Privacy.tsx:51-59` | `Cloudflare Realtime TURN / P2P / DTLS / WebRTC / AES-GCM-256` | 主文写“第三方中继服务可能处理加密流量；文件内容仍受端到端加密保护” | 第三方名称和算法放在紧邻的技术详情中，不能从隐私披露中删除。 |
| `client/src/pages/Privacy.tsx:65-68` | `sessionStorage / localStorage / IndexedDB / OPFS` | `浏览器会在本机保存身份、设置、传输进度和临时文件。` | 同段增加“技术详情”列出各后端，法律精确信息不删除。 |
| `client/src/pages/Terms.tsx:18,24,37` | `P2P / SLA / WebRTC / TURN / Cloudflare / IP` | 主文分别写“点对点”“可用性承诺”“浏览器直连”“服务器协助连接”“Cloudflare 中继服务”“网络地址” | 用定义后的中文术语行文；第三方专名可保留，技术缩写放术语表。 |
| `client/src/lib/transfer.ts:1185` | `内存接收上限…Chrome / Edge…Firefox 111+…流式落盘` | `这个文件超出当前浏览器可安全接收的大小。请更新浏览器、改用其他现代浏览器，或让对方发送较小文件。` | 详情中保留上限字节数和实际 backend。 |
| `client/src/lib/transfer.ts:274-313`、`client/src/store/network.ts:3563` | `传输 ID / 短 ID / 分片数量 / 传输元数据` | `对方发来的文件信息无效，已拒绝接收。请让对方重新发送。` | `validated.code` 和原始计数只写控制台。 |

### [P2] IP 限额弹窗把共享公网 IP 错说成“本机”

- 位置: `server/src/http.ts:247`，`client/src/components/features/IpFullPrompt.tsx:49`
- 证据:

```ts
if (countNodesByIp(ip) >= MAX_NODES_PER_IP) {
  res.status(429).json({ error: 'IP_LIMITED', message: '此 IP 地址节点数已达上限' })
}
```

```tsx
title="本机节点已满"
...
本机 IP 同时最多允许 10 个节点。
```

- 影响: 公司、宿舍、家庭路由器或运营商 CGNAT 下，多台设备会共享一个服务端可见 IP。第 11 台设备触发限额时，弹窗却断言“本机节点已满”，用户会错误地在当前设备上排查标签页或本地数据；实际占用可能来自同一公网出口的其他设备。
- 建议: 标题改为“当前网络的接入名额已满”，说明改为“此网络出口当前最多允许 10 个在线节点。验证节点编号与通行码后，只会释放同一身份的会话。”不要暴露或暗示服务端看到的是设备本机 IP。同步更新 `client/tests/unit/ip-full-prompt-semantics.test.tsx`，继续保留“只释放同一身份”和零释放不重试的既有断言。

### [P2] 所有路由共用同一文档标题，404 文档还未声明 zh-CN

- 位置: `client/index.html:2`，`client/index.html:10`，`client/src/App.tsx:140`，`client/public/404.html:2`
- 证据:

```tsx
<Routes location={location}>
  <Route path="/" element={<Home />} />
  <Route path="/join" element={<Join />} />
  <Route path="/network" element={<ProtectedRoute><Network /></ProtectedRoute>} />
  <Route path="/acgn" element={<ACGN />} />
  <Route path="/tos" element={<Terms />} />
  <Route path="/privacy" element={<Privacy />} />
</Routes>
```

- 影响: `/network`、`/privacy`、`/tos`、`/join` 等页面的浏览器标签、历史记录、书签及读屏页面标题全部只是静态 `御坂网络 · MISAKA NETWORK`，多个标签无法区分；404 文档的 `<html>` 没有 `lang`，其唯一英文链接会被读屏按未知语言处理。
- 建议: 建立 `pageMeta` 路由表，例如 `网络 · 御坂网络`、`隐私政策 · 御坂网络`、`服务条款 · 御坂网络`、`接入设备 · 御坂网络`，在路由切换时同步 `document.title`；404 页添加 `<html lang="zh-CN">` 并使用中文标题/链接。增加路由标题单测及 `client/tests/ui-contract.test.mjs` 的静态检查。

### [P2] 功能页面对同一实体和状态使用“实验体 / 节点 / 设备 / 对端”等不同名称

- 位置: `client/src/pages/Network.tsx:82`，`client/src/pages/Network.tsx:88`，`client/src/components/ui/MisakaStatusBadge.tsx:14`，`server/src/ws.ts:350`
- 证据:

```tsx
发现同身份设备 · {networkStatusLabel(status)}
...
<p>网络中暂无其他实验体</p>
<p>分享 QR 或链接给另一台设备即可接入</p>
...
<p>请先在「节点」页选择目标节点</p>
```

- 影响: 新用户在同一屏会把“实验体”“设备”“节点”理解成不同对象；设置页又使用“对端”。同时，`online` 被徽标称为“脑波同步中”，`reconnecting` 被称为“重新协商中”，而页头使用“在线 / 正在重新连接”，造成状态含义不一致。服务端活动流还直接发送“御坂 N 号通信终止”，客户端原样渲染，进一步形成第五套语气。
- 建议: 功能页面以“设备”为普通用户主词，首次出现可写“设备（节点）”；“节点编号”仅指身份编号；统一使用“连接 / 正在连接 / 正在恢复连接 / 已断开 / 正在传输”。“实验体、脑波、数据流、通信终止”等世界观词只留在 ACGN 与装饰性活动流。服务端活动事件建议新增稳定 `code`，客户端按 code 生成文案；为兼容旧客户端暂时保留 `message` fallback，而不是一次性破坏 `ACTIVITY` 消息形状。

### [P2] zh-CN 文案没有单一来源，页面、Store、底层库和服务端各自拼接

- 位置: `client/src/components/features/QRModal.tsx:73`，`client/src/pages/Network.tsx:967`，`server/src/http.ts:325`，`client/src/components/features/ActivityStream.tsx:128`
- 证据:

```ts
setQrError(`QR 令牌获取失败（HTTP ${res.status}）`)
...
showToast(`复制失败：${String(e)}`)
...
broadcast({ type: 'join', nodeId, message: `御坂 ${nodeId} 号已接入网络` })
```

```tsx
<span>{event.message}</span>
```

- 影响: 同一个“获取接入二维码失败”在 QR 弹窗显示 HTTP 状态、网络页显示 `Error: HTTP ...`、Join 页又显示泛化“接入失败”；修改“QR→二维码”需要跨多个页面、Store、服务端和 PWA 文件逐个搜索。当前差异已证明散布不是未来风险，而是正在发生的用户体验分叉。
- 建议: 不必引入运行时 i18n 框架；建立以下静态结构并由组件只引用命名文案/格式化函数：

```text
client/src/copy/zh-CN/
  common.ts       # 重试、取消、关闭、复制等
  auth.ts         # 接入、通行码、会话、IP 限额
  network.ts      # 设备、连接状态、二维码
  transfer.ts     # 传输状态、错误 code → 行动文案
  settings.ts     # 普通设置与高级诊断
  pageMeta.ts     # 路由标题与描述
  index.ts
```

  插值统一用函数，例如 `copy.transfer.storageFull({ fileName })`，不要在 JSX 中拼接半句。`client/src/copy/errors.ts` 负责 `UserFacingErrorCode` 映射，原始异常保留为 `detail`。Service Worker/404/manifest 无法直接 import TS，可由构建时校验脚本比对固定常量。服务端事件采用 code + data，并在协议过渡期保留旧 `message`；相应更新 `client/src/types.ts`、WS schema 及活动流/协议测试。该建议不改变协议 v2 的 `transfer-ready/reject/repair/done` 语义、帧布局或认证重试契约。

### [P3] 中文标点、范围符号、时间单位和省略号不统一

- 位置: `client/src/components/features/LoginCard.tsx:337`，`client/src/pages/Network.tsx:244`，`client/src/pages/ACGN.tsx:101`，`client/src/components/features/StatsDashboard.tsx:14`
- 证据:

```tsx
{isLoading ? '正在接入...' : '接入网络'}
...
<span>对方:</span>
...
setQueryResult('节点编号范围为 1~20001')
```

- 影响: 同一应用同时出现 `...` 与 `…`、`:` 与 `：`、`1~20001` 与 `1–20001`；在线时长显示 `1h 5m`，连接时长显示 `1m 5s`，设置又显示 `TTL 300s`。中文界面在视觉和读屏停顿上不一致，时间单位也要求用户自行解码。
- 建议: 统一为 `……`（句末）或 `…`（短状态）、全角 `：`、范围号 `1–20001`，中文时间使用“天 / 小时 / 分钟 / 秒”；通过 copy 模块的 `formatDurationZhCN` 和 `formatRange` 复用。清理 JSX 换行造成的 `； 其他`、`信令； 文件` 等多余空格，并加一个只扫描用户文案的静态检查，避免误报代码标识符。

## 附录: 已核查但结论为无问题的区域

- 主文档 `client/index.html` 已声明 `lang="zh-CN"`；`apple-mobile-web-app-title`、manifest `short_name` 均为中文。
- `client/src/store/auth.ts` 对 `BAD_ORIGIN`、节点占用、锁定、IP 限额和网络失败均提供中文分支；未发现服务端 error code 在登录卡片中直接回显。`authedFetch` 的“一次 401 重试、二次 401 抛 `AuthRequiredError`”契约保持完整。
- `client/src/components/features/ScanModal.tsx` 已把摄像头 DOMException 名称映射为中文恢复提示，未知异常不会原样回显；`joinLink.ts` 也不会把被拒绝的原始链接回显给用户。
- `client/src/lib/turn.ts` 的 TURN 测试结果把可展示的 `message` 与原始 `detail` 分开，当前设置页只渲染本地化 `message`；这是错误呈现应复用的正确模式。
- `server/src/http.ts` 的注册、限流、网络满和活动广播消息均为中文；未渲染的 `INVALID_INPUT`、`UNAUTHORIZED` 等 code 仅用于客户端分支或协议控制。`server/src/ws.ts` 的 close reason 与 `ERROR.code` 当前只进入控制路径/控制台，没有直接进入页面。
- `client/src/lib/notify.ts` 的系统文件通知标题与正文为中文，文件名属于用户数据，不应翻译。
- 已核对协议 v2 的 `transfer-ready`、`transfer-reject`、`transfer-repair`、`transfer-done` 用户可见路径；本报告只建议替换显示层和结构化错误映射，不建议改变交付状态、所有权、bitmap 持久化顺序、`CHUNK_FRAME_TAG` 或 IV 规则。
- 依审计指令未运行测试、构建、安装，也未修改除本报告外的任何文件。
