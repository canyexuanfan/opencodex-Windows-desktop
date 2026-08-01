# 桌面 GUI 视觉验收排查指南

## 问题描述

需要在真实 Windows Electron 会话中核对 OpenCodex 主窗口、单实例、键盘焦点和页面视觉，但普通屏幕区域截图可能被其他前台窗口遮挡，不能作为目标窗口证据。

## 已尝试的修复方法及失败原因

- ❌ 2026-08-01：通过 `SetForegroundWindow` 后使用 `Graphics.CopyFromScreen` 按 OpenCodex 窗口矩形截图；输出被其他应用窗口覆盖，未捕获到可辨认的 OpenCodex Dashboard。Windows 前台切换策略或当前桌面焦点阻止了目标窗口置顶，该图片不计入验收。
- ❌ 2026-08-01：`PrintWindow` 已能直接捕获 Dashboard，但仅调用 `SetCursorPos` 的首次 hover 探针在侧栏目标区域产生 0 个变化像素；OpenCodex 仍位于其他窗口后方，鼠标命中遮挡窗口而非目标 HWND。下一次仅临时将 OpenCodex 设为 topmost，捕获后立即撤销。
- ❌ 2026-08-01：首次键盘 Tab 探针后通过 `Get-Process.MainWindowHandle` 取得的窗口矩形变为 `158×26`，`PrintWindow` 只得到标题栏片段；该句柄/窗口状态不能证明页面 focus。下一步枚举主进程全部顶层 HWND、可见性和矩形，选择真实 BrowserWindow 后再发送键盘事件。
- ❌ 2026-08-01：审计“启动保护”隐藏页时按猜测路径读取 `gui/src/pages/StartupPage.tsx`，文件不存在；后续先用 `rg --files gui/src` 定位真实组件，再读取实现，不重复猜测页面文件名。

## 深层问题分析

`CopyFromScreen` 捕获的是桌面最终合成结果，不是指定 HWND 的离屏内容。即使窗口句柄、标题和矩形正确，前台切换受系统策略拒绝或其他置顶窗口覆盖时，截图仍会包含无关应用。应直接请求窗口绘制，或使用 Electron/Chromium 自身的页面捕获能力。

## 下一步排查策略

1. 优先使用 Win32 `PrintWindow(PW_RENDERFULLCONTENT)` 直接抓取 OpenCodex HWND。
2. 若 Electron GPU 表面返回黑屏，再通过 DevTools Protocol 或 BrowserWindow `capturePage()` 增加仅测试期捕获，不修改产品代码。
3. 截图成功后再执行 Tab/Shift+Tab/Escape 等固定键盘动作，并比较焦点或后续截图。

## 调试工具

- `Get-Process` 的 `MainWindowHandle` / `MainWindowTitle`
- Win32 `GetWindowRect`、`PrintWindow`
- `System.Drawing.Bitmap`
- 本地 `view_image` 视觉检查

## 注意事项

- 截图不得包含或上传用户真实聊天、账号、密钥和其他应用内容；误捕获图片只保存在忽略的 `.tmp` 并在本轮清理。
- GUI 验收使用隔离 `OPENCODEX_HOME`、`CODEX_HOME` 和 Electron `--user-data-dir`。
- 停止时按本轮主进程及子进程精确回收，不使用广泛 `taskkill`。

## 更新记录

