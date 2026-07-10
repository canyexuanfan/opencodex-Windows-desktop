---
title: 子代理界面（v1 / base / v2）
description: 全局控制 Codex 在所有模型上生成和管理子代理的方式。
---

opencodex 允许你为目录中的所有模型选择多代理协作界面。仪表盘和 Models 页面中的 **Sub-agent** 开关会全局控制这一设置。

:::caution
**在 v2 界面（`multi_agent_v2`）上，生成的子代理始终继承父会话的模型。`spawn_agent` 的模型覆盖不会生效，因此 v2 无法在其他模型上生成子代理；跨模型生成仅适用于 v1 界面。**
:::

## 模式

| 模式 | 界面 | 行为 |
| --- | --- | --- |
| **v1** | `multi_agent_v1` | 使用经典的命名空间代理工具，以及 `send_input` / `close_agent` / `resume_agent`。`spawn_agent` 的模型覆盖可以在其他模型上生成子代理。 |
| **base**（默认） | 上游固定值 | 恢复上游模型的固定值：gpt-5.6-sol 和 gpt-5.6-terra 使用 v2，gpt-5.6-luna 使用 v1；未固定的模型遵循 Codex 的 `multi_agent_v2` 功能开关。生成行为取决于该模型最终使用的界面。 |
| **v2** | `multi_agent_v2` | 使用扁平的 `spawn_agent` 工具、并发会话，以及 `send_message` / `followup_task` / `wait_agent` / `interrupt_agent`。每个子代理都继承父模型，模型覆盖会被忽略。 |

## 工作原理

所选模式会设置 Codex 读取的每个目录条目中的 `multi_agent_version` 字段：

- **v1 模式**：强制所有条目使用 `multi_agent_version = "v1"`，覆盖上游固定值。
- **base 模式**：恢复上游默认值。已固定的模型使用快照值；未固定的模型不写入该字段，交由 Codex 功能开关决定。
- **v2 模式**：强制所有条目使用 `multi_agent_version = "v2"`，覆盖上游固定值。

无论是实时 `/v1/models` 目录响应，还是磁盘目录同步，这项覆盖都会作为最后一步执行。因此，无论条目原本如何生成，新会话都会使用一致的模式。

### 委托模型与推理强度

仪表盘中的 **子代理委托** 选择器会保存 `injectionModel`，以及可选的 `injectionEffort`。它们用于生成委托指引，并不是由 proxy 执行的子代理路由规则。

`multiAgentGuidanceText` 根据请求中的工具列表判断当前界面。在 **v1** 请求中，只要设置了注入模型，proxy 就会在任意父会话推理强度下添加主动委托指引。指引会写明传给 `spawn_agent` 的确切模型；如果还设置了推理强度，也会写明确切的 `reasoning_effort`。只设置推理强度而不设置注入模型不会产生任何效果。

在 **v2** 上，Codex 会提供自己的主动委托指引，因此 opencodex helper 会直接返回，不注入 v1 兼容消息。当前 proxy 因而不会把 `injectionModel` 或 `injectionEffort` 追加到 v2 请求中。即使 v2 委托指引展示了这些首选项，它们也只是建议：这里不存在逐次生成的跨模型请求，proxy 也不会改写模型，子代理仍使用父会话的模型。不过，v2 的 `spawn_agent` 仍可应用实际传入的 `reasoning_effort`；推理强度与“只能继承模型”的规则相互独立。

## 更改模式

### GUI

- **Dashboard** → 第一个状态单元：选择 **v1**、**base** 或 **v2**。
- **Models** 页面 → 使用顶部的分段控件。
- 两个页面都有 **?** 按钮，可打开帮助弹窗并返回本文。
- **Dashboard** → **子代理委托**：选择首选模型和可选的推理强度。请注意，在 v2 上模型选择仅用于指引，无法覆盖继承规则。

### CLI

```bash
ocx v2 mode v1       # 强制所有模型使用 v1
ocx v2 mode default  # 恢复上游固定值
ocx v2 mode v2       # 强制所有模型使用 v2
ocx v2 status        # 显示当前模式和 Codex 功能开关
```

### API

```bash
# 读取界面模式、功能开关和线程上限
curl http://localhost:10100/api/v2

# 设置界面模式
curl -X PUT http://localhost:10100/api/v2 \
  -H 'Content-Type: application/json' \
  -d '{"multiAgentMode": "v2"}'
```

`/api/v2` 的 PUT 端点还接受 `enabled`（布尔值，Codex 功能开关）和 `maxConcurrentThreadsPerSession`（整数）。它会验证请求、保存模式、重新同步目录，并提示模式更改从新会话开始生效。

委托选择器使用另一个端点：

```bash
# 读取当前模型/推理强度和可选值
curl http://localhost:10100/api/injection-model

# 同时设置两个值
curl -X PUT http://localhost:10100/api/injection-model \
  -H 'Content-Type: application/json' \
  -d '{"model": "anthropic/claude-sonnet-5", "effort": "xhigh"}'

# 清除两个值
curl -X PUT http://localhost:10100/api/injection-model \
  -H 'Content-Type: application/json' \
  -d '{"model": null}'
```

`GET /api/injection-model` 返回 `model`、`effort`、全局 `efforts` 阶梯，以及由已启用原生/路由模型组成的 `available` 列表。PUT 请求省略 `effort` 时会保留当前值，传入 `null` 时会清除它；清除 `model` 一定会同时清除推理强度。API 会按全局 Codex 阶梯验证推理强度，Codex 仍会在生成时检查目标目录条目是否支持该强度。

## 推理强度

可选的子代理推理强度保存在 `injectionEffort` 中，只有同时设置注入模型时才有意义。在当前 proxy 路径中，它会向 v1 委托指引加入 `reasoning_effort` 要求，但不会改变父会话的推理强度。与此相互独立的是，v2 在继承父模型的同时，仍可应用传给 `spawn_agent` 的 `reasoning_effort`。

在 Codex 目录中，`ultra` 的级别高于 `max`，并带有自动委托语义；但 provider 永远不会在线路上收到字面量 `ultra`。Codex 会在客户端边界将 `ultra` 转成 `max`，随后 opencodex 再确保 provider 收到有效值：

| 模型 | 线路上的 `max` | 选择 `ultra` 后的线路值 |
| --- | --- | --- |
| gpt-5.5、gpt-5.4、gpt-5.4-mini | xhigh | xhigh（先转为 max，再经 `nativeEffortClamp`） |
| gpt-5.6-sol、gpt-5.6-terra | max | max |
| gpt-5.6-luna | max | 其精确上游阶梯不提供该选项 |
| 路由模型 | 由适配器映射或限制 | 先转为 max，再由适配器映射或限制 |

目录中是否提供某个推理强度与 v1/v2 模式无关。支持推理的生成条目会提供 `max`，使直接指定的子代理强度能够通过验证；当前生成的路由条目还会提供 `ultra`。精确的上游模型阶梯会原样保留，因此 gpt-5.6-luna 最高只到 `max`。

## 上下文上限

全局上下文上限值默认为 350k。它只会限制已启用上限的路由 provider 所广告的 `context_window`；原生 OpenAI 模型保留其真实上下文窗口。

你可以在 Models 页面更改上限值或全体 provider 设置，也可以通过各 provider 分组标题旁的开关单独启用或禁用上限。
