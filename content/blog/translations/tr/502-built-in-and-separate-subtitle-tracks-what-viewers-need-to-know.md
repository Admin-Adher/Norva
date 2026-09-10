---
language: "tr"
source_slug: "built-in-and-separate-subtitle-tracks-what-viewers-need-to-know"
source_sha256: "98b9d0bbd83440fb5f247e1595988ce7cc53b352a8396f7bd1e88988ce55ed90"
title: "Dahili ve ayrı altyazı parçaları: İzleyicilerin bilmesi gerekenler"
seo_title: "Gömülü, harici ve görüntüye işlenmiş altyazılar"
meta_description: "Gömülü altyazı parçalarını, harici dosyaları ve görüntüye işlenmiş metni karşılaştırın. Kapsayıcı, parça seçici ve kapatma kontrolü neyi gösterebilir?"
excerpt: "Gömülü parça, görüntüye işlenmiş metin değildir. Tamamlanmış örnekle altyazı paketlemesini karşılaştırın; seçicinin kanıtladığını bilinmeyenlerden ayırın."
topic_cluster: "Altyazı yönetimi"
sources_heading: "Kaynaklar"
next_step_heading: "Sonraki adımınız"
translation_status: "approved"
translation_method: "ai_assisted"
---

# Dahili ve ayrı altyazı parçaları: İzleyicilerin bilmesi gerekenler

> **Kısaca:** Gömülü altyazı verileri medya kapsayıcısının içinde; harici altyazılar ise ayrı saklanıp medyayla ilişkilendirilir. Desteklendiğinde ikisi de seçilebilir parça olabilir. Görüntüye işlenmiş altyazılar zaten video görüntüsünün parçasıdır ve seçilebilir bir altyazı parçası gibi kapatılamaz. Çalışan altyazı seçici, altyazı verisinin nerede saklandığını değil, kontrolün çalıştığını kanıtlar.

“Dahili” sözcüğü hem gömülü parça hem de görüntüye kalıcı olarak işlenmiş metin için kullanılır. Bu belirsizlik önemlidir: Biri seçilebilir olabilirken diğeri görüntünün parçasıdır. Medyanın nasıl paketlendiğiyle başlayın, ardından bu oynatıcının seçilen sürüm için ne sunduğunu kontrol edin.

## Üç pratik kategoriyi tanımlayın

- **Gömülü seçilebilir parça:** Medya kapsayıcısının içinde, video görüntülerinden ayrı paketlenmiş ve desteklendiğinde seçenek olarak sunulan altyazı verisi.
- **Ayrı ilişkilendirilmiş parça:** Medyadan ayrı saklanan ve kaynak veya oynatma bağlamıyla ilişkilendirilen altyazı verisi. Ayrı dosyaya bazen eşlikçi, yani sidecar dosyası denir.
- **Görüntüye işlenmiş metin:** Video görüntüsünde zaten bulunan pikseller; hiçbir seçici bunları bağımsız olarak kapatamaz.

