---
title: "Yapılandırma: Yönlendirme"
description: "Model yönlendirme, takma adlar, kombolar, yedekleme kuralları ve yönlendirme profilleri."
---

OpenCodex yönlendirme katmanı, gelen bir model kimliğini somut bir sağlayıcı ve model çiftine dönüştürür.

## Yönlendirme Alanları

| Alan | Tür | Varsayılan | Anlamı |
| --- | --- | --- | --- |
| `defaultModel?` | `string` | — | İstemci açıkça bir model belirtmediğinde seçilen varsayılan modeldir. |
| `aliases?` | `Record<string, string>` | `{}` | Kolay takma adları hedef model kimliklerine eşler (örn. `"fast": "google/gemini-3-flash"`). |
| `combos?` | `Record<string, OcxComboConfig>` | `{}` | Yük devretme veya ağırlıklı yük dengeleme kurallarına sahip sanal kombo modellerdir. |
| `nativeAliases?` | `Record<string, string>` | `{}` | Yalın OpenAI model adlarını yönlendirilen hedeflere bağlar. |

## Kombo Yapılandırması (`OcxComboConfig`)

```json
{
  "routing": {
    "combos": {
      "main": {
        "strategy": "failover",
        "targets": ["anthropic/claude-opus-4-8", "openai/gpt-5.6-sol"]
      }
    }
  }
}
```
