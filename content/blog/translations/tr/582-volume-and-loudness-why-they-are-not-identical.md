---
language: "tr"
source_slug: "volume-and-loudness-why-they-are-not-identical"
source_sha256: "c5afea01c019d7d716ee9c9381688084918f14896336a67afc5e83d8a17ed1d1"
title: "Ses düzeyi ve algılanan ses yüksekliği: Neden aynı değiller?"
seo_title: "Ses düzeyi ve ses yüksekliği: Neden farklıdır?"
meta_description: "Ses kaydırıcısı neden ses yüksekliği ölçer değildir? Kazancı, program ses yüksekliğini, tepeleri, dinamik aralığı ve çıkışı tek sayıdan tahmin etmeden karşılaştırın."
excerpt: "Aynı ses ayarı farklı dinleme düzeyleri oluşturabilir. Uygulamalı hesap ve karşılaştırma listesiyle sinyal kazancını, program ses yüksekliğini, tepeleri ve çıkış yolunu ayırın."
topic_cluster: "Ses kalitesi okuryazarlığı"
sources_heading: "Kaynaklar"
next_step_heading: "Sonraki adımınız"
translation_status: "approved"
translation_method: "ai_assisted"
---

# Ses düzeyi ve algılanan ses yüksekliği: Neden aynı değiller?

> **Kısaca:** Ses düzeyi kontrolü, oynatma zincirinin bir noktasındaki kazancı değiştirir. Ses yüksekliği, sesin ne kadar güçlü algılandığıdır; program ses yüksekliği ölçümleri, tanımlanmış bir yöntemle ses sinyalinden bunu tahmin eder. Kayıt, miks ve işleme sinyali etkilerken çıkış cihazı ile dinleme ortamı da duyduklarınızı etkiler. Kaydırıcının aynı konumu, aynı dinleme düzeyini garanti etmez.

Kumandaya dokunmadan bir film diğerinden çok daha yüksek duyuluyorsa ses düzeyi kontrolü mutlaka değişmiş değildir. Farklı bir miks, ses parçası veya işleme modu duyuyor olabilirsiniz. Gösterilen sayıyı bütün deneyimin ölçümü saymak yerine kontrol ayarını, etkilediği sesten ayırarak başlayın.

## Her kazanç aşamasını belirleyin

