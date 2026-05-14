# 03 · 网络页 NETWORK

登录后核心页。视觉规范见 [01-design-system.md](01-design-system.md)：钴蓝背景 + 白色卡片，禁止辉光/扫描线/glitch。

## 布局

**桌面三栏**（≥1024px）：`grid-template-columns: 1fr 2fr 1fr`，gap 24px，各栏 padding 20px。
- 左：NodeRadar（节点雷达）
- 中：TransferChannel（传输信道）
- 右：TaskPanel（任务面板）

每栏顶部一个 Section Header（`kanji-block + 中文 + 假名副标 + 短光线`）。右下角可放一个 200px 立绘剪影（opacity 0.35）。

**移动**：白色胶囊 Tab `[▪点 节点][▪同 信道][▪流 任务]` 切换，底部 96px bottom-tab `[文件][消息][QR]`。

## 1. NodeRadar

每节点 = 白色卡片（白底 16px 圆角 + 描边 + 软阴影 + 12px gap）：
- 左上 10px 状态圆点
- 节点编号 `var(--font-display-kanji)` 700 18px + 假名注音 12px
- 三行元数据：状态 / 信道类型 / 接入时长（带 kanji-block 单字章）
- 未读提示：收到消息/文件时在右上角显示未读红点计数；点击后清除

状态：
- 🟢 ONLINE `--state-success`
- 🟦 TRANSFERRING `--accent-cyan`（1s 脉冲）
- 🟨 CONNECTING `--state-warn`
- 🟥 UNAUTHORIZED `--state-danger`
- ⚪ OFFLINE `--text-muted`

选中态：卡片背景变 `--surface-tint`，左侧 4px 深海军蓝竖条。

自动打开会话：仅有 1 个在线节点时，自动选中并展开信道区（带 280ms 淡入上移动画）。

**空状态**：居中卡片，「▪空」字章 + `网络中暂无其他实验体 / 他にネットワーク参加者なし` + 描述 + `[显示我的 QR]` `[复制接入链接]`。

## 2. TransferChannel

### 模式 A：未选中节点

大型「拖拽承接区」，白底 + 2px 虚线 `--border-card` 描边。中心大 `kanji-block`「同」48px + `拖拽文件到此处 / ファイルをドロップ` + `或点击选择文件` + `请先从左侧选择目标节点`。

dragover：描边变实线 `--accent-cyan`，背景变 `--surface-tint`，整区上跳 4px。

### 模式 B：已选中节点

垂直三段：

1. **顶部信息条**（`--surface-tint` 浅蓝）：`目标节点 / 信道类型 + 加密 / 批次代号`
2. **上传按钮**：两颗大白底胶囊 `[📁 拖拽/点击选择]` `[📂 选择文件夹]`
3. **会话信道**：消息列表（左侧 `▸` 引导符、时间 mono）+ 输入框 + 发送按钮

### 模式 C：通行码验证中

居中白卡：`kanji-block`「锁」+ `御坂XXXXX号请求接入 / 接続リクエスト` + `请对方输入您的通行码以建立连接` + `[显示我的通行码]` `[取消]`。

## 3. TaskPanel

任务按状态分组（传输中 / 排队中 / 已完成 / 失败），每组前小标题（kanji-block + 中文）。

**任务卡**（白底 12px 圆角 + 描边）：
```
📤 → 御坂 15003 号
   実験報告.pdf · 12.4 MB
   ▓▓▓▓░░░░ 78%  ·  2.1 MB/s · 剩余 5s
   [⏸ 暂停]  [✕ 取消]
```

进度条：高 6px 圆角，底色 `--surface-tint`，填充 `linear-gradient(90deg, var(--bg-deep), var(--accent-cyan))`，头部 1px 亮青蓝呼吸光带。

状态颜色：
- PENDING `--text-muted`
- TRANSFERRING `--accent-cyan` + 动画
- PAUSED `--state-warn`
- COMPLETED `--state-success` → 按钮变 `[打开]` `[保存]`
- FAILED `--state-danger` → 按钮变 `[重试]` + 显示原因
- RECONNECTING `--state-warn` + stripe 动画

**续传 Banner**（顶部，检测到 IndexedDB status='active' 时）：
`⚠ 检测到 N 个中断的数据流，是否继续？` `[全部续传]` `[全部丢弃]`，底色 `--state-warn` 12% 叠加 + 描边。

## 状态管理

```ts
interface NetworkStore {
  myNode: Node;
  peers: Map<string, Peer>;
  selectedPeerId: string | null;
  transfers: Map<string, Transfer>;
  channelMessages: Message[];

  connectToPeer: (peerId: string, code: string) => Promise<void>;
  sendFile: (peerId: string, file: File) => Promise<string>;
  acceptTransfer/rejectTransfer/pauseTransfer/resumeTransfer/cancelTransfer: (id: string) => void;
}
```

## 关键交互

### 发起传输流程

```
1. 从 NodeRadar 选中节点
2. 未连接 → CONNECT_REQ，对方输入通行码
3. 连接建立 → TransferChannel 切到模式 B
4. 拖入/选择文件
5. 发送 metadata（fileName/Size/hash/totalChunks）
6. 对方收到接收确认 Modal
7. 接受 → 分片传输
```

### 接收确认 Modal

居中白卡 + 钴蓝半透明遮罩 `rgba(14,42,107,0.55)` + `blur(8px)`。

`kanji-block`「入」+ `检测到数据包传入 / データ着信検知` + 元数据列表（来源 / 文件名 / 大小 / 信道 / 哈希，左键右 mono 值）+ 三按钮：`[接收]`（主）/ `[拒绝]`（白胶囊）/ `[屏蔽来源]`（白胶囊 `--state-danger` 文字）。

### 多文件 / 文件夹

- 多文件：按队列依次传输，TaskPanel 每文件独立卡片
- 文件夹：前端 `webkitdirectory`，按相对路径打包元数据；接收端用 File System Access API 还原目录，或下载 zip

## 路由

`/network` — 未登录跳回 `/`。
