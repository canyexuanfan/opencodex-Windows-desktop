---
title: Model Yönlendirme
description: opencodex belirli bir model kimliğini hangi sağlayıcının sunacağına nasıl karar verir.
---

Codex bir model talep ettiğinde `router.ts` bu isteği yapılandırılmış tek bir sağlayıcıya çözümler. Kurallar **sırasıyla** kontrol edilir; ilk eşleşen kural kazanır.

OpenAI için yapılandırılmış bir `<seçici>/gpt-*` kimliği, kombo veya sağlayıcı ad alanlarından önce `codexAccountNamespaces` üzerinden tam olarak tek bir kayıtlı Codex hesabına eşlenir. Yalın `gpt-*` kimlikleri ise resmi `openai` sağlayıcısını seçer. Bunun `codexAccountMode` ayarı, model kimliğini değiştirmeden Havuz (Pool - varsayılan, ana hesap artı eklenen hesaplar) veya Doğrudan (Direct - mevcut çağıran/ana bearer) modunu belirler. `openai-apikey/<model>` ise açıkça API anahtarı taşımasını seçer. Bu kimlik doğrulama rotaları kesinlikle birbirine aktarılmaz veya birbirinin yerine geçmez (these credential routes do not fall through to one another).

## Öncelik Sırası (Precedence)

1. **Tam Codex Hesap Seçicisi** — Kimlik `<seçici>/<yerel-openai-modeli>` biçimindeyse ve seçici `codexAccountNamespaces` içinde yapılandırılmışsa, istek yalnızca eşlenen kayıtlı hesabı kullanır ve yerel modeli üst sağlayıcıya gönderir. Hedef kullanılamıyorsa yönlendirme başarısız olur (fail closed).

   ```text
   side/gpt-5.6-sol → sağlayıcı "openai", model "gpt-5.6-sol", hesap seçici "side"
   ```

2. **Kombo Kimliği veya Takma Adı** — En az bir kombo yapılandırılmışsa, `combo/<id>` veya yapılandırılmış bir kombo takma adı, sağlayıcı ad alanları kontrol edilmeden önce somut hedefini seçer. Bkz: [Kombolar](/guides/combos/).

3. **Açık `sağlayıcı/model` Biçimi** — Kimlik `/` içeriyorsa ve bölü işaretinden önceki kısım yapılandırılmış bir sağlayıcının adıysa, o sağlayıcı kullanılır ve kimlik eğik çizgiden sonraki kısma indirgenir.

   ```text
   anthropic/claude-opus-5       →  sağlayıcı "anthropic",   model "claude-opus-5"
   ollama-cloud/glm-5.2          →  sağlayıcı "ollama-cloud", model "glm-5.2"
   openrouter/openai/gpt-5.6-sol →  sağlayıcı "openrouter",  model "openai/gpt-5.6-sol"
   ```

   Bu, açık yönlendirilmiş sağlayıcı biçimidir ve Codex'in model seçicisinde gösterdiği biçimdir. Belirtilen sağlayıcı devre dışıysa yönlendirme yapılmaz ve hata fırlatılır.

4. **Yalın Yerel OpenAI Ailesi Kimliği** — `gpt-*`, `o1-*`, `o3-*` veya `o4-*` gibi bir kimlik, etkin durumdaki resmi `openai` sağlayıcısını ve onun yapılandırılmış Havuz (Pool) veya Doğrudan (Direct) hesap modunu kullanır.

5. **Bir Sağlayıcının `defaultModel` Değeri** — Herhangi bir sağlayıcının `defaultModel` değeri istenen kimliğe eşitse o sağlayıcı kullanılır.

6. **Yerleşik Önek Kalıpları (Prefix Patterns)** — Kimlik bilinen model ailesi önekleriyle eşleştirilir ve o ada sahip yapılandırılmış bir sağlayıcıya yönlendirilir:

   | Önekler | Sağlayıcı |
   | --- | --- |
   | `claude-`, `claude-sonnet-`, `claude-opus-`, `claude-haiku-` | `anthropic` |
   | `llama-`, `mixtral-`, `gemma-` | `groq` |

7. **Bir Sağlayıcının `models[]` Listesi** — Yukarıdaki kurallar eşleşmezse ve aktif bir sağlayıcı bu kimliği kendi `models[]` listesinde barındırıyorsa o sağlayıcı kullanılır.

8. **Varsayılan Sağlayıcı (Default Provider)** — Hiçbir kural eşleşmezse kimlik doğrudan `config.defaultProvider` sağlayıcısına iletilir. (Varsayılan sağlayıcı tanımlı değilse veya devre dışıysa yönlendirme hata verir.)

## API Anahtarları ve Ortam Değişkenleri

Hangi rota seçilirse seçilsin sağlayıcının `apiKey` değeri `resolveEnvValue()` üzerinden çözümlenir: `${OPENAI_API_KEY}` veya `$OPENAI_API_KEY` değeri istek anında ortamdan genişletilir; böylece gizli anahtarların asla `config.json` içinde düz metin olarak saklanması gerekmez.

## Katalog Görünürlüğü ve Bağlam Sınırları

Yönlendirme ve katalog görünürlüğü birbirinden bağımsız kontrollerdir:

- `disabledModels`, ad alanlı yönlendirilmiş kimlikleri Codex kataloğundan ve `/v1/models` çıktısından gizler.
- Bir sağlayıcının boş olmayan `selectedModels` listesi başka bir katalog izin listesidir.
- `provider.disabled: true`, o sağlayıcıyı katalog keşfinden tamamen kaldırır.
- `providerContextCaps`, sağlayıcı başına Codex tarafından görülebilen bağlam sınırlarını belirler.

```json
{
  "contextCapValue": 350000,
  "providerContextCaps": {
    "anthropic": 350000,
    "cursor": 350000
  }
}
```

## İpuçları

- **Bir Codex hesabını açıkça hedefleyin:** `<seçici>/<yerel-openai-modeli>` (Kural 1). Bu rota kesindir ve asla başka bir hesaba sessizce geçiş yapmaz.
- **Yönlendirilen modeller için açık olun:** Tercihen `sağlayıcı/model` (Kural 3) biçimini kullanın.
- **Kısa kimlikler için `models[]` veya `defaultModel` tanımlayın:** Böylece `sağlayıcı/` öneki olmadan da doğrudan model adıyla istek atabilirsiniz.
