---
title: Grok Build
description: xAI Grok Build CLI üzerinden herhangi bir OpenCodex yönlendirilmiş modelini kullanın — proxy çalışırken modeller otomatik olarak ~/.grok/config.toml içine kaydedilir.
---

OpenCodex, yerel portunda OpenAI uyumlu bir `POST /v1/chat/completions` (ve `/v1/responses`) API'si sunar ve Grok Build, OpenAI uyumlu sunuculara karşı özel modelleri destekler. Bu entegrasyon sayesinde OpenCodex, tüm görünür model kataloğunu Grok Build'e otomatik olarak kaydeder — manuel yapılandırma dosyası düzenlemesi gerekmez.

## Otomatik Kayıt (Auto-registration)

`~/.grok` dizini mevcut olduğunda, `ocx start` (ve `ocx ensure` / `ocx restart`) komutları `~/.grok/config.toml` içine yönetilen bir blok yazar:

```toml
# >>> opencodex managed block — do not edit (removed by `ocx stop`) >>>
[model.ocx-gpt-5-6-sol]
model = "gpt-5.6-sol"
base_url = "http://127.0.0.1:10100/v1"
api_backend = "chat_completions"
api_key = "opencodex-loopback"
name = "OCX gpt-5.6-sol"
# ... görünür her model için bir [model.ocx-*] tablosu ...
# <<< opencodex managed block <<<
```

- **Eklemeli (Additive):** İşaretçilerin dışındaki kendi yapılandırmanıza asla dokunulmaz. Var olan bir dosyaya ilk enjeksiyondan önce `~/.grok/config.toml.bak-opencodex` yoluna tek seferlik bir yedek alınır.
- **Etkisiz (Idempotent):** Her `ocx start` (ve otomatik başlatma etkinken `ocx ensure`), işaretli bloğu geçerli katalogla günceller.
- **Kaldırmada Temizleme:** `ocx stop`, `ocx eject`, `ocx uninstall` ve normal arka plan işlemi kapatmaları, işaretli bloğu temizler ve dosyanızı bayt düzeyinde eski haline getirir.
- **Çakışma Güvenli:** Kendi `[model.*]` tablolarınız tarafından tanımlanmış takma adlara saygı gösterilir (OpenCodex kendi girdilerine son ek ekler).

Ardından Grok Build içinde bir model seçin:

```bash
grok models          # yerel grok modellerinin yanında ocx-* girdilerini listeler
grok -m ocx-anthropic-claude-opus-4-8 -p "merhaba"
# veya TUI içinde: /model ocx-anthropic-claude-opus-4-8
```

## Akıl Yürütme Seviyesi (Reasoning Effort)

Grok Build'in `/effort` (ve `--effort`) seçeneği, yalnızca katalog girdisinde akıl yürütme seviyesi tanımlanmış modeller için çalışır. OpenCodex, yapılandırılmış sağlayıcı kademelerini (`reasoningEfforts` / `modelReasoningEfforts`) bu yanıta yansıtır. Yapılandırılmış kademeye sahip yönlendirilen modeller, tıpkı Codex'te olduğu gibi Grok Build'de de akıl yürütme denetimini gösterir.

## Kimlik Doğrulama Notu

Grok Build, yerel bağlantılarda (loopback) bile özel modeller için boş olmayan bir API anahtarı gerektirir. Eklenen girdiler yer tutucu (`opencodex-loopback`) taşır — OpenCodex yerel bağlantılarda kabul anahtarlarını yok saydığı için gerçek bir parola veya gizli anahtar dahil edilmez.

**Otomatik kayıt yalnızca loopback içindir.** OpenCodex yerel olmayan bir ana bilgisayara bağlandığında (tüm arabirimleri açan `0.0.0.0` ve `::` dahil), istekler gerçek kabul belirtecinize ihtiyaç duyar. Güvenlik nedeniyle bu durumda yönetilen blok yazılmaz; modelleri işaretçilerin dışında kendiniz yapılandırırsınız.

## Manuel Yapılandırma (Otomatik Kayıt Olmadan)

`~/.grok/config.toml` dosyasını kendiniz yönetiyorsanız — veya OpenCodex yerel olmayan bir adrese bağlıysa — `# >>> opencodex managed block` işaretçilerinin dışına doğrudan model tabloları ekleyin:

```toml
[model.ocx-opus]
model = "anthropic/claude-opus-4-8"
base_url = "http://127.0.0.1:10100/v1"
api_backend = "chat_completions"
api_key = "opencodex-loopback"
```

Ağ üzerinden erişilebilen bir proxy için `base_url` adresini `grok`'un erişebileceği IP adresine yönlendirin ve kabul belirtecinizi girin:

```toml
[model.ocx-opus]
model = "anthropic/claude-opus-4-8"
base_url = "http://192.168.1.10:10100/v1"
api_backend = "chat_completions"
api_key = "your-OPENCODEX_API_AUTH_TOKEN"
```

Nokta içeren takma adları tırnak içine alın: yalın `[model.grok-4.5]` üç bölümlü bir anahtar yolu olarak algılanır, `grok-4.5` kimliği olarak değil.

## Bilinen Sınırlamalar

- **Responses Arka Ucu ve Canlı Tutma:** OpenCodex, upstream sessizliği sırasında `/v1/responses` akışlarında `response.heartbeat` sinyali yayar. Grok Build Responses kod çözücüsü bilinmeyen olay türlerini reddettiğinden, otomatik kaydedilen girdiler `api_backend = "chat_completions"` kullanır.
- **Katalog Güncellemeleri:** İşaretli blok, enjeksiyon anındaki kataloğu yansıtır. Yeni sağlayıcılar veya modeller ekledikten sonra yenilemek için `ocx ensure` çalıştırın veya proxy'yi yeniden başlatın.
