---
title: 模型路由
description: opencodex 如何决定由哪个提供商来服务给定的模型 id。
---

当 Codex 请求某个模型时，`router.ts` 会将其解析为唯一一个已配置的提供商。规则**按顺序**检查；第一个匹配者胜出。

## 优先级

1. **显式 `provider/model`** —— 如果 id 包含 `/`，且斜杠前的部分是某个已配置提供商的名称，则使用该提供商，并将 id 截取为斜杠之后的部分。

   ```text
   anthropic/claude-opus-4-8   →  provider "anthropic",   model "claude-opus-4-8"
   ollama-cloud/glm-5.2        →  provider "ollama-cloud", model "glm-5.2"
   ```

   这是无歧义的写法，也是 Codex 的模型选择器对路由模型所使用的写法。

2. **某个提供商的 `defaultModel`** —— 如果任一提供商的 `defaultModel` 等于该 id，则使用该提供商（id 原样传递）。

3. **某个提供商的 `models[]`** —— 如果任一提供商在其 `models[]` 中列出了该 id，则使用该提供商。

4. **内置前缀模式** —— 将 id 与已知的模型系列前缀进行匹配，然后路由到名称（或名称前缀）与之相符的已配置提供商：

   | 前缀 | 提供商 |
   | --- | --- |
   | `claude-`、`claude-sonnet-`、`claude-opus-`、`claude-haiku-` | `anthropic` |
   | `gpt-`、`o1-`、`o3-`、`o4-` | `chatgpt` |
   | `llama-`、`mixtral-`、`gemma-` | `groq` |

5. **默认提供商** —— 如果没有任何匹配，id 将原样发送给 `config.defaultProvider`。（如果未配置默认提供商，路由会抛出异常。）

## API 密钥与环境变量

无论选择哪条路由，提供商的 `apiKey` 都会通过 `resolveEnvValue()` 解析：值为 `${OPENAI_API_KEY}` 或 `$OPENAI_API_KEY` 时会在请求时从环境中展开，因此密钥永远无需存放在 `config.json` 中。

## 提示

- **对路由模型使用显式写法。** 优先使用 `provider/model`（规则 1）——它无歧义，并且与目录同步后 Codex 在其选择器中显示的内容一致。
- **为提供商预置 `models[]` 或 `defaultModel`**，这样短 id（规则 2/3）无需 `provider/` 前缀即可解析。
- **前缀模式只是一种便利**，而非保证：只有当确实配置了同名（例如 `anthropic`、`openai`、`groq`）的提供商时，它们才会解析成功。

这些规则读取的提供商字段请参见 [配置](/opencodex/zh-cn/reference/configuration/)。
