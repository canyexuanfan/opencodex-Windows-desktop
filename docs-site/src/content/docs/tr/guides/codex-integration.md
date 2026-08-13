---
title: "Codex Entegrasyonu"
description: "OpenCodex proxy'sini Codex CLI, TUI, App ve SDK ile sorunsuz entegre edin."
---

## Genel Bakış

OpenCodex, Codex ekosisteminin tamamıyla (CLI, Terminal TUI, macOS Desktop App ve resmi SDK) şeffaf bir şekilde entegre olur.

## Entegrasyon Adımları

1. **Proxy'yi Başlatın:**
   ```bash
   ocx start
   ```
2. **Codex Yapılandırmasını Enjekte Edin:**
   ```bash
   ocx init
   ```
3. **Doğrulayın:**
   ```bash
   codex "Rust ile bir hello world yaz"
   ```

## Dahili Görsel Üretimi (image_gen)

Codex'in yerleşik `image_gen` aracı doğrudan `/v1/images/generations` uç noktasına istek gönderir. OpenAI harici sağlayıcılar için bu çağrılar Görsel Köprüsü ([Image Bridge](/tr/guides/image-bridge/)) üzerinden karşılanır.

## Temiz Kaldırma (Teardown)

Codex yapılandırmasını yerel orijinal haline döndürmek için:

```bash
ocx stop
```
