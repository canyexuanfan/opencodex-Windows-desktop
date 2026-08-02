# PowerShell 变量命名排查指南

## 问题描述

执行桌面产物隔离 smoke 时使用了 `$home` 作为临时配置目录变量。PowerShell 变量名不区分大小写，`$home` 会解析为只读的自动变量 `$HOME`，因此临时路径赋值失败。

## 已尝试的方法及结果

- ❌ 在便携版启动命令中使用 `$home=Join-Path ...`：返回“无法覆盖变量 HOME”，应用进程随后退出；本次未建立隔离环境，不能作为有效 smoke 证据。
- ❌ 使用 `Start-Process -RedirectStandardOutput/-RedirectStandardError` 捕获便携版日志：当前 PowerShell 环境同时存在大小写不同的 `PATH`/`Path` 键，`Start-Process` 报“字典中的关键字 PATH 已添加 Path”，未启动目标进程。
- ❌ 用 `.NET ProcessStartInfo.Environment[...]` 注入 sidecar 环境：当前 PowerShell/.NET 版本该属性为空，应使用 `EnvironmentVariables`；本次子进程未收到隔离环境，退出码为 `-1073740791`。

## 深层问题分析

PowerShell 自动变量 `$HOME` 在 Windows 环境中也以大小写不敏感方式匹配 `$home`。任务脚本变量必须避开系统常量和常见自动变量。

## 下一步排查策略

使用 `$smokeHomePath`、`$codexHomePath` 等任务专用变量，启动前确认目录已创建，启动后检查进程、监听端口和临时配置文件。
- 如需保留原始环境，不通过 `Start-Process` 重建环境字典；可使用 `cmd /c` 设置两个临时环境变量后启动，避免 `PATH`/`Path` 大小写冲突。

## 调试工具

- `Get-Process OpenCodex,bun`
- `Get-NetTCPConnection -State Listen`
- `Test-Path`

## 注意事项

不要覆盖 `$HOME`、`$home` 或 `$CODEX_HOME` 等系统/环境变量名；环境变量只通过 `$env:` 前缀设置。

## 更新记录

- 2026-08-01：记录便携版 smoke 中 `$home` 变量冲突，准备使用任务专用变量重试。
- ✅ 2026-08-01：改用 `$smokeHomePath` 等任务变量，并给 Electron 传入全新 `--user-data-dir` 后，签名 portable 和安装版入口均能保持运行；清理时按明确 PID 停止本次 smoke 子进程。
- ❌ 2026-08-01：从中文/空格安装路径启动冒烟时再次使用 `$home`、`$codex` 变量，PowerShell 报 `$HOME` 只读变量冲突；虽然误用默认用户目录的进程取得了 healthz/models 结果，但该次不能作为隔离环境证据。后续必须使用 `$smokeHomePath`、`$smokeCodexPath` 等不冲突变量，并清理误用目录。
- ❌ 2026-08-02：阶段 38 真实环境只读验收脚本中再次使用 `foreach ($home in $homeCandidates)`，PowerShell 大小写不敏感地把 `$home` 视为只读 `$HOME`，导致 runtime health 与 provider config 检查未执行完成。已取得的安装包/快捷方式/进程证据可保留，但健康端口和配置摘要必须改用 `$userHomePath` 等安全变量名后重跑。
- ✅ 2026-08-02：阶段 38 只读验收脚本改用 `$userHomePath` / `$userHomePaths` 后成功重跑；安装包签名、开始菜单快捷方式、运行进程、Codex 配置和 OpenCodex ACL 边界均取得有效证据。关键经验：循环变量也不能叫 `$home`，不仅是显式赋值变量不能叫 `$home`。
- ✅ 2026-08-01：按已有经验改用 `$smokeHomePath`、`$smokeCodexPath`、`$smokeElectronDataPath`，重跑安装版 Unicode 路径冒烟成功（动态端口 2430、healthz/models 均 200）；精确停止 5 个本次子进程，卸载并清理隔离根，确认 `C:\Users\wzm33\runtime-port.json` 与 `ocx.pid` 均不存在。
