# 桌面端关闭后 Codex 死路由排查指南

## 问题描述

桌面端通过 `config.toml` 注入带有 `# Auto-injected by opencodex` 标记的本地路由。代理退出后，如果配置仍指向 `http://127.0.0.1:<port>/v1`，Codex 会在代理未运行时收到 `502 Bad Gateway` 或连接失败。

## 已尝试的修复方法及失败原因

- ❌ 2026-08-01：检查 CLI 的 `ocx stop`、service stop/uninstall 和 `restoreNativeCodex()`。这些路径已经能恢复配置，但桌面 sidecar 的 `shutdown()` 只调用 `drainAndShutdown()` 与运行时文件清理，没有调用恢复函数；Electron 的托盘停止和退出因此仍会留下死路由。
- ❌ 2026-08-01：运行 `bun test desktop/tests/lifecycle-static.test.ts tests/codex-inject.test.ts tests/codex-inject-integration.test.ts` 时，纯函数注入测试通过，但隔离 home 的 10 个集成用例在子进程中返回状态码 1，并在清理临时目录时出现 Windows `EACCES`。当前先不把该结果视为修复验证通过，需要单独捕获子进程 stderr 并用更小范围测试定位环境锁定原因。
- ❌ 2026-08-01：首次运行桌面静态测试时漏写 `./` 路径前缀，Bun 将其当作过滤器而没有执行测试；随后改用明确的 `bun test ./desktop/tests/lifecycle-static.test.ts`。
- ❌ 2026-08-01：桌面静态测试把 sidecar 入口误读为 `desktop/src/entry.ts`，但实际入口位于根目录 `src/desktop/entry.ts`；测试因此出现 `ENOENT`，已调整为读取真实源码路径。
- ❌ 2026-08-01：隔离 sidecar smoke 使用 `%TEMP%` 目录时，sidecar 能监听端口并输出启动日志，但在写入 `OPENCODEX_HOME` 时遇到 Windows `EPERM lstat`，未能产出 ready；按现有最小权限经验改用 `C:\tmp` 隔离根重试，并保留 stderr 作为证据。
- ❌ 2026-08-01：当前沙箱对 `C:\tmp` 子目录创建也返回 `EPERM`，因此第二次 smoke 尚未开始；改用项目自身 `.tmp` 下的隔离目录，并在脚本结束时清理。
- ❌ 2026-08-01：项目 `.tmp` 下动态创建的隔离 `OPENCODEX_HOME` 仍在 sidecar lstat 阶段返回 `EPERM`；这与此前 Bun 子进程临时 home 的已知权限限制一致，改用预先存在的工作区目录继续验证。
- ❌ 2026-08-01：预先存在的工作区隔离目录仍在 Bun 子进程 lstat 阶段返回 `EPERM`，因此本机沙箱无法完成真实 sidecar 注入/stop smoke；桌面静态生命周期、根 typecheck 和既有注入纯函数测试已通过，真实闭环留待授权 Windows/VM 环境复核。
- ❌ 2026-08-01：在授权 `C:\tmp` 环境运行真实 sidecar 注入/stop smoke 后，sidecar 输出普通启动日志但未在 30 秒内输出 ready；外层命令 120 秒超时，未获得可证明的 stop 恢复结果。该次作为有界失败保留，不宣称真实闭环通过。
- ❌ 2026-08-01：新增 GUI 能力对齐测试初版把 `combos` 当成侧边栏 `NAV` 项；原 GUI 是通过页面渲染/深链提供该能力而非侧边栏直列，测试误报后改为检查 `page ===` 渲染分支。

## 深层问题分析

桌面端启动后由 `syncModelsToCodex(port)` 写入配置，端口是动态 loopback 端口。正常停止时 sidecar 能执行异步退出，但恢复动作缺失；强制终止时任何退出钩子都可能来不及执行。因此需要两层保护：由拥有代理的 sidecar 在正常停止前恢复 native Codex；下一次桌面 sidecar 启动、确认没有健康外部代理后，先清理上次崩溃留下的 marker-owned 路由，再启动并重新注入本次端口。

## 下一步排查策略

