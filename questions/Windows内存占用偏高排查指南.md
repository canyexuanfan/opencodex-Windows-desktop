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

- 2026-08-04：✅ 已重新生成桌面端最新构建：`desktop/resources/staging/opencodex` 4260 个文件、Electron TypeScript 编译通过、`desktop/out/win-unpacked` 与 `OpenCodex-Setup-2.8.0-x64.exe` 生成成功；解包资源核验包含 `git-v0.71` 的 active-turn 年龄诊断和 128 admission。当前运行 PID `9220` 仍来自 `E:\Program` 旧安装，未被重启或覆盖。
- 2026-08-04：✅ 根据 Bun 官方 PR #32120 的复现说明，Bun `1.3.14` 在 async-pull 流客户端中止/背压场景仍可能在不到 1 秒内崩溃，因此 `streamMode=auto` 继续保持 legacy tee；eager relay 不在未验证运行时上默认启用。
- 2026-08-04：❌ 读取桌面打包上下文时把不存在的 `desktop/README.md` 与状态查询放进组合命令，导致整组命令提前返回非零；已获取 `desktop/package.json`，后续拆开读取打包资源状态。
- 2026-08-04：✅ `/api/system/memory` 增加无隐私 active-turn 年龄诊断：总数、最老年龄、`<1s/<10s/<60s/>=60s` 分桶；admission 在 draining 状态拒绝新 turn。`bun run typecheck` 与 16 个生命周期/内存诊断测试通过。
- 2026-08-04：❌ 使用项目规定入口 `bun run test` 并捕获输出，仍在 424 秒上限返回 124，未产生测试摘要；测试主进程工作集约 936 MB→1.0 GB。该结果确认完整套件自身存在长耗时/高峰值，不能作为业务代理内存结论。
- 2026-08-04：❌ 按项目规定运行 `bun run test` 时约 76 秒返回退出码 1，但执行工具没有带回测试摘要；尚不能判断为代码回归，下一步需捕获末尾输出或单独运行失败分组。
- 2026-08-04：❌ 拆分完整测试时首次把不存在的 `tests\\AGENTS.md` 和 PowerShell 重定向混入组合查询，导致整组命令返回非零且没有完整输出；后续拆成独立只读查询，避免路径缺失遮蔽测试配置。
- 2026-08-04：✅ 在不重启当前桌面会话的前提下做只读复测：当前 PID `9220` 的 `activeTurnCount` 从历史 `227` 降至 `27/28`，RSS 从约 `609 MB` 降至约 `551 MB`（30 秒采样），说明大量旧 turn 已经收尾且没有继续线性累积；由于进程尚未加载 `git-v0.70`，该结果只作为运行中基线，不作为新代码最终效果证明。
- 2026-08-04：✅ 仅终止本次全量测试留下的 Bun PID `51492`；复核进程列表后仅剩用户当前运行的 OpenCodex PID `9220`，没有重启、关闭或干扰当前桌面会话。
- 2026-08-04：❌ 超时后尝试读取测试 Bun 的父子进程关系时，Windows WMI 查询返回“拒绝访问”；无法用 WMI 取父子树，改用已知的本次测试 PID 做精确收尾，避免触碰正在运行的 OpenCodex PID。
- 2026-08-04：❌ 授权环境运行完整 `bun test` 达到 600 秒上限并返回 124，没有失败堆栈；测试 Bun 进程期间工作集约 242–247 MB、保持响应。定向生命周期/relay/WS/server-auth 测试均已通过，完整套件耗时/挂起点需单独拆分定位，不能宣称全量通过。
- 2026-08-04：✅ `/v1/responses` HTTP fallback 也接入 admission lease；响应流内部仍由 `trackStreamLifetime` 保持 active turn，外层 slot 在 handler 返回后释放，不会截断正常长响应。类型检查通过；授权环境下 `server-auth` 57 个测试、0 失败。
- 2026-08-04：❌ admission 改动后的 `bun test tests\\shutdown-drain.test.ts tests\\server-auth.test.ts` 在 `server-auth` 的临时目录初始化处被 Windows 沙箱拒绝（`C:\\Users\\wzm33\\AppData\\Local\\Temp\\...` 返回 `EPERM/EACCES`），随后清理失败造成连锁失败；`shutdown-drain` 的 admission 测试通过。该失败属于测试环境权限，需授权重跑确认。
- 2026-08-04：✅ 引入 WebSocket active-turn admission lease：最多 128 个“已注册或待绑定”turn；超限返回可重试 503；lease 绑定 `AbortController` 后由统一 `release()` 移除 active turn，重复释放幂等。`bun run typecheck` 通过，相关 50 个测试通过。
- 2026-08-04：❌ 第二次 admission 测试补丁仍把尚未应用的 `MAX_ACTIVE_TURNS` 导出当作既有上下文，导致多文件补丁整体拒绝；后续拆成最小补丁，先修改声明再补导出和测试。
- 2026-08-04：❌ 为 admission lease 添加生命周期测试时，首次补丁假定了 `shutdown-drain.test.ts` 的 import 顺序，导致上下文校验失败且未修改文件；后续先读取实际 import 再应用。
- 2026-08-04：❌ 复试 `git add` 仍无法创建 `.git/index.lock`；结合工作区权限说明确认是当前沙箱对 `.git` 目录只读，非残留锁。后续 Git 存档需申请最小范围的非沙箱授权执行 `git add/commit/tag`。
- 2026-08-04：❌ 第二次并行只读检查仍因 PowerShell 对不存在进程名返回非零状态而中断，锁文件检查未被可靠展示；后续改用 `Get-Process | Where-Object` 过滤并单独读取锁状态。
- 2026-08-04：❌ 并行检查 Git 进程、锁文件和 ACL 时，ACL 查询命令本身被系统拒绝，组合命令因此没有完整输出；后续拆成单项只读检查，避免一个权限错误遮蔽其他证据。

