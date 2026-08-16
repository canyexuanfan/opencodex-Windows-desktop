# Windows 进程诊断权限排查指南

## 问题描述

为确认根测试是否有并发 Bun runner 时，执行 `Get-CimInstance Win32_Process` 查询命令行返回 `拒绝访问`（HRESULT `0x80041003`）。

## 已尝试的方法及结果

- ❌ `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'bun.*test|scripts/test' }`：当前沙箱无权读取 WMI 进程命令行。

## 深层问题分析

WMI 进程命令行属于受限诊断信息；该权限失败与 Bun 测试断言、桌面端代码和 Git 工作树无关。

## 下一步排查策略

使用不读取命令行的 `Get-Process` 检查进程名，或直接运行目标测试并记录退出码；不要为普通测试诊断扩大系统权限。

## 调试工具

- `Get-Process bun,electron -ErrorAction SilentlyContinue`
- `bun run test`

## 注意事项

不要因 WMI 查询失败就结束产品验证，也不要停止不属于当前任务的进程。

## 更新记录

- ❌ 2026-08-04：同步上游时，为确认超时残留 `git.exe` 的命令行，默认权限执行 `Get-CimInstance Win32_Process -Filter "name='git.exe'"` 失败，报 `拒绝访问 / HRESULT 0x80041003`。下一步不依赖 WMI 命令行读取作为必要条件，改用已知启动时间、进程名与精确 PID 控制，并在需要终止残留进程时只对确认的 PID 做最小授权操作。
- 2026-08-01：记录 WMI 进程命令行查询被拒绝，改用低权限检查。
- ✅ 2026-08-01：`Get-Process bun,electron` 未读取命令行即可确认测试前无进程；根测试超时后按本次运行的启动时间和可执行路径定位 6 个 Bun 子进程，逐一停止并确认无 Bun 残留。
- ❌ 2026-08-03：调查本机 OpenCodex 桌面端闪退时再次执行 `Get-CimInstance Win32_Process` 读取 OpenCodex/Bun/Codex 命令行，返回 `HRESULT 0x80041003 / 拒绝访问`。该失败仅表示当前权限无法读取 WMI 进程命令行，不能据此判断桌面端崩溃原因；继续改用 `Get-Process`、安装目录、`.opencodex` runtime 文件和 Windows 事件日志。