1. 只允许 desktop sidecar 在自己完成注入且自己拥有代理时恢复配置，避免误伤外部运行中的 OpenCodex service。
2. 为正常 stop、进程信号、下次启动自愈增加静态生命周期测试。
3. 在隔离 `CODEX_HOME` 中验证注入 -> sidecar stop/recovery -> native config 的闭环。

## 调试工具

- `src/desktop/entry.ts`
- `src/codex/inject.ts` 的 `restoreNativeCodex()`、`isCodexRoutingInjected()`
- `desktop/tests/lifecycle-static.test.ts`
- `tests/codex-inject-integration.test.ts`

## 注意事项

- 用户自行配置的 `openai_base_url` 没有 OpenCodex marker 时不得删除。
- 已存在且健康的外部代理由其他进程拥有时，桌面端不能替它恢复配置或停止它。
- 强制终止无法保证即时执行 JavaScript 清理，因此启动自愈是必要的第二道保护。

## 更新记录

- 2026-08-01：确认桌面端缺少 Codex 路由恢复调用，待实现并验证。
- ✅ 2026-08-01：`src/desktop/entry.ts` 已在正常 stop 前恢复 native Codex，并在无健康外部 proxy 时启动前清理 stale marker；`bun test ./desktop/tests/lifecycle-static.test.ts`、`Push-Location desktop; bun test ./tests`（13/13）和 `bun run typecheck` 通过。真实子进程 smoke 受当前沙箱 EPERM 限制，已明确记录而未伪称通过。

## 2026-08-01 复现线索：未运行代理仍被注入及端口漂移

用户复现：`ocx status` 显示代理未运行/默认端口不可达，但 `config.toml` 仍保留此前动态端口的 `openai_base_url`（例如 37692、1496）。审计确认 `syncModelsToCodex(undefined)` 会回退到 `config.port`/10100，并且 `ocx init` 直接调用 `injectCodexConfig`，因此注入前没有统一的 `/healthz` 存活门槛；这能把死端口写进 Codex 配置。`findLiveProxy()` 已具备 runtime-port + `/healthz` 身份探测，应该成为同步和注入流程的唯一实际端口来源。

排查策略：同步前必须找到健康的 OpenCodex proxy；若没有健康实例，先 `restoreNativeCodex()` 并返回失败结果，绝不刷新/写入 Codex 路由。若调用方传入的端口与健康实例端口不一致，以健康实例的 runtime-port 端口为准。`ocx init` 在代理未运行时不再提前写入死路由；`ocx ensure` 启动失败或自动启动关闭时也执行 stale route 恢复。

- ❌ 2026-08-01：首次运行 `bun test ./tests/codex-sync-api.test.ts` 后，既有同步单测均因未提供健康 proxy mock 而提前恢复；随后清理测试临时目录又遇到 Windows `EACCES`。这证明新 liveness 门槛已生效，但测试夹具需要显式提供 live runtime 端口，并按既有临时目录权限经验重试。
- ❌ 2026-08-01：补齐同步测试的 live-port mock 后重跑，测试夹具残留目录 `tests/.tmp-codex-sync-api` 仍被 Bun/Windows 锁定，所有用例在 `beforeEach` 的递归清理处失败；代码验证需改用授权临时根或先确认锁定进程，再重新执行。
- ❌ 2026-08-01：确认没有残留 Bun/Node 测试进程后，默认 PowerShell 对该精确测试目录执行 `Remove-Item -Recurse -Force` 仍在子目录 `opencodex` 返回 `UnauthorizedAccessException`；不能把普通清理失败误报为代码失败，后续使用授权临时根运行并保留该环境限制。

- ✅ 2026-08-01：`syncModelsToCodex` 已强制使用 `findLiveProxy()` 的 runtime-port + `/healthz` 结果；无健康代理时先恢复 marker-owned Codex 路由并拒绝刷新/注入，传入端口漂移时改用实际 live 端口。`ocx init`、`ocx ensure` 和管理 API 已分别接入未运行恢复、启动失败恢复和可信服务端口路径。回归结果：同步/生命周期/启动测试 36/36，注入测试 27/27，桌面测试 14/14，桌面静态测试 4/4，typecheck 和 privacy scan 通过。
