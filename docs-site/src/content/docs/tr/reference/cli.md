---
title: CLI Referansı
description: Komut yapısı, çıkış kodları ve tüm ocx komut ailelerine bağlantılar.
---

opencodex CLI aracı `ocx` adını kullanır. İlk komut adına göre yönlendirme yapar; `setup`/`init`, `restore`/`eject` ve `models`/`model` gibi belgelenmiş takma adlar aynı işleme karşılık gelir.

Genel kullanım için `ocx help` (veya `ocx --help` / `ocx -h`) komutunu çalıştırın. Belirli bir komut için `ocx help <komut>`, `ocx <komut> --help` veya `ocx <komut> -h` kullanabilirsiniz.

## Komut Aileleri

- [Yaşam Döngüsü (Lifecycle)](/reference/cli/lifecycle/) — Kurulum, proxy ve servis yaşam döngüsü, sistem sağlığı, tanılama, katalog senkronizasyonu, kontrol paneli ve güncellemeler.
- [Sağlayıcılar, Hesaplar ve Modeller](/reference/cli/providers-accounts/) — Sağlayıcı yapılandırması, kimlik doğrulama, kimlik havuzları, kotalar, özel modeller, görünürlük ve bağlam sınırları.
- [Ajanlar, Yönlendirme ve Entegrasyonlar](/reference/cli/agents/) — Çoklu ajan kontrolleri, kombolar, gözlemlenebilirlik, erişim anahtarları ve istemci entegrasyonları.

## Başsız (Headless) Davranış

Yönetim komutları çalışan canlı proxy'nin yönetim API'si ile haberleşir. Durdurulmuş veya erişilemeyen bir proxy HTTP 503 olarak değerlendirilir ve sıfır dışı bir çıkış kodu üretir. Çevrimdışı yapılandırma işlemleri olarak belgelenen komutlar ise canlı proxy olmadan da yapılandırma dosyasını doğrulayabilir ve düzenleyebilir.

Yapılandırılmış anlık çıktılar için `--json` ve akış halindeki istek günlükleri için `ocx observe logs --follow --jsonl` kullanabilirsiniz.

## Çıkış Kodları ve Onay

Başarılı komutlar `0` koduyla çıkar. Geçersiz kullanım, bilinmeyen komutlar, başarısız API işlemleri ve ulaşılamayan servisler sıfır dışı kodla çıkar. `ocx health`, yalnızca proxy sağlıklı olduğunda `0`, aksi takdirde `1` döndürür; böylece servis sağlık kontrolü (health probe) olarak kullanılabilir.

Etkileşimsiz kullanımlarda onay gerektiren işlemler için `--yes` bayrağı gereklidir.
