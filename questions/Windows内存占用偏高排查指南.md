# Windows 内存占用偏高排查指南

## 问题描述

Windows 任务管理器显示 `opencodex · proxy dashboard` / `Bun` 进程占用约 1.3GB 内存。需要判断这是任务管理器口径、Bun/JSC 原生侧保留、流式请求未释放，还是应用层缓存导致。

## 已尝试的修复方法及失败原因

- ❌ 仅用任务管理器截图判断原因：截图只能看到进程树内存，不能区分 RSS、JSC heap、external、ArrayBuffer，也无法定位请求生命周期是否泄漏。
- ❌ 沙箱内直接运行 `bun .\src\cli\index.ts memory --json`：因为无法读取 `C:\Users\wzm33\.opencodex\config.json` 中的管理 token，返回 `opencodex admin token required`。
- ✅ 使用一次只读授权运行 `bun .\src\cli\index.ts memory --json`：成功读取运行中代理的 `/api/system/memory` 标量诊断。

## 当前观测

- 运行中代理 PID: `51444`
- Bun 版本: `1.3.14`
- 运行时长: 约 12 小时
- `rss`: 约 786MB
- `external`: 约 1.81GB，当前 `observedMetric=external`
- `jscHeap.heapSize`: 约 1.87GB
- `responseState.totalBytes`: 约 63MB，不能单独解释 1GB+ 占用
- `activeTurnCount`: `224`，如果当时没有 224 个真实并发 WebSocket turn，则高度可疑
- `streamMode=auto` 且 `eagerRelay.useEagerRelay=false`，符合 Windows 上规避已知 Bun 流式问题的默认路径

## 深层问题分析

`activeTurnCount` 来自 `src/server/lifecycle.ts` 中的 `activeTurns: Set<AbortController>`。HTTP `/v1/responses` 分支不进入这个计数，主要是 WebSocket `response.create` 分支在 `src/server/index.ts` 中注册并在异步 turn 的 `finally` 里释放。

可疑方向：

1. WebSocket turn 的取消函数在 `pumpResponsesSseToWebSocket` 内被覆盖成 reader cancel，可能丢失调用层原本的 `turnAbort.abort()` 语义。
2. 客户端断开、后续 `response.create` 替换旧 turn、或 Bun 流式 reader cancel 未及时完成时，异步 turn 可能长时间停在 `sendResponseToWebSocket` / `reader.read()`，导致 `finally` 不执行。
3. 大量未完成 turn 会把 `AbortController`、Response body reader、闭包中的 request/log context 等对象留在内存里，能解释 `activeTurnCount` 增长和 external/JSC heap 同步偏高。
4. `responseState.totalBytes` 只有几十 MB，不是本次内存大头，但仍应保留在诊断面板中作为会话状态缓存指标。
5. 对比 `cockpit-tools` 和 `cc-switch` 源码后，低内存不是因为它们“不做中转”。两者都支持本地代理/路由，但生命周期边界更硬：`cockpit-tools` 在 Go sidecar 中统一关闭 upstream execution session、WebSocket 和 pending request；`cc-switch` 用 Rust RAII guard、流式超时和 Drop guard 清理 usage collector。
6. 本地 Git 历史显示，当前 Windows fork 相对 `origin/main` v2.8.0 只在 `src/server/index.ts` 增加了 `startServer` hostname option；`lifecycle.ts`、`ws-bridge.ts`、`responses/core.ts` 没有 fork 侧差异。WebSocket active turn 释放风险不是 Windows 桌面端这次改造新增的核心逻辑。
7. 上游 `lidge-jun/opencodex` 当前 `main` 已经出现 `tryAdmitTurn` / `ActiveTurnLease` / `turnAdmissionLease` 这类生命周期硬化代码，而本 fork 当前工作树没有这些符号。后续修复应优先评估上游这段修复能否 backport。

## 下一步排查策略

