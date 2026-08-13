---
title: Kurulum
description: opencodex (ocx) proxy'sini, ön gereksinimlerini kurun ve çalıştığını doğrulayın.
---

opencodex iki eşdeğer komut adı yükler: `ocx` ve `opencodex`. Her ikisi de aynı hafif yerel HTTP sunucusunu (Bun üzerinde çalışan) başlatır. Model istekleri yönlendirme yapılandırmanıza göre seçilen sağlayıcıya iletilir; yönlendirilen bir model ihtiyaç duyduğunda isteğe bağlı görme (vision) ve web arama sidecar'ları da ChatGPT oturumunuzu kullanabilir.

## Ön Gereksinimler

| Gereksinim | Neden Gereklidir |
| --- | --- |
| **[Node](https://nodejs.org) ≥ 18** | `ocx`, Bun çalışma zamanı üzerinde çalışır ancak bu çalışma zamanı `npm install` sırasında otomatik olarak paketlenir — Bun'ı kendiniz kurmanız **gerekmez**. |
| **[OpenAI Codex](https://openai.com/codex)** (CLI, App veya SDK) | opencodex'in önünde konumlandığı istemci. opencodex `$CODEX_HOME/config.toml` (varsayılan: `~/.codex/config.toml`) dosyasına yazar. |
| Bir sağlayıcı hesabı veya API anahtarı | Anthropic, xAI, Kimi, Ollama Cloud, OpenRouter, OpenAI uyumlu bir uç nokta veya ChatGPT oturumunuz. |

## Kurulum

```bash
npm install -g @bitkyc08/opencodex
```

:::note[npm bun postinstall betiğini engelledi mi?]
Yeni npm sürümleri bun'ın postinstall betiğini engelleyebilir (`npm warn install-scripts ... blocked because they are not covered by allowScripts`), bu da paketlenmiş Bun çalışma zamanının hazırlanmamasına neden olur. Bun betiğine izin vererek yeniden kurun — ve her zaman paket adını ekleyin (npm'in kısa önerisi bunu atlar ve mevcut dizini kurmaya çalışır):

```bash
npm install -g --allow-scripts=bun @bitkyc08/opencodex

# Orijinal kurulum sudo ile yapıldıysa sudo kullanmaya devam edin:
sudo npm install -g --allow-scripts=bun @bitkyc08/opencodex
```
:::

Her iki komut takma adının da `PATH` üzerinde olduğunu doğrulayın:

```bash
ocx --version
opencodex --version
```

### Sürüm Kanalları

Kararlı (stable) `latest` kanalı, ChatGPT, OpenAI API anahtarı, OpenRouter ve deneysel Cursor rotaları için GPT-5.6 Sol/Terra/Luna katalog desteğini içerir. Üst sağlayıcı erişimi hesaba bağlıdır; katalog girdileri tek başına erişim hakkı sağlamaz. Henüz yayınlanmamış opencodex yapılarını test etmek için yalnızca preview kanalını kullanın:

```bash
npm install -g @bitkyc08/opencodex@preview
ocx update --tag preview
```

## Kaynak Koddan Çalıştırma

opencodex üzerinde geliştirme yapmak için:

```bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
bun install
bun run dev:proxy   # Proxy API'sini geliştirici modunda başlatır (src/cli/index.ts start)
bun run dev:gui     # Dashboard geliştirici sunucusunu başlatır (farklı bir terminalde)
```

`bun run dev` komutu `bun run dev:proxy` için bir takma addır. Proxy API'si `/healthz`, `/v1/responses` ve `/api/*` uç noktalarını sunar; `GET /` ise yalnızca `bun run build:gui` komutu `gui/dist` dizinini oluşturduktan sonra paketlenmiş kontrol panelini sunar. Kontrol paneli üzerinde çalışırken ön yüzü `bun run dev:gui` ile ayrı çalıştırın.

## Neler Oluşturulur?

opencodex durum bilgileri `$OPENCODEX_HOME` (varsayılan: `~/.opencodex`) altında tutulur. Codex entegrasyon dosyaları `$CODEX_HOME` (varsayılan: `~/.codex`) altında yer alır.

| Yol | Amaç |
| --- | --- |
| `$OPENCODEX_HOME/config.json` | Sağlayıcılarınız, varsayılan sağlayıcı, port ve ayarlar. |
| `$OPENCODEX_HOME/ocx.pid` | Çalışan proxy'nin PID değeri (tek örnek koruması). |
| `$OPENCODEX_HOME/runtime-port.json` | Otomatik seçilen yedek port dahil aktif PID, ana bilgisayar adı ve port. |
| `$OPENCODEX_HOME/auth.json` | Saklanan OAuth kimlik bilgileri (`ocx login` kullanıldığında). |
| `$OPENCODEX_HOME/catalog-backup*.json` | opencodex düzenlemeden önce alınan Codex model kataloğu yedekleri. |
| `$CODEX_HOME/config.toml` | Loopback bağlantılarında opencodex kök düzeyinde `openai_base_url` ekler; loopback dışı bağlantılarda `model_provider = "opencodex"` ve `[model_providers.opencodex]` kullanılır. |
| `$CODEX_HOME/opencodex.config.toml` | Ana Codex yapılandırmasının yanına yazılan yedek/referans profili. |
| `$CODEX_HOME/opencodex-catalog.json` | Codex tarafından kullanılan senkronize yerel ve yönlendirilmiş model kataloğu. |

:::note
opencodex hiçbir zaman Codex yapılandırmanızı silmez. Her ekleme geri alınabilir — `ocx stop`, `ocx restore` veya `ocx eject` tam olarak opencodex'in eklediği satırları kaldırır ve yerel Codex'i geri yükler.
:::

## Sonraki Adımlar

İlk sağlayıcınızı yapılandırmak için [Hızlı Başlangıç](/tr/getting-started/quickstart/) sayfasına geçin veya mimariyi öğrenmek için [Nasıl Çalışır](/tr/getting-started/how-it-works/) bölümünü inceleyin.
