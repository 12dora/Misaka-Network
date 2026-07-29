# Misaka Network 死代码与开发残留审计

## 摘要

- 未发现 P0/P1 级死代码或已提交的构建产物；`dist/`、`coverage/`、`data/`、临时文件和 `.DS_Store` 均未被 Git 跟踪。
- `.gitignore` 的非锚定 `data/` 会连 `client/src/data/` 一起忽略；新增源码数据文件可能在本地可运行、提交时却静默缺失。
- E2E 直接导入 `pngjs`，配置类型检查直接要求 `@types/node`，但二者都未直接声明，只因当前传递依赖树碰巧可用。
- `VITE_APP_BASE` / `APP_BASE` 是完全失效的文档化配置；另有一个实际生效的 `TURN_CF_ANALYTICS_API_TOKEN` 未出现在任何示例或运维文档中。
- 传输模块含确定的零消费者函数、类型岛和两个失效的“单一真源”；删除这些内容不得改变协议 v2 交付语义、二进制帧布局或旧记录迁移路径。
- `client/README.md`、`server/README.md`、启动必读的 `docs/00-overview.md` 及已被最终矩阵取代的交接文档含可验证的过时事实。
- 可安全清理一整个未导入 Hook、若干声明即唯一命中的导出、无引用 CSS、孤立 favicon、空根锁文件和三处无用途的 CI 全历史 checkout。
- `docs/archive/` 本身仍有索引和追溯用途，建议保留；但其中五个样图链接已断，且一个样图与生产资产逐字节重复。

## 发现

### [P2] 非锚定 `data/` 规则会吞掉新的源码文件

- 位置: `.gitignore:7`
- 证据:
```gitignore
data/
server/data/
```
```ts
export interface CharacterData {
  nodeId: number
  kanji: string
```
- 影响: `data/` 会匹配任意层级目录。当前 `client/src/data/lore.ts` 因为已经被跟踪而继续存在，但开发者若新增 `client/src/data/new-lore.ts` 并在本地导入，Git 会静默忽略该文件；本地 Vite 可正常运行，提交后的 CI/生产构建则因模块缺失失败。`git check-ignore`/默认 `rg` 也会跳过这类源码，本次审计的初始文件清单已实际复现这一点。
- 建议: 将规则收窄为 `/data/`、`/server/data/`，如确需忽略客户端运行数据则显式增加 `/client/data/`；随后用 `git check-ignore client/src/data/<fixture>` 固定预期。
- 删除结论: **NEEDS-CHECK** — 删除广域规则并用锚定规则替换；不要删除已跟踪的 `client/src/data/lore.ts`。

### [P2] 客户端清单依赖传递安装的 `pngjs` 与 `@types/node`

- 位置: `client/tests/e2e/qr-invite.spec.ts:12`
- 证据:
```ts
import { test, expect, type Page } from '@playwright/test'
import jsQR from 'jsqr'
import { PNG } from 'pngjs'
```
```json
"devDependencies": {
  "@playwright/test": "^1.60.0",
  "@types/qrcode": "^1.5.5",
  "@types/react": "^18.2.43",
  "@types/react-dom": "^18.2.17",
```
```json
"types": ["node", "vitest/globals"]
```
- 影响: `pngjs` 目前仅因 `qrcode` 的传递依赖而被 npm 扁平安装，`@types/node` 仅因 `@types/qrcode` 而出现。任一上游移除该依赖或采用不允许幽灵依赖的安装器后，QR E2E 会报 `ERR_MODULE_NOT_FOUND: pngjs`，`typecheck:config`/`typecheck:tests` 会报找不到 `node` 类型。
- 建议: 在 `client/devDependencies` 直接声明 `pngjs` 和与 CI Node 20 对齐的 `@types/node`；保留 `client/tests/pngjs.d.ts`，或改为声明并使用正式的 `@types/pngjs` 后删除该手写声明。同步更新 `client/package-lock.json`。
- 删除结论: **KEEP** — 这些能力有真实调用方，不能删除；应补齐直接依赖所有权。

