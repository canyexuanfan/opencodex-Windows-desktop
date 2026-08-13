---
title: "Alt Ajan Arayüzü (Sub-agents)"
description: "Codex spawn_agent için yönlendirilen modelleri ve alt ajan yüzeylerini yapılandırın."
---

## Genel Bakış

OpenCodex, Codex'in çoklu ajan yetenekleri (`spawn_agent`) için yönlendirilen veya yerel modelleri sabitlemenize ve v1 / base / v2 alt ajan arayüzlerini genel olarak yönetmenize olanak tanır.

## Yapılandırma

`~/.opencodex/config.json` içerisinde en fazla 5 model tanımlanabilir:

```json
{
  "agents": {
    "subagentModels": [
      "anthropic/claude-opus-4-8",
      "openai/gpt-5.6-sol",
      "google/gemini-3-pro"
    ]
  }
}
```
