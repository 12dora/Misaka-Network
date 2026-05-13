# Misaka Network — QA Bug Report

> 测试时间: 2026-05-13  
> 测试范围: 服务端全部 HTTP API + WS 协议 + 前端关键逻辑  
> 服务端: `server/src/` (Node.js + Express + ws)  
> 客户端: `client/src/` (React + Zustand)

---

## 🟢 已修复（v2，2026-05-13）

### ✅ BUG-1 — `POST /api/verify-passcode`：`sourceToken` 完全未校验

**文件:** `server/src/http.ts`  
**修复:** 在取出 `targetNodeId` 之前调用 `authMiddleware(sourceToken)` 验证身份，无效 token 返回 401。

### ✅ BUG-2 — `POST /api/qr-redeem`：QR 不含 passCode 时仍可被任何人兑换

**文件:** `server/src/types.ts`, `server/src/http.ts`, `client/src/components/features/QRModal.tsx`  
**修复:**
- `QrTokenRecord` 新增 `passCodeHash?: string` 字段
- `GET /api/qr-token` 支持 `?passCode=` query param，传入则 hash 存入 record
- `POST /api/qr-redeem`：有 hash → 验证；无 hash → 返回 403 `QR_REQUIRES_PASSCODE`
- 客户端 `QRModal` 始终传递 `passCode` 给服务端

### ✅ BUG-3 — `ActivityStream.tsx` 开启第二条 WebSocket，覆盖服务端 `session.socket`

**文件:** `client/src/components/features/ActivityStream.tsx`  
**修复:** 删除自建 WebSocket，改为订阅 `signaling.ts` 的 `onMessage` 事件总线。

### ✅ BUG-4 — `verifyAndConnect`：UI 提示"输入对方通行码"，但服务端校验的是己方通行码

**文件:** `client/src/store/network.ts`  
**修复:** 采用方案 A，`targetNodeId` 改为 `req.fromNodeId`（来源节点 ID），与 UI 文案"输入对方的通行码"一致。

### ✅ BUG-5 — 第 3 次错误尝试返回 `WRONG_PASSCODE` 而非 `NODE_LOCKED`

**文件:** `server/src/http.ts`（`POST /api/verify-passcode`）  
**修复:** `failedAttempts >= MAX_ATTEMPTS` 时直接返回 423 `NODE_LOCKED`，不再走 `WRONG_PASSCODE` 分支。

### ✅ BUG-6 — `stats.totalTransfers` / `stats.totalBytes` 永远为 0

**文件:** `server/src/http.ts`  
**修复:** 新增 `POST /api/transfer-done` 端点，客户端传输完成后调用以递增统计。

### ✅ BUG-7 — `verifyAndConnect` 在 WebRTC 握手完成前就将 peer 状态设为 `'transferring'`

**文件:** `client/src/store/network.ts`  
**修复:** 将 peer 状态更新移至 `setupDataChannel` 的 `dc.onopen` 回调中，仅在 DataChannel 真正打开后才设 `'transferring'`。

### ✅ BUG-8 — `Network.tsx` 不销毁 store，但 `ActivityStream` 重新挂载时会创建新 WS

**修复:** BUG-3 修复后自然消除（ActivityStream 不再自建 WS）。

### ✅ BUG-9 — `GET /api/register` 返回 Express HTML 错误而非 JSON

**文件:** `server/src/http.ts`, `server/src/index.ts`  
**修复:** 在 `/api` 路由末尾和 app 层各加一个 catch-all handler，统一返回 `{"error":"NOT_FOUND"}`。

### ✅ BUG-10 — 通行码明文存储在 `sessionStorage`

**文件:** `client/src/store/auth.ts`  
**修复:** `persistIdentity` 只持久化 `{ nodeId, createdAt }`，`passCode` 仅保留在 Zustand 内存中。`setPassCode` / `regeneratePassCode` 不再写入 sessionStorage。

### ✅ BUG-11 — WebSocket token 暴露在 URL query param

**文件:** `server/src/ws.ts`, `server/src/types.ts`, `client/src/lib/signaling.ts`, `client/src/types.ts`  
**修复:** 客户端连接后首条消息发送 `{ t: 'AUTH', token }`，服务端移除 URL query 解析，改为等待 AUTH 消息认证后才分配 session 并发送 WELCOME。

### ✅ BUG-12 — 节点可以举报自己

**文件:** `server/src/http.ts`  
**修复:** `POST /api/report` 新增 `sourceSession.nodeId === targetNodeId` 检查，返回 400 `CANNOT_REPORT_SELF`。

---

## 测试验证检查清单

### BUG-1 验证 ✅
```bash
# 空 token → 401 UNAUTHORIZED
curl -s -X POST http://localhost:8080/api/verify-passcode \
  -H 'Content-Type: application/json' \
  -d '{"targetNodeId":100,"passCode":"123456","sourceToken":""}' | grep UNAUTHORIZED
# 返回: {"error":"UNAUTHORIZED"} ✅

# 合法 token → 200 ok:true
# 返回: {"ok":true} ✅
```

### BUG-2 验证 ✅
```bash
# QR 含 passCode + 正确码 → 兑换成功 ✅
# QR 含 passCode + 错误码 → WRONG_PASSCODE ✅
# QR 不含 passCode → QR_REQUIRES_PASSCODE ✅
```

### BUG-3 验证 ✅
```bash
grep -n "new WebSocket" client/src/components/features/ActivityStream.tsx
# 无输出 ✅
```

### BUG-4 验证
手动测试（需两个浏览器 Tab）

### BUG-5 验证 ✅
```bash
# 第 3 次错误返回 NODE_LOCKED（非 NODE_OCCUPIED）
Attempt 3: {"error":"NODE_LOCKED","unlockAt":...} ✅
```

### BUG-6 验证 ✅
```bash
curl -s -X POST http://localhost:8080/api/transfer-done \
  -H 'Content-Type: application/json' \
  -d '{"token":"<TOKEN>","bytes":1048576}'
# totalTransfers: 1, totalBytes: 1048576 ✅
```

### BUG-9 验证 ✅
```bash
curl -s http://localhost:8080/api/register
# 返回: {"error":"NOT_FOUND"} ✅ (非 HTML)
```

### BUG-10 验证 ✅
```bash
# sessionStorage 'misaka.identity' 中不含 passCode 字段
```

### BUG-11 验证 ✅
```bash
# WebSocket URL 不再包含 ?token= 参数
grep -n "token" client/src/lib/signaling.ts | grep -v "AUTH\|//"
```

### BUG-12 验证 ✅
```bash
curl -s -X POST http://localhost:8080/api/report \
  -H 'Content-Type: application/json' \
  -d '{"targetNodeId":<SAME_ID>,"reason":"spam","sourceToken":"<TOKEN>"}' | grep CANNOT_REPORT_SELF
```
