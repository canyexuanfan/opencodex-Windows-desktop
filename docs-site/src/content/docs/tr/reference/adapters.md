---
title: "Adaptörler"
description: "Anthropic, Google Gemini, Azure, OpenAI Responses ve Chat Completions adaptör referansı."
---

## Genel Bakış

OpenCodex, farklı sağlayıcıların API formatlarını OpenAI Responses ve Chat Completions hat formatlarına şeffaf bir şekilde dönüştürmek için 7 dahili adaptör içerir.

## Desteklenen Adaptörler

| Adaptör | Hedef API | Özellikler |
|---|---|---|
| `openai-chat` | OpenAI Chat Completions | Standart model akışı ve araç çağrıları |
| `openai-responses` | OpenAI Responses | Doğrudan geçiş (passthrough), akıl yürütme |
| `anthropic` | Anthropic Messages | Prompt önbellekleme, düşünme (thinking) |
| `google` | Google Gemini | Gemini akış ve multimodal destek |
| `azure` | Azure OpenAI | Kurumsal dağıtımlar ve API anahtarı |
| `cursor` | Cursor Protobuf | Cursor entegrasyonu |
