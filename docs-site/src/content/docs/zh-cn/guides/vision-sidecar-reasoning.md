---
title: "Vision 侧车推理强度"
description: 按模型能力安全配置 OpenAI Vision 侧车的推理强度。
---

OpenAI Vision 侧车在为纯文本路由模型描述图像时，可以配置所使用的推理强度。

`visionSidecar.reasoning` 支持 `low`、`medium`、`high`、`xhigh` 和 `max`，默认值仍为 `low`。

支持的等级取决于所选模型。控制台会读取原生模型公布的推理阶梯，并把不受支持的已保存值限制到该模型支持的最高档位。管理 API 和运行时也使用同一套按模型能力归一化逻辑，因此直接 API 调用或旧配置不会把已知不受支持的原生档位发送到上游。对于没有可靠能力元数据的自定义模型，OpenCodex 保持宽松处理。

在 OpenAI 路径中，推理强度会进入图像描述缓存标识。Anthropic 会忽略这个 OpenAI 专用设置，因此 Anthropic 的缓存标识不会因它变化。
