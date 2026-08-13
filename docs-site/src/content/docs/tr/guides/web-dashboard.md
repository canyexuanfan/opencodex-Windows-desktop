---
title: Web Kontrol Paneli
description: Proxy durumu, sağlayıcılar, modeller, yetkilendirme yönlendirmesi, kimlik doğrulama havuzları, kullanım ve günlükler için opencodex arayüzü.
---

opencodex, proxy üzerinden sunulan yerel bir web kontrol paneli (`gui/` altında bir Vite/React uygulaması) içerir. Sağlayıcıları, Codex/ChatGPT hesaplarını, katalog modellerini, sidecar'ları, alt ajan ayarlarını ve istek trafiğini yönetmenin en pratik yoludur.

## Açma

```bash
ocx gui
```

Bu komut tarayıcınızda `http://localhost:<port>` adresini açar ve gerekirse önce proxy'yi otomatik olarak başlatır. Geliştirme sırasında GUI geliştirici sunucusunu çalışan bir proxy'ye karşı ayrı olarak çalıştırabilirsiniz:

```bash
ocx start
bun run dev:gui
```

## Giriş Yapma (Sign-in)

Varsayılan loopback bağlantısında (`localhost` / `127.0.0.1`) kontrol paneli asla belirteç (token) istemez: Proxy, sunulan sayfaya kısa ömürlü GUI oturumları ekler ve bunlar sona erdiğinde veya proxy yeniden başladığında bunları sessizce yeniler. Yalnızca loopback dışı bir ana bilgisayara bağlı bir kontrol paneli yönetici belirteci (`OPENCODEX_ADMIN_AUTH_TOKEN` veya otomatik oluşturulan `~/.opencodex/admin-api-token` dosyası) gerektirir.

## Neler Yapabilirsiniz?

| Alan | Ne İşe Yarar |
| --- | --- |
| **Özet (Dashboard summary)** | Çoklu ajan modu, çevrimiçi durum, sürüm, çalışma süresi, sağlayıcı sayısı, 30 günlük token toplamı, aktif sağlayıcılar ve kullanılabilir modeller. |
| **Alt Ajan Yetkilendirmesi (Sub-agent delegation)** | OpenCodex yetkilendirme rehberliği ve yerel varsayılan katılımı tarafından paylaşılan yerel veya yönlendirilen bir model ve isteğe bağlı akıl yürütme seviyesi seçimi. |
| **Sidecar'lar** | Web arama modeli, akıl yürütme seviyesi ve görme (vision) açıklama modeli seçimi. Değişiklikler bir sonraki istekte uygulanır. |
| **Bakım (Maintenance)** | Codex model kataloğunu yeniden senkronize etme, en son veya önizleme sürümlerini kontrol etme ve güncelleme çalıştırma. |
| **Başlangıç Güvenliği** | Enjekte edilen Codex yönlendirmesinin yeniden başlatmada hayatta kalıp kalmadığını, servis ve başlatıcı shim durumunu gösterir. |
| **Windows Sistem Tepsisi (Tray)** | Tek tıklamayla proxy başlatma, durdurma, yeniden başlatma ve durum kontrolü sağlayan sistem tepsisi kontrolcüsü kurulumu. |
| **Codex Otomatik Başlatma** | Kurulu bir Codex başlatıcı shim'inin `ocx ensure` çalıştırmasına izin verme. |
| **Sağlayıcılar (Providers)** | Sağlayıcı ekleme, düzenleme, varsayılanı belirleme, etkinleştirme/devre dışı bırakma ve kaldırma; OAuth hesap havuzlarını ve API anahtarı havuzlarını yönetme. |
| **Codex Auth** | ChatGPT/Codex havuz hesapları ekleme, sonraki oturum hesabını seçme, 5 saatlik / haftalık / 30 günlük kotaları yenileme, kota otomatik geçişini yapılandırma. |
| **Alt Ajanlar (Subagents)** | `spawn_agent` geçersiz kılma listesinde en fazla beş yerel veya ad alanlı yönlendirilmiş modeli öne çıkarma. |
| **Modeller (Models)** | Yerel GPT ve yönlendirilen modelleri açıp kapatma, sağlayıcı izin listelerini ve bağlam sınırlarını ayarlama, v1/base/v2 seçimi. |
| **Günlükler (Logs)** | Tokenlar, akıl yürütme seviyesi, çözümlenen model, sağlayıcı, durum, istek kimliği, süre ve hata detaylarıyla son istekleri otomatik yenileyerek inceleme. |
| **Kullanım / Hata Ayıklama (Usage / Debug)** | Token kullanım eğilimlerini ve sağlayıcı taşıma tanılamalarını inceleme. |
| **Depolama (Storage)** | CODEX_HOME disk kullanımı dökümü (oturumlar, arşivler, veritabanları, ekler) ve arşiv temizleme. |
| **Durdurma (Stop)** | Proxy'yi ve kurulu arka plan servisini güvenle durdurma, yerel Codex'i geri yükleme ve çıkış yapma. |

