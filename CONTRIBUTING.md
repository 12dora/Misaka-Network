# Contributing

本项目依赖自动测试防止回归。任何人对 `src/` 的改动必须伴随测试更新。

## 开发流程

### 1. 修改前：建立基线

```bash
npm test
```

确认全量测试通过（本地即是 CI 的近似环境）。如果基线已红，先修基线。

### 2. 开发中

- **新增功能**：必须同时新增测试用例，覆盖至少 happy path + 1 个边界情况。
- **修 bug**：必须先写一个能复现该 bug 的失败用例，再修代码让用例变绿。这是验证"你修对了"的唯一证据。
- **修改已有功能**：如果行为变了，必须更新对应的测试用例，让测试反映新行为而非静默通过。

### 3. 修改后：验证

```bash
npm test          # 全部
npm run test:e2e  # 如果改了传输/信令/API 路径
```

全部通过才能提交。

### 4. PR 描述

PR 描述中必须列出本次新增 / 修改的测试用例，例如：

```
- +3 tests in transfer-frame.test.ts for IV overflow
- Updated authedFetch.test.ts to cover double-401 path
```

### 5. CI 门禁

- PR 必须通过 `Test` workflow 全部 job。
- 如果改动了 `src/` 但未改动 `tests/`，CI 会警告。若确为无行为变更（错别字、文档、依赖升级），请在 PR 标题或最新 commit message 中添加 `[skip-test-guard]`。

## 测试分层

| 层 | 框架 | 目标 |
|---|---|---|
| 服务端集成 | Node 原生 (spawn + fetch + ws) | 真实 HTTP/WS 进程，不 mock 信令 |
| 客户端单元 | Vitest + jsdom | 纯逻辑：NAT、加密、帧编码、401 自愈 |
| 客户端契约 | Node 原生 | 保护 authedFetch / signaling 关键路径不被意外改名删掉 |
| 端到端 | Playwright + 真实 server | 两 browser context 间 WebRTC 传输、auth 恢复 |

## 项目结构速查

```
misaka-network/
├── client/          # React + Vite 前端
│   ├── tests/unit/   # Vitest 单测
│   └── tests/e2e/    # Playwright E2E
├── server/           # Node.js 信令服务
│   └── tests/        # spawn 进程 + HTTP/WS 集成
├── scripts/          # CI guard
└── .github/workflows/
    ├── test.yml      # PR 必跑测试
    └── deploy.yml    # main 推送部署
```
