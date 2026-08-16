# Windows 临时文件 ACL 排查指南

## 问题描述

在 Windows 上同步上游 response-state spill 逻辑后，测试中的 `responses-state.json.ocx.<pid>.<seq>.tmp` 临时文件被 ACL hardening 路径留成当前用户无法删除的状态，导致 `rmSync` / `Remove-Item -Recurse -Force` 报 `EACCES` 或“访问被拒绝”。

## 已尝试的修复方法及失败原因

- ❌ 2026-08-04：直接 `Remove-Item` 精确删除本次测试生成的 7 个 `ocx-state-test-*` 目录，失败；每个目录中的 `responses-state.json.ocx.*.tmp` 或 `responses-state-spill` 子目录拒绝访问。说明不是路径匹配问题，而是临时文件 ACL 状态已经阻止当前用户删除。

## 深层问题分析

response-state / spill 文件是本地 continuation 缓存。上游在这些文件上调用 Windows NTFS ACL hardening，但当前环境里的 `icacls`/ACL 组合可能在原子写失败路径中留下已写入但不可删除的临时文件。对桌面端而言，这会同时破坏 snapshot 发布、测试清理和长期临时文件卫生。

## 下一步排查策略

1. 对明确属于本轮测试生成的临时目录，用 `icacls` 精确恢复当前用户 Full Control。
2. 权限恢复后再执行精确 `Remove-Item`，不要扫描或删除整个 Temp。
3. 业务代码侧避免 response-state/spill cache 调用会破坏可删除性的 Windows ACL hardening；保留 chmod best-effort。

## 调试工具

- `Get-ChildItem <dir> -Force`
- `icacls <dir>`
- `Remove-Item -LiteralPath <exact> -Recurse -Force`

## 注意事项

只处理本次任务明确创建的 `ocx-state-test-*` / `ocx-mini-*` 临时目录。不要递归修改 `%TEMP%` 根目录权限，不要对未知目录批量 `takeown`。

## 更新记录

- ❌ 2026-08-04：首次精确删除 7 个测试残留目录失败，确认目录内 response-state 临时文件访问被拒绝。
- ❌ 2026-08-04：首次尝试 `icacls.exe ... /grant:r "$user:(OI)(CI)(F)"` 时，PowerShell 将 `$user:` 解析为非法变量引用，命令未执行。下一步改用 `"${user}:(OI)(CI)(F)"`。
- ✅ 2026-08-04：对 7 个精确测试残留目录执行 `icacls.exe <dir> /grant:r "${user}:(OI)(CI)(F)" /T /C` 后，再用 `Remove-Item -LiteralPath <paths> -Recurse -Force` 成功删除。关键经验：先恢复当前用户 Full Control，再删除；变量后紧跟冒号时必须写 `${user}`。
- ✅ 2026-08-04：上游同步验证后，按精确路径清理 `.tmp/upstream-sync`、`tests/.tmp-account-pool-mgmt-codex` 和本轮全量测试留下的 22 个 `ocx-*` Temp 目录。清理前先校验目标绝对路径只位于当前工作区或用户 Temp 下，本轮未再触发 ACL 拒绝。
