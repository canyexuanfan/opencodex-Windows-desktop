---
title: Windows Bellek Artışı (Memory Growth)
description: Bun sürecinin Windows'ta neden yüksek RAM tüketebileceği, OpenCodex'in şu anki önlemleri ve upstream Bun düzeltmeleri gelene kadarki seçenekleriniz.
---

Bazı Windows kullanıcıları, uzun akış (streaming) oturumları sırasında OpenCodex'in arkasındaki `bun` sürecinin RSS kullanımının gigabaytlarca büyüdüğünü bildirmektedir ([#314](https://github.com/lidge-jun/opencodex/issues/314) numaralı konu). Bu sayfa, gerçekte ne olduğunu ve dürüstçe neler yapabileceğinizi açıklar.

## Temel Neden: Upstream Bun Çalışma Zamanı Sorunları

OpenCodex, Bun çalışma zamanını (şu anda **1.3.14**) paket olarak içerir. Bellek artışı proxy'deki JavaScript düzeyindeki sızıntılardan değil, bilinen upstream Bun sorunlarından kaynaklanır:

| Bun Sorunu | Durum (2026-07-23 kontrolü) |
|---|---|
| [#28035](https://github.com/oven-sh/bun/issues/28035) — `fetch()` geri basıncı JS tüketimine bağlı değil | [PR #29831](https://github.com/oven-sh/bun/pull/29831) ile düzeltildi; hangi sürümde yer aldığı doğrulanmadı — paketli 1.3.14'te olmadığı varsayılır |
| [#32111](https://github.com/oven-sh/bun/issues/32111) — İstemci asenkron akışı iptal ettiğinde çökme | Düzeltme [PR #32120](https://github.com/oven-sh/bun/pull/32120) 2026-06-21'de birleştirildi; 1.3.14'te olmadığı varsayılır. Bu çökme Windows'a özel değildir (macOS/Linux'ta da tekrarlanmıştır) |
| [PR #31654](https://github.com/oven-sh/bun/pull/31654) — `node:net` soket tutamacı (handle) sızıntısı | Upstream'de hala **açık** |

Windows üzerinde OpenCodex, #32111 çökmesini önlemek için yanıt akışlarını muhafazakar bir kod yolunda tutmalıdır; bu yol geri basınç sorununa en açık olanıdır: Yavaş veya duraklatılmış bir istemci, çalışma zamanının JavaScript'in sınırlandıramayacağı yerel bellekte veri arabelleğe almasına neden olabilir.

## OpenCodex'in Bugün Yaptıkları

Sınırlı hafifletme ve görünürlük — **kesin bir çözüm değildir**. Paketlenmiş 1.3.14 çalışma zamanında sızıntının kendisi bir upstream sorunu olmaya devam eder:

- **Bellek Gözlemcisi (Memory Watchdog)** — Proxy her dakika kendi belleğini örnekler ve gözlemlenen bellek 4 GiB'ı aştığında sınırlı bir uyarı kaydeder.
- **`ocx doctor`** — "Bellek / çalışma zamanı" bölümü servis sürecinin Bun sürümünü, RSS, harici sayaçları ve akış modu kararını gösterir.
- **`GET /api/system/memory`** — Kontrol panelleri veya betikler için kimlik doğrulamalı yönetim API'si üzerinden aynı veriyi sunar. Dashboard'daki **Bellek Gözlemlenebilirliği** kartı aynı alanları görüntüler ve onaylı bir **Boşalt ve Yeniden Başlat (Drain & restart)** eylemi sunar.
- **Sınırlandırılmış Alternatif Akış Yolu** — Sınırsız arabelleğe alma yapısını tamamen ortadan kaldıran tek okuyuculu röle (`eager-relay`).

## Seçenekleriniz

1. **Paketli Çalışma Zamanı Güncellemesini Beklemek.** Düzeltmeleri içeren yeni bir Bun sürümü yayınlandığında OpenCodex paketli çalışma zamanını yükseltecektir.
2. **`OPENCODEX_BUN_PATH` ile Güvendiğiniz Bir Bun Sürümü Çalıştırmak.** Bu doğrulanmamış bir alandır — OpenCodex'i test etmediğimiz bir çalışma zamanında kendi sorumluluğunuzda çalıştırırsınız.
3. **`streamMode: "eager-relay"` ile Sınırlı Röleyi Tercih Etmek.** `config.json` dosyasını düzenleyerek veya `PUT /api/settings` API çağrısıyla `"streamMode": "eager-relay"` ayarını etkinleştirebilirsiniz. **Çökme riski uyarısı:** Bun 1.3.14 üzerinde bu mod, istemci akışı yarıda kestiğinde sürecin çökmesine neden olabilir.