### [P2] `VITE_APP_BASE` / `APP_BASE` 是完全失效的部署开关

- 位置: `client/.env.example:36`
- 证据:
```dotenv
# Optional escape hatch: override ONLY the router/link base without changing
# the asset base. Almost never needed — prefer VITE_BASE. A host can also set
# APP_BASE in public/config.json, which wins over both.
#VITE_APP_BASE=
```
```ts
function buildBase(): string {
  return normalizeBase(import.meta.env.BASE_URL)
}
```
- 影响: 全仓精确检索中，`VITE_APP_BASE` 只命中示例和旧交接文档，`APP_BASE` 未进入 `AppConfig`、`validateConfig` 或 `appBase.ts`。运营者按示例设置私有路由基址时，值被完全忽略，分享链接、Router basename 和静态资源仍使用 `VITE_BASE`，从而得到错误路径或 404。
- 建议: 删除 `.env.example` 中这四行及旧文档里的 `APP_BASE` 说法，明确 `VITE_BASE` 是唯一来源；不要重新引入双基址，除非同时补齐 `app-base.test.ts` 和部署子路径 smoke check。
- 删除结论: **SAFE** — 删除的是无任何读取方的文档化伪配置。

### [P2] 生效中的 Analytics token 没有任何配置文档

- 位置: `server/src/config.ts:135`
- 证据:
```ts
export const TURN_CF_KEY_ID = process.env.TURN_CF_KEY_ID ?? ''
export const TURN_CF_API_TOKEN = process.env.TURN_CF_API_TOKEN ?? ''
export const TURN_CF_ACCOUNT_TAG = process.env.TURN_CF_ACCOUNT_TAG ?? ''
export const TURN_CF_ANALYTICS_API_TOKEN = process.env.TURN_CF_ANALYTICS_API_TOKEN ?? TURN_CF_API_TOKEN
```
```ts
'Authorization': `Bearer ${TURN_CF_ANALYTICS_API_TOKEN}`,
```
- 影响: `TURN_CF_ANALYTICS_API_TOKEN` 确实用于 GraphQL Analytics，但在根、server、deploy 三份 `.env.example`、README 和部署文档中均零命中。运营者无法从仓库发现可拆分签发/撤销 token 与只读分析 token，只能给单一 token 同时授予两类权限；反过来，误设置该变量后也没有文档说明启动校验仍只验证 `TURN_CF_API_TOKEN`。
- 建议: 在 `server/.env.example`、`deploy/.env.example` 和 TURN 运维段落记录该可选变量、回退行为与最小权限；启动校验保持对签发 token 的要求，Analytics token 仅作为可选覆盖。
- 删除结论: **KEEP** — 变量有生产读取方；应补文档，不能删除。

### [P2] Pages 工作流授予未使用的仓库写权限

- 位置: `.github/workflows/deploy.yml:7`
- 证据:
```yaml
# Grant the GITHUB_TOKEN write access to pages and contents
permissions:
  contents: write
  pages: write
  id-token: write
```
- 影响: 该工作流后续只有 checkout、构建、上传 Pages artifact 和 Pages deploy，没有提交、打 tag、发 release 或写仓库内容的步骤。任一被攻陷的第三方 action 目前可使用 `GITHUB_TOKEN` 修改仓库；这是与实际工作不相称的权限。
- 建议: 将 `contents: write` 降为 `contents: read`，保留 Pages 部署所需的 `pages: write` 与 `id-token: write`。
- 删除结论: **SAFE** — 可安全删除 contents 写权限，不影响现有步骤。

### [P2] 两个传输限值的“单一真源”已经失效

