# 01 · 设计系统

## 视觉风格

赛博朋克 + 科幻军用终端 + 学园都市冷峻感。

## 配色

```css
--bg-primary:    #0a0e1a;   /* 主背景 */
--bg-secondary:  #131829;   /* 卡片背景 */
--bg-tertiary:   #1c2238;   /* 悬浮态 */

--accent-arc:    #00d4ff;   /* 电弧蓝（主色） */
--accent-volt:   #4dffea;   /* 电压青 */
--accent-warn:   #ff6b3d;   /* 橙红警告 */
--accent-success:#00ff88;   /* 同步成功 */
--accent-danger: #ff3366;   /* 错误/中断 */

--text-primary:  #e8ecf4;
--text-secondary:#8b95b0;
--text-muted:    #4a5273;

--border-line:   #2a3454;
--border-glow:   #00d4ff33; /* 带辉光的边框 */
```

## 字体

```css
--font-display: 'Orbitron', 'Rajdhani', sans-serif;  /* 标题/数字 */
--font-mono:    'JetBrains Mono', 'Fira Code', monospace; /* 代码/数据 */
--font-body:    'Inter', 'Noto Sans SC', sans-serif; /* 正文 */
```

## 关键视觉元素

- **扫描线效果**：背景叠加 1% 透明的水平扫描线
- **辉光边框**：聚焦/激活状态用 box-shadow 营造电弧辉光
- **等宽数字**：所有数据用 tabular-nums
- **粒子流动**：传输中的连接线显示流动光点
- **故障文字效果（glitch）**：错误状态偶尔出现 RGB 错位

## 术语对照表（必须严格使用）

| 通用术语 | 御坂网络术语 |
|---|---|
| 用户 | 实验体 / 节点 |
| 用户 ID | 节点编号（御坂XXX号） |
| 密码 | 通行码 |
| 登录 | 接入网络 |
| 退出 | 断开连接 / 通信终止 |
| 在线 | 脑波同步中 |
| 离线 | 通信终止 |
| 在线用户数 | 在线实验体数 / 人格连接数 |
| 文件传输 | 数据流注入 / 脑波同步 |
| 传输总数 | 累计脑波同步次数 |
| 文件总量 | 累计数据通量 |
| 进行中传输 | 活跃信道 / 量子纠缠链路 |
| 服务器负载 | 树形图运算负荷 |
| 加密 | 脑量子波加密 |
| 黑名单 | 屏蔽人格 |
| 举报 | 上报至树形图设计者 |
| 局域网 | 直接信道 |
| STUN 穿透 | 标准信道 |
| TURN 中继 | 中继信道 |
| WebSocket 降级 | 备用信道 |
| 错误 | 检测到脑量子波干扰 |
| 连接成功 | 人格连接已建立 |
| 系统/应用 | 树形图（Tree Diagram） |
| 房间/Channel | 实验批次 |
| 房间码 | 批次代号 |

## 组件库基线

所有自定义组件统一前缀 `Misaka-`，例如：
- `MisakaCard`
- `MisakaButton`
- `MisakaInput`
- `MisakaQRCode`
- `MisakaProgressBar`
- `MisakaStatusBadge`

## 动效原则

- 充能动效：电磁炮蓄能（按钮点击 → 边框光从中心向外辐射）
- 同步动效：脑波同步进度条（流动光带）
- 错误动效：故障跳动（轻微抖动 + RGB 分离）
- 接入动效：节点淡入 + 辐射波纹

## 响应式断点

```css
--bp-mobile:  640px;
--bp-tablet:  768px;
--bp-desktop: 1024px;
--bp-wide:    1280px;
```

移动端：网络页改为单列垂直布局（节点列表 → 传输区 → 任务面板）。
