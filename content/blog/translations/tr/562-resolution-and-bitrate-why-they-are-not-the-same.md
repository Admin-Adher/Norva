---
language: "tr"
source_slug: "resolution-and-bitrate-why-they-are-not-the-same"
source_sha256: "f01136e764e04cac55c20c14d3c6d393d827a51ecc5bf37cce8da07de71596be"
title: "Çözünürlük ve bit hızı: Neden aynı şey değiller?"
seo_title: "Çözünürlük ve bit hızı: 1080p, Mbps ve video kalitesi"
meta_description: "4 ve 8 Mbps hızındaki iki 1080p örneğini karşılaştırın, veri kullanımını hesaplayın ve çözünürlük ile bit hızının kalite hakkında neler söylediğini öğrenin."
excerpt: "Kare boyutları ile veri hızının; kodek, kaynak, sahne karmaşıklığı, hareket ve iletim bağlamını içeren kontrollü karşılaştırması."
topic_cluster: "Video kalitesi okuryazarlığı"
sources_heading: "Kaynaklar"
next_step_heading: "Sonraki adımınız"
translation_status: "approved"
translation_method: "ai_assisted"
---

# Çözünürlük ve bit hızı: Neden aynı şey değiller?

> **Kısaca:** Çözünürlük, her video karesinin genişliğini ve yüksekliğini örnek veya piksel cinsinden tanımlar. Bit hızı, zaman içinde kullanılan kodlanmış veri miktarını genellikle bir hız olarak ifade eder. Bağımsız özelliklerdir: İki video aynı çözünürlükte farklı bit hızlarına veya farklı çözünürlüklerde benzer bit hızlarına sahip olabilir. İki değerden hiçbiri tek başına görünür kaliteyi garanti etmez.

Çözünürlük “Kareyi kaç uzamsal örnek oluşturuyor?” sorusunu yanıtlar. Bit hızı “Zaman içinde ne kadar kodlanmış veri ayrılıyor?” sorusunu yanıtlar. Kodek, kodlayıcı ayarları, kaynak, kare hızı, hareket, gürültü ve sahne karmaşıklığı bu verinin görüntüyü ne kadar etkili temsil ettiğini belirler.

## Uygulamalı örnek: İki 1080p video, farklı veri hızları

**Kare başına 1920 × 1080 piksel** içeren iki video parçası düşünün. İkisinin de her karesinde 2.073.600 piksel vardır. A sürümüne ortalama 4 Mbps, B sürümüne ortalama 8 Mbps video bit hızı verin. Kare boyutları aynı kalır; ikinci parça aynı sürede iki kat kodlanmış video biti kullanır.

![İki açıklayıcı kare de 1920 × 1080 boyutundadır. Varsayılan 4 ve 8 Mbps ortalama video hızlarında bir saniye sırasıyla 4 ve 8 megabit kullanır; bu sayıların hiçbiri görüntü kalitesi puanı değildir.](/assets/blog/resolution-bitrate-worked-example.svg "Özgün aritmetik çizimidir; Norva ekran görüntüsü veya kodlanmış video testi değildir. Izgaralar şematiktir, tek tek pikselleri göstermez.")

On dakika için yalnızca video hesabı:

| Varsayılan ortalama video hızı | 600 saniye için hesap | Video verisi, ondalık MB |
|---|---|---|
| 4 Mbps | 4 × 600 ÷ 8 | 300 MB |
| 8 Mbps | 8 × 600 ÷ 8 | 600 MB |

Burada Mbps, saniyede milyon **bit**; MB, milyon **bayt** demektir ve her bayt sekiz bittir. Bu örneklere ses, altyazı, kapsayıcı ek yükü, şifreleme ve ağ ek yükü dahil değildir. Değişken hızlı parçada bu hesap için tepe değer değil, süre boyunca ortalama gerekir. Sonuç, Norva indirme boyutu veya gerekli bağlantı hızı vaadi değildir.

Hangi sonuca varabilirsiniz? Bu örnekte B sürümü iki kat video verisi taşır. İki kat ayrıntılı olduğu, iki kat iyi göründüğü veya belirli cihazda sorunsuz oynatılacağı sonucuna varamazsınız. Bu sorular görüntü ve oynatma karşılaştırması gerektirir.