- 位置: `client/src/lib/transfer.ts:14`
- 证据:
```ts
// agent will publish `MAX_FILE_SIZE` from constants.ts; until then, fall
// back to 16 GB so the guard still functions.
const MAX_FILE_SIZE: number =
  (constants as { MAX_FILE_SIZE?: number }).MAX_FILE_SIZE ?? (16 * 1024 * 1024 * 1024)
```
```ts
export const MAX_TRANSFER_ID_LENGTH = 128
const TRANSFER_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/
```
- 影响: `constants.ts` 已无条件导出 `MAX_FILE_SIZE`，所以 optional cast 与 16 GiB fallback 永远不可达；将来常量被误删/改名时，编译器不会失败，而会悄悄恢复旧上限。`MAX_TRANSFER_ID_LENGTH` 则全仓只命中声明，真正校验硬编码 `128`；维护者修改该导出会以为协议限值已变，实际入站校验毫无变化。
- 建议: 直接具名导入 `MAX_FILE_SIZE`，删除 fallback 和过时“agent will publish”注释；对 transfer ID 要么删除未使用常量并保留正则为唯一来源，要么让长度检查显式引用常量。保持 `validateMetaMessage` 的严格顺序与现有上限，不改协议 v2 或帧布局；复核 `client/tests/unit/transfer-max-size.test.ts`、`transfer-meta-validation.test.ts`。
- 删除结论: **SAFE** — 可删除不可达 fallback、optional cast、过时注释及未使用常量；不能删除实际大小/metadata 防线。

### [P2] `client/README.md` 仍描述不存在的目录和依赖

- 位置: `client/README.md:27`
- 证据:
```text
    ├── main.tsx
    ├── App.tsx
    ├── router.tsx
    ├── styles/
    │   ├── globals.css
    │   └── tokens.css
```
```json
"idb": "^8",
"hash-wasm": "^4"      // 流式 SHA-256
```
- 影响: `router.tsx`、`styles/`、`HomePage.tsx`、`stores/`、`services/` 等所列路径全部不存在，实际代码使用 `App.tsx` 路由、`index.css`、`store/` 与 `lib/`；`hash-wasm` 也不在 manifest、lockfile 或源码中。新维护者会在错误目录新增模块，或误以为整文件 SHA-256 仍是传输依赖，与当前 AES-GCM 分片完整性设计冲突。
- 建议: 删除“推荐目录结构”中的虚构树，改为由 `client/src` 当前结构生成的简短导航；删除 `hash-wasm` 行，并将配置优先级更新为 host injection > config.json > Vite env > default。
- 删除结论: **SAFE** — 可删除这些已被实现否定的文档段落。

### [P2] `server/README.md` 给出错误的容量默认值和配置模型

- 位置: `server/README.md:39`
- 证据:
```md
| `MAX_NODES` | 不限制 | 全局节点上限，`0` 表示不限制 |
| `RATE_LIMIT_PER_MIN` | `60` | API 每分钟限流次数（按 IP） |
| `SESSION_TTL_MS` | `1800000` | 登录 token 有效期（毫秒），默认 30 分钟 |

其余参数（节点锁定时长、清理间隔、举报阈值等）为编译时常量，直接在 `src/config.ts` 中修改。
```
```ts
const MAX_NODES_RAW = readInt('MAX_NODES', 5000, { min: 0 })
export const MAX_NODES = MAX_NODES_RAW === 0 ? Infinity : MAX_NODES_RAW
```
- 影响: 未配置 `MAX_NODES` 的部署会在 5000 节点达到上限，而文档承诺“不限制”；同时 cleanup、WS 边界、scrypt、TURN 等大量参数都通过 env 读取，并非只能改源码。运营者按该文档容量规划或直接改 TypeScript，会得到与运行时事实不同的系统。
- 建议: 删除“不限制”和“其余均为编译时常量”两项陈述，链接 `server/.env.example` 作为唯一完整清单，并注明 `MAX_NODES=0` 才显式无限。
- 删除结论: **SAFE** — 删除错误文案；保留 README 其余仍有效的启动/部署说明。

### [P2] 启动必读 overview 把未实现设计写成当前信息架构

