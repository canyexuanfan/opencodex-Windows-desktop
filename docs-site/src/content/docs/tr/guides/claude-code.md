---
title: "Claude Code"
description: "Claude Code üzerinden yönlendirilen tüm modelleri kullanın — OpenCodex, aynı port üzerinden Anthropic Messages API ve ağ geçidi model keşfi sunar."
---

OpenCodex, `/v1/responses` ile birlikte `POST /v1/messages` (ve `count_tokens`) sunar; böylece Claude Code, OAuth girişleri, hesap havuzları, anahtar yük devretmesi ve sidecar'lar dahil olmak üzere yönlendirilen tüm sağlayıcıları ek kimlik doğrulama zahmeti olmadan kullanabilir.

## Claude OAuth Hesap Havuzu (Deneysel)

Sağlayıcılar kontrol panelinden (`ocx login anthropic` / hesap ekleme) birden fazla Claude hesabına giriş yapabilirsiniz. Varsayılan olarak her istek yalnızca **aktif** hesabı kullanır.

**Deneysel ve isteğe bağlı** bir Claude hesap havuzu (`anthropicAccountPool.enabled`), bu OAuth hesapları arasında yapışkan oturum benzerliği (sticky session affinity) ve 429 bekleme süresi yük devretmesi (cooldown failover) ekler. Yalnızca **yeni** oturumlar için `anthropicAccountPool.strategy` uygun hesaplar arasından seçim yapar: `quota` (varsayılan), `autoSwitchThreshold` üzerindeyken bilinen en düşük 5 saatlik kullanımı seçer; `round-robin` eşit şekilde dağıtır (`stickyLimit`, varsayılan `1`); `fill-first`, aktif hesabı bekleme süresine, yeniden kimlik doğrulamaya veya eşik değerine kadar tüketir ve ardından bir sonrakine geçer. **Varsayılan olarak kapalıdır**, arayüzde bir uyarı gösterir ve Anthropic otomatik hesap rotasyonu gibi görünen hesapları kısıtlayabileceğinden dikkatle kullanılmalıdır.

Etkinleştirildiğinde işletim sözleşmesi:

- Üst akıştan gelen **429** yanıtı, varsa `Retry-After` kullanarak (yoksa varsayılan bekleme ile) o hesabı soğutmaya alır, benzerliklerini temizler ve aynı istek içinde sınırlandırılmış şekilde uygun başka bir hesaba dönebilir.
- Benzerlik **süreç bazlıdır** (proxy yeniden başlatıldığında kaybolur).
- **401/403** kimlik bilgisi hataları hesabı karantinaya alır (`needsReauth`), böylece yeniden doğrulanana kadar seçimden hariç tutulur.
- Uygun tüm hesaplar soğutmada ise, proxy bilindiğinde `Retry-After` ile birlikte **429** (401 değil) döndürür.

Ayrıntılar için [Yapılandırma](/tr/reference/configuration/agents/) sayfasına bakın.

## Hızlı Başlangıç

```bash
ocx claude
```

`ocx claude`, proxy'nin çalıştığından emin olur ve ardından ortam değişkenlerini bağlayarak Claude Code'u başlatır:

