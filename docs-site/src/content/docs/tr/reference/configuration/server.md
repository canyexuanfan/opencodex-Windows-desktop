---
title: "Yapılandırma: Sunucu"
description: "Port, dinleme adresi, bellek sınırları, arka plan servisi ve sunucu çalışma zamanı ayarları."
---

Sunucu yapılandırması, OpenCodex yerel HTTP proxy sürecinin ağ ve çalışma zamanı davranışlarını yönetir.

## Sunucu Alanları

| Alan | Tür | Varsayılan | Anlamı |
| --- | --- | --- | --- |
| `port` | `number` | `10100` | Proxy'nin dinleyeceği yerel TCP portudur. |
| `host` | `string` | `"127.0.0.1"` | Bağlanılacak yerel arabirimdir. |
| `streamMode` | `"auto" | "strict" | "compat"` | `"auto"` | SSE yanıt akışı uyumluluk kipidir. |
| `maxMemoryMb?` | `number` | `512` | Bellek denetimi için üst eşik değeridir. |