- 2026-08-04：❌ 阶段存档首次执行 `git add --sparse` 时无法创建 `.git/index.lock`，Git 返回 `Permission denied`；暂存未发生。需先检查真实 Git 进程、锁文件属性和 `.git` 写权限，再重试，不能直接删除未知来源的锁。

- 2026-08-04：✅ 本轮完成并验证 SSE 缓冲上限与 abort listener 清理：`relay.ts`、WebSocket bridge、payload rewrite 都限制未闭合 SSE 缓冲为 16 MiB；正常流仍原样转发，超限流会明确结束；inspection 完成后移除 abort listener；相关测试 63 个通过，`bun run typecheck` 通过。当前运行中的旧进程尚未重启，实际 RSS 下降需用户稍后重启应用后复测。

- 2026-08-04：❌ 记录测试补丁失败后，首次用 PowerShell 组合查询测试上下文和失败记录时引号未闭合，命令未执行；改用分开的简单命令读取，避免复杂嵌套引号。

- 2026-08-04：❌ 添加 SSE 缓冲上限回归测试时，首次 `apply_patch` 使用了不存在的文件尾部上下文，补丁未应用；后续必须先读取实际测试尾部再定位插入点。

- 2026-08-04：❌ 第一版“清理 abort listener + SSE 缓冲上限”补丁在把匿名回调改成可移除回调时，误把 `addEventListener` 的 `{ once: true }` 选项留在了箭头函数声明后，导致语法错误；检查阶段发现后未进入测试，修正为先声明回调、再显式注册，避免把补丁应用误判为可验证成功。