## Yıldızlama Sizin Kararınızdır, Bir Ajanın Değil

Kenar çubuğundaki yıldız butonu ve etkileşimli terminalde `ocx start` komutunun sorduğu tek seferlik soru **kendi `gh` oturumunuz** üzerinden çalışır. opencodex hiçbir GitHub belirteci tutmaz.

Bu işlem GitHub hesabınıza yazdığı için ajan odaklı çağrıcıların sizin adınıza yanıt vermesi engellenir:

- `ocx start` ve `ocx service install`, bir ajan veya CI ortamı tarafından çalıştırıldığında bu istemi tamamen atlar.
- `POST /api/github/star` uç noktası, proxy bir ajan oturumu altında çalıştığında ve istek tarayıcı oturumu içermediğinde `403` (`agent_consent_required`) ile reddedilir.
- Kontrol panelindeki buton normal şekilde çalışmaya devam eder.
- "Hayır" demek istemi kalıcı olarak sonlandırır.

## Kontrol Paneli Proxy İle Nasıl İletişim Kurar?

GUI, proxy'nin JSON yönetim API'si üzerinde çalışan ince bir istemcidir. Önemli uç noktalar şunlardır:

| Uç Nokta | Amaç |
| --- | --- |
| `GET` / `PUT /api/settings` | Ayarları okuma veya Codex otomatik başlatma, bellek ayarlarını güncelleme. |
| `GET /api/startup-health` | Yönlendirme, servis, shim ve yeniden başlatma güvenlik tanılamalarını okuma. |
| `POST /api/sync` | Paylaşılan model kataloğunu yeniden oluşturma. |
| `GET` / `PUT /api/sidecar-settings` | Arama ve görme sidecar model ayarlarını yönetme. |
| `GET` / `PUT /api/injection-model` | Paylaşılan alt ajan model/akıl yürütme seçimini okuma veya ayarlama. |
| `GET /api/providers` · `POST /api/providers` | Sağlayıcıları listeleme, ekleme, güncelleme veya silme. |
| `GET /api/models` · `PUT /api/disabled-models` | Model satırlarını listeleme ve devre dışı bırakılan modelleri güncelleme. |
| `GET /api/codex-auth/accounts?refresh=1` | Ana ve havuz hesaplarını listeleme, kota yenilemeyi tetikleme. |
| `GET /api/logs` | Filtrelenebilir son istek meta verilerini ve günlükleri okuma. |
| `POST /api/stop` | Proxy'yi durdurma, yerel Codex'i geri yükleme ve çıkış. |

:::tip
Kontrol panelinden **Ollama Cloud** veya başka bir katalog sağlayıcısı eklemek, metin/görsel sınıflandırmasını kaydedilen sağlayıcı yapılandırmasına otomatik kopyalar; böylece [görme sidecar'ı](/guides/sidecars/) manuel yapılandırma gerekmeden doğru şekilde devreye girer.
:::