- 位置: `docs/00-overview.md:16`
- 证据:
```md
设置（弹出）    TURN / 主题 / 音效 / 黑名单 / 语言
```
```tsx
{ id: 'turn' as const, label: '中继' },
{ id: 'sound' as const, label: '音效' },
{ id: 'about' as const, label: '关于' },
```
- 影响: `docs/README.md` 将 `00-overview.md` 标为“启动必读”，但当前设置页只有中继、音效、关于；主题、黑名单、语言均没有 tab、store 或模块。维护者会把不存在的功能当成已交付能力，测试/文案审查也会按错误范围执行。
- 建议: 删除未实现的三个设置项，并把“信令 Node.js + ws 单文件”等旧实现描述更新为当前模块化 server；若这些是路线图，移入明确标注“未实现”的 roadmap，而非当前 overview。
- 删除结论: **SAFE** — 可删除当前事实中不存在的能力声明；overview 文件本身仍有用途，应保留。

### [P2] 已完成交接文档仍宣称后续 wave 未开始且存在旧 flake

- 位置: `docs/AUDIT_REPAIR_HANDOFF.md:8`
- 证据:
```md
| Wave 3 | 未开始 | ~25 项 |
| Wave 4 | 未开始 | UX-COPY-001 + 收尾 |

**当前 HEAD 全量测试绿：** `npm test` → server 38 个脚本 + client 63 文件 / 480 测试

**⚠️ server 集成套件存在既有 flake（TEST-002/003，尚未修）：**
```
```md
本文件是 `CODE_AUDIT_2026-07-27.md` 与 `AUDIT_REPAIR_HANDOFF.md` 的最终收口记录。
交接文档中的“未开始 / 未修复”状态以本文件为准。
```
- 影响: `AUDIT_REPAIR_COMPLETION_2026-07-27.md` 明确取代该交接状态，并记录 wave 3/4 与测试生命周期问题已完成；旧文件仍会诱导接手者忽略真实失败为“已知 flake”，或重复已经完成的工作，且其中测试数量也已落后于当前 44 个 server 脚本和 72 个 unit 文件。
- 建议: 删除 `docs/AUDIT_REPAIR_HANDOFF.md`，或移到 `docs/archive/` 并在标题首行加醒目的“已由 completion 取代”；保留原审计和最终 completion 作为证据链。
- 删除结论: **SAFE** — Git 历史和最终 completion 已保留状态演进，当前交接文件不应继续作为活动文档。

### [P3] `useCardIn.ts` 是零导入的完整孤立模块

- 位置: `client/src/hooks/useCardIn.ts:1`
- 证据:
```ts
import { useEffect, useRef } from 'react'

export function useCardIn(threshold = 0.15) {
  const ref = useRef<HTMLDivElement>(null)
```
- 影响: 对 `useCardIn`、`hooks/useCardIn` 及动态 import/new URL 的全仓检索除本文件外零命中。它不会进入 bundle，却仍被 `tsconfig.json` 的 `include: ["src"]` 类型检查；React/DOM 类型调整可被一个用户永远无法执行的 Hook 阻塞。
- 建议: 删除整个 `client/src/hooks/useCardIn.ts`；同时删除只由它触发的 `.card-in` selector，但保留 StatsDashboard 仍直接引用的 `@keyframes card-in`。
- 删除结论: **SAFE** — 整个模块无生产、测试或字符串调用方。

### [P3] transfer 模块保留四个声明即唯一命中的运行时 API

