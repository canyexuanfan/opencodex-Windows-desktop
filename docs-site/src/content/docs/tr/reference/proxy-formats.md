---
title: "Proxy API Formatları"
description: "OpenAI Responses ve Chat Completions API formatlarının dönüştürme ve uyumluluk detayları."
---

## Genel Bakış

OpenCodex iki ana hat formatını destekler ve bunları tüm sağlayıcı adaptörlerine çift yönlü olarak dönüştürür:

1. **OpenAI Responses (`/v1/responses`):** Codex'in yerel iletişim protokolüdür; araç çağrıları, durum güncellemeleri ve akıl yürütme akışını içerir.
2. **OpenAI Chat Completions (`/v1/chat/completions`):** Standart LLM istemcileri için genel uyumluluk katmanıdır.
