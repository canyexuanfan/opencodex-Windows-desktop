---
title: "Vision Sidecar Reasoning"
description: Configure OpenAI vision-sidecar reasoning effort safely by model capability.
---

The OpenAI vision sidecar can use a configurable reasoning effort when it describes images for a text-only routed model.

Set `visionSidecar.reasoning` to `low`, `medium`, `high`, `xhigh`, or `max`. The default remains `low`.

```json
{
  "visionSidecar": {
    "backend": "openai",
    "model": "gpt-5.6-luna",
    "reasoning": "medium"
  }
}
```

Supported levels depend on the selected model. The Dashboard reads each native model's advertised reasoning ladder and clamps an unavailable saved value to the highest supported rung. The management API and runtime apply the same model-aware normalization, so a direct API call or stale config cannot send a known-unsupported native effort upstream. Unknown/custom models remain permissive when opencodex has no reliable capability metadata.

Changing the OpenAI reasoning effort creates a distinct image-description cache identity. Anthropic vision ignores this OpenAI-specific setting, so its cache identity does not change.
