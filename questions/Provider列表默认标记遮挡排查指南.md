# Provider 列表默认标记遮挡排查指南

## 问题描述

Provider 列表行尾的五角星表示当前默认 Provider，但它常驻在状态点旁边。鼠标 hover 时删除按钮浮出到同一区域，导致星标和删除按钮视觉遮挡，用户既不清楚星标含义，也不容易判断删除按钮是否可点。

## 已尝试的修复方法及失败原因

- ❌ 2026-08-02：首次用 `apply_patch` 直接改 `rail-hover-delete.test.ts` 时，旧注释里的编码显示和实际文本不一致，导致上下文匹配失败。下一步改为整体替换这个小型静态测试文件，避免继续被注释乱码卡住。

## 深层问题分析

Provider rail 行本身是 `<button role="option">`，删除按钮不能作为交互子元素嵌进去。旧删除按钮已经作为 row wrapper 的 sibling 绝对定位；默认星标如果仍放在行内部，就会和 sibling 浮层抢同一个右侧区域。更稳的结构是把星标和删除按钮都放进同一个 hover 操作组，操作组作为行的 sibling，默认隐藏，hover/focus-within 时显示。

## 下一步排查策略

1. 从 `RailRow` 中移除常驻 `pwi-default-star`。
2. 在 `ProviderWorkspaceShell` 的 row wrapper 中新增 `pws-rail-row-actions`，星标在左，删除按钮在右。
3. 操作组默认隐藏，hover/focus-within 显示；touch 无 hover 时隐藏。
4. 补 DOM 与静态测试，确认星标不在 option 内、不进入无障碍树、且顺序在删除按钮左侧。

## 调试工具

- `gui/tests/rail-hover-delete.test.ts`
- `gui/tests/rail-hover-delete-dom.test.tsx`
- `gui/src/styles/provider-workspace-shell.css`

## 注意事项

- 不要把删除按钮放回 `RailRow` 内部，否则会形成 button 内嵌 button 的无效 HTML。
- 键盘和读屏用户已经有详情页头部的删除按钮，hover 加速器应保持鼠标辅助性质。

## 更新记录

- ❌ 2026-08-02：确认常驻默认星标会被 hover 删除按钮遮挡，且首次测试 patch 被旧注释编码差异阻断。
- ❌ 2026-08-02：按“默认星标常驻、hover 左移让出删除按钮”调整实现后，定向 GUI DOM 测试通过，但静态源码测试仍按旧实现查找精确 `className="pws-rail-row-actions"`，遇到模板字符串追加 `pws-rail-row-actions--default` 后误报失败；下一步改为检查稳定 class token 和相对顺序，不再依赖完整 className 字面量。
- ✅ 2026-08-02：最终采用同级 hover 操作组：默认 Provider 的星标常驻显示，删除按钮默认宽度为 0；hover/focus-within 时删除按钮展开为 24px，星标自然位于删除按钮左侧。非默认 Provider 的操作组仍默认隐藏。定向验证：`cd gui && bun test tests\rail-hover-delete.test.ts tests\rail-hover-delete-dom.test.tsx` 11/11、67 个断言通过。
