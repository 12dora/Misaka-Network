# 02 · 首页 HOME

按 [home-page-sample.jpg](../sample/home-page-sample.jpg) 的海报构图。视觉规范见 [01-design-system.md](01-design-system.md)。

## 页面分层

```
FIRSTFOLD  钴蓝海报 = 左立绘 + 右上胶囊导航 + 右中字标 + 右下登录卡片
SECOND     网络运行情报（StatsDashboard 6 卡）
THIRD      实时活动流（ActivityStream 横向滚动）
FOOTER     版权信息（作者 + GitHub）
```

全页背景 `var(--bg-primary)`。

## 1. FirstFold

桌面 ≥1024px：`grid-template-columns: 44% 1fr`，高 `min(100vh, 820px)`。

- **左栏**：立绘 [misaka.webp](../../client/public/assets/misaka.webp)，`object-position: bottom left`，底部出血，4s 上下浮动 ±6px。
- **右栏**：TopNav（吸顶）/ TitleLockup / LoginCard 三段垂直。

平板：立绘缩到右下 ~320px；移动：立绘变顶部头图 200px。

### TopNav

64px 高，左右内边距 32px。背景 `rgba(26,79,196,0.72)` + `backdrop-filter: blur(20px)`。

- 左：`MisakaKanjiBlock`「御」+ 文字 `御坂网络 / MISAKA NETWORK`
- 中：三颗胶囊 `[首页][网络][ACGN]`，当前页背景 `--bg-deep` 白字
- 右：状态指示灯（绿/灰）+ 设置按钮，登录后多一个 QR 按钮

### TitleLockup

```tsx
<img src="/assets/misaka-title.webp" alt="とある科学 御坂网络" className="title-lockup" />
```

```css
.title-lockup {
  width: clamp(280px, 32vw, 460px);
  filter: drop-shadow(0 6px 16px rgba(0,0,0,.18));
  user-select: none; pointer-events: none;
}
```

入场：fade-in + 微缩放 1.05→1.0（MVP）。v3 可改 SVG 分笔画揭示。

### LoginCard

白卡，宽 `min(420px, 100%)`，距字标 48px。padding `28px 32px`，圆角 20px，描边 + 软阴影。

**未登录态**字段：
- 节点编号：`御坂 [10032] 号` + 重新生成 ↻
- 通行码：6 位独立 input，自动跳格、支持粘贴
- 主按钮「接入网络」：`--bg-deep` 实底白字，48px 高，圆角 12px
- QR 接入：登录卡内嵌入口，打开扫码 / 粘贴链接 Modal
- 副文「ⓘ 30 分钟无活动自动释放」

**已登录态**字段：
- `✓ 已接入` + 脉冲绿点
- 节点编号 + 假名注音
- 通行码：显示/隐藏切换
- 按钮：`[📡 进入网络]`（主）/ `[🔲 显示 QR]`、`[⏏ 断开]`（白底胶囊）

输入框：白底 + `var(--border-card)` 描边，聚焦时描边变 `--bg-deep`、底部 2px `--accent-cyan` 增益线。

## 2. StatsDashboard

Section Header 模式（全站复用）：
```
[kanji-block 章] 中文标题 / 假名副标
─── 80px 短光线 ───
```

6 张白卡 3×2（平板 2 列，移动 1 列），每张：
- 左上 `MisakaKanjiBlock`（同/流/量/链/域/稳 单字章）
- 中部大数字 48px `--font-display-kanji` 700 `tabular-nums`
- 右下副标 furigana
- hover：上抬 + 数字变 `--accent-cyan`

6 项指标：
1. 在线实验体数
2. 累计脑波同步次数
3. 累计数据通量
4. 当前活跃信道
5. 节点覆盖区域
6. 最长稳定时长

底部装饰：「树形图运算负荷」进度条 6px 圆角，`linear-gradient(90deg, var(--accent-cyan), #FFFFFF)` 填充。

数据来源：`/api/stats` 每 10s 轮询。

## 3. ActivityStream

横向滚动带，92px 高，左右 64px 渐变遮罩。最近 20 条 ring buffer。

每条 = 白底胶囊徽章：`[时间 mono] [圆点] 御坂XXXXX号已接入网络`

圆点颜色：接入=`--state-success`、离线=`--text-muted`、传输=`--accent-cyan`、批次=`--state-warn`。

新事件从右滑入 300ms ease-out + 微亮一下，超出从左滑出。

实现：WebSocket 订阅 `ACTIVITY` 事件。

## 4. Footer

首页页脚统一复用 `AppFooter` 组件（与 ACGN 共用），仅保留 App 作者版权与 GitHub 链接，纵向留白为紧凑模式。

## 状态管理（Zustand）

```ts
interface HomeStore {
  stats: NetworkStats;
  activities: Activity[];
  identity: Identity | null;   // 来自 authStore
  fetchStats: () => Promise<void>;
  subscribeActivities: () => void;
}
```

## 路由

`/` — 已登录用户不强制跳转，LoginCard 切换态。

## 交互细节

- 节点编号失焦校验 1~20001 + 服务端去重
- 「重新生成」按钮：360° 旋转动画，新数字 stagger 50ms 上滚显现
- 「接入网络」点击：按钮内部由左到右扫一道 `--accent-cyan` 亮带（平面光），600ms 后跳 `/network`
- 立绘 / 字标加载：先深海军蓝 silhouette 占位，加载完淡入
