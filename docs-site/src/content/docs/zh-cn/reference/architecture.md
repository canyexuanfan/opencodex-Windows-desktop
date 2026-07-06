---
title: 架构
description: opencodex 内部机制 —— 模块图、AdapterEvent 桥接、请求解析器,以及缓存。
---

opencodex 是单个 Bun 进程。一个请求以 OpenAI Responses 格式进入,被规范化为内部模型,经过路由,通过 adapter 发送给某个 provider,再被桥接回 Responses SSE。端到端流程参见 [工作原理](/opencodex/zh-cn/getting-started/how-it-works/)。

## 模块图

```
src/
├── cli/                # ocx command dispatch, init, status, provider commands
├── server/             # Bun.serve, /v1/* proxy, /api/* management API, WS bridge
├── codex/              # Codex config injection, catalog sync, auth/account integration
├── providers/          # provider metadata, API-key pool, quota and labels
├── adapters/           # base + openai-chat, openai-responses, anthropic, google, azure, image
├── oauth/              # OAuth providers, API-key catalog, token store/refresh
├── lib/                # runtime, process, retry, privacy, token estimate helpers
├── web-search/         # web-search sidecar (synthetic tool, loop, executor, parser)
├── vision/             # vision sidecar (describe + plan)
├── config.ts           # ~/.opencodex/config.json, defaults, PID, env resolution
├── router.ts           # model id → provider + adapter
├── bridge.ts           # AdapterEvent stream → Responses SSE / JSON
├── reasoning-effort.ts # reasoning-effort translation, clamping, and catalog levels
├── responses/
│   ├── parser.ts       # Responses request → OcxParsedRequest
│   ├── schema.ts       # Zod validation
│   └── compaction.ts   # remote compaction prompts, envelopes, compact history
├── service.ts          # launchd / systemd / Task Scheduler background service
├── types.ts            # core interfaces + helpers (modelInList, namespacedToolName)
└── index.ts            # public entry
```

## 解析器

`responses/parser.ts` 使用 `responses/schema.ts`(Zod)校验传入的请求,然后构建一个 `OcxParsedRequest`:

- **消息(Messages)** —— `input` 条目会变成规范化的 `OcxMessage[]`:user / developer / assistant / toolResult。`reasoning` 条目变成思考块;`function_call`、`custom_tool_call` 和 `tool_search_call` 条目变成工具调用;它们对应的 `*_output` 条目变成工具结果。
- **工具(Tools)** —— function 工具直接透传;**带命名空间的(MCP)工具会被扁平化**为 `namespace__name`(并在返回时还原);**自由格式(freeform)**工具(例如 `apply_patch`)和 **tool_search** 发现类工具会被打上标记;**托管工具(hosted tools)**(`web_search`、图像生成……)会被丢弃,仅当某个 sidecar 会处理它时才重新注入。
- **图像(Images)** —— 作为真实的内容部分保留(data URL 或远程 https),绝不内联为文本。
- **功能标志(Feature flags)** —— `_webSearch`(请求了托管的网络搜索)和 `_structuredOutput`(`text.format` 为 json_schema / json_object)。

## 桥接器

`bridge.ts` 将 adapter 的内部 `AdapterEvent` 流转换回 Codex 能理解的 Responses SSE:

| AdapterEvent | 发出的 Responses SSE |
| --- | --- |
| `text_delta` | `response.output_text.delta` → `…done`、`response.content_part.done`、`response.output_item.done` |
| `thinking_delta` | `response.reasoning_summary_text.delta` → `…done`、item close |
| `tool_call_start` | `response.output_item.added`(type:`function_call` / `custom_tool_call` / `tool_search_call`) |
| `tool_call_delta` | `response.function_call_arguments.delta`(对 freeform / tool_search 跳过) |
| `tool_call_end` | `response.function_call_arguments.done` → `response.output_item.done` |
| `done` | `response.completed`(带 usage) |
| `error` | `response.failed`(带 `last_error`) |

桥接器还运行一个**心跳保活**（RC3）：在上游沉默期间，每 2 秒发出一个解析器会忽略的
`response.heartbeat` SSE 事件，以重置 Codex 的空闲定时器。**停滞截止时间**为 150 个 tick
（默认 2 秒间隔下为 5 分钟），如果 provider 始终不恢复，则中止上游并关闭流 —— 防止挂起的
连接无限期阻塞 Codex。

工具调用会借助解析器捕获的命名空间映射、freeform 集合和 tool-search 集合,被消歧为三种 Responses item 类型 —— 因此 MCP 命名空间、`apply_patch` 风格的 freeform 工具,以及由客户端执行的 `tool_search` 都能完整往返。一个 `buildResponseJSON()` 变体会从同一批事件中生成单个非流式的响应对象。

## 传输与 compaction

`server/index.ts` 默认在 `/v1/responses` 上提供 HTTP/SSE。如果 `websockets` 为 `false` 时 Codex
尝试 Responses WebSocket upgrade，opencodex 会返回 `426 upgrade_required`，Codex 随后在该 session
中回退到 HTTP。设置 `"websockets": true` 后，同一端点会接受 upgrade 并使用 WebSocket bridge。

Codex context compaction 也适用于路由模型。`server/responses.ts` 处理
`POST /v1/responses/compact`，通过一次内部路由 summarization turn 返回压缩后的历史。
`responses/parser.ts` 和 `bridge.ts` 则处理 remote compaction v2 的 `compaction_trigger` turn，
并发出且只发出一个合成的 `compaction` 输出项。

## 缓存与目录

- `codex/model-cache.ts` 为每个 provider 维护一个内存中的 TTL 缓存,缓存实时 `/models` 的结果(默认 5 分钟,与 Codex 自身的缓存一致),并在请求失败时提供陈旧回退(stale-fallback)。
- `codex/catalog.ts` 将已路由的模型作为带命名空间的条目合并到 Codex 的目录中,将精选的 [subagent 模型](/opencodex/zh-cn/guides/codex-integration/#the-subagent-picker) 排在前面,过滤掉 `disabledModels`,并能从一次性备份中完全恢复原始目录。

## Reasoning effort

`reasoning-effort.ts` 将 Codex 的推理标签翻译为每个 provider 的线上值。Codex 目录只广告 Codex
自身接受的标签（`low` / `medium` / `high` / `xhigh`），但上游 provider 可能使用不同的名称（如
`max`）或支持更小的子集。该模块：

- 定义了标准的 `CODEX_REASONING_LEVELS` 及其排序顺序。
- 当精确级别不可用时，将请求的 effort 钳位到最接近的受支持层级。
- 解析每个模型和 provider 的 `reasoningEffortMap` 覆盖，用于自定义线上映射。
- 对列在 `noReasoningModels` 中的模型完全丢弃 effort。

## 核心类型

内部模型位于 `types.ts` 中:`OcxParsedRequest`、`OcxContext`、`OcxMessage` 联合类型、`OcxContentPart`(text / image)、`OcxToolCall`、`OcxTool`、`AdapterEvent`,以及配置类型(`OcxConfig`、`OcxProviderConfig`)。有两个被广泛使用的辅助函数:`namespacedToolName()` 和 `modelInList()`(为 `noVisionModels` / `noReasoningModels` 提供可容忍 `:size` 标签的匹配)。
