---
title: Pull Request Kalite Standartları
description: OpenCodex pull request'leri için incelemeye hazırlık, katkıcı sorumluluğu, otomatik denetimler ve kapatma politikası.
---

## Bir Şeyi Düzeltmek İçin İzne İhtiyacınız Yoktur

Karşılaştığınız gerçek bir hatayı (bug) düzeltmek için plansız bir Pull Request açmanız memnuniyetle karşılanır. Projenin en iyi düzeltmelerinin birçoğu tam olarak bu şekilde geldi — araç çağrılarından sonra takılan bir yönlendirilmiş model, yanlış model parametreleri gönderen bir sağlayıcı veya araç sonuçlarından kaybolan görseller. Bunların hiçbiri bir planlama tartışmasıyla başlamadı ve böyle bir zorunluluk olsaydı hiçbiri projeye kazandırılamazdı.

Daha büyük veya tasarımsal değişiklikler için önceden bir issue açmak, yanlış bir şey geliştirmeyi önlemek adına faydalıdır. Ancak bu bir zorunluluk değil, bir tavsiyedir.

## İncelemeye Hazır Bir PR Neleri Taahhüt Eder?

Bir PR'ı incelemeye hazır (ready for review) olarak işaretlemek, değişikliğin eksiksiz, anlaşılmış ve test edilmiş olduğunu iddia etmektir. Bir PR açmak, o dalın sorumluluğunu bakımcılara devretmez.

Yazarların değişen her satırı anlaması, doğrulama iddialarının arkasındaki kesin komutları ve sonuçları belirtmesi, davranış değişiklikleri için regresyon testleri eklemesi ve CI ile inceleme geri bildirimlerini çözmek için hazır bulunması beklenir. Bakımcılar sorunları tespit eder; katkıcı dallarını onarmak, eksik testleri yazmak veya otomatik bulguları sizin adınıza yamalara dönüştürmek zorunda değillerdir.

Çalıştırılan komutlar ve sonuçlar belirtilmeden yazılan "Test edildi" veya "CI geçti" ifadeleri geçerli bir kanıt değildir.

## Otomatik Denetimler (Automated Gates)

İnsan incelemesinden önce dört otomatik kontrol çalışır ve her hata mesajı neyi değiştirmeniz gerektiğini açıkça belirtir:

- **PR Kalitesi (`enforce-target`).** Pull Request'ler `dev` dalını hedeflemeli ve gerçek bir açıklama içermelidir: Ne değiştiğini ve nedenini açıklayan bir **Summary** ve bir **Test plan**. Başlık veya açıklama `gui` kelimesini içeriyorsa, açıklamada kullanıcı arayüzü değişikliğini gösteren bir ekran görüntüsü (screenshot) bulunmalıdır; kontrol, ekran görüntüsü eklenene kadar PR'ı taslak (draft) modunda tutar.
  Repo yetkisi olmayan katkıcı PR'ları taslak olarak açılır ve 4 kutucuklu incelemeye hazırlık kontrol listesi tamamlanana kadar taslakta kalır: Yerel CI yeşil, dal en güncel `dev` commit'i üzerinde, tüm bot tespitleri incelendi ve incelemeye hazır onayı verildi. Tamamlama durumu PR head commit SHA'sına bağlıdır; sonradan yeni commit push edilirse kontrol listesi sıfırlanır ve PR tekrar taslak durumuna döner. Tüm kutucuklar işaretlendiğinde bot PR'ı incelemeye hazır duruma getirir ve bakımcılara bildirim gönderir.
- **Çapraz Platform CI.** Test paketi ve macOS işleri yalnızca CI yol filtresi (`paths:`) eşleştiğinde çalışır; Windows test matrisleri yalnızca `workflow_dispatch` tetiklemelerinde çalışır ve Windows seçili duman testi (smoke-test) matrislerine dahil kalır. Yalnızca dokümantasyon veya `devlog/` değiştiren PR'lar test kuyruğuna alınmaz.
- **Tip Etiketi (Type Label).** `label` kontrolü PR başlığından `bug` / `enhancement` / `documentation` / `chore` etiketlerini otomatik türetir.

CodeRabbit her PR'ı inceler ve bulguları tavsiye niteliğindedir. Doğru tespitleri düzeltin; yanlış olduğu durumlarda nedenini belirtin. Birleştirmeyi (merge) engellemez.

## Korumalı Alanlar (Sponsored Surfaces)

Kimlik doğrulama, kimlik bilgisi yönetimi, GitHub Actions iş akışları, sürüm otomasyonu ve bağımlılık kurulumları, birleştirilmeden önce bir bakımcının sponsorluğunu (`maintainer-sponsored`) gerektirir.

## Bir PR Kapatıldığında

Çözülemeyen inceleme geri bildirimleri nedeniyle ilerlemeyen bir PR açık bir gerekçe belirtilerek kapatılabilir. Kapatılma kararı katkıcıya yönelik olumsuz bir hüküm değildir: Belirtilen sorun çözüldüğünde PR yeniden açılabilir veya temiz bir PR ile değiştirilebilir.
