---
title: "CLI Referansı: Ajanlar"
description: "ocx agent ve alt ajan yönetimi komut satırı referansı."
---

## Genel Bakış

`ocx agent` komutları, Codex ve Claude Code için alt ajan modellerini, sabitlemeleri ve çoklu model ortamlarını yönetir.

## Komutlar

```bash
ocx agent list
ocx agent set <name> --model <provider/model>
```

## Gözlemlenebilirlik ve Hata Ayıklama

| Takma Ad | Karşılık Gelen Kaynak |
| --- | --- |
| `ocx logs [filters] [--follow] [--json\|--jsonl]` | `ocx observe logs` |
| `ocx usage [--range <7d\|30d\|all>] [--surface <all\|codex\|claude\|grok>] [--json]` | `ocx observe usage` |
| `ocx storage [--json]` | `ocx observe storage` |
| `ocx memory [--json]` | `ocx observe memory` |
