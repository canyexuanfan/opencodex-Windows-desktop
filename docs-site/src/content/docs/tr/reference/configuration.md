---
title: Yapılandırma Referansı
description: opencodex yapılandırmasının nerede saklandığı, düzenlemelerin nasıl uygulandığı ve yapılandırma alanlarına bağlantılar.
---

opencodex kalıcı yapılandırmasını `$OPENCODEX_HOME/config.json` (genellikle `~/.opencodex/config.json`) dosyasında saklar. Windows üzerinde varsayılan yol `%USERPROFILE%\.opencodex\config.json` şeklindedir.

## Yapılandırmayı Düzenleme Yolları

İhtiyacınıza uygun düzenleme kanalını seçin:

- **Kontrol Paneli (Dashboard):** Sağlayıcı, model, ajan, erişim ve depolama ayarları için web arayüzünü kullanın.
- **CLI:** `ocx init` başlangıç dosyasını oluştururken `ocx provider`, `ocx models`, `ocx combo`, `ocx agent` ve `ocx config` gibi komutlar ilgili ayarları günceller.
- **Dosya:** Özel bir UI veya CLI komutu bulunmayan alanlar için doğrudan `config.json` dosyasını düzenleyin. Dosya geçerli bir JSON formatında kalmalıdır.

Canlı bir işlem yapılandırmayı bellekte tuttuğundan, elle düzenleme yapmadan önce proxy'yi durdurmanız önerilir.

## Öncelik Sırası ve Varsayılanlar

`config.json` dosyasındaki geçerli değerler yerleşik varsayılanları geçersiz kılar. `OPENCODEX_HOME` ortam değişkeni varsayılan yapılandırma dizinine göre önceliklidir. `apiKey: "${PROVIDER_API_KEY}"` gibi ortam değişkeni referansı kabul eden alanlar, ilgili değişkeni istek anında çözer.

## Yapılandırma Alanları

- [Sağlayıcılar (Providers)](/tr/reference/configuration/providers/) — Sağlayıcı girdileri, kimlik doğrulama, uç noktalar, kataloglar, izin listeleri, bağlam sınırları ve kotalar.
- [Yönlendirme (Routing)](/tr/reference/configuration/routing/) — `defaultProvider`, model çözümleme sırası, kombolar ve takma adlar.
- [Ajanlar (Agents)](/tr/reference/configuration/agents/) — Çoklu ajan modu, yetkilendirme yönlendirmesi, yedek modeller ve akıl yürütme sınırları.
- [Sunucu ve Çalışma Zamanı (Server & Runtime)](/tr/reference/configuration/server/) — Dinleyici ve uzaktan erişim, erişim anahtarları, zaman aşımları, depolama ve sidecar'lar.

## Gizli Bilgileri Dosyadan Uzak Tutun

API anahtarları için `${ENV_VAR}` referanslarını tercih edin. Düz metin API anahtarları gizlidir; bunları commit etmeyin veya günlüklerde paylaşmayın. OAuth belirteçleri `config.json` yerine ayrı kimlik depolarında saklanır.