- 2026-08-04：创建排查指南，记录首次内存诊断结果与 WebSocket active turn 泄漏方向。
- 2026-08-04：二次只读检测确认 Codex 仅有两个 active 任务（当前 opencodex 排查任务与 `019fa6b1-4a0b-7ff3-b078-44ab1f307200`），后者包含多 Agent 活动；但 `/api/system/memory` 显示 `activeTurnCount=227`，最近 200 条请求日志中主要 conversation 为 `cbf95a10...` 171 条、`715d4110...` 21 条，绝大多数已有 `terminal/completed` 终态。判断：多 Agent 能解释高请求量，不能解释 227 个 turn 长期不释放，WebSocket turn 释放链仍是首要嫌疑。
- 2026-08-04：✅ 拉取并分析 `cockpit-tools` 与 `cc-switch` 代理源码。确认二者同样承担本地中转，但通过连接级 defer 清理、read/write deadline、heartbeat、pending request 删除、RAII active connection guard、流式首包/静默超时、usage collector finish/drop 清空等方式控制驻留内存。结论：OpenCodex 当前 1GB+ 占用更像应用层 WebSocket turn 未释放，不是中转站共性，也不应归咎于 Windows 桌面壳本身。
- 2026-08-04：✅ 直接检查本地原始基线与 fork 差异。`origin/main..HEAD` 在内存相关路径中只有 `src/server/index.ts` 的 9 行 hostname option 变更；`registerTurn/unregisterTurn`、`ws.data.cancel` 覆盖、`pumpResponsesSseToWebSocket` 均来自 v2.8.0 基线。另查上游当前 `main` 已有 turn admission/lease 硬化代码，本 fork 未包含；判断应优先按上游修复方向 backport，而非定义为 Windows 桌面端独有 bug。
- 2026-08-04：✅ 完成最小代码修复：`pumpResponsesSseToWebSocket` 在覆盖 `ws.data.cancel` 前保存原有外层 cancel hook，客户端关闭或 replacement turn 取消时会先触发外层 `turnAbort.abort()`，再 cancel SSE reader；新增测试覆盖外层 cancel hook 只触发一次且 reader cancel 仍执行。验证通过：`bun test tests\ws-endpoint.test.ts tests\shutdown-drain.test.ts`、`bun run typecheck`、`bun test tests\bridge-live-delivery.test.ts`。
- 2026-08-04：❌ 为不重启当前桌面会话而启动隔离新包 sidecar 时，第一次使用 PowerShell `Start-Process` 注入 `OPENCODEX_HOME`/`CODEX_HOME`，因当前环境同时存在大小写不同的 `PATH`/`Path` 键，PowerShell 在构造子进程环境字典时抛出重复键异常；sidecar 未启动。后续应避免 `Start-Process` 的环境字典合并路径，改用显式 `ProcessStartInfo` 环境或一次性临时启动脚本，并继续保持配置目录隔离。
- 2026-08-04：❌ 改用 `ProcessStartInfo`/`cmd.exe` 注入隔离环境后，Bun sidecar 进程确实启动，但在读取 `F:\workbuddy\opencodex\.tmp\isolated-sidecar\opencodex` 时立即报 `EPERM: operation not permitted, scandir` 并退出；当前尝试无法区分是沙箱对子进程临时目录的访问限制，还是目录权限继承问题。下一步改用项目内普通目录并检查 ACL/具体扫描调用，仍不触碰真实用户配置。
- 2026-08-04：✅ 在沙箱外用同一套隔离配置成功启动最新解包包，监听临时端口 `64419`，ready 消息确认版本 `2.8.0`、PID `16836`。连续三次 `/api/system/memory` 空闲采样：RSS `174.5–175.5 MB`、JSC heap `16.3–17.0 MB`、external `3.1–3.8 MB`、`activeTurnCount=0`、`activeTurns.count=0`、`responseState.totalBytes=0`。说明新包启动后没有凭空保留 turn 或 continuation；该结论是空闲基线，不等同于多 Agent 压力下的最终峰值。
- 2026-08-04：❌ 第一次为本轮排查记录建档时直接执行 `git add -- questions/Windows内存占用偏高排查指南.md`，被仓库 sparse-checkout 拒绝，提示该路径位于稀疏定义之外；未暂存其他文件。后续按 Git 提示使用 `git add --sparse`，继续保持单文件存档范围。
