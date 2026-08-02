# Claude CLI 文案生成超时排查指南

## 问题描述

在开源准备阶段，按用户要求使用 Claude CLI 为 README / Release 文案提供公开文案方向。首次让 Claude CLI 直接读取仓库和 README 时，命令在 120 秒内没有返回，无法取得可用文案。

## 已尝试的修复方法及失败原因

- ❌ 2026-08-02：执行 `claude -p (Get-Content .tmp\claude-public-readme-prompt.md -Raw) --allowedTools Read,Grep,Glob ...`，允许 Claude 自行读取 README 和元数据。失败原因：上下文与工具读取范围偏大，120 秒超时，未返回可审计文案。

## 深层问题分析

Claude CLI 可用性本身正常；随后执行极小提示 `Say OK` 在数秒内返回。故本次不是 CLI 未安装或未登录，而是“让 Claude 在仓库内自行读取并归纳”对当前任务过重，容易卡在模型请求或工具上下文处理阶段。

## 下一步排查策略

1. 文案任务优先缩小输入，只喂给 Claude 需要改写的 README 顶部片段。
2. 禁用不必要工具，让 Claude 只输出文案，不直接改文件、不操作 Git。
3. Codex 侧继续负责公开边界审计，并用受控 patch 落地。

## 调试工具

- `claude --version`
- `claude -p "Say OK" --tools ""`
- `git diff -- README.md scripts\release-notes.ts`

## 注意事项

- 不把 Claude 的原始输出直接视为最终可公开文案，仍需审计 HTML/Markdown 格式、署名边界和内部信息泄露。
- 不允许 Claude CLI 操作远端 GitHub。

## 更新记录

- ✅ 2026-08-02：改用小输入提示，只提供 README 顶部 45 行并禁用工具，Claude CLI 成功返回文案方向；Codex 保留原徽章结构与上游署名，用 patch 更新 README 顶部和 release notes 文案。
