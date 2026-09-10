---
language: "tr"
source_slug: "cold-start-or-warm-start-measure-the-right-tv-launch"
source_sha256: "1d98978ab5f697cccbc66a8ab0cd8d60492abc5f7897a76ab52c9df291edcdcb"
title: "Soğuk mu, ılık mı? TV uygulaması neden farklı hızlarda açılır?"
seo_title: "TV'de soğuk ve ılık başlatma: Açılış süresini adil ölçün"
meta_description: "TV uygulaması neden bir kez hızlı, sonra yavaş açılır? Uygulamalı zamanlama örneğiyle başlatma durumlarını, ilk görüntüyü ve kullanılabilir gezinmeyi ayırın."
excerpt: "Home'dan dönmek mutlaka yeni bir başlatma değildir. Aynı başlangıç durumunu karşılaştırın; görünür görüntüyü gerçekten yanıt veren gezinmeden ayırın."
topic_cluster: "Akıllı TV performansı"
sources_heading: "Kaynaklar"
next_step_heading: "Sonraki adımınız"
translation_status: "approved"
translation_method: "ai_assisted"
---

# Soğuk mu, ılık mı? TV uygulaması neden farklı hızlarda açılır?

> **Kısaca:** TV uygulaması sıfırdan başlayabilir, korunan durumdan yararlanarak ekranı yeniden oluşturabilir veya arayüzünün büyük bölümü bellekteyken geri gelebilir. Bunlar farklı işlerdir. Aynı başlangıç koşullarını karşılaştırın; hem ilk uygulama görüntüsünü hem de kullanılabilir kumanda gezinmesini zamanlayın. Logo görmek kataloğun hazır olduğunu kanıtlamaz.

Bu rehber, TV'yi evrensel bir hız hedefine göre puanlamak için değil, tutarsız açılış sürelerini açıklamaya çalışan izleyici içindir. TV işletim sistemleri süreçleri görünmeden yönetebilir. İç durumu doğrulayamıyorsanız teknik etiket uydurmak yerine ne yaptığınızı kaydedin.

## Dört durumu tanımlayın

Android, **cold**, **warm** ve **hot**, yani **soğuk**, **ılık** ve **sıcak** başlatmayı belgeler. Soğuk başlatmada uygulama sıfırdan oluşturulur; ılık başlatma korunan durumla başlangıç işlerinin bir kısmını yapar; sıcak başlatma ise korunan etkinliği öne getirir. Uygulama içindeki bir ekranı yeniden ziyaret etmek ayrı bir gezinme gözlemidir, Android'in dördüncü başlatma kategorisi değildir.

Pratik TV günlüğünde gözlenebilir şu dört durumu ayırın:

| Kaydedebileceğiniz durum | Ne anlatır? | Ne bilinmez? |
|---|---|---|
| Resmî TV yeniden başlatmasının ardından açılış | Uygulama açılmadan önce sistem yeniden başlatılmıştır | Gecikmenin ne kadarının sistem veya ağ hazırlığına ait olduğu |
| Back ile çıkıldıktan sonra yeniden açılış | Uygulamadan normal kontrolüyle çıkılmıştır | Sürecinin veya ekranının korunup korunmadığı |
| Home'a basıp 30 saniye bekledikten sonra dönüş | Kısa bir arka plan aralığı yaşanmıştır | Sistemin uygulamayı canlı tutup tutmadığı |
| Uygulamanın başka ekranından Movies'e dönüş | Gezinme uygulama içinde kalmıştır | Hangi katalog veya görsel kaynakların yeniden kullanıldığı |

[Katman rehberi](/blog/smart-tv-media-app-performance-a-layer-by-layer-guide/), yaşam döngüsünü ağdan ve görüntü oluşturmadan ayırır.

## İki bitiş noktası tanımlayın

İlk görünür kare; odak çalışmadan, görseller yüklenmeden veya gezinme yanıt vermeden önce gelebilir. “İlk uygulama karesi” ile “kullanılabilir ekran”ı ayrı kaydedin. Yalnızca soru buysa “görseller kararlı” noktasını ekleyin. Android'in TTID ve TTFD ölçümleri ilk görüntüyü tam hazırlıktan ayırır; ancak kumandadan ekrana elle yaptığınız zamanlama kendiliğinden bu araçla ölçülmüş değerlerden biri değildir.