- 位置: `client/src/lib/transfer.ts:374`
- 证据:
```ts
export function getTransferOwner(transferId: string): TransferOwner | undefined {
  const rec = transferOwners.get(transferId)
  return rec ? { peerSessionId: rec.peerSessionId, epoch: rec.epoch } : undefined
}
```
```ts
export function getSendTaskInfo(transferId: string):
  { peerSessionId: string; epoch: number; settled: boolean; acked: boolean } | undefined {
```
```ts
export function droppedWhilePausedCount(transferId: string): number {
  return receiveSessions.get(transferId)?.droppedCount ?? 0
}
```
- 影响: `getTransferOwner`、`getSendTaskInfo`、`droppedWhilePausedCount`、`checkForResumableTransfers` 在包含测试和字符串引用的全仓检索中都只命中自身；`checkForResumableTransfers` 还只是 `getActiveTransfers()` 的一行转发。它们制造看似受支持的调试/恢复 API，维护者修改后不会影响任何行为，却仍增加重构与测试判断成本。
- 建议: 删除这四个函数，并删除 transfer.ts 因一行 wrapper 才需要的 `getActiveTransfers` import；不要删除实际被 `network.ts` 使用的 owner、repair、resume、finalize API。
- 删除结论: **SAFE** — 四个导出无任何消费者，不涉及协议 v2、帧布局或持久化迁移。

### [P3] 协议消息类型形成未接入处理器的死类型岛

- 位置: `client/src/lib/transfer.ts:128`
- 证据:
```ts
export interface ReadyMessage {
  type: 'transfer-ready'
  transferId: string
  shortId: number
}
```
```ts
export type DCProtocolMessage =
  | MetaMessage
  | ResumeRequest
  | ReadyMessage
```
- 影响: `ReadyMessage`、`RejectMessage`、`DoneMessage` 只被未使用的 `DCProtocolMessage` union 引用，而 union 本身全仓只命中声明；实际 DataChannel handler 对 `JSON.parse` 结果使用未定型的 `msg`。维护者向 union 增删控制消息不会获得任何处理器 exhaustiveness 检查，形成“已经类型化”的虚假安全感。
- 建议: 若短期不把解析结果接到可验证 schema/判别联合，删除 `ReadyMessage`、`RejectMessage`、`DoneMessage` 与 `DCProtocolMessage`；`RepairRequest`、`ResumeRequest`、`MetaMessage` 有真实消费者，应保留。
- 删除结论: **SAFE** — 删除这四个纯类型声明不产生运行时代码，也不改变六类 v2 控制消息的线上格式。

### [P3] network store 有两个零消费者状态快照 wrapper

- 位置: `client/src/store/network.ts:209`
- 证据:
```ts
let networkEpoch = 0
export function getNetworkEpoch(): number { return networkEpoch }
```
```ts
// Re-export the auto-TURN state inspector so the page can decide whether
// to call out "TURN unavailable" explicitly. Cheap wrapper, no state copy.
export function getAutoTurnSnapshot() {
  return getAutoTurnState()
}
```
- 影响: 两个函数全仓都只命中声明；注释还错误宣称页面会使用 TURN wrapper。维护者若通过它们排查 epoch/TURN UI，会观测一个无人调用的入口并在错误层修改代码，实际页面仍走 store state 与直接导入。
- 建议: 删除两个 wrapper 及 `getAutoTurnSnapshot` 的失实注释；保留内部 `networkEpoch` 和真正使用的 `getAutoTurnState`。
- 删除结论: **SAFE** — 无生产或测试调用方。

### [P3] 服务端存在四个零消费者 helper 和一个死消息类型

- 位置: `server/src/store.ts:136`
- 证据:
```ts
export function findSessionsByNodeAndHash(nodeId: number, passCodeHash: string): NodeSession[] {
  const now = Date.now()
  const out: NodeSession[] = []
```
```ts
/** Test/diagnostic hook — current semaphore occupancy. */
export function scryptQueueDepth(): { inFlight: number; queued: number } {
  return { inFlight: scryptInFlight, queued: scryptWaiters.length }
}
```
```ts
export type WSClientMessage =
  | { t: 'AUTH'; token: string }
  | { t: 'JOIN_CLUSTER' }
```
- 影响: `findSessionsByNodeAndHash`、`scryptQueueDepth`、`countReportsForTarget`、`_resetAllowedOriginsCache` 和 `WSClientMessage` 在生产、测试及动态 import 字符串中都只命中自身。所谓 test hook 没有测试调用，消息 union 也没有约束 `ws.ts` 的 zod schema；修改这些声明不会改变服务行为。
- 建议: 删除四个函数及 `WSClientMessage`；若需要 semaphore 诊断或 schema 类型，则先在真实测试/`z.infer` 中建立消费者再保留。
- 删除结论: **SAFE** — 均无调用方；不会触及 passcode legacy migration、WS 4001/4002 语义或测试 harness。

