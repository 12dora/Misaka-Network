# 04 · ACGN 页

世界观/致敬页。视觉规范见 [01-design-system.md](01-design-system.md)，钴蓝海报美学推到最浓。

## 页面结构

```
Hero        立绘 + 字标 + 长副标（复用首页 FirstFold 构图）
Section 1   关于御坂网络 / みさかネットワークについて
Section 2   实验体档案 / 実験体ファイル
Section 3   彩蛋功能 / おまけ機能
Footer      致敬声明
```

Section 间用一条 `2px var(--accent-cyan)` 短光线（120px 宽）+ `kanji-block` 章号分割。

## Hero

复用首页 FirstFold：左立绘 + 右字标。但右下不放 LoginCard，改为长副标 + 两颗按钮：
```
─── 连接全部御坂妹妹的脑量子波共享网络 ───
─── 全ての御坂妹妹を繋ぐ脳量子波ネットワーク ───
[前往首页]  [立即接入]
```

副标使用 `var(--font-display-jp)` 明朝、line-height 1.8。

## Section 1 · 关于御坂网络

`kanji-block`「設」+ 标题 + 假名副标。

白卡片容器（最大宽 880px 居中），dropcap「御」用放大版 kanji-block。

正文 `var(--font-body)` 16px、行距 1.85、`--text-on-white`。关键词「脑量子波 / 实验体 / 分布式」用 `--accent-cyan` 高亮。

文案：
> 御坂网络是连接全部御坂妹妹的脑量子波共享网络。在《某科学的超电磁炮》设定中，约 20,000 名御坂妹妹（实验体）通过脑量子波互联，形成分布式意识网络。每个妹妹既是独立个体，又能共享视觉、记忆、知识。本 APP 借用这一设定作为美学骨架，构建 P2P 文件传输工具：每位用户都是一个「节点」，节点之间通过加密信道直接共享数据。

## Section 2 · 实验体档案

`kanji-block`「体」+ 标题。卡片网格桌面 2 列、移动 1 列。

每张档案卡（白底圆角 + 描边 + 软阴影）：
- 上半 60%：钴蓝渐变背景 (`linear-gradient(180deg, var(--bg-soft), var(--bg-primary))`) + SVG 抽象图形/剪影（**避免使用未授权官方立绘**）
- 下半：kanji-block 编号 + 中文名 + 假名 + 称号标签 + 简介

数据写在 `client/src/data/lore.ts`：
- **御坂美琴**（原型）— 电击使、超电磁炮、学园都市第三位 LV5、御坂妹妹 DNA 提供者
- **御坂 10032 号** — 青蛙玩偶持有者、最为人熟知的个体、「这种事情，御坂如此问道」
- **Last Order（御坂 20001 号）** — 管制人格、网络管理者、「咪萨咖咪萨咖～」
- **打止细节** — 新接入者时显示「检测到新实验体，最新编号已更新」

## Section 3 · 彩蛋功能

`kanji-block`「戯」+ 标题。三张白卡横向排列：

**3.1 妹妹语录生成器**
- 引文 `var(--font-display-jp)` 明朝 20px line-height 1.7
- 「」装饰加大显示
- 白底胶囊「重新生成」+ 旋转 icon

**3.2 实验体编号查询**
- 编号输入框（同首页登录卡片样式）+ 「查询」按钮
- 查询结果区背景 `--surface-tint`
- 有原著记录的编号（9982/10031/10032/19090/20001 等）→ 真实设定
- 其他编号 → 随机生成符合人设的描述（lore.ts 模板池）

**3.3 网络日志**（伪事件流）
- 日期 mono；每行进入时左侧出现 `--accent-cyan` 圆点
- 列表自动循环滚动（30s 周期，hover 暂停）

## Footer · 致敬声明

固定底部，`--bg-deep` 背景白字。大号 `kanji-block`「敬」居中。

```
御坂网络 / MISAKA NETWORK · 粉丝作品
みさかネットワーク · ファン制作

本作品致敬 镰池和马、冬川基 的原作
《某科学的超电磁炮》/ A Certain Scientific Railgun / とある科学の超電磁砲

· 非商业用途  · 不存储用户文件  · 所有版权归原作者所有

GitHub · 反馈 · 服务条款 · 隐私政策
```

字体 `var(--font-display-jp)` 明朝、行距宽松。底部链接用白色胶囊小按钮。

## 实现要点

- 静态页面，无后端
- 彩蛋内容在 `client/src/data/lore.ts`
- 角色立绘 MVP 用 SVG 抽象图防版权
- TopNav `[ACGN]` 在锚定到对应 section 时显示 active 下划线
- Section 进入视口触发卡片淡入 + 上移 12px（IntersectionObserver）

## 路由

`/acgn`（锚点 `#about` `#characters` `#easter-eggs` `#credits`）
