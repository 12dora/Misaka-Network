# 09 · TURN 服务器（用户自配置）

## 设计原则

- **默认禁用**：TURN 中继会产生服务器带宽成本，不由项目方承担
- **用户自配置**：在「设置」中手动填写 TURN 服务器信息
- **本地存储**：TURN 配置存 localStorage，不上传服务器
- **多服务器**：支持添加多个 TURN，按顺序尝试

## 用户场景

大多数用户场景下：
- 同局域网 → host candidate 直连
- 跨公网但非对称 NAT → STUN 穿透成功

只有少数对称 NAT / 严格防火墙场景下，才需要 TURN。

## 设置页 UI

设置 → 网络 → TURN 服务器：

```
┌───────────────────────────────────────────┐
│  TURN 中继服务器（高级）                    │
│                                           │
│  当 STUN 穿透失败时通过中继服务器转发流量。   │
│  ⚠ 中继流量会消耗服务器带宽，请使用您自己的   │
│  TURN 服务器。                              │
│                                           │
│  [+ 添加 TURN 服务器]                       │
│                                           │
│  ┌─────────────────────────────────────┐  │
│  │ 1. my-turn.example.com:3478         │  │
│  │    用户名: misaka  密码: ******     │  │
│  │    协议: turn   状态: ✓ 可达        │  │
│  │    [测试] [编辑] [删除]              │  │
│  └─────────────────────────────────────┘  │
│                                           │
│  ☐ 启用 TURN 中继                          │
│  ☐ 强制使用 TURN（仅用于测试）              │
│                                           │
│  📖 [如何搭建自己的 TURN 服务器？]           │
└───────────────────────────────────────────┘
```

## 添加 TURN 表单

```
┌───────────────────────────────────────┐
│  添加 TURN 服务器                       │
│                                       │
│  地址：    [my-turn.example.com    ]  │
│  端口：    [3478                   ]  │
│  协议：    [● turn  ○ turns        ]  │
│  传输：    [● udp   ○ tcp          ]  │
│  用户名：  [misaka                 ]  │
│  密码：    [••••••                 ]  │
│                                       │
│  [测试连接]  [取消]  [保存]            │
└───────────────────────────────────────┘
```

## 数据结构

```ts
// localStorage key: misaka.turnServers
interface TurnServer {
  id: string;
  url: string;          // 完整 URL: turn:my-turn.example.com:3478?transport=udp
  username: string;
  credential: string;   // 不加密存储（用户本地数据）
  enabled: boolean;
  lastTested?: number;
  reachable?: boolean;
}

interface TurnSettings {
  servers: TurnServer[];
  enabled: boolean;         // 总开关
  forceRelay: boolean;      // 调试用
}
```

## 连接测试

```ts
async function testTurnServer(server: TurnServer): Promise<boolean> {
  const pc = new RTCPeerConnection({
    iceServers: [{
      urls: server.url,
      username: server.username,
      credential: server.credential,
    }],
    iceTransportPolicy: 'relay',  // 强制只用 TURN
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

## 自建 TURN 服务器（用户文档）

在 ACGN 或单独的「帮助」页提供文档：

```
推荐使用 coturn：

1. 在 VPS 上安装：
   sudo apt install coturn

2. 配置 /etc/turnserver.conf：
   listening-port=3478
   external-ip=<你的公网IP>
   realm=misaka.example.com
   user=misaka:你的密码
   
3. 启动：
   sudo systemctl enable coturn
   sudo systemctl start coturn

4. 开放防火墙：
   sudo ufw allow 3478
   sudo ufw allow 49152:65535/udp

5. 在御坂网络设置中添加：
   地址: 你的VPS_IP
   端口: 3478
   用户名: misaka
   密码: 你设置的密码
```

## 集成到 WebRTC

```ts
function getIceServers(): RTCIceServer[] {
  const base: RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ];
  
  const turnSettings = loadTurnSettings();
  if (!turnSettings.enabled) return base;
  
  const turns: RTCIceServer[] = turnSettings.servers
    .filter(s => s.enabled)
    .map(s => ({
      urls: s.url,
      username: s.username,
      credential: s.credential,
    }));
  
  return [...base, ...turns];
}
```

## UI 文案

| 状态 | 文案 |
|---|---|
| 未配置 | 中继信道未配置 |
| 测试中 | 正在与中继节点握手... |
| 可达 | ✓ 中继信道可达 |
| 不可达 | ✗ 中继节点无响应 |
| 凭证错误 | 中继节点拒绝接入 |

## 实现优先级

1. localStorage 读写
2. 设置页 UI
3. 测试连接功能
4. 集成到 WebRTC ICE 配置
5. 文档页（自建教程）
