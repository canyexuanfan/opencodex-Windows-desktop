---
title: Katkıda Bulunma
description: opencodex geliştirme — kurulum, proje düzeni, kurallar ve yeni bir sağlayıcı veya adaptör ekleme.
---

## Kurulum

Kaynak kod üzerinden geliştirme yapmak için `PATH` üzerinde `bun` CLI aracının bulunması gerekir. Yayınlanan npm paketi kullanıcılar için kendi Bun çalışma zamanını paketlese de bu depodaki betikler yerel Bun kurulumunuz üzerinden çalışır.

```bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
bun install
bun run dev:proxy    # Proxy API'sini geliştirici modunda başlatır
bun run dev:gui      # Dashboard geliştirici sunucusu (başka bir terminalde)
bun run typecheck    # bun x tsc --noEmit
bun run test         # bun test ./tests/
```

`bun run dev` komutu `bun run dev:proxy` için bir takma addır. Dashboard geliştirici sunucusu `bun run dev:gui` ile çalışır; `GET /` altındaki paketlenmiş dashboard ise `bun run build:gui` (`gui/dist`) tarafından üretilir.

## Derleme ve Test Komutları

Kök paket Bun tabanlı TypeScript kullanır; ayrı bir sunucu derleme adımı yoktur. Yerel komutların CI ile eşleşmesi için tanımlı betikleri kullanın:

```bash
bun run typecheck                 # Katı TypeScript tip kontrolü
bun run test                      # tests/ altındaki tüm test paketi
bun test tests/router.test.ts     # Belirli bir test dosyası
bun run build:gui                 # Vite GUI derlemesi + paket hazırlığı
bun run privacy:scan              # CI tarafından kullanılan gizlilik/kimlik bilgisi taraması
bun run prepare:package           # Paket başlatıcılarını/varlıklarını yenileme
```

Çoğu test `tests/*.test.ts` altında bağımsız Bun testleridir. `tests/helpers/` paylaşılan yardımcıları, `tests/e2e-style/` ise daha geniş uçtan uca senaryoları barındırır. Değiştirdiğiniz alt sistem için odaklanmış bir regresyon testi ekleyin; ortak yönlendirme, adaptörler, yapılandırma veya sunucu davranışları için tüm test paketini çalıştırın.

Okumakta olduğunuz dokümantasyon sitesi `docs-site/` (Astro + Starlight) dizininde yer alır:

```bash
cd docs-site && bun install && bun dev
```

## Dokümantasyon Yayınlama

Genel dokümanlar GitHub Pages üzerinde <https://opencodex.me/> adresinde yayınlanır. `.github/workflows/deploy-docs.yml` iş akışı, `main` dalına `docs-site/**` klasörünü etkileyen push işlemlerinde tetiklenir, `docs-site`'ı derler ve dağıtır. Doküman değişikliklerini göndermeden önce çalıştırın:

```bash
cd docs-site
bun install --frozen-lockfile
bun run build
```

## CI ve Sürümler

GitHub Actions iş akışları sade tutulmuştur:

- **Çapraz Platform CI** (`.github/workflows/ci.yml`): Çalışma zamanı, testler, paket, betik veya TypeScript dosyalarına dokunan PR'larda ve `main` push'larında çalışır. Linux, Windows ve macOS üzerinde kurulum, tip kontrolü, testler, gizlilik taraması ve GUI derlemesini kapsar.
- **Sürüm Yayınlama** (`.github/workflows/release.yml`): Manueldir. Yayınlama öncesinde ilgili commit'in (`GITHUB_SHA`) CI kontrolünden geçmiş olmasını zorunlu kılar.
- **Hareketsiz Sorunlar (Stale needs-info)**: `needs-info` etiketli ve 14 gün işlem görmeyen açık sorunlara uyarı verir; 7 gün daha işlem yapılmazsa kapatır.
- **Issue Kalitesi** (`.github/workflows/enforce-issue-quality.yml`): Yeni ve düzenlenen issue'larda şablon yapısını doğrular ve uygun etiketleri otomatik atar.

Sürümler için yardımcı betiği kullanın:

```bash
bun run release VERSION           # Sürüm artışını commit/push eder; varsayılan olarak dry-run çalışır
bun run release VERSION --publish # CI onaylı dry-run anlaşıldıktan sonra yayınlar
bun run release:watch             # En güncel Release iş akışını izler
```

## Dallar (Branches)

- **`dev`** — Tek entegrasyon hedefidir. Pull Request'lerinizi buraya açın.
- **`main`** — Yalnızca sürümler içindir. `dev` dalından bakımcı kontrollü yükseltmelerle ilerler; doğrudan `main`e özellik PR'ı açmayın.
- **`preview`** — Ön sürüm kanalıdır.

