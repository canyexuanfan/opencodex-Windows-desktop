---
title: "Model Sıralaması ve Kataloğu"
description: "Codex ve Claude Code arayüzlerinde modellerin görünürlük, sıralama ve katalog yapılandırması."
---

## Genel Bakış

OpenCodex, tek bir port üzerinden birden fazla sağlayıcıyı ve onlarca modeli yönetir. Bu kılavuz, Codex App, Codex CLI, Claude Code ve web kontrol panelinde modellerin nasıl sıralandığını ve hangi modellerin arayüzlerde görüntüleneceğini açıklar.

## Model Görünürlüğü ve Sıralama Kuralları

Modeller `~/.opencodex/config.json` dosyasındaki `routing` ve `providers` yapılandırmasına göre arayüzlere sunulur:

1. **Varsayılan Model:** `routing.defaultModel` olarak ayarlanan model, istemci açıkça bir model belirtmediğinde kullanılır.
2. **Katalog Sıralaması:** Web panelinde ve model seçicilerde modeller, sağlayıcı bazında alfabetik veya tanımlanan özel öncelik sırasına göre listelenir.
3. **Akıl Yürütme Seviyeleri (Reasoning Efforts):** Modeller, destekledikleri akıl yürütme seviyeleriyle (low, medium, high) birlikte katalogda ilan edilir.

## Komut Satırından Model İnceleme

Mevcut model kataloğunu listelemek için:

```bash
ocx models
```

Belirli bir modelin ayrıntılarını ve yönlendirme rotasını görüntülemek için:

```bash
ocx models show <provider/model>
```
