---
title: "Yönetim API'si Referansı"
description: "OpenCodex proxy kontrolü, bellek yönetimi ve yapılandırma için REST API uç noktaları."
---

## Genel Bakış

OpenCodex, kontrol paneli ve harici betikler için yerel bir HTTP yönetim API'si sunar.

## Temel Uç Noktalar

| Uç Nokta | Metot | Açıklama |
|---|---|---|
| `/api/status` | GET | Proxy durumu, çalışma süresi ve aktif sağlayıcılar |
| `/api/models` | GET | Görünür ve yönlendirilen modellerin listesi |
| `/api/routing` | GET / PUT | Yönlendirme profillerini okuma ve güncelleme |
| `/api/settings` | GET / PUT | Genel proxy ayarları (örn. streamMode) |
| `/api/system/memory` | GET | Bellek tüketimi ve çalışma zamanı sayaçları |
| `/api/stop` | POST | Proxy'yi güvenli bir şekilde durdurma |
