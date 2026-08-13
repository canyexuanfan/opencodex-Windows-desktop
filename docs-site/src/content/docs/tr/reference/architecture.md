---
title: "Mimari Referansı"
description: "OpenCodex yerel proxy motoru, hat biçimi dönüştürücüler ve oturum yaşam döngüsü mimarisi."
---

OpenCodex tek bir Bun sürecidir. İstek OpenAI Responses olarak girer, dahili bir modele normalize edilir, yönlendirilir, bir adaptör aracılığıyla sağlayıcıya gönderilir ve tekrar Responses SSE akışına dönüştürülür. Uçtan uca akış için [Nasıl Çalışır](/tr/getting-started/how-it-works/) sayfasına bakın.

## Modül Haritası

```text
src/
├── cli/                # ocx komut dağıtımı, init, status, sağlayıcı komutları
├── server/             # Bun.serve, /v1/* proxy, /api/* yönetim API'si, WS köprüsü
├── codex/              # Codex yapılandırma enjeksiyonu, katalog senkronizasyonu
├── providers/          # Sağlayıcı meta verileri, API anahtarı havuzu, kota ve etiketler
├── adapters/           # Yedi hat adaptörü, paylaşılan korumalar/yardımcılar
├── oauth/              # OAuth sağlayıcıları, API anahtarı kataloğu, belirteç yenileme
├── usage/              # İstek kullanım çıkarma, JSONL günlükleri, özetler
├── lib/                # Çalışma zamanı, süreç, yeniden deneme, gizlilik yardımcıları
├── web-search/         # Web arama sidecar'ı
├── vision/             # Görsel sidecar'ı
├── config.ts           # ~/.opencodex/config.json, varsayılanlar, PID yönetimi
├── router.ts           # Model kimliği → sağlayıcı + adaptör yönlendiricisi
├── bridge.ts           # Adaptör Olay akışı → Responses SSE / JSON köprüsü
└── index.ts            # Genel giriş noktası
```
