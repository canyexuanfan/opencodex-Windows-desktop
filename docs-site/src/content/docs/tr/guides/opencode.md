---
title: "OpenCode ile Kullanım"
description: "OpenCode ve topluluk araçlarıyla OpenCodex proxy kullanım rehberi."
---

## Genel Bakış

OpenCode, OpenCodex'in yerel portu üzerinden sağladığı OpenAI uyumlu uç noktaları kullanarak tüm yönlendirilen modelleri kullanabilir.

## Yapılandırma

Kontrol panelindeki **Entegrasyonlar** sekmesinden OpenCode anahtarını açabilir veya `~/.config/opencode/opencode.json` dosyasını manuel olarak yapılandırabilirsiniz:

```json
{
  "api_base": "http://127.0.0.1:10100/v1",
  "api_key": "opencodex-loopback"
}
```
