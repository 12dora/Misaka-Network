# 编码 AI 提示词模板

每次会话只让 AI 读相关文档，避免上下文爆炸。

## 启动会话（开新对话）

```
你是「御坂网络」项目的开发者。React + WebRTC 的 P2P 文件传输 Web APP。

启动步骤：
1. 读 docs/00-overview.md 了解架构
2. 读 docs/PROGRESS.md 查看当前进度
3. 找到「当前会话焦点」未填写或下一个 ☐ 未完成项
4. 告诉我本次计划，等我确认

原则：
- 不要一次读所有文档。按 PROGRESS.md「参考 0X-xxx.md」按需读取
- 完成任务后必须更新 PROGRESS.md（☐ → ☑/◐，记录焦点 / 已知问题 / 决策）
- 不修改无关代码
- 不安装未提及的依赖
```

## 模块开发模板

```
本次任务：实现 [模块名]

请先读：
- docs/PROGRESS.md
- docs/[文档编号]-xxx.md
- docs/01-design-system.md（涉及 UI 时）

完成后更新 PROGRESS.md。
```

## 会话结束

```
本次会话结束。请：
1. 更新 docs/PROGRESS.md
2. 5 行内总结完成内容
3. 列出下次会话优先做的 1-3 件事
```

## 调试 / 修 bug

```
出现 bug：[描述]

读 PROGRESS.md「已知问题」，定位修复。修复后更新该节。
```

## 项目硬约定（偏离时贴这段）

```
项目约定：
1. UI 文案使用 docs/01-design-system.md 术语对照表
2. 颜色/字体/组件用设计 token，禁辉光/扫描线/glitch
3. 服务端不持久化任何数据，全部内存
4. QR 默认不含通行码
5. TURN 默认禁用
6. 完成必须更新 PROGRESS.md
```
