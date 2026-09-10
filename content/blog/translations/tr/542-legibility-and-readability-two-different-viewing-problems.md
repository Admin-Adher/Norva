---
language: "tr"
source_slug: "legibility-and-readability-two-different-viewing-problems"
source_sha256: "1b55217a33e5761ed80d94c9865abae96810f3ab7ef102102082a65f06d9dd9b"
title: "Okunaklılık ve okunabilirlik: İki farklı izleme sorunu"
seo_title: "Okunaklılık ve okunabilirlik: İki görsel medya örneği"
meta_description: "Etiketi tanımanın onu anlamaktan nasıl ayrıldığını görün. Telefon veya TV’de okuma engellerini iki kontrollü örnek ve tekrarlanabilir görevle tanımlayın."
excerpt: "Karakterleri ve kontrolleri tanımakla sözcükleri, hiyerarşiyi, etiketleri ve düzeni verimli biçimde anlamak arasındaki göreve dayalı ayrım."
topic_cluster: "Görsel konfor ve erişilebilirlik"
sources_heading: "Kaynaklar"
next_step_heading: "Sonraki adımınız"
translation_status: "approved"
translation_method: "ai_assisted"
---

# Okunaklılık ve okunabilirlik: İki farklı izleme sorunu

> **Kısaca:** Okunaklılık (“legibility”), metindeki tek tek karakterleri tanımayla ilgilidir. Okunabilirlik (“readability”), kişinin metni ne kadar kolay okuyup anladığıyla ilgilidir. Medya arayüzünde aynı pratik ayrımı, etiket ve kontrol durumlarını tanımakla bunların gruplamasını ve görevi anlamayı ayırmak için kullanırız. Net harfler net karar garantisi değildir; mantıklı bir düzen de ayırt edilmesi zor metinler içerebilir.

Yanlış teşhis zayıf düzeltmelere yol açar. Metni büyütmek okunaklılığı iyileştirirken kırpılma yaratıp okunabilirliği bozabilir; etiketleri sadeleştirmek taramayı iyileştirip düşük kontrastı düzeltmeyebilir.

## Aynı sözcüklerle farkı görün

Önce aşağıdaki **“Episode 18”** (“18. bölüm”) ifadesinin iki sürümünü karşılaştırın. Sözcükler, yazı tipi, boyut ve arka plan aynıdır; yalnızca metin kontrastı değişir. Soru şudur: “Sayıyı doğru tanıyabiliyor muyum?” Bu, olası bir tanıma engelini diğerlerinden ayırır. Ne kadar hızlı okuduğunuzu ölçmez veya gerçek izleme ortamını yeniden oluşturmaz.

Ardından **“Audio English Subtitles Off”** (“Ses İngilizce Altyazılar Kapalı”) ile aynı sözcüklerin iki satıra yerleştirilmiş hâlini karşılaştırın. Her sözcük net kalır ancak gruplama değişir. “English, ses ayarı mı yoksa altyazı ayarı mı?” diye sorun. Görev artık harfleri tanımak değil, etiketleri değerlerle ilişkilendirmektir.

![Kontrast çifti, Episode 18 ifadesini soluk ve parlak metinle tekrarlar. Gruplama çifti Audio English Subtitles Off ifadesini önce tek satır, ardından etiket-değer çiftleri hizalı Audio: English ve Subtitles: Off olarak gösterir.](/assets/blog/legibility-readability-paired-example.svg "Özgün açıklayıcı örneklerdir, Norva arayüzü ekran görüntüleri değildir. Örnekleri anlamanın tek yolu görsel olmasın diye metin makalede de tekrarlanmıştır.")

İkinci düzen olası bir iyileştirmedir, ölçülmüş kazanan değildir. Farklı dil, daha uzun değer veya daha dar ekran sonucu değiştirebilir. W3C’nin bilişsel erişilebilirlik rehberi açık gruplama ve boşluk kullanımını destekler; bu fikirleri uygulamak yine gerçek görevin sınanmasını gerektirir.

