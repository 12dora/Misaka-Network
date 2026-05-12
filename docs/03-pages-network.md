# 03 · 网络页 NETWORK

登录后的核心功能页。

## 桌面布局（三栏）

```
┌────────────────────────────────────────────────────────┐
│  TopNav                                                │
├──────────────┬──────────────────────┬──────────────────┤
│              │                      │                  │
│  节点雷达    │   传输 Channel       │   传输面板        │
│  NodeRadar   │   TransferChannel    │   TaskPanel      │
│  (1/4)       │   (1/2)              │   (1/4)          │
│              │                      │                  │
└──────────────┴──────────────────────┴──────────────────┘
```

## 移动布局（垂直 Tab）

```
[节点 NODES] [传输 TRANSFER] [任务 TASKS]
─────────────────────────────────────────
当前 Tab 内容全屏显示
```

## 1. NodeRadar（节点雷达）

显示所有可见节点（同批次/同房间内）。

**节点卡片：**
```
┌──────────────────────────┐
│  ◉ 御坂 08821 号          │
│  状态：🟢 在线            │
│  信道：直接信道（局域网）  │
│  接入时长：3m 21s         │
│  [📤 发送]  [💬 消息]     │
└──────────────────────────┘
```

**节点状态：**
- 🟢 ONLINE - 已建立 WebRTC 连接
- 🟡 TRANSFERRING - 正在传输
- 🔵 CONNECTING - 协商中
- 🔴 UNAUTHORIZED - 通行码错误
- ⚪ OFFLINE - 已离线

**空状态：**
```
📡 网络中暂无其他实验体

· 邀请其他设备扫码加入
· 或在另一台设备打开御坂网络

[显示我的 QR]  [复制接入链接]
```

## 2. TransferChannel（传输区）

中央主区域，三种模式：

### 模式 A：默认（未选中节点）
```
拖拽文件到此处
或点击选择文件

请先从左侧选择目标节点
```

### 模式 B：已选中节点
```
目标：御坂 08821 号
信道类型：直接信道（局域网） · 加密强度：DTLS + AES-GCM

[拖拽文件 / 点击选择]
[选择文件夹]

──────────────────────
当前会话消息：
> [已连接] 通过房间码 ABXC42 建立连接
> 用户输入：这是给你的实验报告
> [发送] notes.pdf → 等待对方接收
──────────────────────
[消息输入框]  [发送]
```

### 模式 C：通行码验证中
```
御坂 08821 号请求接入

请对方输入您的通行码以建立连接...

[显示我的通行码]  [取消]
```

## 3. TaskPanel（任务面板）

所有传输任务列表，按状态分组。

**任务项：**
```
📤 → 御坂 15003 号
   实验报告.pdf · 12.4 MB
   ▓▓▓▓▓▓▓▓░░ 78% · 2.1 MB/s
   剩余 5s · [暂停] [取消]
```

**状态：**
- 排队中 PENDING
- 传输中 TRANSFERRING
- 已暂停 PAUSED
- 已完成 COMPLETED（成功后显示「打开/保存」）
- 已失败 FAILED（显示原因 + 重试）
- 等待重连 RECONNECTING

**断点续传提示：**
检测到中断的任务时，顶部 banner：
```
⚠ 检测到 2 个中断的数据流，是否继续？
[全部续传]  [全部丢弃]
```

## 状态管理

```ts
interface NetworkStore {
  myNode: Node;
  peers: Map<string, Peer>;           // 其他节点
  selectedPeerId: string | null;
  transfers: Map<string, Transfer>;   // 所有传输任务
  channelMessages: Message[];          // 当前 channel 文字消息
  
  connectToPeer: (peerId: string, code: string) => Promise<void>;
  sendFile: (peerId: string, file: File) => Promise<string>;
  acceptTransfer: (transferId: string) => void;
  rejectTransfer: (transferId: string) => void;
  pauseTransfer: (transferId: string) => void;
  resumeTransfer: (transferId: string) => void;
  cancelTransfer: (transferId: string) => void;
}
```

## 关键交互

### 发起传输

```
1. 用户从 NodeRadar 选中节点
2. 若未连接，先发起连接请求 → 对方输入通行码确认
3. 连接建立后，TransferChannel 切换为「模式 B」
4. 用户拖入文件 / 点击选择
5. 发送方先发 metadata（文件名、大小、hash、chunk 数）
6. 对方收到「检测到数据包传入」确认 Modal
7. 接受 → 开始分片传输
```

### 接收方确认 Modal

```
┌─────────────────────────────────────┐
│  ⚡ 检测到数据包传入                  │
│                                     │
│  来源：御坂 10032 号                 │
│  文件：实验报告.pdf                   │
│  大小：12.4 MB                       │
│  信道：直接信道（局域网）             │
│  哈希：a3f5...c821                   │
│                                     │
│  [ 接收 ]  [ 拒绝 ]  [ 屏蔽来源 ]    │
└─────────────────────────────────────┘
```

### 多文件 / 文件夹

- 多选时按队列依次传输，TaskPanel 显示每个文件独立任务
- 文件夹：前端用 webkitdirectory，按相对路径打包元数据，接收端还原目录结构（保存时用浏览器 File System Access API 或下载为 zip）

## 路由

- 路径：`/network`
- 未登录访问时跳回 `/`
