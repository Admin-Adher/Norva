---
language: "tr"
source_slug: "bandwidth-throughput-latency-and-jitter-explained"
source_sha256: "1187d6fb8fd3c55e3350243076646f12a474e161b0a321d197fcb55237b068da"
title: "Bant genişliği, gerçek veri aktarım hızı, gecikme ve gecikme değişkenliği"
seo_title: "Bant genişliği, aktarım hızı ve gecikme: Video rehberi"
meta_description: "Uygulamalı video ağı örneğiyle bant genişliği, aktarım hızı, gecikme ve değişkenliğini anlayın. Hız testi puanı veya evrensel jitter sınırı neden yanıltabilir?"
excerpt: "Kapasite, ölçülen aktarım hızı, gecikme ve gecikme değişkenliği farklı soruları yanıtlar. Arabelleğe almayı tek sayıya bağlamadan önce tamamlanmış ağ karşılaştırmasını yorumlayın."
topic_cluster: "Video için ev ağı temelleri"
sources_heading: "Kaynaklar"
next_step_heading: "Sonraki adımınız"
translation_status: "approved"
translation_method: "ai_assisted"
---

# Bant genişliği, gerçek veri aktarım hızı, gecikme ve gecikme değişkenliği

> **Kısaca:** Bant genişliği, kullanılabilir veya nominal kapasite kavramıdır; gerçek veri aktarım hızı ise belirli bir testte ölçülen yararlı veri hızıdır. Gecikme, bekleme süresini; jitter ise belirtilmiş yöntem altında gecikme değişkenliğini tanımlar. Paket kaybı bunlardan yine ayrıdır. Video birinden veya birkaçından etkilenebilir; bu yüzden sayıyı yorumlamadan önce yöntemi ve yolu kaydedin.

Her ölçüt kısmi bir görünüm sunar. Birimleri aynı olan iki test bile farklı uç noktaları, protokolleri, yönleri, süreleri, rotaları veya trafik koşullarını ölçebilir.

## Bant genişliği, teslim edilmiş sonuç değildir

İnsanlar bant genişliğini sık sık hızın kısaltması olarak kullanır; ancak kapasite etiketleri, belirli bir aralıkta ne kadar uygulama verisinin ulaştığını söylemez. Paylaşılan bağlantılar, protokol ek yükü, sıkışıklık, radyo koşulları, cihaz sınırları ve uzak uç nokta gözlenen aktarım hızını düşürebilir.

Bu nedenle plan hızı, Wi-Fi bağlantı hızı, Ethernet etiketi ve uygulama aktarım hızı farklı değerlerdir. Başkasıyla karşılaştırmadan önce ekranın hangisini gösterdiğini kaydedin.

## Gerçek veri aktarım hızı bir test bağlamı gerektirir

Gerçek veri aktarım hızı, ölçülmüş aktarım oranıdır. RFC 6349, TCP aktarım hızı testi için bir çerçeve tanımlar ve test yöntemini vurgular. Sonuç; uç noktası, yönü, protokolü, süresi, bağlantı sayısı, cihazı, rotası ve zamanıyla birlikte anlam taşır.

[Ev ağı temelleri rehberi](/blog/the-complete-guide-to-home-network-basics-for-video/), cihazla kaynak arasındaki yolu gösterir. Yakındaki test sunucusu, kullanma yetkiniz olan her kaynak yolunu yeniden oluşturmaz; kısa bir tepe değeri de sürdürülen uygulama performansı olarak sunulmamalıdır.

## Gecikme, geçen bekleme süresidir

Gecikme, verinin veya yanıtın ölçülen bir yoldan geçmesinin ne kadar sürdüğünü tanımlar. RFC 7679'un yönteminde tek yönlü gecikme için saat eşzamanlaması ve zamanlama belirsizliğinin hesaba katılması gerekir; birçok tüketici aracı ise gidiş-dönüş süresini bildirir. Bu sonuçlar birbirinin yerine geçmez.

Videonun başlaması, kontroller, kimlik doğrulama ve segment istekleri farklı nedenlerle hızlı veya gecikmeli hissedilebilir. Yüksek aktarım hızı sonucu, kendiliğinden düşük gecikme demek değildir.

## Jitter, yalnızca yavaşlık değil değişkenliktir

RFC 3393, paket gecikmesi değişkenliği ölçütlerini tanımlar. Günlük araçlarda “jitter” farklı hesap, yön, aralık veya istatistik kullanabilir. Değerleri karşılaştırmadan önce aracın tanımını okuyun.

