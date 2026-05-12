# 08 · QR 扫码系统

## 三种 QR 类型

### 类型 A：节点 QR（NodeQR）

最常用。发起方分享自己的接入凭证。

**URL 格式：**
```
https://misaka.network/join?type=node&id=10032&t=<qrToken>
```

- `id`：目标节点编号
- `t`：一次性 token（5 分钟有效，单次使用）
- **通行码不放进 QR**：扫码用户需要单独询问/输入（更安全）

或者「快速模式」（用户主动开启）：
```
https://misaka.network/join?type=node&id=10032&t=<qrToken>&c=<encodedPasscode>
```
- `c`：base64 编码通行码（默认关闭，需用户在 QR 弹窗手动勾选「包含通行码」）

### 类型 B：文件 QR（FileQR）

发送方选择文件后生成一个绑定文件的 QR。

```
https://misaka.network/join?type=file&id=10032&t=<qrToken>&fid=<fileSessionId>
```

- 扫码者自动跳转 → 自动接入 → 自动收到该文件的传输请求
- QR 10 分钟有效，扫码后绑定到该文件会话

### 类型 C：批次 QR（ChannelQR）

多人共享场景。

```
https://misaka.network/join?type=channel&cid=<channelId>&t=<qrToken>
```

- 扫码者进入指定批次，自动看到批次内所有节点
- 批次最后一人离开后 30 分钟销毁

## QR 生成

```ts
// 使用 qrcode 库
import QRCode from 'qrcode';

async function generateQR(url: string): Promise<string> {
  return QRCode.toDataURL(url, {
    width: 320,
    margin: 2,
    color: {
      dark: '#00d4ff',   // 电弧蓝
      light: '#0a0e1a00', // 透明背景
    },
    errorCorrectionLevel: 'M',
  });
}
```

**视觉装饰：**
- QR 周围加扫描线动画
- 中心放小图标（御坂闪电）
- 边角加未来感装饰框

## QR 扫码

### 优先方案：BarcodeDetector API
现代浏览器原生支持，性能最好：

```ts
if ('BarcodeDetector' in window) {
  const detector = new BarcodeDetector({ formats: ['qr_code'] });
  // 从 video 帧扫描
  const codes = await detector.detect(videoElement);
}
```

### 降级方案：jsQR
当 BarcodeDetector 不可用：

```ts
import jsQR from 'jsqr';
// 从 canvas ImageData 扫描
const code = jsQR(imageData.data, imageData.width, imageData.height);
```

## 扫码 UI

```
┌──────────────────────────────┐
│  📷 扫描节点 QR              │
│                              │
│  ┌────────────────────┐      │
│  │                    │      │
│  │   [视频画面]        │      │
│  │   ┌──┐             │      │
│  │   │QR│ 扫描框      │      │
│  │   └──┘             │      │
│  │                    │      │
│  └────────────────────┘      │
│                              │
│  对准 QR 即可                │
│                              │
│  [切换摄像头]  [手电筒]  [取消]│
└──────────────────────────────┘
```

扫描动画：水平光线从上到下循环扫描扫描框。

## 扫码后流程

```
扫码成功 → 解析 URL → 
  ├─ type=node:    
  │  1. 当前未登录 → 先生成自己的身份
  │  2. 自动调用 /api/qr-redeem
  │  3. 跳转 /network 并自动发起 CONNECT_REQ
  │  4. 弹窗输入对方通行码（除非 QR 包含 c=）
  │
  ├─ type=file:    
  │  1. 同上接入流程
  │  2. 收到文件传输请求后自动弹出接收 Modal
  │
  └─ type=channel: 
     1. 接入网络
     2. JOIN_CHANNEL
     3. 跳转 /network
```

## 显示我的 QR

登录后，登录卡片下方/右上角永久显示一个小图标：
```
[🔲 我的 QR]
```

点击展开大 QR 弹窗：

```
┌─────────────────────────────────────┐
│  我的接入 QR                         │
│                                     │
│  ┌────────────┐                     │
│  │            │                     │
│  │  [QR 图]   │                     │
│  │            │                     │
│  └────────────┘                     │
│                                     │
│  御坂 10032 号                       │
│  通行码：4 8 5 2 9 1                 │
│                                     │
│  ☐ 在 QR 中包含通行码（不安全）       │
│                                     │
│  [刷新 QR]  [复制链接]  [关闭]        │
└─────────────────────────────────────┘
```

## 安全注意

- QR token 严格单次使用（服务端记录已使用 token）
- QR token 5 分钟过期
- 通行码默认不入 QR
- 文件 QR 仅授权指定文件传输，不授予完整通信权限

## 实现优先级

1. QR 生成（节点 QR）
2. 扫码（BarcodeDetector）
3. 自动接入流程
4. 文件 QR
5. 批次 QR
6. jsQR 降级
7. 视觉装饰动画