## Çözünürlüğün ne anlatabildiğini anlayın

Kare boyutları, kodlanmış görüntü için en büyük uzamsal ızgarayı belirler. Kaynağın buna karşılık gelen ayrıntı içerip içermediğini, daha önce sıkıştırılıp sıkıştırılmadığını veya ölçekleme ve filtrelemenin onu yumuşatıp yumuşatmadığını söylemez.

Daha küçük veya bozulmuş kaynaktan oluşturulmuş büyük kare, kaynağın sınırını yine taşır. [Tam kalite rehberi](/blog/the-complete-guide-to-understanding-video-quality/), kaynak, kodlama, iletim, çözme ve ekranı ayrı katmanlar olarak açıklar.

## Bit hızının ne anlatabildiğini anlayın

Bit hızı zaman içindeki veriyi gösterir; ancak bildirilen değer hedef, ortalama, tepe, ölçülmüş segment hızı veya kapsayıcı düzeyi bilgisi olabilir. Değişken hızlı kodlama farklı anlara farklı miktarlar ayırabilir. Sayının neyi temsil ettiğini ve nasıl elde edildiğini daima kaydedin.

Daha fazla veri kodlayıcıya daha geniş alan sağlayabilir; ancak farklı kodekler, profiller, kaynaklar, çözünürlükler, kare hızları ve kodlayıcı uygulamaları arasında yalın bit hızını karşılaştırmak kontrollü kalite testi değildir.

## Sahne karmaşıklığını dahil edin

Temiz arka planlı sakin çekimi temsil etmek; hızlı hareket, ince doku, film greni, su, duman, konfeti veya hızlı ışık değişimlerini temsil etmekten daha kolay olabilir. Bu yüzden aynı kodlama bir sahnede güçlü görünürken başka sahnede bozulmaları gösterebilir.

Gördüğünüzü açıklayın: Kare bloklar, kenar çevresinde haleler, renk geçişinde görünür basamaklar veya harekette kaybolan ince ayrıntılar. Bu gözlemler, görüntünün yalnızca “1080p olmadığını” söylemekten daha yararlıdır; hiçbiri nedeni tek başına belirlemez.

## Kodek ve kodlayıcı bağlamını dahil edin

Kodek belirtimi, çözme biçimini ve araçları tanımlar; her kodlayıcı çıktısını eşit derecede etkili kılmaz. Kodlayıcı kararları, profil, bit derinliği, renk örnekleme biçimi, anahtar kare yapısı ve diğer parametreler önemli olabilir. Yalnızca doğrulayabildiğiniz özellikleri kaydedin.

Bir kodeğin belirli bit hızında bütün içeriklerde daima daha iyi göründüğünü iddia etmeyin.

## Kendi medyanız için bu karşılaştırma kartını kopyalayın

| Alan | A sürümü | B sürümü | Kontrol altında mı? |
|---|---|---|---|
| Kaynağın kökeni | Biliniyor/bilinmiyor | Biliniyor/bilinmiyor | Evet/hayır |
| Boyutlar | Doğrulanmış değer | Doğrulanmış değer | Evet/hayır |
| Bit hızı türü/değeri | Doğrulanmış bağlam | Doğrulanmış bağlam | Evet/hayır |
| Kodek/profil/kare hızı | Doğrulanmış/bilinmiyor | Doğrulanmış/bilinmiyor | Evet/hayır |
| Sahne/zaman kodu | Aynı | Aynı | Evet |
| Gözlenen bozulmalar | Açıklama | Açıklama | Uygulanamaz |
| İletim/cihaz/ekran | Bağlam | Bağlam | Evet/hayır |

Kaynak kökeni veya kodlayıcı ayarları farklıysa karşılaştırmayı tek değişkenin kanıtı olarak değil, gözlemsel olarak tanımlayın.

## Adil bir izleyici karşılaştırması yapın

Cihazı, çıkışı, ekran modunu, oturma yerini ve sahneyi sabitleyin. İki sürümün de amaçlanan oynatma durumunu kullandığını ve otomatik kalite değişiminden sonra kararlı hâle geldiğini doğrulayın. Aynı zaman kodlarında ince ayrıntıları, kenarları, geçişleri, karanlık bölgeleri ve hareketi karşılaştırın.