Saati en elverişli dönüm noktasında durdurmayın.

## Bağlamı sabitleyin

TV modelini, işletim sistemini, uygulama sürümünü, giriş kaynağını, güç durumunu, çıkışı, kablolu veya Wi-Fi yolunu, zamanı, hesap bilgilerini koruyan oturum bağlamını, kaynak kullanılabilirliğini ve arka plan etkinliğini kaydedin. Ağ ve kaynak durumunu karşılaştırılabilir tutun.

Elle zamanlamada tepki süresi belirsizliği belirtilmelidir.

## Özgün katkı: Başlatma protokolü

Aşağıdaki değerler **kurmaca öğretici örneklerdir, Norva ölçümleri değildir**. Bir izleyici aynı TV'yi, uygulama sürümünü, hesabı ve kataloğu kullanır. Her deneme, uygulamayı açan kumanda basışıyla başlar. “Kullanılabilir”, amaçlanan ekranın görünmesi, bir yön tuşu hareketine yanıt verilmesi ve engelleyici katman kalmaması demektir. Süreler aynı başlangıç olayından itibaren saniye cinsindendir.

| Deneme | Gözlenen hazırlık | İlk uygulama karesi | Kullanılabilir gezinme | Görseller kararlı |
|---|---|---|---|---|
| A | Resmî yeniden başlatma; TV ana ekranı ve ağ hazır | 1.8 s | 4.6 s | 6.2 s |
| B | Home, 30 saniye bekleme, dönüş | 0.7 s | 1.2 s | 1.9 s |
| C | Aynı kısa dönüş | 0.8 s | 1.4 s | 2.0 s |
| D | A için kullanılan hazırlığın tekrarı | 1.9 s | 4.4 s | 6.0 s |

Yeniden başlatma sonrası iki gözlemde kullanılabilir gezinmeye 4.4–4.6 saniyede, kısa dönüşlerde ise 1.2–1.4 saniyede ulaşılır. Bu, hazırlıklar arasında tekrarlanabilir fark olduğunu düşündürür. Belirli bir önbelleğin ne kadar zaman kazandırdığını ortaya **koymaz**, sürecin ılık veya sıcak durumda olduğunu kanıtlamaz ve başka TV'nin sonucunu öngörmez.

Destek için yararlı gözlem, A ve D'de ilk kare ile yanıt veren gezinme arasındaki farktır. Uygulamayı “1.8 saniyede hazır” diye tanımlamak bu farkı gizler. Elle zamanlama, gözlemcinin tepki hatasını da içerir: Daha hassas ölçüm olmadan saniyenin onda biri kadar farkı performans iyileşmesi olarak yorumlamayın.

## Soğuk durumu güvenle oluşturun

Yalnızca resmî uygulama durdurma, TV yeniden başlatma veya güç yönergelerini kullanın. Sırf soğuk durum yaratmak için fişi çekmeyin, servis menülerini kullanmayın veya verileri temizlemeyin. Platform çalışmama durumunu doğrulayamıyorsa buna “yeniden başlatma sonrası açılış” deyin.

Güvenlik ve cihaz bütünlüğü, deneysel saflıktan önce gelir.

## Ilık durumu oluşturun

Genel bir Home veya Back dizisi, sürecin ılık durumda olduğunu garanti etmez. Bunu platform ölçüm araçlarıyla doğrulayamıyorsanız **kısa dönüş** kaydedin: Aynı ekrana ulaşın, belgelenmiş kontrolle ayrılın, sabit bir süre bekleyin ve dönün. Doğrulanmamış yaşam döngüsü etiketi atamadan ekranın, odağın veya görsellerin korunup korunmadığını not edin.

Korunan durum denemeler arasında değişebilir; bu nedenle beklenmedik yeniden yüklemeleri kayıtta tutun.

## Sırayı tersine çevirin ve ara verin

Uygunsa sabit dinlenme aralıklarıyla yeniden başlatma sonrası, kısa dönüş, kısa dönüş, yeniden başlatma sonrası sırasını kullanın. Sırayı tersine çevirmek; önbellek, sıcaklık, ağ veya kaynak değişimleriyle uyumlu bir örüntüyü ortaya çıkarabilir, ancak nedeni belirlemez. Onlarca başlatma yapmayın; önceden küçük bir sayı belirleyin.

