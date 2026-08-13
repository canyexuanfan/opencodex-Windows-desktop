---
title: Hızlı Başlangıç
description: İlk sağlayıcınızı yapılandırın ve OpenAI Codex'i üç komutta opencodex üzerinden yönlendirin.
---

Bu kılavuz, sıfırdan kurulmuş bir sistemde Codex'i OpenAI harici bir model üzerinde çalıştırma adımlarını gösterir.

## 1. Kurulum Sihirbazını Çalıştırın

```bash
ocx init
```

`ocx init` sihirbazı size şu adımlarda rehberlik eder:

1. **Sağlayıcı seçin** — 76 yerleşik kayıt şablonundan birini seçin veya temel bir URL ve adaptör girmek için `custom` seçeneğini kullanın.
2. **API anahtarı** — bir API anahtarı yapıştırın veya `${ANTHROPIC_API_KEY}` gibi bir ortam değişkenine başvurun.
3. **Varsayılan model** — anahtar tabanlı, yerel veya özel sağlayıcılar için varsayılan şablonu kabul edin ya da bir model kimliği (id) girin.
4. **Proxy portu** — varsayılan olarak `10100` kullanılır.
5. **Codex'e enjekte edilsin mi?** — standart bir loopback kurulumunda, opencodex `$CODEX_HOME/config.toml` (varsayılan: `~/.codex/config.toml`) dosyasına kök düzeyinde `openai_base_url` ekler. Böylece Codex'in yerleşik `openai` sağlayıcısı proxy'yi hedefler. Loopback dışı / uzak bağlantılarda ise `OPENCODEX_API_AUTH_TOKEN` belirtecini `x-opencodex-api-key` başlığıyla gönderen ve `wire_api = "responses"` içeren özel bir sağlayıcı girdisi kullanılır.
6. **Otomatik başlatma shim'i kurulsun mu?** — etkinleştirildiğinde `codex` komutu çalıştırılmadan önce `ocx ensure` çalışır.

Yapılandırma sonucu `$OPENCODEX_HOME/config.json` (varsayılan: `~/.opencodex/config.json`) dosyasına kaydedilir.

:::note[GPT-5.6 Dağıtım Girdileri]
Mevcut kararlı sürüm; ChatGPT doğrudan geçişi, OpenAI API anahtarı, OpenRouter ve deneysel Cursor adaptörü için GPT-5.6 Sol/Terra/Luna modellerini içerir. Bu modeller yalnızca üst hesabınız ilgili erişime sahip olduğunda çalışır. OpenAI API anahtarı ve OpenRouter şablonları 372.000 tokenlik kullanılabilir bağlam penceresi sunar; Cursor ise kendi adaptör meta verilerini korur.
:::

## 2. Proxy'yi Başlatın

```bash
ocx start            # Varsayılan port 10100
ocx start --port 8080
```

Başlatıldığında opencodex:

- PID bilgisini `~/.opencodex/ocx.pid` dosyasına yazar (ve aynı anda iki kez başlamayı engeller),
- Sağlayıcının desteklediği durumlarda canlı modelleri keşfeder ve **yerel ve yönlendirilen girdileri Codex'in model kataloğuyla senkronize eder**,
- `http://localhost:<port>/v1` üzerinde dinlemeye başlar.

İstenen port doluysa `ocx start` boş bir port seçer, bunu `runtime-port.json` dosyasına kaydeder ve Codex'i aktif dinleyiciye yönlendirir.

Durumu kontrol edin:

```bash
ocx status
ocx gui       # Aktif port üzerinde web kontrol panelini açar
```

## 3. Codex'i Kullanın

Codex artık şeffaf bir şekilde opencodex ile haberleşir:

```bash
codex "Bu fonksiyonu okunabilirlik için yeniden yapılandır (refactor)"
```

Yönlendirilen belirli bir modeli hedeflemek için Codex model seçicisinde görünen `sağlayıcı/model` biçimini kullanın:

```bash
codex -m "anthropic/claude-opus-5" "Bu stack trace hatasını açıkla"
codex -m "ollama-cloud/glm-5.2"      "Bir SQL migration betiği yaz"
```

## Alt Ajan Modellerini Seçin (İsteğe Bağlı)

Yeni bir yapılandırmada Codex'in alt ajan (sub-agent) seçicisinde beş yerel model bulunur: `gpt-5.5`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` ve `gpt-5.4-mini`. Beş adede kadar yerel veya yönlendirilmiş modeli değiştirmek ya da yeniden sıralamak için `ocx gui` kontrol panelini açın. Kontrol paneli üzerinden tercih edilen bir alt ajan modeli ve akıl yürütme seviyesi de belirlenebilir. Detaylar ve v1/base/v2 seçenekleri için [Alt Ajan Arayüzü](/guides/sub-agent-surface/) sayfasına göz atın.

## Anahtar Yapıştırmak Yerine Hesapla Giriş Yapma

Bazı sağlayıcılar gerçek hesap girişini (OAuth, otomatik yenileme) destekler:

```bash
ocx login xai          # veya: anthropic, kimi, kiro, google-antigravity, cursor
ocx logout xai
```

OpenAI ChatGPT/Codex Doğrudan veya Havuz (Direct/Pool) rotası için **ayrı bir API anahtarına gerek yoktur** — mevcut `codex login` kimlik bilgilerinizi doğrudan iletir; OpenAI API anahtarı rotaları (`openai-apikey`) ise kendi yapılandırılmış API anahtarını gerektirir (Bkz: [Sağlayıcılar](/tr/guides/providers/)).

## Durdurma ve Geri Yükleme

```bash
ocx stop          # Proxy'yi durdurur ve yerel Codex yapılandırmasını geri yükler
ocx restore       # Proxy'yi durdurmadan yerel Codex'e döner (takma ad: ocx eject)
ocx restore back  # Codex'i çalışan proxy üzerinden yeniden yönlendirir
```

## Sonraki Adımlar

- [Nasıl Çalışır](/tr/getting-started/how-it-works/) — her isteğin perde arkasında nasıl işlendiğini öğrenin.
- [Sağlayıcılar](/tr/guides/providers/) — kimlik doğrulama seçeneklerinin tümü.
- [Yapılandırma](/tr/reference/configuration/) — eksiksiz `config.json` referansı.
