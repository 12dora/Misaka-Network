# 08 · QR 扫码系统

## 三种 QR 类型

### A. 节点 QR（NodeQR）— 最常用

```
https://misaka.network/join?type=node&id=10032&t=<qrToken>
```
- `id` 目标节点编号；`t` 一次性 token（5min 有效、单次使用）
- 通行码默认**不**入 QR；快速模式（用户主动勾选）追加 `&c=<base64Passcode>`

### B. 文件 QR（FileQR）

```
https://misaka.network/join?type=file&id=10032&t=<qrToken>&fid=<fileSessionId>
```
- 扫码者跳转 → 自动接入 → 自动收到该文件的传输请求
- QR 10min 有效，绑定到该文件会话

### C. 批次 QR（ChannelQR）— 多人共享

```
https://misaka.network/join?type=channel&cid=<channelId>&t=<qrToken>
```
- 扫码者进入指定批次
- 最后一人离开后 30min 销毁

## QR 生成

QR 图案使用**深海军蓝**绘制在**白底**上，符合 [01-design-system.md](01-design-system.md)。

```ts
import QRCode from 'qrcode';
QRCode.toDataURL(url, {
  width: 320, margin: 2,
  color: { dark: '#0E2A6B', light: '#FFFFFF' },
  errorCorrectionLevel: 'M',
});
```

视觉装饰：
- 白底圆角卡片承接（16px 圆角 + 软阴影 + 2px `--accent-cyan` 细描边）
- 四角 L 形角框（深海军蓝，16px × 3px）
- 中心 `MisakaKanjiBlock`「御」字章 28×28（避开容错区中心）
- 顶部叠 2px 钴蓝→亮青蓝平面光带，2s 周期循环（非辉光）

## QR 扫码

```ts
// 优先：BarcodeDetector API
if ('BarcodeDetector' in window) {
  const detector = new BarcodeDetector({ formats: ['qr_code'] });
  const codes = await detector.detect(videoElement);
}
// 降级：jsQR
import jsQR from 'jsqr';
const code = jsQR(imageData.data, imageData.width, imageData.height);
```

### 扫码 Modal

居中白卡 + 钴蓝遮罩 `rgba(14,42,107,0.55)` + `backdrop-filter: blur(8px)`。

- 标题 `kanji-block`「読」+ `扫描节点 QR / スキャン`
- 视频画面：圆角 12px + 白描边 + `object-fit: cover`
- 扫描框：四角深海军蓝 L 形线（无完整边框）
- 扫描光带：1 条 `--accent-cyan` 2px 平面光带，2.4s 上→下循环
- 底部：`[切换摄像头]` `[手电筒]`（白底胶囊）+ `[取消]`（文字按钮）

## 扫码后流程

```
解析 URL →
  type=node:    未登录则先生成身份 → /api/qr-redeem → 跳 /network → 发 CONNECT_REQ
                → 弹窗输通行码（除非 QR 带 c=）
  type=file:    同上接入 → 自动弹出接收 Modal
  type=channel: 接入 → JOIN_CHANNEL → 跳 /network
```

## 显示我的 QR

登录后，TopNav 右侧 + LoginCard 都有 `[🔲 我的 QR]` 白胶囊按钮。点击展开 Modal（居中白卡 + 钴蓝遮罩）：

- 标题 `kanji-block`「我」+ `我的接入 QR / わたしの QR`
- QR 图（深海军蓝 + 中心「御」字章 + 角框）
- 节点编号 + 假名注音
- 通行码：6 位 mono 大字
- 选项 `☐ 在 QR 中包含通行码（不安全）`
- 按钮 `[刷新 QR]` `[复制链接]` `[关闭]`

## 安全

- QR token 单次使用（服务端记录已用 token）
- QR token 5min 过期
- 通行码默认不入 QR
- 文件 QR 仅授权指定文件传输