Bir bağlantının ortalama aktarım hızı yeterli olduğu hâlde paket varışları düzensiz olabilir; ya da gecikme kararlı olsa bile sürekli aktarım hızı yetersiz kalabilir. Sabit 80 ms gidiş-dönüş süresi ile 20 ve 140 ms arasında gidip gelen bir süre aynı ortalamaya sahip olup farklı davranabilir. Bu örnek, değişkenliği anlatır; jitter formülü veya kabul edilebilir sınır değildir.

## Paket kaybı başka bir boyuttur

RFC 7680, açık yöntemi olan tek yönlü paket kaybı ölçütünü tanımlar. Tüketici sonuçları ise kaybı gelmeyen yanıtlardan çıkarabilir; bazı cihazlar tanılama trafiğine daha düşük öncelik verebilir. Bildirilen sıfır, her uygulama paketinin ulaştığını kanıtlamaz; sıfırdan farklı sonucun tekrarı ve kapsamı gerekir.

Notlarınızda gelmeyen paketleri geç gelenlerden ayrı tutun. Oynatma duraklaması görünür bir belirtidir, paket düzeyinde teşhis değildir.

## Özgün katkı: Ölçüt sözlüğü

| Ölçüt | Günlük dille soru | Gerekli bağlam | Tek başına neyi kanıtlayamaz? |
|---|---|---|---|
| Bant genişliği/kapasite | Bu bağlantı tanımı altında ne taşıyabilir? | Bağlantı, etiket, yön | Uygulama verisinin iletimini |
| Gerçek veri aktarım hızı | Hangi yararlı hız ölçüldü? | Uç nokta, protokol, süre, rota | Her kaynak yolunu |
| Gecikme | Yöntem ne kadar gecikme gözledi? | Tek yön/gidiş-dönüş, saatler, yol | Sürekli kapasiteyi |
| Jitter | Gecikme nasıl değişti? | Formül, örneklem, istatistik | Ortalama aktarım hızını |
| Kayıp | Beklenen hangi paketler yoktu? | Test paketi türü, yön, aralık | Oynatmanın kesin nedenini |

Her değere birim ekleyin ve gizliliğin izin verdiği ölçüde ham sonuçları saklayın.

### Uygulamalı örnek: Hızlı bir plan ve tutarsız bir akşam

Bunlar **kurmaca öğretici sonuçlardır**; Norva'nın veya bir kaynağın testi değildir. Hanenin 100 Mbps etiketli bir planı vardır. Aynı dizüstü bilgisayarı aynı Wi-Fi konumunda, aynı yakındaki uç noktaya karşı, aynı indirme ayarlarıyla ve her zaman diliminde 30 saniyelik üç denemeyle test eder.

| Gözlem | Sakin zaman dilimi | Yoğun zaman dilimi | Yorum |
|---|---|---|---|
| İndirme aktarım hızı, üç deneme | 82, 80, 84 Mbps | 28, 14, 31 Mbps | Ortanca 82'den 28 Mbps'ye düşer; yoğun dönemde aralık 14–31 Mbps'dir |
| Aynı yük koşulunda alınan, aracın bildirdiği ortanca gidiş-dönüş gecikmesi | 18 ms | 65 ms | Bu test yolu yoğun dönemde daha yavaş yanıt verir |
| Aynı formül ve örnekleme ayarlarıyla aracın gösterdiği jitter | 3 ms | 24 ms | Aracın tanımına göre gecikme daha çok değişir; bu geçer/kalır notu değildir |
| Yoğun dönemde izleme yetkisi bulunan video | Kontrol edilmedi | İki duraklama kaydedildi | Duraklamalar daha kötü sonuçlarla aynı zamana denk gelir, ancak video uç noktası ölçülmemiştir |

Makul sonraki adım, belirtinin görüldüğü zamanda tekrarlamak ve destekleniyorsa isteğe bağlı olarak yalnızca yerel bağlantıyı Ethernet'e çevirmektir. Hemen daha hızlı plan satın almak **değildir**. 14 Mbps örneği bile videonun oynatılabilmesi gerekip gerekmediğini ortaya koyamaz: Sürümün gerçek gereksinimleri, kısa düşüşler, kaynak yolu ve arabelleğe alma davranışı bilinmemektedir.

Mbps'yi (saniyede megabit), MB/s'den (saniyede megabayt) ayırın: Ölçümün ek yük tanımı hesaba katılmadan 8 Mbps, 1 MB/s'ye eşittir. Milisaniye veri hızını değil zamanı tanımlar. Bu birimler, büyük sayının her zaman daha iyi bağlantı anlamına geldiği varsayımıyla karşılaştırılamaz.

## Küçük bir ölçüm kümesi oluşturun

