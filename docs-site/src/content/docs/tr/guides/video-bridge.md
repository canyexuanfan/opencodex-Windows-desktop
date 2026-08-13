---
title: "Video Köprüsü (Video Bridge)"
description: "OpenAI harici bir model üzerinden Grok Imagine Video ile videolar üretin."
---

## Genel Bakış

Video Köprüsü (Video Bridge), OpenCodex tarafından yönlendirilen herhangi bir OpenAI harici model aracılığıyla xAI'ın Grok Imagine Video üretimini kullanmanızı sağlar. Etkinleştirildiğinde, sohbete sentetik bir \`video_gen\` aracı enjekte edilir. Model bunu standart bir fonksiyon aracı gibi çağırır; OpenCodex çağrıyı yakalar, xAI'a bir video üretim görevi gönderir, tamamlanana kadar yoklar ve sonucu indirir.

## Ön Koşullar

- **API anahtarına** sahip bir \`xai\` sağlayıcı kaydı (\`ocx login xai\` tek başına yeterli değildir — video köprüsü OAuth değil, API anahtarı ile kimlik doğrulama gerektirir).
- Yönlendirilen sağlayıcınız olarak OpenAI harici bir model (örn. Anthropic Claude, Google Gemini).
- OpenCodex'in OpenAI harici sağlayıcı üzerinden yönlendirilecek şekilde yapılandırılmış olması.

> **⚠ Sağlayıcı anahtarı gereklidir:** Video köprüsü yalnızca \`xai\` sağlayıcısı API anahtarı kimlik doğrulaması kullandığında devreye girer. Yapılandırmanıza şunu ekleyin:
>
> ```json
> {
>   "providers": {
>     "xai": { "adapter": "openai-chat", "apiKey": "\${XAI_API_KEY}", "authMode": "key" }
>   }
> }
> ```
>
> \`ocx login xai\` (OAuth) ile giriş yaptıysanız sağlayıcı \`authMode: "oauth"\` modunda kalır ve köprü etkinleşmez. Ortamınızda \`XAI_API_KEY\` tanımlayın veya doğrudan anahtarı yapılandırın.

## Yapılandırma

\`images\` yapılandırmanıza \`videoBridgeEnabled: true\` ekleyin:

```json
{
  "images": {
    "videoBridgeEnabled": true,
    "videoBridgeModel": "grok-imagine-video",
    "videoMaxRounds": 2,
    "videoTimeoutMs": 300000
  }
}
```

| Seçenek | Varsayılan | Açıklama |
|---|---|---|
| \`videoBridgeEnabled\` | \`false\` | Ana anahtar. Açıkça etkinleştirilmelidir. |
| \`videoBridgeModel\` | \`"grok-imagine-video"\` | xAI video model kimliği. |
| \`videoMaxRounds\` | \`2\` | Zorunlu son cevaptan önceki maksimum video üretim turu. |
| \`videoTimeoutMs\` | \`300000\` (5 dk) | Yoklama dahil video başına zaman aşımı süresi. |

## Nasıl Çalışır?

1. OpenCodex, \`videoBridgeEnabled: true\` etkinken OpenAI harici yönlendirilen bir modeli tespit eder.
2. Sohbete sentetik bir \`video_gen\` fonksiyon aracı enjekte edilir.
3. Model aracı çağırdığında, OpenCodex isteği yakalar ve \`https://api.x.ai/v1/videos/generations\` uç noktasına iletir.
4. Tamamlanana kadar yoklar (varsayılan her 5 saniyede bir).
5. Videoyu \`~/.opencodex/artifacts/\` dizinine indirir ve yerel dosya yolunu modele döndürür.

## Sınırlamalar

- **Yalnızca xAI Grok Imagine Video desteklenir.**
- **Aktif xAI kredisi gereklidir.** Video üretimi xAI API faturalandırmasına tabidir.
- **Yalnızca akış (streaming) modu.** \`stream: false\` olan istekler reddedilir.