Kazanç, sinyali belirli bir aşamada ölçeklemek demektir. Basit dijital kazanç her örneği bir değerle çarpar; [MDN'nin GainNode belgeleri](https://developer.mozilla.org/en-US/docs/Web/API/GainNode) bu ilkeyi gösterir. Tüketiciye sunulan kaydırıcı bu çarpanı doğrudan göstermek zorunda değildir; “50” ayarı evrensel bir akustik düzey veya algılanan ses yüksekliğinin yarısı garantisi değildir.

Gerçekten uygulanan kontrolleri kaydedin: Oynatıcı ses düzeyi, işletim sisteminin medya düzeyi, TV veya alıcı düzeyi, kulaklık kontrolleri ve parça başına ayarlar. Bazı kontroller bağlantılı olabilir; başka aşamalar ise seçilen yol için sabitlenmiş veya atlanmış olabilir. Kontrolleri tek tek değiştirmeden önce sesi hangi cihazın ürettiğini kontrol edin.

## Program ses yüksekliğini anlayın

[ITU-R BS.1770](https://www.itu.int/rec/R-REC-BS.1770/en), program ses yüksekliği ve gerçek tepe ölçümü için algoritmalar tanımlar. Program ses yüksekliği değeri, bir ses sinyalini o yöntem altında tanımlar; kulaklarınızdaki ses basıncını doğrudan ölçmez. Tavsiye ayrıca ölçülen ses yüksekliğinin algıyı, dinleyicilere, malzemeye ve dinleme koşullarına göre değişen bir belirsizlikle tahmin ettiğini belirtir.

Dijital tam ölçeğe referanslı ses yüksekliği birimleri olan **LUFS** ile karşılaşabilirsiniz. Bütünleşik ölçüm, analiz edilen programı veya kesiti kapsar; daha kısa süreli ölçümler ise daha küçük bir zaman aralığını tanımlar. Yöntemi, kanalları, analiz edilen aralığı ve ölçümün işlemeden önce mi sonra mı yapıldığını belirtin. Kısa bir diyalog örneğini tüm filmin sonucu olarak etiketlemeyin.

[EBU R 128](https://tech.ebu.ch/publications/r128), yayın normalleştirme çerçevesinde ses yüksekliği ölçümlerini kullanır ve ses yüksekliğini en büyük gerçek tepe düzeyinden ayırır. Her tüketici uygulaması için evrensel hedef değildir ve ses kaydırıcısını ölçere dönüştürmez.

## Tepeleri ve dinamik aralığı ayırın

Örnek tepeleri, kaydedilmiş en büyük mutlak örnek değerlerini tanımlar; gerçek tepe ölçümü ise örnekler arasında oluşabilecek dalga biçimi tepelerini tahmin eder. Bu sayılardan hiçbiri programın ne kadar sürekli yüksek kaldığını söylemez. Kısa bir darbe ile kesintisiz diyalog aynı tepeye ulaşabilirken genel dinleme düzeyleri farklı olabilir.

Dinamik aralık, daha sessiz ve daha yüksek malzeme arasındaki karşıtlıkla ilgilidir. Sabit ses düzeyi ayarını artırmak ikisini de yükseltir; sessiz diyaloğu seçici biçimde yüksek efektlere yaklaştırmaz. Dinamik aralık işleme farklı bir sorunu ele alır. Örneğin [Sony'nin resmî rehberi](https://www.sony.com/electronics/support/televisions-projectors/articles/00203665), belirli TV'ler ve ses biçimlerinde bu karşıtlığı değiştiren ayarları açıklar. Bu, cihaza özgü bir örnektir; Norva'nın aynı ayarı sunduğu iddiası değildir.

## Özgün katkı: Kazanç-ses yüksekliği kartı

Bu, **oluşturulmuş bir aritmetik örneğidir**; ölçülmüş medya, dinleme testi veya Norva ses ayarı değildir. Aşağıdaki örnek tepelere sahip iki dijital sinyal ve 0.5 değerinde basit doğrusal kazanç varsayalım. Birimsiz tepe değerleri dijital tam ölçeğin kesirleridir; desibel veya ses basıncı ölçümü değildir. Başka işleme dahil değildir.

| Oluşturulmuş sinyal | En büyük mutlak giriş örneği | Kazanç çarpanı | Hesaplanan çıkış örnek tepesi | Program ses yüksekliği veya kulaktaki düzey |
| --- | --- | --- | --- | --- |
| A | 0.20 | 0.5 | 0.20 × 0.5 = 0.10 | Bu değerlerden bilinemez |
| B | 0.60 | 0.5 | 0.60 × 0.5 = 0.30 | Bu değerlerden bilinemez |

Giriş sinyalleri farklı olduğundan aynı kazanç, farklı çıkış tepeleri bırakır. B'nin hesaplanan örnek tepesi A'nın üç katıdır; ancak bu B'nin üç kat yüksek duyulduğu anlamına **gelmez**. İki sinyalin geri kalanını, süresini, çıkış ekipmanını veya dinleme koşullarını belirtmedik.

Bu tepeleri eşleştirmek de eşit program ses yüksekliğini ortaya koymaz. Kart, bilinçli olarak aritmetiğin kanıtladığı yerde durur; LUFS değeri, kalite sıralaması veya güvenli kulaklık düzeyi sağlayamaz. 0.5 çarpanı, belirli bir ürünün kaydırıcısının %50'ye ayarlanması gerektiği anlamına da gelmez.

## Ses parçalarını eşleştirilmiş düzeyde karşılaştırın

Sorunuz hangi ses parçasının daha anlaşılır olduğuysa düzeyin kontrol edilmemiş fark olmasına izin vermeyin. Oynatma yetkiniz olan medya ile şu küçük karşılaştırma sürecini kullanın:

1. İki parçanın etiketlerini ve rollerini belirleyin. Yorum parçası, ana ses kuşağıyla aynı miks değildir; etiketler belirsizse [ses parçası listesi rehberini](/blog/how-to-read-an-audio-track-list-before-playback/) kullanın.
2. İki sürümde de aynı bölümü seçin. Başlangıç ve bitiş zamanlarını kaydedin; araştırdığınız sorun buysa diyalogla birlikte daha yüksek bir anı da dahil edin.
3. Cihazı, çıkış yolunu, dinleme konumunu ve işleme durumunu sabit tutun. Bilinmeyen ayarları kapalı varsaymak yerine kaydedin.
4. Düşük, rahat bir düzeyde karşılaştırın. Algılanan düzeyi kabaca eşleştirirken daha yüksek duyulan parçayı azaltın; sessiz parçayı, yüksek bir efekt rahatsız edici olana kadar artırmayın. Geçerli bir ses yüksekliği ölçer kullanıyorsanız yöntemini ve kapsamını ayrıca kaydedin.
5. Sırayı değiştirin ve “yaklaşık düzey eşleştirmesinden sonra diyalogu takip etmek hâlâ zor” gibi dar kapsamlı bir gözlem yazın. Gayriresmî tercihi ölçülmüş üstünlük iddiasına dönüştürmeyin.

Kulakla yapılan eşleştirme yaklaşık sonuçtur, standart uygunluğu sonucu değildir. Bölüm rahatça karşılaştırılamıyorsa karşılaştırmayı durdurun.

## Normalleştirmeyi dahil edin

Ses yüksekliği normalleştirmesi, program veya oynatma kazancını tanımlanmış bir ses yüksekliği ilişkisine doğru ayarlar. Tepe normalleştirmesi ise tepe ölçütü kullanır. Bu terimlerden hiçbiri tek başına bir programdaki sessiz diyalog ile yüksek efektlerin birbirine yaklaştırıldığı anlamına gelmez; bunun için göreli düzeylerinin değişmesi gerekir.

Hedefler, ölçüm kapsamı, tepelerin ele alınışı ve kullanıcı kontrolleri uygulamaya bağlıdır. Etkin normalleştirme veya dinamik işleme olup olmadığını uygulama, TV, alıcı ya da kulaklık belgelerinden kontrol edin. Bu makale Norva için normalleştirme hedefi ortaya koymaz ve Norva'nın EBU R 128 uyguladığını iddia etmez.

## Çıkış duyarlılığını ve odayı dahil edin

Kulaklıklar ve hoparlörler, aynı dijital sinyalden veya gösterilen ayardan farklı akustik düzeyler üretebilir. Oturuş, mesafe, oda yansımaları, arka plan gürültüsü ve cihaz işleme de dinlemeyi etkiler. Çıkışı değiştirirseniz ekrandaki sayı aynı kalsa bile karşılaştırmayı değiştirmiş olursunuz.

Sessiz ayrıntı oda gürültüsünde kayboluyorsa sesi sürekli artırmak yerine ortamı araştırın veya uygun [erişilebilirlik altyazısı kapsamından](/blog/captions-and-subtitles-why-the-accessibility-goals-can-differ/) yararlanın. [Dünya Sağlık Örgütünün güvenli dinleme rehberi](https://www.who.int/news-room/questions-and-answers/item/deafness-and-hearing-loss-safe-listening), hem ses düzeyini hem maruz kalma süresini vurgular; ara vermeyi ve gürültülü ortamlarda sesi artırma ihtiyacını azaltmayı önerir. Rahatlık tek başına maruziyet ölçümü değildir.

## Düzey farkını bildirin

Öğe/sürümü, tam parça etiketlerini, kesit zamanlarını, geçerli ses kontrollerini, işleme durumunu, çıkış yolunu ve cihazını, oda koşullarını, karşılaştırma yöntemini ve sonucu kaydedin. Geçerli ölçümleri yalnızca mevcutsa kapsamlarıyla birlikte ekleyin. “Ses yüksekliği ölçümü yok; TV işleme durumu bilinmiyor” ifadesi, kaydırıcıdan uydurulmuş desibel tahmininden daha yararlıdır.

[Eksiksiz ses kalitesi rehberi](/blog/the-complete-guide-to-understanding-audio-quality/), zincirin geri kalanını gösterir.

## Yaygın hatalar ve sınırlamalar

Cihazlar arasında kaydırıcı sayıları karşılaştırmaktan, tepe eşleştirmesini ses yüksekliği eşleştirmesi saymaktan veya doğrulanmamış telefon ses düzeyi değerini kalibre edilmiş kanıt olarak kullanmaktan kaçının. Hoparlörün yanındaki telefon mikrofonu da kulaklık içindeki sesin doğrudan ölçümü değildir. Gayriresmî dinleme; resmî ses yüksekliği uygunluk testi, işitme değerlendirmesi veya bir kodeğin ya da oynatıcının daha iyi olduğunun kanıtı değildir.

## Yol değişikliğinden sonra düzeyi kontrol edin

Hoparlörden kulaklığa veya alıcıya geçerken oynatmayı başlatmadan ya da sürdürmeden önce hedefin düzeyini kontrol edin ve düşük başlayın. Önceki sayıyı kopyalamak yerine etkin kazanç aşamalarını kaydedin. Yolu ve medyayı aynı anda değiştirdiyseniz farkı yeni ses parçasının yarattığına karar vermeden önce düşük düzeyde bildiğiniz bir bölüme dönün.

## Sık sorulan sorular

### Ses düzeyi, program ses yüksekliğiyle aynı mıdır?

Hayır. Ses düzeyi kontrolü, oynatmanın bir aşamasında kazancı ayarlar. Program ses yüksekliği değeri, sinyali belirtilmiş bir ölçüm yöntemi altında niteler; ikisinden hiçbiri tek başına kulaklarınızdaki akustik düzeyi belirlemez.

### Aynı kaydırıcı değeri iki cihazda aynı ses yüksekliğini üretir mi?

Hayır. Kazanç yapısı, yükselteç, çıkış duyarlılığı, hoparlör veya kulaklık, oda ve işleme farklıdır.

### Tepe normalleştirmesi ile ses yüksekliği normalleştirmesi aynı mıdır?

Hayır. Tepe ve ses yüksekliği ölçümleri farklı özellikleri tanımlar ve farklı iş akışlarını destekler.

## Sonraki adımınız

Başka bir sürümü karşılaştırmadan önce gerçekten kullandığınız parçayı ve çıkış yolunu kaydedin. Ardından belgelenmemiş bir normalleştirme modu varsaymadan [Norva'nın oynatma özelliklerini keşfedin](https://norva.tv/#features). Norva, içeriğin veya TV aboneliğinin dahil olmadığı medya oynatıcı yazılımıdır; medyanız kullanma yetkiniz olan uyumlu bir kaynaktan gelmelidir.

## Kaynaklar

- [MDN: Dijital kazanç ve GainNode](https://developer.mozilla.org/en-US/docs/Web/API/GainNode)
- [ITU-R BS.1770: Program ses yüksekliği ve gerçek tepe](https://www.itu.int/rec/R-REC-BS.1770/en)
- [EBU R 128: Ses yüksekliği normalleştirmesi](https://tech.ebu.ch/publications/r128)
- [Sony: Dinamik aralık ayarları ve geçerli biçimler](https://www.sony.com/electronics/support/televisions-projectors/articles/00203665)
- [Dünya Sağlık Örgütü: Güvenli dinleme, düzey ve maruz kalma süresi](https://www.who.int/news-room/questions-and-answers/item/deafness-and-hearing-loss-safe-listening)
- [Norva özellikleri](https://norva.tv/#features)