### [P3] `http.ts` 的 legacy re-export 已无任何旧调用点

- 位置: `server/src/http.ts:39`
- 证据:
```ts
// Re-export so legacy import sites keep working without touching the new
// derivation location (which lives in store.js to avoid a circular import
// between turn.ts and http.ts).
export { deriveCustomIdentifier, redactCustomIdentifier }
```
- 影响: 全仓没有从 `http.ts`/`dist/http.js` 导入这两个名字；真实生产和 `server-secret.test.mjs` 都从 `store` 取值。该 shim 迫使 `http.ts` 继续导入两个自身不使用的符号，并暗示一个已经不存在的兼容面。
- 建议: 删除 re-export、两行 legacy 注释，以及 `http.ts` import 列表中的这两个名字；保留 `store.ts` 的实现和测试。
- 删除结论: **SAFE** — 旧入口零消费者，规范入口有生产及测试调用。

### [P3] 多组 CSS utility、动画和 token 全仓无引用

- 位置: `client/src/index.css:440`
- 证据:
```css
/* Card entrance ─── triggered by .animate-in class added via JS */
.card-in {
  animation: card-in 0.4s ease forwards;
  opacity: 0;
}
```
```css
.title-in { animation: title-in 0.7s ease forwards; }
.slide-up { animation: slide-up 0.6s ease forwards; }
```
```css
.no-scrollbar::-webkit-scrollbar { display: none; }
.no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
```
- 影响: `.title-in`、`.slide-up`、`.no-scrollbar`、自定义 `.tabular`、`--accent-ribbon`、`--z-nav` 在源码/测试/HTML 中均无消费者；`.card-in` 仅由上述死 Hook 添加，注释中的 `.animate-in` 从不存在。Vite 会把这些规则继续打入每个生产 CSS bundle，且维护者可能误用与 Tailwind `tabular-nums` 重复的 `.tabular`。
- 建议: 删除上述 selector、`title-in`/`slide-up` keyframes、两个未用 token 和失实注释；删除 Hook 后移除 `.card-in` selector，但保留 StatsDashboard inline animation 仍使用的 `@keyframes card-in`。
- 删除结论: **SAFE** — 精确 token 检索无实际消费者，例外的 `card-in` keyframe已明确保留。

### [P3] `favicon.svg` 会被复制进产物但没有任何引用

