---
title: "Claude Code Kullanımı"
description: "Claude Code üzerinden yönlendirilen tüm modelleri tek bir portta kullanın."
---

OpenCodex, `/v1/responses` ile birlikte `POST /v1/messages` (ve `count_tokens`) sunar. Böylece Claude Code içinde OAuth girişleri, hesap havuzları, anahtar yük devretmeleri ve sidecar'lar dahil tüm yönlendirilen sağlayıcıları ek kimlik doğrulama zahmeti olmadan kullanabilirsiniz.

## Hızlı Başlangıç

```bash
ocx claude
```

`ocx claude`, proxy'nin çalıştığından emin olur ve ortamı bağlayarak Claude Code'u başlatır:

| Değişken | Değer |
| --- | --- |
| `ANTHROPIC_BASE_URL` | `http://127.0.0.1:<port>` |
| `ANTHROPIC_AUTH_TOKEN` | Yalnızca proxy API anahtarı gerektirdiğinde ayarlanır; aksi halde boştur (claude.ai aboneliğiniz korunur) |
| `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` | `1` (varsayılan `/model` seçicide model keşfi) |

Ek argümanlar doğrudan iletilir: `ocx claude -p "merhaba"`.

## Model Seçici ve Takma Adlar

Claude Code CLI ve Desktop arayüzlerinde yönlendirilen modeller takma adlar (aliases) ile temsil edilir:

| Arayüz | Format | Örnek |
| --- | --- | --- |
| Claude Code CLI | `claude-ocx-<provider>--<model>` (düz) veya `claude-ocx2-…` | `claude-ocx-openai--gpt-5.6-sol` |
| Claude Desktop | `claude-opus-4-8-<code>` (3 basamaklı base36 hash) | `claude-opus-4-8-ncb` |

Takma ad kuralı: Sağlayıcı adı `/` veya `--` içeremez ve `native` kelimesine eşit olamaz.
