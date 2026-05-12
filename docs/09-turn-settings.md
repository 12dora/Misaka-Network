# 09 · TURN 服务器（用户自配置）

## 设计原则

- **默认禁用**：TURN 中继消耗服务器带宽，不由项目方承担
- **用户自配**：在「设置」中手动填写
- **本地存储**：TURN 配置存 localStorage，不上传服务器
- **多服务器**：支持添加多个，按顺序尝试

大多数场景同局域网（host candidate）或 STUN 穿透即可。只有对称 NAT / 严格防火墙才需要 TURN。

## 数据结构

```ts
// localStorage key: misaka.turnServers
interface TurnServer {
  id: string;
  url: string;          // turn:my-turn.example.com:3478?transport=udp
  username: string;
  credential: string;
  enabled: boolean;
  lastTested?: number;
  reachable?: boolean;
}

interface TurnSettings {
  servers: TurnServer[];
  enabled: boolean;     // 总开关
  forceRelay: boolean;  // 调试用
}
```

## 设置页 UI

设置 → 网络 → TURN 服务器：

- 顶部说明：当 STUN 穿透失败时通过中继转发流量；⚠ 中继流量消耗服务器带宽，请使用自己的 TURN
- `[+ 添加 TURN 服务器]` 按钮
- 已添加列表：每项显示地址 / 用户名 / 协议 / 状态（✓ 可达 / ✗ 不可达），`[测试]` `[编辑]` `[删除]`
- 总开关 `☐ 启用 TURN 中继`
- 调试开关 `☐ 强制使用 TURN（仅测试）`
- `📖 如何搭建自己的 TURN 服务器？` 跳帮助页

样式遵循 [01-design-system.md](01-design-system.md) 白色卡片风格。

## 添加 TURN 表单

字段：地址 / 端口 / 协议（turn / turns）/ 传输（udp / tcp）/ 用户名 / 密码

按钮：`[测试连接]` `[取消]` `[保存]`

## 连接测试

```ts
async function testTurnServer(server: TurnServer): Promise<boolean> {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: server.url, username: server.username, credential: server.credential }],
    iceTransportPolicy: 'relay',
  });
  pc.createDataChannel('test');
  await pc.setLocalDescription(await pc.createOffer());

  return new Promise(resolve => {
    const timeout = setTimeout(() => resolve(false), 5000);
    pc.onicecandidate = e => {
      if (e.candidate?.type === 'relay') {
        clearTimeout(timeout);
        pc.close();
        resolve(true);
      }
    };
  });
}
```

## 集成到 WebRTC

```ts
function getIceServers(): RTCIceServer[] {
  const base: RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ];
  const t = loadTurnSettings();
  if (!t.enabled) return base;
  return [
    ...base,
    ...t.servers.filter(s => s.enabled).map(s => ({
      urls: s.url, username: s.username, credential: s.credential,
    })),
  ];
}
```

## 自建 TURN（用户文档）

推荐 coturn：
```
sudo apt install coturn
# /etc/turnserver.conf:
listening-port=3478
external-ip=<公网IP>
realm=misaka.example.com
user=misaka:你的密码

sudo systemctl enable coturn
sudo ufw allow 3478
sudo ufw allow 49152:65535/udp
```

## UI 文案

| 状态 | 文案 |
|---|---|
| 未配置 | 中继信道未配置 |
| 测试中 | 正在与中继节点握手... |
| 可达 | ✓ 中继信道可达 |
| 不可达 | ✗ 中继节点无响应 |
| 凭证错误 | 中继节点拒绝接入 |