- 位置: `client/public/favicon.svg:1`
- 证据:
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="12" fill="#1A4FC4"/>
```
```html
<link rel="icon" type="image/webp" href="/assets/misaka-logo.webp" />
```
```json
"src": "./assets/misaka-logo.webp",
```
- 影响: index favicon、manifest icon 和 service worker shell 全部使用 `misaka-logo.webp`；`favicon.svg` 除自身和一条已过时进度记录外零引用。Vite 会原样复制 `public/`，所以每次部署仍携带不可达资产。
- 建议: 删除 `client/public/favicon.svg`，并修正 `docs/PROGRESS.md` 中“manifest 当前使用 favicon.svg”的旧记录。
- 删除结论: **SAFE** — 所有运行时图标入口已指向被引用和预缓存的 webp。

### [P3] archive 样图链接全部断开，且存在逐字节重复资产

- 位置: `docs/archive/01-design-system.md:7`
- 证据:
```md
参考样图：
- [sample/home-page-sample.jpg](sample/home-page-sample.jpg) — 首页构图
- [sample/misaka.webp](sample/misaka.webp) — 立绘
- [sample/misaka-text.webp](sample/misaka-text.webp) — 字标
```
```md
按 [sample/home-page-sample.jpg](sample/home-page-sample.jpg) 的海报构图。
```
- 影响: 从 `docs/archive/` 解析时，这五个链接都指向不存在的 `docs/archive/sample/`，实际文件位于 `docs/sample/`；维护者点击即 404。另经 SHA-1 逐字节核对，`docs/sample/misaka.webp` 与 `client/public/assets/misaka.webp` 完全相同，重复占用约 168 KiB。三张 sample 合计约 546 KiB，却没有一个有效 Markdown 入链。
- 建议: 若样图仍承担历史设计证据，先把链接改成 `../sample/...`，并让立绘链接直接指向生产资产后删除重复副本；若 archive 只保留文本追溯，则删除整个 `docs/sample/` 并移除五条失效链接。
- 删除结论: **NEEDS-CHECK** — 重复 `misaka.webp` 可在修正链接后安全删除；另外两张是否保留取决于维护者是否需要视觉历史。

### [P3] 根 `package-lock.json` 是无依赖包装器的空锁文件

- 位置: `package-lock.json:1`
- 证据:
```json
{
  "name": "misaka-network",
  "version": "0.1.0",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
```
```json
"description": "Top-level wrapper for the misaka-network test suite. Not a workspace — each sub-project (client/ server/) keeps its own package.json and lockfile."
```
- 影响: 根 manifest 没有 dependencies/devDependencies，CI 也只对 client/server 执行 `npm ci`。自动化若在根目录看到 lockfile 并执行 `npm ci`，会“成功”但没有安装两个子项目依赖，产生假成功；依赖机器人也会把空包装器当成第三个 Node 项目。
- 建议: 删除根 `package-lock.json`，必要时用仅匹配根的 `/package-lock.json` 忽略规则防止重生；保留 client/server 两份真实 lockfile。
- 删除结论: **SAFE** — 根脚本只编排 `npm --prefix`，不消费根依赖树。

### [P3] 三个测试 job 无用途地下载完整 Git 历史

- 位置: `.github/workflows/test.yml:16`
- 证据:
```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0  # guard script diffs against origin/<base>
```
```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
```
- 影响: `server-tests`、`client-tests`、`e2e-tests` 后续没有 Git diff/log 命令；guard 在独立 `tests-touched-guard` job 中并自行 fetch base。当前配置使每个 PR 在三个额外 runner 上下载全历史，增加 checkout 流量和冷启动时间；server job 的注释还错误归因给不在该 job 运行的 guard。
- 建议: 删除这三个 job 的 `with: fetch-depth: 0`（使用 checkout 默认浅克隆）及 server 错误注释；仅在 `tests-touched-guard` 保留全历史。
- 删除结论: **SAFE** — 三个测试 job 的命令只读取当前 checkout。

### [P3] 配置源码存在两个互相漂移的 TypeScript 检查入口

- 位置: `client/tsconfig.node.json:1`
- 证据:
```json
{
  "compilerOptions": {
    "composite": true,
    "skipLibCheck": true,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "allowSyntheticDefaultImports": true
  },
  "include": ["vite.config.ts"]
}
```
```json
"typecheck:config": "tsc --noEmit --strict ... vite.config.ts vitest.config.ts playwright.config.ts"
```
- 影响: `tsconfig.node.json` 只覆盖 `vite.config.ts` 且未启用 `strict`；CI 实际绕过它，用另一组命令行 flags 检查三个配置文件。编辑器若采用 project reference，会给 Vite 配置比 CI 更弱且与 Vitest/Playwright 不同的诊断，直到提交后才暴露差异。
- 建议: 建立唯一 `tsconfig.config.json`，包含三个配置文件和 CI 所需选项，让 `typecheck:config` 使用 `tsc -p`；随后删除 `tsconfig.node.json` 及 `tsconfig.json` 中旧 reference。若编辑器依赖 solution-style reference，则让 reference 指向新的唯一配置。
- 删除结论: **NEEDS-CHECK** — 旧文件可在 CI 和编辑器都切换到新配置后删除，不能只删文件而保留 reference。

### [P3] receive-side 已接通，页面注释仍宣称“尚未接线”

- 位置: `client/src/pages/Network.tsx:1018`
- 证据:
```ts
// variants when the transfer is inbound, since the engine state lives in
// a different bucket. Falls back to the send-side action if the receive
// variant isn't wired yet — same UX, just less complete.
function dispatchPause(transferId: string) {
  const t = store.transfers.find(tr => tr.id === transferId)
  if (t?.direction === 'recv') {
    useNetworkStore.getState().pauseReceiveTransfer(transferId)
```
- 影响: `pauseReceiveTransfer`、`resumeReceiveTransfer`、`cancelReceiveTransfer` 都已实际调用，不存在注释所称 fallback。维护者排查接收端暂停/恢复时会错误判断功能尚未完成，重复设计或在错误的 send-side 路径加补丁。
- 建议: 删除“variant isn't wired yet”两行，保留关于 inbound 必须分派到 receive-side bucket 的有效说明。
- 删除结论: **SAFE** — 只删除与紧邻代码相矛盾的历史注释。

## 附录: 已核查但结论为无问题的区域

- **协议/迁移 KEEP**：协议 v1 协商、`receivedChunks` 旧 resume 格式、IndexedDB `receivedChunks`→bitmap 迁移、旧 `fileHash` 字段、passcode sha256→scrypt 升级均仍有生产读取路径或专门测试；不能作为“legacy”直接删除。`CHUNK_FRAME_TAG = 0x01`、帧布局、`makeChunkIv` 和 `finalizeReceive()` 合同均未建议变更。
- **仅测试消费者 KEEP**：`makeChunkIv(prefix, index)` 两参数兼容重载、`client/lib/turn.ts:testTurnServer`、`server/turn.ts:getTurnStatus`、TURN `_...Now` hooks 等均被测试直接调用；按审计规则不判死代码。
- **依赖 KEEP**：client/server 的全部已声明运行时依赖均有静态 import；类型包、TypeScript、Vite/Vitest/Playwright、PostCSS/Tailwind/autoprefixer、jsdom、tsx 均由配置或 npm scripts 消费。除 `pngjs`/`@types/node` 直接声明缺失外，未发现可验证的未使用 npm 依赖。
- **测试与脚本 KEEP**：44 个 `server/tests/*.test.mjs` 全部出现在 server scripts 且全部使用 `runTest`；fixture/harness/stub 均有调用方。72 个 client unit 文件由 Vitest glob 覆盖，4 个 E2E spec 由 Playwright 覆盖，manual/contract 脚本均有文档入口。
- **部署/config KEEP**：Vite、Vitest、Playwright、Tailwind、PostCSS、Dockerfile、两套 compose、Caddy、coturn、proxy 验证脚本、service worker、404 fallback、manifest 和 `config.json` 均有构建、CI、运行时或文档化人工入口。
- **资产 KEEP**：`misaka-logo.webp` 被 index/manifest/SW 使用，`misaka-title.webp` 被 `MisakaHeroTitle` 使用，`misaka.webp` 被 Home/ACGN 使用；除 `favicon.svg` 与重复 sample 外未发现 orphan public asset。
- **archive KEEP**：`docs/archive/` 有根 README、overview、server README 和 prompt 模板的明确入口，定位也明确为低频历史材料，因此没有把“内容较旧”本身当成可删除证据；只报告了可机械复现的断链/重复资源。
- **调试残留**：shipped client/server 中未发现 `debugger`、TODO/FIXME/HACK/XXX 或注释掉的可执行代码块。现有 `console.warn/error/log` 均位于错误处理、启动/关闭、TURN/persist 运维或测试输出路径，未找到可证明为临时调试的日志。
- **本地生成物 SAFE 清理但未入库**：当前工作区有 `.DS_Store`、`client/coverage/`、`server/dist/`、`client/data/`、根 `data/`、`server/data/*.tmp`，共约 1.2 MiB；`git ls-files` 对这些路径零命中，且 `.gitignore` 已覆盖。它们可按需本地删除，但不是版本库提交垃圾。
