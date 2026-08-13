---
title: "Codex App Model Seçici"
description: "Codex App model seçicisinde yönlendirilen modelleri yapılandırın ve akıl yürütme seviyelerini ayarlayın."
---

## Genel Bakış

OpenCodex, yönlendirilen modelleri (Anthropic, Gemini, DeepSeek, xAI vb.) yerel modellerle yan yana Codex App arayüzüne enjekte eder.

## Akıl Yürütme Seviyeleri (Reasoning Efforts)

Yönlendirilen modeller, Codex App içerisinde yerel OpenAI modelleri gibi akıl yürütme seviyesi (Low, Medium, High) seçicisiyle birlikte görünür.

```bash
ocx models
```

## Masaüstü Seçici Uyumluluğu

Codex Desktop sürümlerinde model kataloğu senkronizasyonu `ocx init` ile otomatik olarak sağlanır.
