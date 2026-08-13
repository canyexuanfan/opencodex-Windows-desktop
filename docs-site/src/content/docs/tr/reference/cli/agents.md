---
title: "CLI Referansı: Ajanlar"
description: "ocx agent, combos, gözlemlenebilirlik ve model yönetimi komut satırı referansı."
---

## Ajan ve Model Komutları

```bash
ocx models               # Görünür tüm modelleri listeler
ocx combo list           # Tanımlı tüm komboları görüntüler
ocx combo set <name> --targets <targets...>
```

## Gözlemlenebilirlik ve Günlükler

| Takma Ad | Karşılık Gelen Kaynak |
| --- | --- |
| `ocx logs [filters] [--follow] [--json\|--jsonl]` | `ocx observe logs` |
| `ocx usage [--range <7d\|30d\|all>] [--surface <all\|codex\|claude\|grok>] [--json]` | `ocx observe usage` |
| `ocx storage [--json]` | `ocx observe storage` |
| `ocx memory [--json]` | `ocx observe memory` |
