---
title: "Entegrasyonlar"
description: "OpenCodex'i kontrol panelinden OpenCode, Pi, OMP, Hermes, OpenClaw, Kimi Code ve Gajae Code'a bağlayın — her istemci için tek bir anahtar ve her yazmadan önce otomatik yedekleme."
---

**Entegrasyonlar (Integrations)** sekmesi, OpenCodex'in sağlayıcı bloğunu istemcinin kendi yapılandırma dosyasına yazar ve istendiğinde temiz bir şekilde kaldırır. Yedi istemci bu şekilde çalışır ve her biri bir anahtara sahiptir:

| İstemci | Yapılandırma Dosyası | Format | Değişikliğin Geçerli Olduğu An | Kimlik Bilgisi |
|---|---|---|---|---|
| OpenCode | `~/.config/opencode/opencode.json` | JSON | sonraki doğrudan başlatma | `OPENCODEX_OPENCODE_API_KEY` |
| Pi | `~/.pi/agent/models.json` | JSON | yeni oturumlar | loopback yer tutucusu |
| OMP | `~/.omp/agent/models.yml` | YAML | OMP yeniden başlatıldıktan sonra | `opencodex-loopback` yer tutucusu |
| Hermes | `~/.hermes/config.yaml` | YAML | yeni oturumlar | `OPENCODEX_HERMES_API_KEY` |
| OpenClaw | `~/.openclaw/openclaw.json` | JSON5 | anında, çalışan ağ geçidinde | `OPENCODEX_OPENCLAW_API_KEY` |
| Kimi Code | `~/.kimi-code/config.toml` | TOML | yeniden başlatmada veya `/reload` ile | loopback yer tutucusu |
| Gajae Code | `~/.gjc/agent/models.yml` | YAML | yeni oturumlar veya `/model` açıldığında |`OPENCODEX_GAJAE_API_KEY` |

Dosya yolları, her istemcinin kendi ortam değişkeni geçersiz kılmalarına saygı gösterir. OMP için, `OMP_PROFILE` değişkeni mevcut olduğunda (açıkça boş olsa bile) `PI_PROFILE` yerine geçer. OMP sağlayıcı düzeyinde başlıkları destekler, ancak bu ilk entegrasyon kasıtlı olarak yalnızca loopback (yerel bağlantı) içindir.

Yerel OpenAI modelleri için oluşturulan OMP bloğu, model düzeyindeki Responses API'sini seçerek görsel girişini ve akıl yürütme seviyesi denetimlerini korur. Yönlendirilen modeller, mevcut adaptörlerin uyumlu kalması için sağlayıcının Chat Completions diyalektini korur.

Bu yollar **mutlak yollar** olmalı veya `~` ile başlamalıdır. Göreli yollar reddedilir.

## Geri Alma (Rollback)

Her başarılı yazma işlemi, *önce* dosyanızın anlık görüntüsünü (snapshot) alır; böylece önceki durumunuz her zaman kurtarılabilir:

- **Geri Al (Undo):** Dosyanız hala yazdığımız içerikle eşleşiyorsa en son işlemde görünür.
- **Bu Noktayı Geri Yükle (Restore this point...):** Daha eski işlemlerde veya dosya o işlemden sonra değiştirildiğinde görünür.
- İstemci başına on adet yedek saklanır. Bunun ötesinde en eski anlık görüntü dosyaları silinir.

Devre dışı bırakma anahtarı yalnızca OpenCodex'in kendine ait olarak kaydettiği girdileri kaldırır. Dosyanız biz yazdıktan sonra elle değiştirildiyse, anahtar kilitlenir ve hangi düzenlemelerin size ait olduğunu tahmin etmek yerine işlemi reddeder.

## Bilinmesi Gerekenler

- **Biçimlendirme genel olarak korunmaz.** Yapılandırma ayrıştırılıp yeniden yazıldığından JSON, JSON5 ve TOML dosyaları yeniden biçimlendirilebilir ve yorumlar kaybolabilir. OMP istisnadır: YAML yazıcısı yalnızca `providers.opencodex` alanını yamalar.
- **Pi, Kimi Code ve Gajae Code yalnızca loopback bağlantılarda çalışır.** Yapılandırma şemalarında yerel olmayan bağlantıların gerektirdiği `x-opencodex-api-key` başlığı için yer yoktur.
- **Hiçbir istemci yapılandırmasına asla gerçek bir kimlik bilgisi yazılmaz.**
