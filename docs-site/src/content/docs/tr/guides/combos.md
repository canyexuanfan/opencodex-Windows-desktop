---
title: "Kombolar: Yük Devretme ve Dengeleme"
description: "Yük devretme (failover) veya ağırlıklı yük dengeleme için tek bir sanal modeli birden fazla sağlayıcıya yönlendirin."
---

## Genel Bakış

**Kombo (Combo)**, sıralı bir gerçek sağlayıcı/model hedef listesinin önüne geçen sanal bir modeldir. İstemciniz `combo/<id>` modelini talep eder; OpenCodex bir hedef seçer, isteği o somut `provider/model` hedefine dönüştürür ve ilk hedefte yeniden denenebilir bir hata oluştuğunda diğer hedefe geçer.

Bu yapı şu iki durumda çok kullanışlıdır:
- **Yük Devretme (Failover):** Bir modeli öncelikli kullanın, ancak yedek modelleri hazır tutun.
- **Yük Dengeleme (Load Balancing):** Başarılı istekleri modeller veya sağlayıcılar arasında ağırlıklı gruplar halinde paylaştırın.

## Hızlı Başlangıç

```bash
ocx combo set main --targets anthropic/claude-opus-4-8,openai/gpt-5.6-sol
```

Varsayılan strateji yük devretmedir (`failover`), bu nedenle normal bir istek `anthropic/claude-opus-4-8` hedefine gider. Bu denemede geçici bir hata oluşursa OpenCodex `openai/gpt-5.6-sol` hedefine geçer.

```json
{
  "model": "combo/main",
  "input": "Gökyüzünün neden mavi olduğunu açıkla."
}
```

Kaydedilen tanımı doğrulamak için:

```bash
ocx combo show main
```