Eski Go yerel çalışma zamanı (`dev2-go`) emekliye ayrılmıştır ve geçmişi [lidge-jun/opencodex-go-archive](https://github.com/lidge-jun/opencodex-go-archive) adresinde salt-okunur olarak arşivlenmiştir. `dev` üzerindeki Bun-native TypeScript tek çalışma zamanıdır.

Rebase PR'ları memnuniyetle karşılanır. Eski bir dalı güncel head seviyesine getirmek normal bir katkıdır — açıklamada kaynak commit'leri belirtin.

## Pull Request'ler

- **`dev`** dalını hedefleyin. **`main`** dalına asla özellik veya düzeltme PR'ı açmayın.
- Dalınızı **`main`**'den değil, güncel **`dev`** ucundan oluşturun. Zorunlu **`enforce-target`** kontrolü, merge tabanı güncel olmayan başlıkları reddeder.
- Gerçek ve açıklayıcı bir açıklama yazın: Ne yapıldığını ve nedenini belirten bir **Summary** ve çalıştırılan komutları içeren bir **Test plan**. Boş gövdeler veya kaçış karakteri (`\n`) kullanılan metinler kontrolden geçemez.
- Başlık veya açıklamada `gui` geçiyorsa, açıklamaya mutlaka kullanıcı arayüzü değişikliğini gösteren bir **ekran görüntüsü (screenshot)** ekleyin.
- İş akışı değişiklikleri `pull_request_target` kullanır.

## Proje Bakımcıları

Mevcut proje bakımcıları, sorumlulukları ve inceleme/birleştirme politikaları [`MAINTAINERS.md`](https://github.com/lidge-jun/opencodex/blob/main/MAINTAINERS.md) dosyasında belgelenmiştir.

## Kod Standartları ve Kurallar

- **Yalnızca ES Modülleri** (`import`/`export`), TypeScript, `strict` mod. `bun x tsc --noEmit` çıktısının hatasız olduğundan emin olun.
- **Dosya başına en fazla ~500 satır** — sorumluluklara göre ayırın (örneğin `web-search/` ve `vision/` sidecar'ları tek bir `index.ts` arkasında küçük ve odaklanmış modüllerdir).
- **Asenkron hataları sınırlarda yakalayın** — sidecar'lar asla ana istek yoluna hata fırlatmaz; zarif bir hata işaretine indirgenir.
- **Dışa aktarımları (exports) koruyun** — diğer modüller bunlara bağımlı olabilir.

## Kataloğa Yeni Bir Sağlayıcı Ekleme

Tüm sağlayıcı seçicileri ve şablonları resmi kayıt dosyasından (`src/providers/registry.ts`) türetilir:

```ts
{
  id: "my-provider",
  label: "My Provider",
  baseUrl: "https://api.example.com/v1",
  adapter: "openai-chat",
  authKind: "key",
  dashboardUrl: "https://example.com/keys",
  models: ["model-a", "model-b"],
  defaultModel: "model-a",
  noVisionModels: ["model-a"],   // Yalnızca metin destekleyen modeller → vision sidecar görselleri açıklar
},
```

`src/providers/derive.ts` bu girdiyi `ocx init`, `ocx provider`, dashboard şablonları, API anahtarı girişi ve OAuth yapılandırmalarına besler.

### Resmi Bir Şablon İçin Gerekli Kanıtlar

Kayıt girdisi taahhüt edilen bir sözdür: opencodex, kullanıcının API anahtarının gönderildiği hedefi tanımlar. Bu nedenle bir şablon çalışan bir kod yolundan ziyade birincil kaynak kanıtı gerektirir. PR açıklamasında aşağıdakiler bulunmalıdır:

- **Belgelenmiş OpenAI uyumlu uç noktalar:** Sağlayıcının kendi API referans bağlantısı.
- **Hizmet şartları ve yasal tüzel kişilik:** Uç noktayı kimin işlettiğini ve kullanıcı trafiğinin hangi şartlarda işlendiğini belirten yasal sayfa.
- **Toplayıcılar için yeniden satış veya yönlendirme yetkisi:** Üçüncü taraf modelleri sunan bir ağ geçidi için yetkilendirme kanıtı.
- **Belirtilmiş bir bakım sorumlusu:** Temel URL veya kimlik doğrulama değiştiğinde şablonu kimin güncelleyeceğini belirtin.
- **Doğrulama tarihi:** Kaynağın incelendiği tarih.

## Adaptör Ekleme

`src/adapters/` altında `ProviderAdapter` arayüzünü uygulayın (Bkz: [Adaptörler](/reference/adapters/)), adını `src/server/adapter-resolve.ts` içine kaydedin ve çıktısını dahili `AdapterEvent` olaylarına köprüleyin. Görseller için `image.ts` dosyasını yeniden kullanın ve standart akış/araç çağrıları için `openai-chat.ts` dosyasını takip edin. `tests/` altına odaklanmış testler ekleyin.

## Tamamlandığını İddia Etmeden Önce Doğrulayın

Değişikliğinizi kanıtlayan en dar kapsamlı komutu çalıştırın — tipler için `bun run typecheck`, davranış için odaklanmış `bun test tests/NAME.test.ts`, ardından etkilenen alan için genel kontrolleri yapın. opencodex büyük paketler yerine küçük, doğrulanabilir commit'leri tercih eder.
