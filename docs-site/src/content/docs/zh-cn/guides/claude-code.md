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

## 系统环境集成

在 macOS 上运行 `ocx start` 时，opencodex 会通过 `launchctl setenv` 在系统范围内自动设置
`ANTHROPIC_BASE_URL` 及相关 Claude Code 环境变量。因此，新打开的终端窗口和标签页中的普通
`claude` 命令也会通过代理路由，无需使用 `ocx claude` 包装器。已经打开的 shell 不受影响，
需要重新打开才能获取这些更改。

运行 `ocx stop` 或关闭代理时，环境变量会恢复到之前的状态。可以在配置中设置
`claudeCode.systemEnv: false`，或使用 GUI 开关禁用此功能。此功能仅支持 macOS；在其他平台上，
请使用 `ocx claude` 启动带有代理环境的 Claude Code。

## 原生 Claude 直通（订阅穿透）

未设置认证覆盖时，Claude Code 保持 claude.ai OAuth 登录并将其发送给代理。未被别名或模型映射
占用的真正 `claude*`/`anthropic*` 模型请求会带着你自己的凭证和全部端到端头 **原样** 转发到
`api.anthropic.com` — beta、thinking 签名、提示缓存和计费身份完全原生，同一会话中路由模型仍可
通过选择器别名使用。因此 `ocx claude` 不再出现 "claude.ai connectors are disabled" 警告。
关闭：`claudeCode.nativePassthrough: false`；更改目标：`claudeCode.anthropicBaseUrl`。

## /model 选择器（"From gateway"）

Claude Code 2.1.129+ 可以发现网关模型：它调用 `GET /v1/models?limit=1000`，并在原生 `/model`
选择器中以 "From gateway" 标签列出。由于选择器只接受以 `claude` 或 `anthropic` 开头的 id，
opencodex 将路由模型暴露为稳定、可逆的别名——每个界面使用不同的家族：

```
claude-ocx-<provider>--<model>     Claude Code CLI（可读形式，例：claude-ocx-native--gpt-5.6-sol）
claude-opus-4-8-<code>             Claude Desktop 3P（哈希形式，例：claude-opus-4-8-ncb）
```

家族按请求决定：`?ids=cli|desktop` 优先；否则 Claude Code 的发现 user-agent
（`claude-code/<版本>`）获得可读形式，其他客户端保持哈希形式。两个家族（以及
`--model gpt-5.6-sol` 这样的裸 id）都会永久解码，因此 `settings.json` 中无论保存哪种形式都
继续工作——本次变更后，旧的哈希选择在重新挑选前只会显示为自定义条目。可读形式无法表达的
路由（提供商名含 `--` 或 `/`）会回退为哈希别名，模型不会消失。

每个条目带有诚实的显示名（如 `gemini-3-pro (gemini)`），并以官方 ModelInfo 形态附带模型能力
信息（推理强度梯度、thinking 类型），使 Claude Desktop 的第三方网关模式能够启用推理强度选择
UI。真实 Anthropic 模型保留其原始 id。旧配置中的 `claude-ocx-<provider>--<model>` 别名仍可
解析。拥有 1M 上下文的模型会多出一行 `…[1m]`：选中后 Claude Code 会按 1M 计算该模型的上下文

### 自动上下文（突破 200k 上限使用大上下文）

Claude Code 对不认识的模型一律按 200k 计算上下文——即使路由模型实际能记住 372k 或 400k。
**自动上下文**（默认开启）分两步解决：

1. 实际窗口超过 200k 且不低于自动摘要触发点的模型，其选择器行和 env 槽位会带上 `[1m]`
   标记（Claude Code 按 1M 计算该模型）。
2. 注入 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`（默认 `350000`），在该点自动摘要对话。Claude Code
   采用 `min(计算窗口, 该值)`，一个 env 相当于按模型生效的下限：带标记的模型在 350k 摘要，
   200k 模型保持原有行为。

该值可在 Claude 页面通过下拉框调整（允许范围 100000~1000000）。**注意：**设得比模型真实
窗口更大会导致该模型在摘要触发前报错。1M 以下的原生 Anthropic 模型绝不会被自动标记；你
自己导出的值始终优先（代理会以该值重新判断哪些模型可以安全标记）。设置旧版
`maxContextTokens` 会整体关闭自动上下文。
（自动压缩保留，代理在路由前去掉该标记）。选中后会保存到 Claude Code 的 `settings.json`
`model` 字段；入站请求会将别名解析回路由
模型。旧版 Claude Code 中选择器保持原生 — 通过 `ANTHROPIC_MODEL` 设置槽位，或直接在 `/model`
中输入任意路由 id（Claude Code 会原样传递字符串）。

## 子代理层级模型

Claude Code 子代理按层级别名（`opus` / `sonnet` / `haiku` / `fable`）选择模型。派遣特定路由
模型的正道是上面的名册代理（`ocx-*`），因此层级映射现在仅限配置文件
（`claudeCode.tierModels`——无 GUI 控件）。设置后 `ocx claude`（及系统环境变量选项）会注入对应的
`ANTHROPIC_DEFAULT_*_MODEL`。haiku 跟随后台辅助槽位；1M 模型自动加 `[1m]`。你自己导出的值
始终优先。

## GUI

控制台有一个专用的 **Claude** 页面（侧边栏 API 下方）：入站开关、快速开始与手动 env 块、
后台辅助模型选择器、模型拦截（modelMap）编辑器，以及选择器将发现的别名预览。侧边栏还有一个
**Claude ON** 开关（标签在所有语言中刻意保持一致），用于开关入站。
默认主模型由 Claude Code 自己的 `/model` 选择器管理（保存在其 `settings.json`），本页不再重复提供。

## 名册代理（injectAgents）

`ocx claude`（以及系统 env 守护进程）会把“子代理”页选中的模型（最多 5 个）加上
`ocx-self`——固定为 `/model` 选择器的默认模型（否则回退 `claudeCode.model`，两者皆无则省略）——
同步到 `~/.claude/agents/ocx-*.md`。可用 `subagent_type: "ocx-gpt-5-6-sol"` 派遣任意路由模型。
由于 Claude Code 会忽略代理定义中的自定义网关 id，每个正文携带 `<!-- ocx-route: ... -->`
指令，代理请求由代理服务器据此固定真实路由——因此这些代理的 `model` 参数无效（占位填
`"sonnet"` 或省略）。1M 级目标自动带 `[1m]`。只有经标记
验证的 `ocx-*.md` 会被覆盖或清理，你自己的代理绝不被触碰。用
`claudeCode.injectAgents: false` 关闭（会清理归属文件）。

## 捆绑技能拦截（blockedSkills）

Claude Code 捆绑的 `claude-api` 技能一旦加载，就会向对话注入约 840KB（约 13.6 万 token）的
Anthropic 文档包，而且随口提到 Claude 模型名就会自动触发（anthropics/claude-code#74473、
#63566、#69164）。第三方路由模型并未用这些文档训练，因此 opencodex 默认在路由请求中把该
技能的工具结果正文替换为简短占位说明。原生 Anthropic 直通不受影响——Claude 模型仍收到完整
内容。通过 `claudeCode.blockedSkills` 配置（默认 `["claude-api"]`，`[]` 表示关闭，可添加
更多技能名）。替换保留工具调用/结果配对，重放不会出错。

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
`medium`，更高为 `high`。thinking disabled 时（子代理中很常见），代理服务器会有意省略推理参数（不把客户端已关闭的推理强加给路由提供商）。最终值显示在
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