## Okunaklılığı doğrudan sınayın

İzleyiciden şunları tanımasını isteyin:

- birbirine benzeyen harfler veya sayılar;
- etiketiyle birlikte simgenin anlamı;
- odaklanmış kontrol ile seçili kontrol;
- etkin durum ile kullanılamayan durum;
- normal mesafede üstveri;
- altyazı noktalaması ve konuşmacı işaretleri.

Yalnızca izleyicinin sonunda yanıt verip vermediğini değil, hataları ve harcanan çabayı kaydedin.

## Okunabilirliği görevlerle sınayın

İzleyiciden şunları isteyin:

- bir satırı tarayıp başlık seçmesi;
- filtre grubunu anlaması;
- özet ve üstveriyi okuması;
- sürümleri karşılaştırması;
- iletişim kutusunda gezinip amaçlanan işlemi doğrulaması;
- önceki bağlama dönmesi.

Görev; hiyerarşi, gruplama, ifade, yoğunluk ve sıra sorunlarını ortaya çıkarır.

## Bu ikili teşhis kartını kullanın

| Katman | Test | Sonuç | Engel | Denenecek değişken |
|---|---|---|---|---|
| Okunaklılık | Karakterleri/kontrol durumunu tanıma | Başarılı/sorun | Boyut, kontrast, biçim, odak | Tek etken |
| Okunabilirlik | Gezinme/okuma görevini tamamlama | Başarılı/sorun | Yoğunluk, hiyerarşi, ifade, yeniden akış | Tek etken |

Her seferinde tek bir aday değişkeni yeniden sınayın.

## Yaygın okunaklılık etkenleri

Karakter boyutu, yazı tipi biçimi, kalınlık, boşluklar, kontrast, parlama, mesafe, kenar işleme ve ekranın çizimi tanımayı etkileyebilir. Yalnızca renkle gösterilen durumlar, metin okunabilir olsa bile kontrolleri ayırt edilemez kılabilir.

Yakın çekim ekran görüntüsü yerine gerçek ortamı kullanın.

## Yaygın okunabilirlik etkenleri

Uzun etiketler, tekrarlanan üstveri, zayıf başlıklar, tutarsız terimler, sıkışık kontroller, kötü gruplama, beklenmedik odak sırası ve bozuk yeniden akış, arayüzü anlamayı zorlaştırabilir.

Okunabilirlik dile ve göreve bağlıdır. Çok dilli içerikte dili akıcı kullanan kişileri sürece dahil edin.

## Aralarındaki etkileşimi sınayın

Metin boyutunu desteklenen bir kademe artırın. Karakterler netleşirken kontroller çakışıyor veya içerik kayboluyorsa okunaklılık iyileştirmesi bir yeniden akış engelini ortaya çıkarmıştır. Kullanıcının ayarını geri alıp sorunu çözüldü ilan etmek yerine ayarı ve kaybolan veya çakışan öğeyi kaydedin.

Karşılaştırmayı aynı başlık, dil, görev, görüntü alanı ve giriş yöntemiyle yapın. Önce izleyiciden belirli bir etiketi veya durumu tanımasını, sonra onu kullanarak görevi tamamlamasını isteyin. Tanıma süresini yalnızca zamanlama gerçekten yararlıysa kaydedin ve izleyicinin açıklamasıyla birlikte ele alın. Hızlı tahmin, öğenin açık olduğunun kanıtı değildir. Bir değişiklik tanımayı iyileştirirken gezinme hatalarını artırıyorsa ikisini tek başarılı/başarısız sonucuna indirmek yerine iki sonucu da belgeleyin.

Simgelerde, simgeyi tek başına değerlendirmeden önce sembolü ve görünür etiketini birlikte sınayın. Aşinalık, belirsiz bir sembolü deneyimli inceleyiciye açık gösterebilir. İlk kez veya seyrek kullanan kişi etikete, konuma ve çevredeki hiyerarşiye dayanabilir.

## Ortamı dahil edin