Etkilenen cihazı olağan konumunda kullanın. Sakin zamanda aralıklı üç örnek, belirtinin yaşandığı dönemde de üç örnek kaydedin. Güvenli ve destekleniyorsa uç noktayı veya test ayarlarını değiştirmeden alternatif tek yerel bağlantı üzerinden tekrarlayın.

Sonra en iyi sayıyı seçmek yerine ortancaları, aralıkları ve tekrarlanmayı karşılaştırın. Eşzamanlı yüklemeleri, mesh değişimlerini, cihazın güç durumunu ve hava koşullarını yalnızca doğrudan gözlendiğinde not edin; rastlantısal olayların çevresinde nedensellik hikâyeleri uydurmayın.

## Birleşimleri yorumlayın

Düşük sürekli aktarım hızı oynatma arabelleğini boşaltabilir. Gecikme değişkenliği ve kayıp, kısa süreli ortalama hız yeterli görünse bile iletimi aksatabilir. Yüksek gecikme, uzun aktarımı mutlaka sınırlamadan istek-yanıt dizilerini yavaşlatabilir. Görünür etkiyi uygulama, taşıma davranışı, arabellek tasarımı ve kaynak belirler.

Oynatma devam ediyor ama görüntü kötü görünüyorsa bulanıklığı yavaş ağın kanıtı saymak yerine [görüntü kalitesi karşılaştırmasını](/blog/the-complete-guide-to-understanding-video-quality/) kullanın. Norva, kullanma yetkiniz olan uyumlu kaynakları oynatır; katalog sağlamaz ve yönlendiricinizi, kaynak yolunu veya kodlamasını kontrol etmez.

## Yaygın yorumlama hataları

Bit ile baytı karşılaştırmayın, bağlantı hızını gerçek aktarım hızıyla karıştırmayın, tüm gecikme değişkenliğini “paket kaybı” diye adlandırmayın veya tek sunucu sonucunu garanti saymayın. Yalnızca yönlendirici, cihaz ve kaynağı birlikte değiştirdikten sonra ölçmekten kaçının.

## Sık sorulan sorular

### Video için en önemli ölçüt hangisi?

Hiçbir ölçüt her zaman baskın değildir. Hangi ölçümlerin ilgili olduğunu sürümün iletim biçimi, yol, cihaz ve belirti belirler.

### Gerçek aktarım hızı, plan etiketini aşabilir mi?

Etiketler, tahsis, test yöntemleri, birimler ve ek yük tanımları değişir. Bir farkı hata kabul etmeden önce her sayının neyi temsil ettiğini doğrulayın.

### Her araç jitter'ı aynı biçimde mi ölçer?

Hayır. Aracın formülünü, yönünü, test paketi türünü, örnekleme süresini ve bildirilen istatistiği kontrol edin.

### Video akışı için kabul edilebilir jitter nedir?

Video oynatmayı onaylayan evrensel bir milisaniye eşiği yoktur. Arabelleğe alınan isteğe bağlı video ile etkileşimli görüşmeler gecikmeyi farklı tolere eder; araçlar da jitter'ı farklı hesaplar. Aynı yöntemle tekrarlanan sonuçları gerçek belirtiyle karşılaştırın. Tek uygulama veya protokol için yayımlanan sınır, Norva için genel gereksinime dönüşmemelidir.

### İyi bir hız testinden sonra video neden arabelleğe alır?

Test farklı sunucu, rota, aktarım biçimi veya zaman dilimi kullanabilir. Kısa kesintileri kaçırabilir; oynatma kaynağa ve cihaza da bağlıdır. Sonraki testi seçmeden önce gecikmenin ilk kareden önce mi yoksa oynatma sırasında mı olduğunu kaydedin.

## Sonraki adımınız

[Oynatma belirtinizi sonraki kontrolle eşleştirin](https://norva.tv/blog/a-symptom-pattern-atlas-for-video-buffering/). Destek isteğinize kaynak giriş bilgilerini değil, cihazı, zaman dilimini, test yöntemini ve tekrarlanabilir tek belirtiyi ekleyin.

## Kaynaklar

- [RFC 6349: TCP aktarım hızı testi](https://www.rfc-editor.org/rfc/rfc6349)
- [RFC 7679: Tek yönlü gecikme ölçütü](https://www.rfc-editor.org/rfc/rfc7679)
- [RFC 3393: Gecikme değişkenliği ölçütü](https://www.rfc-editor.org/rfc/rfc3393)
- [RFC 7680: Tek yönlü paket kaybı ölçütü](https://www.rfc-editor.org/rfc/rfc7680)

