# 01 · 设计系统

## 视觉风格

**和风海报美学**：钴蓝大背景 + 御坂美琴整身立绘 + 中日混排字标 + 白色卡片。**不**走赛博暗黑终端方向（无辉光、无扫描线、无 glitch、无机能字体）。

参考样图：
- [home-page-sample.jpg](../sample/home-page-sample.jpg) — 首页构图
- [misaka.webp](../../client/public/assets/misaka.webp) — 立绘（生产资产）
- [misaka-text.webp](../sample/misaka-text.webp) — 字标

## 配色

```css
/* 背景 */
--bg-primary:    #1A4FC4;   /* 钴蓝主背景 */
--bg-deep:       #0E2A6B;   /* 深海军蓝（强调块/描边） */
--bg-soft:       #2A63D8;   /* 悬浮态 */

/* 前景 */
--surface:       #FFFFFF;
--surface-cream: #F5EFE6;   /* 米白（草帽/缎带） */
--surface-tint:  #EAF1FF;   /* 极淡蓝（次级容器） */

/* 强调 */
--accent-cyan:   #5BB3FF;   /* 链接/进度条高光 */
--accent-ribbon: #E8C5C0;   /* 缎带粉，谨慎使用 */

/* 状态 */
--state-success: #00C28A;
--state-warn:    #FFB23D;
--state-danger:  #FF5670;

/* 文字 */
--text-on-blue:    #FFFFFF;
--text-on-blue-2:  #C7DBFF;
--text-on-white:   #0E2A6B;
--text-on-white-2: #4A5A85;
--text-muted:      #8FA3CC;

/* 线与影 */
--border-card:   #D6E0F2;
--border-strong: #0E2A6B;
--shadow-card:   0 10px 30px -12px rgba(14,42,107,0.25);
--shadow-float:  0 20px 50px -20px rgba(14,42,107,0.35);
```

## 字体

```css
--font-display-jp:    'Shippori Mincho', 'Noto Serif JP', serif;        /* 明朝平假名/装饰 */
--font-display-kanji: 'Noto Sans JP', 'Noto Sans SC', sans-serif;       /* 黑体汉字/标题 */
--font-body:          'Noto Sans SC', 'Noto Sans JP', system-ui, sans-serif;
--font-mono:          'IBM Plex Mono', 'Roboto Mono', monospace;
```

- 字标用明朝 + 黑体混排
- 正文 400/500，标题 700
- 数字 `font-variant-numeric: tabular-nums`

## 签名视觉单元

### 1. 海报式双栏构图
首页/ACGN Hero：左 ~44% 整身立绘出血、右侧白色胶囊导航 + 字标 + 卡片。

### 2. 钴蓝大色块背景
全站固定 `--bg-primary`，不用渐变。允许叠加 1% 白色十字网格点。

### 3. 字标块 (KanjiBlock)
深海军蓝实心方块嵌反白汉字，复用于 Logo、section 角章、强调标签。

```css
.kanji-block {
  display: inline-grid; place-items: center;
  width: 1.2em; height: 1.2em;
  background: var(--bg-deep);
  color: var(--surface);
  font-family: var(--font-display-kanji);
  font-weight: 800; line-height: 1;
}
```

### 4. Furigana 假名注音
所有中文标题/节点编号下方允许加日文假名小字。用 `<ruby><rt>` 或 `var(--font-display-jp)` 12-13px。

### 5. 白色胶囊导航
```css
.nav-pill {
  background: var(--surface); color: var(--text-on-white);
  border-radius: 9999px; padding: .6rem 1.6rem;
  font-weight: 600; box-shadow: var(--shadow-card);
}
.nav-pill[aria-current="page"] { background: var(--bg-deep); color: var(--surface); }
.nav-pill:hover { transform: translateY(-2px); box-shadow: var(--shadow-float); }
```

### 6. 白色卡片
白底 + 16~20px 圆角 + 1px `--border-card` 描边 + `--shadow-card`。**不**用毛玻璃（顶栏除外）、**不**用辉光。

### 7. 角框 (Corner Frame)
4 个 L 形 12px 短线，`--bg-deep` 颜色，用于关键展示区。

## 术语对照表（世界观文案，严格使用）

| 通用 | 御坂网络 |
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

## 组件库基线（前缀 `Misaka-`）

- `MisakaCard` — 白底圆角卡片
- `MisakaButton` — `primary`（深海军蓝实底白字）/ `pill`（白底胶囊）/ `ghost`（透明 + 白描边，置于钴蓝上）
- `MisakaInput` — 白底 + 细蓝描边，聚焦时描边变深海军蓝
- `MisakaKanjiBlock`、`MisakaFurigana`
- `MisakaQRCode` — 白底圆角 + 深海军蓝二维码 + 角框 + 中心「御」字章
- `MisakaProgressBar` — 钴蓝→亮青蓝渐变填充 + 头部亮带
- `MisakaStatusBadge` — 圆点 + 文字
- `MisakaTitleLockup` — 封装字标资源使用

## 动效

- **立绘微浮动**：4s 周期 ±6px ease-in-out
- **字标入场**：fade-in + 微缩放 1.05→1.0（1.2s）
- **按钮 hover**：`translateY(-2px)` + 阴影加深，**不**发光
- **卡片入场**：下方 12px 淡入，stagger 80ms
- **进度条**：渐变填充 + 1px 亮带（平面光，非辉光）

## 响应式断点

```css
--bp-mobile: 640px; --bp-tablet: 768px; --bp-desktop: 1024px; --bp-wide: 1280px;
```

- 桌面：双栏海报
- 平板：立绘缩为右下角装饰
- 移动：立绘变页眉装饰，全屏垂直流

## 资源路径

实施时复制（不移动）`docs/sample/` 资源到 `client/public/assets/`：

```ts
export const HERO_CHARACTER = '/assets/misaka.webp';
export const HERO_TITLE     = '/assets/misaka-title.webp';
```

v3+ 可改 SVG/字体复刻字标。