1. 写一个 WebSocket 回归测试：模拟 SSE body 永不结束，连接关闭或发送下一条 `response.create` 后，`activeTurnCount` 必须回到原值。
2. 修改 WebSocket pump 的取消链：保留调用层 `turnAbort.abort()`，并同时 cancel SSE reader，确保 close/supersede 都能释放 turn。
3. 给 `/api/system/memory` 增加更细的 WebSocket/active turn 标量诊断，例如 active websocket 数、active response turn 数、最长 turn 年龄。注意不能暴露请求体、路径、账号或 token。
4. 考虑给 WebSocket response turn 增加最大静默/最长生命周期保护，超时后主动 abort 并记录 499/502，避免无限挂起。
5. 在修复后运行 `bun run typecheck` 和相关测试，至少覆盖 `tests/server-auth.test.ts`、`tests/bridge-live-delivery.test.ts`、`tests/shutdown-drain.test.ts` 或新增专门测试。
6. 参考 `docs/中转项目内存占用对比分析.md` 中的方案，优先修复 WebSocket cancel 链，再考虑是否需要 native sidecar；不要把“迁移到 Go/Rust”作为绕过生命周期 bug 的第一步。
7. 对比上游当前 `main` 的 turn admission/lease 实现，确认是否已有针对 active turn 泄漏的完整修复；如果兼容 v2.8.0 fork，优先 cherry-pick/backport，再补 Windows 现场回归测试。

## 调试工具

- `bun .\src\cli\index.ts memory --json`
- `ocx memory --json`
- `Get-Process bun | Select-Object Id,WorkingSet64,PrivateMemorySize64,CPU,Path`
- `/api/system/memory`
- `/api/logs?tail=...`

## 注意事项

- 不要重启或停止当前 Codex / OpenCodex 会话来验证，除非用户明确授权；否则可能打断正在进行的对话。
- Windows 任务管理器、`WorkingSet64`、`PrivateMemorySize64`、Bun `process.memoryUsage()` 的口径不同，必须同时看。
- `heapUsed` 在 Bun 1.3.14 上看起来可能与 `heapTotal`/`jscHeap` 不一致，诊断时以 `jscHeap` 和 `observedMetric` 一起判断。
- `questions/` 是排查记录，不默认推送到 GitHub。

## 更新记录

- 2026-08-04：创建排查指南，记录首次内存诊断结果与 WebSocket active turn 泄漏方向。
- 2026-08-04：二次只读检测确认 Codex 仅有两个 active 任务（当前 opencodex 排查任务与 `019fa6b1-4a0b-7ff3-b078-44ab1f307200`），后者包含多 Agent 活动；但 `/api/system/memory` 显示 `activeTurnCount=227`，最近 200 条请求日志中主要 conversation 为 `cbf95a10...` 171 条、`715d4110...` 21 条，绝大多数已有 `terminal/completed` 终态。判断：多 Agent 能解释高请求量，不能解释 227 个 turn 长期不释放，WebSocket turn 释放链仍是首要嫌疑。
- 2026-08-04：✅ 拉取并分析 `cockpit-tools` 与 `cc-switch` 代理源码。确认二者同样承担本地中转，但通过连接级 defer 清理、read/write deadline、heartbeat、pending request 删除、RAII active connection guard、流式首包/静默超时、usage collector finish/drop 清空等方式控制驻留内存。结论：OpenCodex 当前 1GB+ 占用更像应用层 WebSocket turn 未释放，不是中转站共性，也不应归咎于 Windows 桌面壳本身。
- 2026-08-04：✅ 直接检查本地原始基线与 fork 差异。`origin/main..HEAD` 在内存相关路径中只有 `src/server/index.ts` 的 9 行 hostname option 变更；`registerTurn/unregisterTurn`、`ws.data.cancel` 覆盖、`pumpResponsesSseToWebSocket` 均来自 v2.8.0 基线。另查上游当前 `main` 已有 turn admission/lease 硬化代码，本 fork 未包含；判断应优先按上游修复方向 backport，而非定义为 Windows 桌面端独有 bug。
