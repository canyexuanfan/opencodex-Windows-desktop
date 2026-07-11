---
title: Claude Code
description: 在 Claude Code 中使用任意路由模型 — opencodex 在同一端口提供 Anthropic Messages API 和网关模型发现。
---

opencodex 在 `/v1/responses` 旁提供 `POST /v1/messages`（+ `count_tokens`），Claude Code 可以直接
使用所有路由提供商 — 包括 OAuth 登录、账户池、密钥故障转移和边车 — 无需任何额外认证工作。

## 快速开始

```bash
ocx claude
```

`ocx claude` 确保代理正在运行，然后注入环境变量并启动 Claude Code：

| 变量 | 值 |
| --- | --- |
| `ANTHROPIC_BASE_URL` | `http://127.0.0.1:<port>` |
| `ANTHROPIC_AUTH_TOKEN` | 仅当代理要求 API 密钥时 — 否则不设置，保持 claude.ai 登录（订阅 + 连接器）有效 |
| `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` | `1`（原生 `/model` 选择器发现） |
| `ANTHROPIC_MODEL` | `claudeCode.model`（可选） |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | `claudeCode.smallFastModel`（可选，含旧版 `ANTHROPIC_SMALL_FAST_MODEL`） |

你自己导出的变量始终优先。额外参数原样传递：`ocx claude -p "hello"`。

## 原生 Claude 直通（订阅穿透）

未设置认证覆盖时，Claude Code 保持 claude.ai OAuth 登录并将其发送给代理。未被别名或模型映射
占用的真正 `claude*`/`anthropic*` 模型请求会带着你自己的凭证和全部端到端头 **原样** 转发到
`api.anthropic.com` — beta、thinking 签名、提示缓存和计费身份完全原生，同一会话中路由模型仍可
通过选择器别名使用。因此 `ocx claude` 不再出现 "claude.ai connectors are disabled" 警告。
关闭：`claudeCode.nativePassthrough: false`；更改目标：`claudeCode.anthropicBaseUrl`。

## /model 选择器（"From gateway"）

Claude Code 2.1.129+ 可以发现网关模型：它调用 `GET /v1/models?limit=1000`，并在原生 `/model`
选择器中以 "From gateway" 标签列出。由于选择器只接受以 `claude` 或 `anthropic` 开头的 id，
opencodex 将路由模型暴露为稳定、可逆的别名：

```
claude-ocx-<provider>--<model>     例：claude-ocx-gemini--gemini-3-pro
claude-ocx-native--<slug>          例：claude-ocx-native--gpt-5.5（原生 OpenAI 模型）
```

每个条目带有诚实的显示名，如 `gemini-3-pro (gemini)`。选中后会保存到 Claude Code 的
`settings.json` `model` 字段；入站请求会将别名解析回路由模型。旧版 Claude Code 中选择器保持
原生 — 通过 `ANTHROPIC_MODEL` 设置槽位，或直接在 `/model` 中输入任意路由 id（Claude Code 会
原样传递字符串）。

## GUI

控制台有一个专用的 **Claude** 页面（侧边栏 API 下方）：入站开关、快速开始与手动 env 块、
默认/小型模型槽位选择器、模型映射编辑器，以及选择器将发现的别名预览。侧边栏还有一个
**Claude ON** 开关（标签在所有语言中刻意保持一致），用于开关入站。

## 模型映射

`claudeCode.modelMap` 在路由前重写入站 Anthropic 模型 id：

```json
{
  "claudeCode": {
    "modelMap": {
      "claude-sonnet-4-5": "gemini/gemini-3-pro",
      "claude-haiku-4-5": "gemini/gemini-3-flash"
    }
  }
}
```

查找顺序：发现别名 → 精确 id → 去掉日期后缀（`-20250514`）→ 原样通过。

## 推理强度

Claude Code 的 `/effort` 设置会完整通过适配器。adaptive 线格式
（`thinking: { type: "adaptive" }` + `output_config: { effort }`）中的 effort 会直接传递。
旧版 `thinking.enabled` 请求按 `budget_tokens` 映射：不超过 4096 为 `low`，不超过 16384 为
`medium`，更高为 `high`。thinking disabled 时（子代理中很常见）不发送推理强度。最终值显示在
请求日志的 **推理强度** 列中。

## 提示缓存

- 对 Anthropic 路由请求，适配器管理 tools、system 内容和倒数第二条 user 消息的缓存断点，
  并设置顶层 automatic `cache_control`。稳定轮次通常可达到约 99.9% 的缓存命中率。
- 原生 OpenAI/ChatGPT 路由合成会话范围的 `prompt_cache_key` 和 `session_id` 头，以保持缓存亲和性。
- `CLAUDE.md` 只注入第一条 user 消息，因此不会在每轮使提示缓存失效。

## Logs 和 Usage 中的令牌用量

请求日志的总量为输入（包括缓存输入）加输出。`c` 后缀表示缓存读取（命中），`w` 表示缓存写入
（创建）。Usage 页面也会分别显示缓存命中和缓存创建。

## 手动配置（不使用 ocx）

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:10100
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
claude
```

或持久化到 `~/.claude/settings.json` 的 `env` 键。除非代理要求准入密钥，否则不要设置
`ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` — 任何认证覆盖都会禁用 claude.ai 连接器并取代
你的订阅登录。

## 生产说明

- **流式优先。** 入站内部始终流式处理；非流式客户端得到折叠后的 message JSON。
- **Thinking。** 推理以 `thinking` 块流式传给 Claude Code（带合成签名）；Claude Code 回放的
  thinking 块会在路由前被丢弃 — 提供商在自己的信封中保留推理。
- **错误。** 上游失败映射为 Anthropic 错误分类：400、401、403 和 404；429 为
  `rate_limit_error`；529 为 `overloaded_error`；其他 5xx 为 `api_error`。`Retry-After` 会保留。
- **count_tokens 遵循路由。** 路由模型使用近似值。使用 `sk-ant` 凭证的原生 Anthropic 模型会
  将请求直通到真实 Anthropic API。
- **SSE 流式传输。** 流式响应使用 server-sent events，并包含 `ping` 事件。
- **开关。** `claudeCode.enabled: false`（GUI：Claude ON 开关）使 `/v1/messages` 返回 403 并清空
  发现列表。
- 请求与其他路由流量一样出现在 Logs/Usage 页面。