Parlama, mesafe, aydınlatma ve ekran açısı görünürdeki okunaklılığı azaltabilir ve okuma çabasını artırabilir. İzleme mesafesini ve giriş yöntemini karşılaştırmanın parçası tutmak için [TV arayüzü ergonomisi rehberini](/blog/tv-interface-ergonomics-guide/) kullanın. Belirsiz odak durumunda [kumanda ve D-pad kontrol listesi](/blog/remote-dpad-navigation-qa/), odağın nereye taşındığını ve sonra ne olduğunu açıklamaya yardımcı olur.

[Tam görsel konfor rehberi](/blog/the-complete-guide-to-visual-comfort-in-media-interfaces/), bu bulguları yakınlaştırma, renk, odak ve hareketle ilişkilendirir.

## Tıbbi sonuçlardan kaçının

İzleyicinin neyi tanıyabildiğini ve tamamlayabildiğini sorun. Zorluğu varsayılan bir sağlık durumuyla açıklamayın. Tekrarlanabilir bir görev engeli, tanı olmadan da ele alınabilir.

## Kesin bildirim yapın

Bağlamı, mesafeyi, yakınlaştırmayı veya ölçeklemeyi, görevi, tam öğeyi, beklenen sonucu, gözlenen hatayı, geçici çözümü ve gizliliği koruyan ekran görüntüsünü belirtin. “Metin kötü” yerine “Normal TV mesafesinde yıl ve puan birbirinden ayırt edilemiyor” yazın.

Somut Norva bildirimi için sahibi olduğunuz veya kullanma yetkiniz bulunan uyumlu kaynaktan bir öğe seçin. Yılını bulmayı deneyin, ardından bir seçim yapmadan o ekranda amaçlanan işlemi açıklayın. Hangi bölümün başarısız olduğunu bildirin: Yılı tanımak, işlemi anlamak veya odağı takip etmek. Sorunun telefonda, TV’de veya web’de olduğunu not edin. Paylaşılan görüntüye hesap tanımlayıcılarını, kaynak giriş bilgilerini veya özel medya başlıklarını eklemeyin; mümkünse hassas olmayan materyalle yeniden oluşturun.

## Yaygın hatalar ve sınırlamalar

Terimleri birbirinin yerine kullanmaktan, gerçekçi olmayan yakın mesafede sınamaktan, yazı tipi ve düzeni birlikte değiştirmekten ve daha büyük boyutun her okuma sorununu çözdüğünü varsaymaktan kaçının.

Bu ayrım bir teşhis aracıdır, resmî tıbbi değerlendirme değildir. Güncel ürün kontrolleri yine resmî doğrulama gerektirir.

## Sık sorulan sorular

### Okunaklı bir metni okuyup anlamak yine zor olabilir mi?

Evet. Tek tek karakterler açıkken yoğun anlatım, zayıf hiyerarşi veya kötü düzen görevi zorlaştırabilir.

### Okunabilir bir düzende ayırt edilemeyen kontroller bulunabilir mi?

Evet. Sıra mantıklı olabilir ancak küçük metin, düşük kontrast veya belirsiz odak tek tek öğeleri gizleyebilir.

### Önce hangi sorun düzeltilmeli?

Tanımayı ve görevi engelleyen başarısızlıkları etkilerine göre ele alın; sonra yeniden sınayın, çünkü bir katmanı değiştirmek diğerini etkileyebilir.

## Sonraki adımınız

Yukarıdaki ikili kartı kullanarak [Norva Destek’e tekrarlanabilir bir okuma engeli bildirimi gönderin](https://norva.tv/support). Tek ve kesin bir ekran, görev ve gözlenen zorluk, ekibe nedeni tahmin etmeden araştırabileceği bilgi verir.

## Kaynaklar

- [W3C: Bilişsel ve öğrenme engelleri olan kişiler için içeriği kullanılabilir kılma](https://www.w3.org/TR/coga-usable/)
- [W3C: Kontrast (Asgari)](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)
- [Norva özellikleri](https://norva.tv/#features)
