# Windows 桌面打包临时目录 ACL 排查指南

## 问题描述

在 Windows 本机为桌面端生成安装包时，`desktop` 目录下执行 `bun run package`，进入 `scripts/prepare-desktop-resources.ts` 的生产依赖安装阶段后失败：

`AccessDenied accessing temporary directory. Please set $BUN_TMPDIR or $BUN_INSTALL`

## 已尝试的修复方法及失败原因

- ❌ 2026-08-04：直接执行 `bun run package`。失败原因是 Bun 默认临时目录在当前 Windows/沙箱环境中访问受限，生产依赖安装无法创建或访问临时文件。
- ❌ 2026-08-04：设置 `BUN_TMPDIR='F:\\workbuddy\\opencodex\\.tmp\\bun-tmp'` 后重试仍失败。失败原因可能是 PowerShell 单引号里的双反斜杠被按字面值传入，导致 Bun 没有得到可用的 Windows 路径；下一步改用 `F:\workbuddy\opencodex\.tmp\bun-tmp`。
- ❌ 2026-08-04：创建仓库根 `.tmp\bun-tmp` / `.tmp\bun-install` 并同时设置 `BUN_TMPDIR`、`BUN_INSTALL`、`TEMP`、`TMP` 后，打包不再立刻报 ACL，但在 `prepare-desktop-resources.ts` 的生产依赖安装阶段超过 240 秒无输出被截断。下一步拆开执行 staging 目录里的 `bun install --production`，确认是否为依赖安装或缓存访问卡住。
- ❌ 2026-08-04：改为从根 `node_modules` 复制生产依赖后，资源准备、桌面 TypeScript 编译和 Electron 解包均通过，但 NSIS 阶段尝试写入 `C:\Users\wzm33\AppData\Local\electron-builder\Cache` 时 `EPERM`。下一步把 `ELECTRON_BUILDER_CACHE` 指向工作区 `.tmp\electron-builder-cache` 后重试，避免访问用户目录缓存。
- ✅ 2026-08-04：成功方法是让 `prepare-desktop-resources.ts` 为桌面 staging 生成去掉 `bun` 依赖的 package metadata，并从根 `node_modules` 递归复制生产依赖；同时设置 `ELECTRON_BUILDER_CACHE=F:\workbuddy\opencodex\.tmp\electron-builder-cache`。最终 `bun run package` 成功生成 `desktop/out/OpenCodex-Setup-2.10.0-x64.exe` 和 blockmap。

## 深层问题分析

这个问题不属于桌面端代码编译错误，也不是安装包配置缺资源，而是 Bun 在子进程安装生产依赖时使用了受 ACL 影响的默认临时目录。桌面端打包会重新准备 `desktop/resources/staging/opencodex`，因此依赖安装阶段必须有一个当前用户可写、可删除的临时目录。

## 下一步排查策略

1. 在当前工作区内创建 `.tmp/bun-tmp`，避免使用系统 `%TEMP%`。
2. 为打包命令设置 `BUN_TMPDIR=F:\workbuddy\opencodex\.tmp\bun-tmp` 后重试。
3. 打包成功后检查 `desktop/out` 产物，并清理本次临时目录。

## 调试工具

- `bun run package`
- `Get-ChildItem desktop/out`
- `git status --short`

## 注意事项

只使用当前工作区内的 `.tmp/bun-tmp` 作为临时目录，不修改系统 PATH、用户全局 Bun 配置或系统 Temp 权限。

## 更新记录

- ❌ 2026-08-04：记录首次直接打包失败，下一步改用工作区内 `BUN_TMPDIR`。
- ❌ 2026-08-04：记录第一次 `BUN_TMPDIR` 重试失败，下一步修正路径格式并验证环境变量传入。
- ❌ 2026-08-04：记录精确临时目录后打包超时，下一步拆分资源准备命令。
- ❌ 2026-08-04：记录 electron-builder 默认缓存目录 EPERM，下一步改用工作区缓存目录。
- ✅ 2026-08-04：桌面安装包生成成功，关键经验是桌面包不需要在 staging 内重新安装 `bun` npm 包，因为运行时已经通过 `runtime/bun.exe` 单独内置；electron-builder 缓存也应固定到工作区内。
