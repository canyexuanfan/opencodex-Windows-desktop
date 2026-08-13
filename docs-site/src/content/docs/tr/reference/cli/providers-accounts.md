---
title: "CLI Referansı: Sağlayıcılar ve Hesaplar"
description: "ocx login, logout, provider ve account komut satırı referansı."
---

## Sağlayıcı Kimlik Doğrulama

```bash
ocx login <provider>     # OAuth sağlayıcısına giriş yapar (örn. anthropic, xai)
ocx logout <provider>    # Kayıtlı OAuth kimlik bilgilerini kaldırır
```

Çalışan bir proxy yeni kimlik bilgisini yeniden başlatmaya gerek kalmadan canlı olarak yükler:

```text
⚠️  A proxy is running but could not reload this provider (unattested-target).
   The credential is saved to disk; the running proxy keeps using the previous one.
   Restart it to pick this up: ocx restart
```

## Hesap Havuzu Yönetimi

```bash
ocx account list         # Kayıtlı ChatGPT/Codex hesaplarını listeler
ocx account add          # Yeni bir hesap ekler
ocx account pause <id>   # Bir hesabı geçici olarak duraklatır
ocx account resume <id>  # Duraklatılan hesabı devam ettirir
```
