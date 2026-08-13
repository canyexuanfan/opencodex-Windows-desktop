---
title: "Yapılandırma: Sağlayıcılar"
description: "Sağlayıcı girdileri, kimlik doğrulama, uç noktalar, model kataloğu, kotalar, bağlam üst sınırları ve sağlayıcıya özgü seçenekler."
---

Sağlayıcılar (Providers), OpenCodex'e modellerin nerede barındırıldığını, hangi hat adaptörünün kullanılacağını ve isteklerin nasıl doğrulanacağını bildirir.

## Sağlayıcı ile İlgili Üst Düzey Alanlar

| Alan | Tür | Varsayılan | Anlamı |
| --- | --- | --- | --- |
| `providers` | `Record<string, OcxProviderConfig>` | — | Sağlayıcı adlarını sağlayıcı yapılandırmalarına eşler. |
| `openaiProviderTierVersion?` | `2` | Geçişle ayarlanır | Seçenekleri tanıyan tekil OpenAI projeksiyonunun tamamlandığını belirtir. |
| `disabledModels?` | `string[]` | — | Codex kataloğunda ve `/v1/models` içinde gizler ancak doğrudan proxy çağrılarını engellemez. Yönlendirilen kimlikler listeden kaldırılır. |
| `providerContextCaps?` | `Record<string, number>` | `{}` | Sağlayıcı bazında Codex ekran bağlam üst sınırlarıdır. Üst sınır yalnızca zaten bilinen bağlam pencerelerini düşürür. |
| `contextCapValue?` | `number` | `350000` | Kontrol panelindeki bağlam üst sınır denetiminin kullandığı varsayılan değerdir. |
| `codexAccounts?` | `CodexAccount[]` | `[]` | Codex Auth tarafından yönetilen ChatGPT/Codex havuz hesabı meta verileridir. Gizli bilgiler `codex-accounts.json` içinde saklanır. |
| `pausedCodexAccountIds?` | `string[]` | `[]` | Duraklatılan hesaplar, devam ettirilene kadar havuz seçiminden hariç tutulur. |
| `codexAccountNamespaces?` | `Record<string, string>` | — | Genel model seçicilerini kayıtlı Codex hesap hedeflerine bağlayan isteğe bağlı haritadır. |
| `codexAccountPickerEnabled?` | `boolean` | Harita boşsa kapalı | `codexAccountNamespaces` eşlemesinden hesap nitelikli Codex seçici satırlarının oluşturulup oluşturulmayacağını denetler. |
| `activeCodexAccountId?` | `string` | — | Sonraki istekler için manuel olarak seçilen havuz hesabıdır. |
| `codexAccountPriorities?` | `Record<string, number>` | — | Codex havuzundaki hesap bazında seçim sırasıdır (-100 ile 100 arası tam sayı; büyük değerler önce seçilir). |
| `autoSwitchThreshold?` | `number` | `80` | Kullanım tabanlı önleyici geçiş eşiğidir. |
| `accountPoolStrategy?` | `"quota" | "round-robin" | "fill-first"` | `"quota"` | Yeni görevler ve serbest Codex istekleri için hesap atama stratejisidir. |
| `upstreamFailoverThreshold?` | `number` | `3` | Ardışık geçici hata sayısı bu değere ulaştığında sonraki yeni oturumlar yük devreder. |
| `upstreamHostCircuitThreshold?` | `number` | `0` | Bağlantı öncesi DNS/TCP hatalarına uygulanan devre kesici (circuit breaker) eşiğidir. |
| `modelCacheTtlMs?` | `number` | `300000` | Sağlayıcı bazında `/models` önbellek tazelik süresidir. |
| `cacheRetention?` | `"none" | "short" | "long"` | `"short"` | Anthropic prompt önbellekleme ilkesidir. |

## Ayrılmış OpenAI Sağlayıcıları

`openai` ve `openai-apikey` sabit ayrılmış kimliklerdir. `openai.codexAccountMode` varsayılanı `"pool"` olup ana hesap ve eklenen tüm hesaplar arasından seçim yapar. `"direct"`, yalnızca mevcut çağıranı/ana oturumu kullanır. `openai-apikey` ise yalnızca yapılandırılmış API anahtarını kullanır.

## Sağlayıcı Girdisi (`OcxProviderConfig`)

| Alan | Tür | Anlamı |
| --- | --- | --- |
| `adapter` | `string` | `openai-chat`, `openai-responses`, `anthropic`, `google`, `kiro`, `cursor`, `azure-openai` adaptörlerinden biri. |
| `baseUrl` | `string` | Üst API temel URL adresidir. |
| `responsesPath?` | `string` | Anahtar doğrulamalı `openai-responses` istekleri için göreli kaynak yoludur. |
| `supportsServiceTier?` | `boolean` | `service_tier` yetenek durumu. |
| `apiKey?` | `string` | Sağlayıcı için birincil API anahtarıdır. |
| `authMode?` | `"key" | "oauth"` | Kimlik doğrulama modudur. |
