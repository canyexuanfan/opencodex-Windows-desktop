# GitHub 公开树资源缺失排查指南

## 问题描述

开源准备阶段首次更新 fork `main` 后，GitHub README 出现图片断链。截图显示 README 中的 `assets/codex-app-picker.png` 未能加载。

## 已尝试的修复方法及失败原因

- ❌ 2026-08-02：使用当前 sparse-checkout 工作树的 `git checkout-index -a --prefix=...` 生成公开树。失败原因：当前工作树的 sparse 规则只展开 `.github`、`bin`、`docs`、`gui`、`scripts`、`src`、`structure`、`tests`，没有展开原仓库公开的 `assets/`、`readme/`、`docs-site/` 等目录；导出的公开树保留了 README 引用，却漏掉了被引用资源。
- ❌ 2026-08-02：短暂考虑删除 README 中的 `assets/...` 图片和 `docs/...` 链接。失败原因：用户指出原仓库已有公开内容应保留上传，正确修复不是删除原有公开内容，而是完整保留上游公开资源。

## 深层问题分析

sparse-checkout 只影响工作树可见文件，不代表 Git 对象库中不存在完整仓库内容。公开仓库生成如果从 sparse 工作树导出，就会遗漏 README 依赖的公开资源，造成 GitHub 首页断图或链接失效。

## 下一步排查策略

1. 公开发布树必须从 Git 对象树导出，而不是从当前 sparse 工作树导出。
2. 使用 `git archive HEAD -- . ':(exclude)...'` 这类 pathspec 从完整对象树导出公开内容。
3. 只排除内部过程文件：`questions/`、`todolist.md`、`reference/`、各级 `AGENTS.md` 等。
4. 保留原仓库公开内容：`assets/`、`readme/`、`docs-site/`、`docs/`、`.github/`、`devlog/` 等，除非用户明确要求精简。
5. 推送前必须执行 README 本地链接审计，确认本地相对链接对应文件存在。

## 调试工具

- `git sparse-checkout list`
- `git ls-tree -d --name-only HEAD`
- `git ls-files assets readme docs-site`
- README 本地链接审计脚本：解析 Markdown 链接和 HTML `<img src="...">`，检查相对路径是否存在。
- `gh release view <tag> --json assets,body`

## 注意事项

- 不要把“公开最小化”误用成“删除上游公开资源”。用户明确要求保留原仓库公开内容时，公开树应尽量保留原仓库内容，只剔除本地新增的内部过程文件。
- 安装包不应直接提交到源码树；Windows 安装包应作为 GitHub Release asset 上传。
- 远端 `main` 历史重写必须使用 `--force-with-lease` 并复核远端当前 SHA。

## 更新记录

- ✅ 2026-08-02：改用 `git archive HEAD -- . ':(exclude)dist' ':(exclude)questions' ':(exclude)todolist.md' ':(exclude)reference' ...` 从完整 Git 对象树导出公开内容，重新创建公开根提交 `30d9ede`，覆盖 fork `main`。复核 README 本地链接通过，`assets/codex-app-picker.png`、`assets/architecture.png`、翻译 README 和 `docs/github-copilot-app.md` 均存在。
- ✅ 2026-08-02：创建 GitHub Release `v2.8.0` 并上传 `OpenCodex-Setup-2.8.0-x64.exe`；Release asset digest 为 `sha256:1812f1f2f6849868c5e212f5d579acd500134b7b58725f404cc251f7999fec27`。
- ✅ 2026-08-02：按用户要求通过 Claude CLI 生成中英文双语 Release notes，审计后覆盖 `v2.8.0` 正文。