- 2026-08-01：记录屏幕截图被其他窗口遮挡，改用指定 HWND 的窗口内容捕获。
- ✅ 2026-08-01：对阶段 20 最新 `win-unpacked` 使用 `PrintWindow(PW_RENDERFULLCONTENT)` 成功捕获完整 Dashboard；窗口显示在线、版本 2.8.0、原侧栏和管理卡片，未出现第二窗口或缩水页面。
- ✅ 2026-08-01：临时将目标窗口设为 topmost 后，鼠标命中“模型”侧栏项并显示真实 hover 背景；捕获完成立即撤销 topmost。
- ✅ 2026-08-01：以 `--force-renderer-accessibility` 重启隔离实例后，UI Automation 枚举 48 个可聚焦元素；从“仪表盘”设置焦点并发送 Tab，焦点移动到“Codex 认证”，`HasKeyboardFocus=true`，`PrintWindow` 图像可见清晰 focus-visible 外框。
- ✅ 2026-08-01：同一真实窗口验证第二实例退出码 0、主进程/窗口各 1、sidecar PID 与端口不变；关闭主窗口后窗口隐藏但 healthz=200，再次启动恢复同一 1281×820 窗口。
- ✅ 2026-08-01：所有 GUI 测试使用隔离 home；退出前由包内 CLI 恢复 native Codex，随后精确停止本轮进程。含其他应用内容的误捕获图及全部验收截图均已从 `.tmp` 删除，未进入 Git。
- ✅ 2026-08-01：阶段 21 通过 UI Automation 逐项调用 11 个侧栏页面，每页均出现非空主内容和可聚焦控件；另从 Dashboard 的“重启后 Codex 可能无法访问模型”链接进入 `startup`，从模型页“组合 → 设置”进入 `combos`，确认 Page 联合类型的 13/13 页面均可达。该证据是页面可达/基本交互验收，不替代外部环境的全部控件逐项视觉检查。
- ✅ 2026-08-01：最终包复用外部 CLI 时，真实窗口可访问性树显示“由外部 CLI 管理”按钮且 `Enabled=false`；避免把“停止/重启 helper”误表述成外部代理生命周期操作。
- ❌ 2026-08-01：阶段 21 停止确认握手成品 smoke 首次以 `Start-Process -WindowStyle Hidden` 启动 `win-unpacked`；动态端口 62963、healthz 正常，但 20 秒内 UIAutomation 找不到隔离进程树的“停止代理”按钮。精确进程树显示主进程/renderer/sidecar 均正常，失败来自隐藏窗口不可访问，不是代理或握手断言。保持同一实例，下一步只把该测试窗口恢复可见后重试，不启动第二实例。
- ❌ 2026-08-01：用同一 user-data-dir 的第二实例请求成功聚焦原窗口并枚举到“停止代理”，但随后用 PowerShell 构造 UIAutomation `AndCondition` 精确查找时返回空；窗口和按钮此前均已证实存在，失败是条件对象构造/重查方式不稳定。下一步沿用已验证的全树枚举后按 PID/Name 过滤，不重复复合条件构造。
- ❌ 2026-08-01：第二实例聚焦命令结束后再独立执行全树枚举，原测试主进程的 `MainWindowHandle` 已回到 0，按钮不可见；代理/62963 仍健康。说明最初用 `-WindowStyle Hidden` 创建的宿主只在第二实例聚焦处理期间短暂暴露窗口。下一次把“同一 user-data-dir 二次聚焦 → 枚举 → 调用停止”放进同一个有界命令，不重启主实例或代理。
- ✅ 2026-08-01：保持原 PID 12872/sidecar 24900/端口 62963 不变，把二次聚焦、UIAutomation 枚举和按钮调用放在同一命令内后成功触发停止确认；成品 sidecar 输出新 `stopped` 确认并 exit 0，`runtime-port.json=False`、sidecar 不存在，隔离 Codex 未保留 managed 路由。随后用相同单实例聚焦方式点击离线页“退出”，Electron 主 PID 12872 正常结束。证明最终 `win-unpacked` 的 ack+exit 0 握手和离线退出链实际可用。
- ❌ 2026-08-01：阶段 22 全量交互契约审计确认全局 `:focus-visible`、主要按钮/导航/Select/rail 已有基础覆盖，但仍缺少一批明确 hover/键盘行为：共享 input/checkbox/radio/range、switch/toggle、link/copy 控件、catalog/usage/filter/sort tabs、collapsible heading；`SectionTabs`、Provider catalog tabs 与 Combo detail tabs 缺少一致的 ArrowLeft/ArrowRight/Home/End roving focus；离线页 disabled 按钮仍会命中 hover。下一步先补共享 CSS 与可复用 tab keydown helper，再用隔离 Happy DOM/静态契约测试验证，不启动真实 Codex；完成后仍需对最终成品做可见窗口抽样，不能仅凭静态选择器宣称全部视觉验收。
- ✅ 2026-08-01：阶段 22 按一次审计结果集中补齐全部已识别交互缺口；三个 tab 组统一使用共享 roving helper，hover/focus-visible/disabled 选择器由静态契约守护。GUI 定向 29/29、193 个断言，lint、i18n lint、build 通过；desktop typecheck 与 21/21、119 个断言通过。最终重包资源中的压缩 CSS 已确认包含新增选择器，桌面离线页编译产物包含 `:hover:not(:disabled)`，没有启动真实 Codex。
- ❌ 2026-08-01：阶段 22 暂存后 `git diff --cached --check` 发现两个新 GUI 测试文件各自多一个 EOF 空白行；业务测试已通过，但提交格式门不通过。下一步只删除这两个精确文件的尾部多余空行，重新暂存并复核，不修改测试逻辑或产品代码。
- ✅ 2026-08-01：仅删除 `interaction-states-static.test.ts` 与 `roving-tabs.test.ts` 的尾部多余空白行并重新暂存，`git diff --cached --check` 无输出、退出 0；测试逻辑和产品代码未改变。
