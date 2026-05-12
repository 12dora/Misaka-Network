# 信令服务器 / Signaling Server

详细规格见 `../docs/07-signaling-server.md`

## 快速开始

```bash
cd server
npm install
npm run dev
```

默认监听 `8080` 端口。

## 环境变量

```bash
PORT=8080                # 端口
MAX_NODES=10000          # 全局节点上限
RATE_LIMIT_PER_MIN=60    # 单节点每分钟消息上限
```

## 推荐目录结构

```
server/
├── package.json
├── tsconfig.json
├── .env.example
└── src/
    ├── index.ts       # 启动入口
    ├── http.ts        # REST 路由
    ├── ws.ts          # WebSocket 信令
    ├── store.ts       # 内存存储
    ├── stats.ts       # 统计
    ├── activity.ts    # 活动流
    ├── cleanup.ts     # 30 分钟清理
    └── types.ts       # 共享类型
```

## 部署

- Fly.io / Railway / Render 推荐
- 单实例足够（无状态可扩，但跨实例需要 Redis 共享 Map）

## 关键约束

- 所有数据内存存储，重启即清
- 不记录 IP、文件名、SDP 内容到日志
- 仅做信令转发，不参与文件传输（除 WebSocket 降级模式外）
