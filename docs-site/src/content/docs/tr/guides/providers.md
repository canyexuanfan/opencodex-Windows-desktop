---
title: Sağlayıcılar (Providers)
description: opencodex'in bir LLM sağlayıcısıyla kimlik doğrulama ve iletişim kurma yöntemleri — OAuth, API anahtarı, ChatGPT doğrudan geçişi ve yerel modeller.
---

Bir **sağlayıcı (provider)**, bir üst LLM uç noktası ile ona nasıl ulaşılacağını tanımlar: bir adaptör, bir temel URL, bir kimlik doğrulama modu ve isteğe bağlı bir model listesi. Sağlayıcılar `~/.opencodex/config.json` içerisindeki `providers` altında yer alır.

## OpenAI Hesap Modları

| Sağlayıcı Kimliği | Kullanım | Kimlik Bilgisi / Hesap Kuralı |
| --- | --- | --- |
| `openai` | Codex girişi | Havuz (Pool - varsayılan) ana ve ek hesapları seçer; Doğrudan (Direct) yalnızca mevcut çağıran/ana oturumu kullanır. |
| `openai-apikey` | OpenAI API | Yalnızca yapılandırılmış API anahtarını kullanır; asla Codex hesaplarını okumaz. |

## Kimlik Doğrulama Modları (`authMode`)

Sağlayıcı yapılandırmaları üç `authMode` değerini kabul eder (varsayılan: `key`):

| `authMode` | Nasıl Doğrular | Kullanan Sağlayıcılar |
| --- | --- | --- |
| `key` | API anahtarınızı gönderir (`Authorization: Bearer …` veya adaptöre göre `x-api-key`). Anahtar bir düz metin veya `${ENV_VAR}` olabilir. | Çoğu sağlayıcı. |
| `forward` | Gelen Codex yetkilendirme başlıklarını aynen sağlayıcıya iletir — anahtar saklanmaz. | OpenAI (`openai-responses` adaptörü). |
| `oauth` | Saklanan OAuth erişim belirtecini (süresi dolmadan önce otomatik yenilenir) çözer ve taşır. | xAI, Anthropic, Kimi, Kiro, Google Antigravity, Cursor, GitHub Copilot. |

## 1. ChatGPT Girişi (Doğrudan Geçiş / Forward)

`openai` sağlayıcısı **ekstra API anahtarı gerektirmez**. Mevcut `codex login` kimlik bilgilerinizi doğrudan kullanır:

```json
{
  "openai": {
    "adapter": "openai-responses",
    "baseUrl": "https://chatgpt.com/backend-api/codex",
    "authMode": "forward"
  }
}
```

Bu yol aynı zamanda [web arama ve görme sidecar'larını](/tr/guides/sidecars/) da besler.

## 2. Hesap Girişi (OAuth)

Birçok popüler sağlayıcı doğrudan hesap girişi (OAuth) destekler:

```bash
ocx login xai          # xAI Grok
ocx login anthropic    # Anthropic Claude (Pro/Max)
ocx login kimi         # Moonshot Kimi
ocx login kiro         # kiro-cli oturumunu içe aktarma
ocx login google-antigravity
ocx login cursor       # Cursor PKCE girişi
ocx login chatgpt      # Bağımsız ChatGPT OAuth girişi
ocx logout <sağlayıcı>
```

| Sağlayıcı | Adaptör | Temel URL | Notlar |
| --- | --- | --- | --- |
| `xai` | `openai-chat` | `https://api.x.ai/v1` | Canlı Grok kataloğu; varsayılan `grok-4.5`. |
| `anthropic` | `anthropic` | `https://api.anthropic.com` | Claude modelleri; canlı model listesi `/v1/models` üzerinden alınır. |
| `kimi` | `openai-chat` | `https://api.kimi.com/coding/v1` | Kimi K2.7/K2.6/K2.5 kodlama modelleri. |
| `google-antigravity` | `google` | `https://daily-cloudcode-pa.googleapis.com` | Google OAuth. |
| `cursor` | `cursor` | `https://api2.cursor.sh` | Deneysel PKCE girişi, HTTP/2 taşıması. |

## 3. API Anahtarı ile Çalışan Sağlayıcılar

40'tan fazla sağlayıcı için yerleşik şablonlar bulunur veya `custom` ile dilediğiniz OpenAI uyumlu uç noktayı ekleyebilirsiniz:

```bash
# DeepSeek
ocx provider add deepseek --api-key "$DEEPSEEK_API_KEY"

# OpenRouter
ocx provider add openrouter --api-key "$OPENROUTER_API_KEY"

# Groq
ocx provider add groq --api-key "$GROQ_API_KEY"
```

## 4. Yerel Modeller (Ollama / Local Server)

Yerel olarak çalışan modelleri kullanmak için:

```bash
ocx provider add ollama --base-url "http://localhost:11434/v1"
```