Birden fazla sahne kullanın: Durgun yüz, hareketli ince ayrıntı ve karanlık renk geçişi farklı sorunlar gösterir. Başkasının gözleminizi tekrarlayabilmesi için kesin zaman kodlarını yazın. Görüntü yalnızca yumuşak görünmek yerine duruyorsa, bu ayrı belirtiyi açıklamak için [başlangıç ve oynatma ortası arabelleğe alma rehberini](/blog/startup-buffering-or-mid-playback-buffering-separate-the-cases/) kullanın.

## Yanıltıcı hesaplardan kaçının

“Piksel başına bit” türü oranlar, boyutlar, kare hızı, bit hızı tanımı, kodek ve içerik kontrol altındayken teknik analizi destekleyebilir; ancak evrensel bir algısal puana dönüşmez. Ortalamalar anlık zorlanmayı ve değişken dağılımı gizleyebilir.

Medya bit hızını bağlantınızın kullanılabilir kapasitesiyle eşitlemeyin. [Bant genişliği, gerçek veri aktarım hızı, gecikme ve gecikme değişkenliği](/blog/bandwidth-throughput-latency-and-jitter-explained/), belirtilen kapasite ile gerçekten aktarılan veri arasındaki fark dahil iletimin farklı yönlerini açıklar.

## Arayüz etiketlerini dikkatle okuyun

Çözünürlük rozeti, şu anda ekrana ulaşan tam piksel sayısını değil, mevcut bir gösterimi veya medya özelliğini tanımlıyor olabilir. Bit hızı hiç sunulmayabilir. Değer uydurmak yerine güncel Norva rozetlerini ve oynatma davranışını resmî ürün bilgileriyle doğrulayın.

Norva, kullanıcıların sahibi olduğu veya kullanma yetkisi bulunduğu uyumlu kaynakları düzenler ve oynatır; katalog sağlıyor şeklinde tanımlanmamalıdır.

## Farkı bildirin

Giriş bilgileri olmadan sürümleri, doğrulanmış boyutları, bit hızı türünü ve kaynağını, biliniyorsa kodek ve kare hızını, sahne ve zaman kodunu, cihazı, iletim durumunu, ekran yolunu ve gözlenen bozulmaları ekleyin. Bilinmeyenleri açıkça işaretleyin.

## Sık sorulan sorular

### Daha yüksek çözünürlük daha yüksek bit hızı mı demektir?

Şart değildir. Daha fazla uzamsal ayrıntıyı temsil etmek kodlama ihtiyaçlarını değiştirebilse de bunlar bağımsız seçilen özelliklerdir.

### Daha yüksek bit hızı her zaman gözle daha iyi midir?

Kodekler, kaynaklar, ayarlar, sahneler ve cihazlar kontrol edilmemişse hayır. Tek sayı yerine eşleşen bağlamları karşılaştırın.

### Aynı iki bit hızı farklı görünebilir mi?

Evet. Çözünürlük, kodek, kodlayıcı kararları, kaynak, kare hızı ve sahne karmaşıklığı farklı olabilir.

## Sonraki adımınız

Görüntü kalitesi sorunu sürüyorsa tamamlanmış karşılaştırma kartını [Norva Destek’e](https://norva.tv/support) gönderin. Cihazı, kesin belirtiyi ve zaman kodlarını ekleyin; kaynak giriş bilgilerini ve özel medya URL’lerini dışarıda bırakın. Norva, sahibi olduğunuz veya kullanma yetkiniz bulunan uyumlu kaynak için yazılım oynatıcıdır; medya kataloğu sağlamaz.

## Kaynaklar

- [ITU-R BT.2020: UHDTV sistem parametreleri](https://www.itu.int/rec/R-REC-BT.2020/en)
- [W3C: Medya yetenekleri](https://www.w3.org/TR/media-capabilities/)
- [Alliance for Open Media: AV1 belirtimi](https://aomedia.org/specifications/av1/)
- [Norva özellikleri](https://norva.tv/#features)
