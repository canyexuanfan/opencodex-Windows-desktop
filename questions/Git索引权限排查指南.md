# Git 索引权限排查指南

## 问题描述

收尾阶段执行 `git add -- todolist.md "docs/Windows桌面端安装与验证.md"` 时，Git 报错：

```text
fatal: Unable to create 'F:/workbuddy/opencodex/.git/index.lock': Permission denied
```

工作树中的源文件仍可读写，`.git/index.lock` 未发现残留文件；问题发生在当前执行环境对 Git 元数据目录的写权限边界，而不是目标文件内容或仓库锁冲突。

## 已尝试的方法及结果

- ❌ 在默认沙箱权限下执行 `git add`：Git 无法创建 `.git/index.lock`，未完成暂存。
- ❌ 以普通 pathspec 暂存排查文档：仓库启用了 sparse-checkout，`questions/` 位于稀疏范围外，Git 提示 `outside of your sparse-checkout definition`，因此未改变索引。

## 深层问题分析

当前任务环境将工作树写权限与 `.git` 元数据写权限分开控制。提交和 tag 需要写入 index、objects、refs，因此仅有工作树写权限不足。

## 下一步排查策略

1. 先确认 `.git/index.lock` 不存在，避免误删其他进程的锁。
2. 使用最小范围的 Git 暂存/提交授权重试，只包含本阶段明确文件。
3. 若需归档稀疏范围外的排查记录，使用显式 `git add --sparse -- <path>`；否则保留为未跟踪过程资料。
4. 归档后重新检查 `git status --short`，确认用户已有未跟踪文件未被纳入提交。

## 调试工具

- `Get-ChildItem -Force .git`
- `git status --short`
- `git diff --check`

## 注意事项

不要用 `git reset --hard`、删除 `.git/index.lock` 或全量 `git add .` 绕过问题；先确认锁文件状态和提交范围。

## 更新记录

- ❌ 2026-08-01：本阶段尝试暂存桌面路由恢复、托盘重启、能力对齐测试、`todolist.md` 和新排查指南时，`.git/index.lock` 仍无法创建；已确认 `.git/index.lock` 不存在，属于当前执行环境对 Git 元数据目录的写权限限制，尚未修改索引。
- ❌ 2026-08-01：获得最小 Git 元数据写权限后，普通 `git add` 又被仓库 sparse-checkout 规则拒绝（桌面源码和新问题指南在稀疏范围外）；按既有指南改用 `git add --sparse -- <明确文件>`，不扩大稀疏范围。

- 2026-08-01：记录默认沙箱阻止 Git index 写入的失败现象，等待最小授权重试。
- ✅ 2026-08-01：在确认没有 `.git/index.lock` 残留后，以最小范围授权暂存 `todolist.md` 与 `docs/Windows桌面端安装与验证.md` 成功；未纳入已有用户未跟踪文件。
- ✅ 2026-08-01：本阶段默认权限再次无法创建 `.git/index.lock`；确认锁文件不存在后，使用最小授权并按 sparse-checkout 规则执行 `git add --sparse -- desktop/package.json desktop/tests/package-static.test.ts questions/中文空格安装路径排查指南.md questions/阶段0基线依赖缺失排查指南.md todolist.md` 成功暂存，用户已有的两个未跟踪文件仍未纳入。
- ❌ 2026-08-01：preload 修复收尾再次在默认权限下执行精确 `git add --sparse`，仍无法创建 `.git/index.lock`；未改变索引，需等待可用的最小 Git 元数据授权后暂存。
- ❌ 2026-08-01：按既有最小授权规则重试精确 `git add --sparse`，平台因当前执行额度耗尽拒绝授权请求；未绕过授权边界，也未改变索引，提交/tag 暂时无法完成。
- ❌ 2026-08-01：本阶段路由健康门修复完成后按最小文件清单执行 `git add --sparse`，确认没有 `.git/index.lock` 残留但默认权限仍无法创建锁文件；按既有记录改用最小范围授权重试，未改动未跟踪用户文档。
- ❌ 2026-08-01：本轮收尾在默认权限下执行 `git add -- todolist.md questions/桌面端启动链排查指南.md questions/阶段0基线依赖缺失排查指南.md`，Git 因 `questions/` 位于 sparse-checkout 范围外而拒绝更新索引；未改变索引，需按既有指南使用 `git add --sparse` 的精确文件清单重试。
- ❌ 2026-08-02：阶段 30 收尾首次执行普通 `git add` 暂存桌面源码、测试和 `questions/` 文档，被 sparse-checkout 拒绝，提示相关路径在稀疏范围外；未改变索引。继续按既有经验使用 `git add --sparse -- <精确文件清单>`，不扩大 sparse-checkout 规则。
- ❌ 2026-08-02：阶段 36 已成功提交 `todolist.md` 后，默认权限执行 `git tag -a git-v0.54` 失败，报 `insufficient permission for adding an object to repository database .git/objects` 与 `unable to write tag file`。这与此前 index 写入失败同属 Git 元数据写权限边界；提交对象未丢失，tag message 留在 `.git/TAG_EDITMSG`，下一步用最小范围授权重试 `git tag`。
