---
title: "CLI Referansı: Yaşam Döngüsü"
description: "ocx start, stop, restart, status, doctor ve servis yönetimi komut satırı referansı."
---

## Temel Yaşam Döngüsü Komutları

```bash
ocx start          # Proxy'yi ön planda çalıştırır
ocx stop           # Çalışan proxy'yi durdurur ve temizler
ocx restart        # Proxy'yi yeniden başlatır
ocx status         # Proxy durumunu ve aktif yapılandırmayı görüntüler
ocx doctor         # Sistem uyumluluğunu ve bağımlılıkları denetler
```

## Servis Yönetimi

OpenCodex, sistem düzeyinde bir arka plan servisi olarak kurulabilir (macOS için launchd, Linux için systemd, Windows için Task Scheduler):

```bash
ocx service install
ocx service status
ocx service repair
ocx service uninstall
```

Kurulum ve başlatma komutları proxy'nin belirtilen portta yanıt verdiğini doğrular:

```text
✅ opencodex service installed and serving on port 10100.
```

Hiçbir proxy yanıt vermezse uyarır ve sıfır dışı bir kodla çıkar:

```text
⚠️  Service installed, but no proxy answered on port 10100 within 20s.
   The manager registered the job; that is not the same as serving.
   Log:       ~/.opencodex/service.log
   Meanwhile: ocx start   (serves in the foreground)
```