| Değişken | Değer |
| --- | --- |
| `ANTHROPIC_BASE_URL` | `http://127.0.0.1:<port>` |
| `ANTHROPIC_AUTH_TOKEN` | Yalnızca proxy bir API anahtarı gerektirdiğinde ayarlanır — aksi takdirde ayarlanmaz, böylece claude.ai girişiniz (abonelik + bağlayıcılar) aktif kalır |
| `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` | `1` (yerel `/model` seçici keşfi) |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | Otomatik bağlam sıkıştırma eşiği (varsayılan `350000`); yalnızca otomatik bağlam etkinken enjekte edilir |
| `ANTHROPIC_MODEL` | `claudeCode.model` (isteğe bağlı) |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | `claudeCode.tierModels.haiku ?? claudeCode.smallFastModel` (isteğe bağlı; eski `ANTHROPIC_SMALL_FAST_MODEL` dahil) |
| `ANTHROPIC_DEFAULT_{OPUS,SONNET,FABLE}_MODEL` | `claudeCode.tierModels.*` (isteğe bağlı) |
| `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT` | `alwaysEnableEffort` açıkken `1` (koşullu) |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` / `DISABLE_COMPACT` | `maxContextTokens` ayarlandığında eski bağlam geçersiz kılma (koşullu) |

Kendi dışa aktardığınız değişkenler her zaman önceliklidir. Ek argümanlar doğrudan iletilir: `ocx claude -p "merhaba"`.

Birlikte gelen Bun çalışma zamanı bir projenin `.env` / `.env.local` dosyasını otomatik yükler, bu nedenle başlatılan dizindeki başıboş bir `ANTHROPIC_API_KEY`, önceden kasıtlı bir dışa aktarma gibi algılanırdı. `ocx claude` artık yalnızca bir proje dotenv dosyasından gelen Anthropic kimlik bilgilerini yok sayar. Kabuğunuzda dışa aktardığınız bir değer her kimlik doğrulama modunda geçerliliğini korur.

## Kimlik Doğrulama Modu (Auth mode)

Claude Code bir ağ geçidiyle konuşmak için `ANTHROPIC_AUTH_TOKEN` içinde bir belirtece ihtiyaç duyar, ancak bu değişkeni ayarlamak claude.ai girişinizi ve bağlayıcılarını da devre dışı bırakır.

**Claude → Claude Code** altında **Kimlik Doğrulama Modunu** **Otomatik** (varsayılan) olarak bıraktığınızda OpenCodex her başlatmada karar verir:

| Ne Bulur | Ne Yapar |
| --- | --- |
| Bir Claude girişi (`~/.claude.json` OAuth hesabı, `.credentials.json`, macOS keychain veya dışa aktarılmış `ANTHROPIC_API_KEY`) | Belirteci ayarlanmamış olarak bırakır, böylece aboneliğiniz ve bağlayıcılarınız çalışmaya devam eder |
| Hiçbir Claude kimlik doğrulaması yoksa | Bir yer tutucu belirteç enjekte eder, böylece Claude Code giriş yapmanızı istemeyi durdurur ve proxy üzerinden yönlendirir |
| Tespit edilemiyorsa (okunamayan anahtarlık, bozuk dosya) | Abonelik olduğunu varsayar ve bir uyarı yazdırır |

Sabit kalmasını istediğinizde açıkça **Abonelik (Subscription)** veya **Proxy** seçin. Açık bir seçim `claudeCode.authMode` içinde saklanır ve otomatik algılama bunu geçersiz kılmaz.

## Claude Desktop Profili

Claude Desktop, Claude Code'dan ayrı bir profil kullanır. Kontrol panelinde **Claude → Desktop** sayfasını açarak mevcut her rotayı dört aileden birine yerleştirin: Opus, Fable, Sonnet veya Haiku. Yeni bir profilde tüm rotalar Opus ile başlar. İlk Opus rotası genel varsayılan olur ve boş olmayan her ailenin her zaman bir aile varsayılanı bulunur.

Bu profili komut satırından da yönetebilirsiniz:

```bash
ocx claude desktop [apply]
```

`apply`, Claude Desktop'ın gerçek Electron kullanıcı verisi `configLibrary` dizinine yazar.

## Model Seçici ve Takma Adlar (Model Picker & Aliases)

Claude Code 2.1.129+, ağ geçidi modellerini `GET /v1/models?limit=1000` uç noktasından keşfeder ve yerel `/model` seçicisinin "From gateway" bölümünde görüntüler. Seçici yalnızca `claude` veya `anthropic` ile başlayan kimlikleri kabul ettiğinden, OpenCodex yönlendirilen modelleri kararlı ve tersine çevrilebilir takma adlarla sunar:

| Arayüz | Format | Örnek |
| --- | --- | --- |
| Claude Code CLI | `claude-ocx-<provider>--<model>` (düz) veya `claude-ocx2-…` (kaçışlı) | `claude-ocx-openai--gpt-5.6-sol` |
| Claude Desktop 3P | `claude-opus-4-8-<code>` (3 basamaklı base36 hash) | `claude-opus-4-8-ncb` |

**Takma ad kuralları:** Sağlayıcı `/` veya `--` içeremez ve `native` kelimesine eşit olamaz. Model kimlikleri `--` içerebilir (çözümleme sırasında yalnızca ilk `--` temel alınır).

## Otomatik Bağlam (Auto-context)

Claude Code, bilinmeyen modellerin bağlamını varsayılan 200k belirteç olarak hesaplar. Varsayılan olarak açık olan **Otomatik Bağlam (Auto-context)**:

1. Gerçek bağlam penceresi 200k'dan büyük ve otomatik sıkıştırma eşiğinin üzerindeki modellerin seçici satırına ve ortam yuvalarına `[1m]` işareti ekler.
2. `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (varsayılan `350000`) enjekte ederek o noktada konuşmayı otomatik olarak özetler.

## Roster Ajanları (injectAgents)

`ocx claude` ve sistem ortamı arka plan programı, önerilen alt ajan kadrosunu (Subagents sekmesi, en fazla 5 model) ve `ocx-self` ajanını `~/.claude/agents/ocx-*.md` dosyalarına senkronize eder.

- Her ajan gövdesi bir `<!-- ocx-route: <model> -->` yönergesi içerir. Proxy, gerçek rotayı bu yönergeye göre sabitler.
- Yalnızca `generated-by: opencodex` içeren dosyalar yönetilir ve temizlenir; kendi oluşturduğunuz özel ajanlara dokunulmaz.
