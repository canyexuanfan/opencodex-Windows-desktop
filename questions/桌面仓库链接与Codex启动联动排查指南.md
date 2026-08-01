# 桌面仓库链接与 Codex 启动联动排查指南

## 问题描述

用户在桌面端发现两个一致性问题：

- GitHub 入口仍指向原仓库 `lidge-jun/opencodex`，而当前本地 remote 是用户 fork `canyexuanfan/opencodex-Windows-desktop`。
- Dashboard 上“随 Codex 启动 opencodex”容易让用户误以为桌面端已经完整接管所有 Codex 启动场景。

## 已尝试的修复方法及失败原因

- ❌ 2026-08-02：初始桌面改造保留了原项目的 GitHub/Star 常量和 `package.json` 元数据，未随 fork 仓库迁移，导致桌面端底部 GitHub 入口仍打开原仓库。
- ❌ 2026-08-02：Dashboard 文案“随 Codex 启动 opencodex”过于笼统。实际实现中该开关只允许已经安装的 `codex-shim` 在 Codex CLI launcher 被调用时运行 `ocx ensure`；它不会自动安装 shim，也不能覆盖 Windows 上直接启动 `codex.exe`、Codex Desktop/app-server 绕过脚本 launcher 的场景。
- ❌ 2026-08-02：直接使用默认临时目录运行 `bun test tests/sidebar-routes.test.ts tests/sidebar-star-state.test.ts tests/update-job.test.ts tests/startup-health-ui.test.ts tests/startup-action-control.test.ts` 时，`tests/update-job.test.ts` 在 `C:\Users\wzm33\AppData\Local\Temp\ocx-update-job-*` 下发生 `EPERM rename/rm`，触发多例级联失败。该失败与本次仓库链接/UI 语义改动无关，属于当前 Windows 临时目录权限/句柄限制；需要改用已授权的 `C:\tmp` 隔离临时目录重跑。
- ❌ 2026-08-02：将 `TEMP/TMP` 指向 `C:\tmp\opencodex-github-startup-test-temp-20260802` 后，当前沙箱对该目录创建仍返回 `UnauthorizedAccess/EPERM`，导致测试在 `mkdtemp/mkdir` 阶段失败。不能继续假设 `C:\tmp` 在本轮 shell 中可写；改用项目工作区内 `.tmp` 作为隔离临时根。
- ❌ 2026-08-02：将 `TEMP/TMP` 指向项目 `.tmp` 后，默认 Bun 1.2.20 仍在 `tests/update-job.test.ts` 的 atomic write/cleanup 中触发 `EPERM rename/rm`。该失败与本次改动无关，符合既有记录中的 Windows Bun 1.2.20 兼容问题；下一步使用项目 bundled Bun 1.3.14 重跑。
- ❌ 2026-08-02：项目 bundled Bun 1.3.14 在沙箱内仍对 `tests/update-job.test.ts` 触发 `EPERM rename/rm/scandir`。因为同一批中 sidebar/star/startup UI 测试已通过，且失败集中在 atomic write 临时目录，下一步用非沙箱权限重跑同一 focused 套件，区分沙箱限制和真实代码回归。
- ❌ 2026-08-02：沙箱内清理本轮 `.tmp/github-startup-*` 测试残留时，`Remove-Item` 对 `ocx-update-job-*` 子目录返回 `UnauthorizedAccess`。目标路径已校验位于当前仓库 `.tmp` 下，下一步使用非沙箱权限删除这些精确临时目录。

## 深层问题分析

GitHub 链接有前后端两处来源：GUI 组件 fallback URL 和后端 `/api/github/star` 的 `STAR_REPO`。只改前端会导致 Star API 仍操作原仓库；只改后端则 GUI fallback 仍会打开原仓库。

Codex 启动联动有两层：配置项 `codexAutoStart` 是许可开关，真正的启动保护由 `codex-shim install` 或后台服务安装完成。桌面端已经复用管理 API 的 `install-shim`/`install-service`，但 Dashboard 概览里的单个开关不能被描述成完整安装动作。

## 下一步排查策略

1. 将 GUI GitHub fallback、后端 Star repo、包元数据统一迁移到 `canyexuanfan/opencodex-Windows-desktop`。
2. 更新 route/star 单测，防止回归到原仓库。
3. 从 Dashboard 概览移除 Codex CLI shim 许可开关，避免桌面端用户把它误解为日常“开启代理”步骤；启动安全页继续承担 service/shim 安装与风险检查。
4. 保留启动安全页的风险提示：Windows launcher shim 只覆盖 CLI 脚本，不覆盖 Codex Desktop 或直接 `codex.exe`。

## 调试工具

- `git remote -v`
- `rg "lidge-jun/opencodex|STAR_REPO|codexAutoStart" ...`
- `bun test tests/sidebar-routes.test.ts tests/sidebar-star-state.test.ts tests/startup-health-ui.test.ts tests/startup-action-control.test.ts`
- `$env:TEMP=".tmp\..."; $env:TMP=".tmp\..."; bun test ...`
- `.\node_modules\bun\bin\bun.exe test ...`
- 非沙箱重跑同一 focused 套件，用于排除 Windows sandbox 文件权限干扰。

## 注意事项

- 不把远端发布、push 或 GitHub Release 作为本地修复的一部分。
- 不在当前对话中重启或修改真实 Codex。
- 不把 CLI shim 夸大为 Codex Desktop 全覆盖；完整重启保护仍优先依赖后台服务。

## 更新记录

- 2026-08-02：创建本指南，记录 GitHub 仓库链接和 Codex 启动联动的首次排查结论。
- ✅ 2026-08-02：将桌面 Sidebar GitHub fallback、后端 `/api/github/star` 的 `STAR_REPO`、CLI 首次 star prompt、`package.json` 仓库/主页/issue 元数据、GUI 更新 release notes URL 统一迁移到 `canyexuanfan/opencodex-Windows-desktop`；`tests/sidebar-routes.test.ts` 与 `tests/update-job.test.ts` 同步更新。
- ✅ 2026-08-02：从 Dashboard 概览移除 Codex CLI shim 许可开关，避免桌面端用户误以为日常代理使用还需要安装 shim；启动安全页继续保留 service/shim 安装与风险检查能力。桌面端日常路径是打开 OpenCodex 自动启动/复用本地代理，必要时点击开启/重启代理。
- ✅ 2026-08-02：验证通过：`bun run typecheck`、`cd gui && bun run lint:i18n`、`cd gui && bun run lint`、`cd gui && bun run build`、`cd desktop && bun run build`、`cd desktop && bun test tests/package-static.test.ts`、非沙箱 bundled Bun 1.3.14 focused 测试 68/68。已重新生成桌面资源和 NSIS/Portable 包；Setup SHA-256=`4CA2FE68EB4EE06D94404F164584FF172B9A180A3EC9B1E2EB0C666B1FEDAFF2`，Portable SHA-256=`2565A04FEA63E6841D9DEF31D9D3CB532BD719CB627B33FF0F692988023C4328`。
- ✅ 2026-08-02：使用非沙箱权限清理本轮 7 个 `.tmp/github-startup-*` 测试/打包隔离目录，复核无残留；未清理无关 `.tmp` 内容。
