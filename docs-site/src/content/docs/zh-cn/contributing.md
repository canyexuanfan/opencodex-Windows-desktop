---
title: 贡献指南
description: 开发 opencodex —— 环境搭建、目录结构、约定,以及如何添加 provider 或 adapter。
---

## 环境搭建

```bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
bun install
bun run dev          # proxy in dev mode
bun x tsc --noEmit   # typecheck (must be clean)
```

Web 仪表盘是一个独立的应用:

```bash
cd gui && bun install && bun dev
```

你正在阅读的文档站点位于 `docs-site/`(Astro + Starlight):

```bash
cd docs-site && bun install && bun dev
```

## 文档发布

公开文档发布到 GitHub Pages：<https://lidge-jun.github.io/opencodex/zh-cn/>。
`.github/workflows/deploy-docs.yml` 会在 `main` 分支中 `docs-site/**` 或该 workflow 自身发生变化时运行，
构建 `docs-site` 并部署生成的网站。推送文档变更前请运行：

```bash
cd docs-site
bun install --frozen-lockfile
bun run build
```

## CI 与发布

GitHub Actions 会刻意保持短小:

- **Cross-platform CI**(`.github/workflows/ci.yml`) 会在改动 runtime、tests、package、scripts、
  TypeScript 或 workflow 文件的 pull request 与 `main` push 上运行。它在 Linux 和 Windows 上验证
  install、typecheck、tests、release helper build smoke 以及 `ocx help`。
- **Release**(`.github/workflows/release.yml`) 只能手动触发。它不是第二套完整 CI；在 dry-run 或
  publish 前,它会要求精确的发布提交(`GITHUB_SHA`)已经有一次成功的 Cross-platform CI run。

发布请使用 helper:

```bash
bun run release <version>           # 会提交/推送版本 bump；publish workflow 默认 dry-run
bun run release <version> --publish # 理解 CI-gated dry-run 后再真正 publish
bun run release:watch               # 观察最新的 Release workflow run
```

## 约定

- **仅使用 ES Modules**(`import`/`export`)、TypeScript、`strict` 模式。保持 `bun x tsc --noEmit` 无报错。
- **每个文件最多约 500 行** —— 按职责拆分(`web-search/` 和 `vision/` sidecar 就是隐藏在单个 `index.ts` 背后的小而专注模块的良好范例)。
- **在边界处处理异步错误** —— sidecar 绝不向请求路径抛出异常;它们会优雅地降级为一个标记。
- **Structure SOT** —— 当前维护者不变量放在 `structure/`。公开用户流程放在 `docs-site/`，
  历史调查/诊断笔记放在 `docs/`。
- **保留导出(exports)** —— 其他模块可能依赖它们。

## 向目录中添加 provider

大多数 provider 只是 API-key 目录(`src/oauth/key-providers.ts`)中的一个条目:

```ts
"my-provider": {
  label: "My Provider",
  baseUrl: "https://api.example.com/v1",
  adapter: "openai-chat",
  dashboardUrl: "https://example.com/keys",
  models: ["model-a", "model-b"],
  defaultModel: "model-a",
  noVisionModels: ["model-a"],   // text-only models → vision sidecar describes images
}
```

`enrichProviderFromCatalog()` 会将 `models` / `noVisionModels` / `noReasoningModels` 复制到创建出的 provider 配置上,因此这些分类会自动生效。对于 OAuth provider,请改为添加到 `src/oauth/index.ts` 中的 `OAUTH_PROVIDERS`。

## 添加 adapter

在 `src/adapters/` 中实现 `ProviderAdapter`(见 [Adapters](/opencodex/zh-cn/reference/adapters/)),在 adapter 解析器中注册它,并将其输出桥接为内部的 `AdapterEvent`。图像处理请复用 `image.ts`,流式输出 + 工具调用请以 `openai-chat.ts` 作为参考。

## 在声称完成前先验证

运行能够证明你的更改的最小命令 —— 类型用 `bun x tsc --noEmit`,行为用一个聚焦的运行时探测。opencodex 倾向于小而可验证的提交,而非大批量提交。