MKV veya MP4 gibi bir **kapsayıcı**, medya akışlarını ve meta verileri paketler. Kendisi altyazı parçası veya kod çözücü desteği garantisi değildir. [MDN'nin kapsayıcı rehberi](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Containers), kapsayıcıyı içindeki kodeklerden ayırır. Bu nedenle MKV uzantısı tek başına hangi altyazıların bulunduğunu veya belirli bir oynatıcının bunları sunup sunmayacağını söylemez.

Altyazı verisi her zaman düz metin değildir. [Matroska altyazı belirtimi](https://www.matroska.org/technical/subtitles.html), metin tabanlı altyazılar ile VobSub gibi görüntü tabanlı biçimleri açıklar. Görüntü tabanlı altyazı parçası yine de video görüntüsünden ayrıdır; “görüntü tabanlı”, “görüntüye işlenmiş” demek değildir. Bu kategoriler çeviri kalitesini veya erişilebilirlik kapsamının tamlığını değil, paketlemeyi tanımlar.

## Kategoriyi davranış üzerinden belirleyin

Tam öğe ve sürüm için altyazı seçiciyi açın ve hiçbir şeyi değiştirmeden önce kayıtları not edin. Tek parça seçin, etiketini kaydedin ve bir altyazı iletisi içeren sahneyi inceleyin. Kapatma kontrolü varsa kullanın ve aynı ana dönün; farklı iki anı karşılaştırmak, yalnızca altyazı iletisi ile altyazısız arayı karşılaştırmak olabilir.

Seçilen metin kaybolursa bu, o bağlamda kontrol edilebildiğini gösterir. Gömülü parçayı harici parçadan **ayırmaz**. Metin kalıyorsa görüntüye işlenmiş olması bir olasılıktır; ancak videonun parçası olduğu sonucuna varmadan önce başka etkin altyazı katmanını veya cihaz düzeyindeki altyazı özelliğini kontrol edin. Saklama biçimini yalnızca görsel üslupla değil, sağlanan medyaya ilişkin bilgilerle doğrulayın.

## Ayrı parça desteğini koşullu ele alın

Ayrı kaynak, doğru öğeyle ilişkilendirilmeyi ve oynatma bağlamının desteklediği biçimi gerektirir. Örneğin [HTML track öğesi](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/track), harici kaynağı açıkça işaret eder ve dil ile etiket sağlayabilir. [WebVTT taslak belirtimi](https://www.w3.org/TR/webvtt1/), bu amaçla kullanılan zamanlı metin biçimini tanımlar. Bu bir web platformu örneğidir, Norva'nın içe aktarma kontrollerinin açıklaması değildir.

Videonun yanında duran dosya, her oynatıcıda onunla kendiliğinden ilişkilendirilmez. Kullandığınız cihaz ve kaynak için belgelenmiş iş akışını kontrol edin. Harici altyazı parçalarının varlığı tek başına Norva'da herhangi bir yerel dosyanın içe aktarılabildiğini, otomatik dosya adı eşleştirmesini veya evrensel biçim desteğini ortaya koymaz.

## Özgün katkı: Paketleme kartı

Bu **yazarın oluşturduğu açıklayıcı örnek**, 00:18'de “The gate is open” (“Kapı açık”) sözünün geçtiği kurmaca Harbour Gate klibini kullanır. İndirilebilir örnek dosyalar veya Norva oynatma gözlemleri yoktur. A–C satırları, sahibinin klibi hazırlayabileceği farklı yolları tanımlar; kontrol davranışı, oynatıcının belirtilen kaynağı desteklediğini varsayar.

| Sürüm | Örnekte sağlanan paketleme bilgisi | Beklenen kontrol davranışı | Gerekçeli sonuç |
| --- | --- | --- | --- |
| A | MKV kapsayıcısı içinde video, ses ve ayrı İngilizce altyazı parçası var | İngilizceyi seçmek iletiyi gösterir; o parçayı kapatmak gizler | Saklama konumu açıkça bilindiği için gömülü altyazı parçası |
| B | MP4 video, iletiyi içeren ayrı İngilizce WebVTT dosyasıyla açıkça ilişkilendirilmiş | İngilizceyi seçmek iletiyi gösterir; kapatmak gizler | İlişkilendirme ve ayrı saklama bilindiği için harici altyazı kaynağı |
| C | Sahibi İngilizce cümleyi video görüntülerine işlemiş; altyazı parçası sağlanmıyor | Altyazı kapatma kontrolü bu pikselleri kaldıramaz | Sağlanan video böyle tanımlandığı için görüntüye işlenmiş metin |
| D | Yalnızca English etiketli oynatıcı kaydı biliniyor; iletiyi gösterip gizleyebiliyor | Açma/kapama A ve B'deki gibi çalışıyor | Seçilebilir altyazı parçası; gömülü veya harici saklama hâlâ doğrulanmamış |

A ve B satırları oynatıcıda aynı görünebilir. Önemli sınır D satırıdır: Kapatma kontrolü testi, bunları ayıramaz. Gerçek bir öğe, görüntüye işlenmiş metinle seçilebilir çeviriyi birleştirebilir; dolayısıyla farklı görünür satırlar için birden fazla kategori geçerli olabilir.

Kartı yeniden kullanmak için öğe/sürümü, seçici listesinin tamamını, seçilen etiketi, ileti zamanını, kapalı durum sonucunu ve paketleme bilgisinin kaynağını kaydedin. Medya kaynağı yeterli ayrıntı sunmadığı her yere “doğrulanmadı” yazın.

## Sürümleri dikkatle karşılaştırın

Bir sürüm altyazıları farklı paketleyebilir veya başka bir küme sunabilir. Sürümleri karşılaştırırken cihazı, profili ve medya kaynağını sabit tutun; her parça listesinin tamamını kaydedin. Başlığın yanı sıra edisyonu ve süreyi de doğrulayın: Başka kurguya zamanlanmış altyazı kaynağı, aynı adlı filmle örtüşmeyebilir.

Sürüm değişiminden sonra eksik parça, ayrı bir kaynağın yüklenemediğini kanıtlamaz.

## Eksik ayrı parçayı teşhis edin

Önce o parçayı neden beklediğinizi belirleyin. Katalog etiketi, sahibinin sağladığı dosya ve bu sürüm için gerçekten listelenen parça farklı kanıt türleridir. Kaynak sahibinin kaynağı ve seçilen sürümle ilişkisini doğrulayıp doğrulamadığını sorun.

Beklenen dili ve rolü, cihazı, uygulama veya tarayıcı sürümünü, bağlantıyı ve seçicinin tamamını kaydedin. “Listelenmiyor”, “listeleniyor ama seçilemiyor” ve “seçildi ama kontrol edilen anda ileti görünmüyor” durumlarını ayırın. Bu gözlemler farklı sorulara işaret eder; hiçbiri tek başına oynatıcı kusurunu kanıtlamaz. Dosyaları yeniden adlandırmadan, kaynakları taşımadan, medya kaynağını kaldırmadan, verileri temizlemeden veya yeniden kurmadan önce bu kanıtı koruyun.

## Özellik farklarını anlayın

Gömülü ve harici parçaların ikisi de yararlı altyazılar sağlayabilir. Biçimlendirme seçenekleri biçime ve görüntüleyiciye bağlıdır; metin ve görüntü tabanlı kaynakların aynı kontrolleri sunması gerekmez. Görüntüye işlenmiş metnin biçimi, altyazı seçicisinden bağımsız olarak değiştirilemez veya metin kapatılamaz. W3C'nin [altyazı rehberi](https://www.w3.org/WAI/media/av/captions/) de izleyicinin gizleyebildiği altyazıları, görüntüde kalan açık altyazılardan ayırır.

[Eksiksiz altyazı yönetimi rehberi](/blog/the-complete-guide-to-managing-subtitle-tracks/), parça bulunduktan sonra uygulanacak dil, rol, zamanlama, durum ve cihaz kontrollerini açıklar.

Ardından parçanın neler içerdiğini değerlendirin: [Erişilebilirlik altyazıları ve diyalog altyazıları farklı bilgi ihtiyaçlarını karşılayabilir](/blog/captions-and-subtitles-why-the-accessibility-goals-can-differ/). İletiler mevcut ama okunmaları zorsa saklama yöntemini suçlamak yerine [okunaklılık ile okunabilirliği](/blog/legibility-and-readability-two-different-viewing-problems/) ayırın.

## Kaynak haklarını ve gizliliği koruyun

Sahibi olduğunuz veya erişim yetkinizin bulunduğu medya ve altyazı kaynaklarını kullanın. Norva, içerik veya TV aboneliğinin dahil olmadığı medya oynatıcıdır; bir kaynağı bağlamak ona ilişkin hak sağlamaz. Gerekli izin olmadan medya veya altyazı dosyalarını desteğe yüklemeyin. Bildirime hassas olmayan etiketler, adımlar ve zaman damgalarıyla başlayın; paylaşmadan önce ekran görüntülerinde özel kaynak adresleri veya hesap ayrıntıları olup olmadığını inceleyin.

## Yaygın hatalar ve sınırlamalar

Görüntüye işlenmiş metne gömülü seçilebilir parça demekten, otomatik eşleştirme vaat etmekten, her biçimin desteklendiğini varsaymaktan ve kanıtı korumadan kaynak dosyaları düzenlemekten kaçının.

Kaynak yalnızca oynatılabilir seçenek sunuyorsa paketleme belirsiz kalabilir. Saklama yöntemini tahmin etmek yerine gözlenen seçici davranışını açıklayın.

## Sık sorulan sorular

### Görüntüye işlenmiş altyazılar kapatılabilir mi?

Metin görüntünün parçası olduğu için ayrı parça olarak kapatılamaz. Başka medya sürümü farklı olabilir, ancak kullanılabilirliğini doğrulayın.

### Ayrı altyazı parçaları her zaman metin dosyası mıdır?

Hayır. WebVTT ve SubRip metin tabanlı örneklerdir; ancak altyazı kaynakları VobSub gibi görüntü tabanlı da olabilir. “Ayrı”, iletilerin nasıl kodlandığını değil, kaynağın medyaya göre nerede saklandığını tanımlar. Gerçek biçimi ve belgelenmiş desteği kontrol edin.

### Eksik ayrı parça, oynatıcının bozuk olduğu anlamına mı gelir?

Hayır. Neden atamadan önce ilişkilendirmeyi, öğe/sürümü, kaynak meta verilerini, biçim desteğini ve seçiciyi doğrulayın.

## Sonraki adımınız

Kaynak bir altyazı kaynağını doğruluyor ama sonuç belirsiz kalıyorsa tamamlanmış paketleme kartınızı [Norva desteğe](https://norva.tv/support) iletin. Ne gözlediğinizi ve nelerin hâlâ doğrulanmadığını belirtin; ilk bildirime medya dosyalarını ve özel bağlantı ayrıntılarını dahil etmeyin.

## Kaynaklar

- [MDN: Medya kapsayıcıları ve içerdikleri kodekler](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Containers)
- [Matroska: Metin ve görüntü tabanlı parçalar dahil altyazı kodekleri](https://www.matroska.org/technical/subtitles.html)
- [MDN: HTML track öğesi ve harici kaynaklar](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/track)
- [W3C: WebVTT taslak belirtimi](https://www.w3.org/TR/webvtt1/)
- [W3C: Erişilebilirlik altyazıları, diyalog altyazıları, açık veya kapalı sunum](https://www.w3.org/WAI/media/av/captions/)
- [Norva: Özellikler ve uyumlu kaynak gereksinimleri](https://norva.tv/#features)