Ölçüm araçları süreç durumunu ve zamanlama sınırlarını daha kesin ortaya koyabilir; ancak izleyicinin tekrarlanabilir görünür gecikmeyi bildirmek için geliştirici moduna veya özel günlüklere ihtiyacı yoktur.

## Farkları yorumlayın

Ilık başlatmanın soğuktan hızlı olması, korunan durumu veya önbellekteki kaynakları yansıtabilir; ancak hangi önbelleğin katkısını nicel olarak belirlemez. Ilık başlatmanın soğuk gibi davranması, uygulamanın sonlandırılmasını, güncellemeyi, bellek baskısını veya uygulama tercihini yansıtabilir.

Tekrarlanan konum kaybını veya beklenmedik yeniden yüklemeleri, TV'nin daha fazla belleğe ihtiyacı olduğunun kanıtı değil, gözlem olarak kaydedin. Yalnızca izlemeyi ekranlar arasında taşımak yavaş görünüyorsa önce [devretme, yansıtma ve casting rehberindeki](/blog/handoff-mirroring-or-casting-know-which-workflow-you-need/) mekanizmayı belirleyin.

## Değişiklikten sonra karşılaştırın

Uygulama güncellemesinden sonra aynı protokolü ve sürüm bağlamını tekrarlayın. Belleğinize güvenmek yerine önce/sonra notlarını koruyun. Eski bir yeniden başlatma sonrası açılışı yeni bir kısa dönüşle karşılaştırmayın.

Norva'nın TV açılış davranışı cihaza, sürüme ve bağlı kaynağa bağlıdır. Norva, kullanma yetkiniz olan uyumlu medya için oynatıcıdır; dahil edilmiş katalog değildir. Bu örnekler açılış hızını veya oynatma performansını onaylamaz.

## Deneme sırasını ve hazırlığı kontrol edin

Soğuk denemeler sıkça önce yapılır; bu yüzden başlangıç bakımı, ağın yeniden bağlanması veya gözlemci hazırlığı onları haksız yere olumsuz etkileyebilir. Platform belgelenmiş bir duruma izin veriyorsa oturumlar arasında sırayı değiştirin ve her başlatmadan önce aynı sabit süreyi bekleyin. Ana ekranın, kumandanın, ağın ve çıkışın zaten hazır olup olmadığını kaydedin.

Zamanlamadan önce “kullanılabilir”i tanımlayın: Örneğin amaçlanan ekran görünür, odak bir kez yanıt verir ve engelleyici katman kalmamıştır. Yalnızca logo belirdi diye zamanlamayı bitirmeyin. Ortancayı ancak tek tek değerler ve aralıkla birlikte bildirin; tek özet, küçük ortalama farktan daha önemli olan takılmış veya başarısız bir açılışı gizleyebilir.

## Sık sorulan sorular

### TV'yi açmak, uygulamanın soğuk başlatılmasıyla aynı mıdır?

Hayır. Sistem başlangıcını içerir ve uygulama durumunu farklı biçimde geri yükleyebilir.

### Kaç deneme gerekir?

Cihazı veya kaynağı zorlamadan aralığı gösterecek kadar, önceden belirlenmiş birkaç deneme kullanın.

### Görsellerin tamamlanması açılışı tanımlamalı mı?

Yalnızca görev görsel hazırlığıysa; ilk kareyi ve kullanılabilir odağı ayrı tutun.

## Sonraki adımınız

[Tekrarlanabilir bir TV açılış sorunu için yardım alın](https://norva.tv/support). TV modelini, işletim sistemi ve uygulama sürümünü, hazırlık adımlarını, beklenen ekranı ve iki zamanlama noktasını ekleyin. Ekran görüntülerine hesap tanımlayıcılarını, kaynak adreslerini ve giriş bilgilerini dahil etmeyin.

## Kaynaklar

- [Android Developers: Uygulama başlatma süresi](https://developer.android.com/topic/performance/vitals/launch-time)
- [Google TV Yardım: Yavaş veya takılan Google TV cihazını düzeltme](https://support.google.com/googletv/answer/12364830?hl=en)

