---
language: "tr"
source_slug: "connect-compatible-media-source-norva"
source_sha256: "8efa2f6c3971568d3ed277e8cdd99305ea755c0d2b3628b40aefe9cc0d3bf659"
title: "Norva’ya uyumlu bir medya kaynağı nasıl bağlanır?"
seo_title: "Norva’ya uyumlu bir medya kaynağı bağlama rehberi"
meta_description: "Yetkili ve uyumlu bir kaynağı Norva’da hazırlayın, bağlayın ve doğrulayın; giriş bilgilerinizi koruyup sorun giderme bulgularını açık tutun."
excerpt: "Norva’nın güncel kaynak yönetimi akışıyla yetkili bir kaynak bağlayın, ayarlarını koruyun, kataloğun yüklenmesini bekleyin ve başka kaynak eklemeden bilinen bir öğeyi doğrulayın."
topic_cluster: "Norva kurulumu ve hesap"
sources_heading: "Kaynaklar"
next_step_heading: "Sonraki adımınız"
translation_status: "approved"
translation_method: "ai_assisted"
---

# Norva’ya uyumlu bir medya kaynağı nasıl bağlanır?

> **Kısaca:** Web’de hesap menüsünü, ardından Settings (Ayarlar) ve TV service (TV hizmeti) bölümünü açın. Tam oynatma listesi URL’si için M3U link, uyumlu sağlayıcı bilgileri için Xtream login seçin. Yalnızca sahibi olduğunuz veya kullanma yetkiniz olan bir kaynağı bağlayın, giriş bilgilerini gizli tutun ve başka kaynaklar eklemeden önce bilinen bir öğeyi doğrulayın. Norva bir oynatıcıdır; kaynağı veya medyayı sağlamaz.

**Kontrol edilenler:** 10 Eylül 2026 tarihinde canlı web uygulamasında oturum açılmış bir test hesabıyla formları inceledik ve kullanıcının sağladığı bir Xtream test erişimini gönderdik. Daha sonraki kontrol **Ready** (Hazır) durumunu, kaynağa özgü dil filtrelemeyi ve on iki sürümlü bir başlığı açan aramayı doğruladı. Görseller, özel bağlantı bilgileri görünmeyen, doğrudan alınmış ve değiştirilmemiş web ekran görüntüleridir. M3U içe aktarımı veya yerel telefon/TV akışı sınanmadı; başarılı oynatma ayrı bir kontrol olarak kalmaktadır.

## Başlamadan önce

Dört koşulun tümünü doğrulayın:

- Norva hesabı sizin kontrolünüzdedir.
- Kaynak size aittir veya kullanma izniniz vardır.
- Kaynağın koşulları amaçlanan bağlantıya izin verir.
- Norva şu anda kaynağın bağlantı yöntemini destekler.

Resmî kaynak bilgilerini doğrudan kaynak sahibinden veya hesap sayfasından hazırlayın. Kökeni açık olmayan, başkasından iletilmiş ayarları kullanmayın.

Hazırlık formu için [Medya kaynağınızı eklemeden önce neleri hazırlamalısınız?](/blog/prepare-media-source-setup/) yazısını okuyun.

## 1. adım: Resmî bir Norva giriş noktası kullanın

Norva’yı resmî sitesinden veya kurulu uygulamasından açın. Hesap veya kaynak bilgilerini girmeden önce adresi ya da uygulamanın kimliğini kontrol edin.

İstediğiniz hesap ve profilde oturum açın. Paylaşılan veya ödünç alınmış bir cihazdaysanız, cihaz güvenilir ve kaynak koşulları izin veriyor olmadıkça özel giriş bilgilerini kaydetmeyin.

**Gözlenebilir sonuç:** Hesap normal biçimde açılır ve kaynak yönetimi kontrollerine ulaşabilirsiniz.

## 2. adım: Kaynak yönetimini bulun

Web’de hesap menüsünü açın, **Settings** (Ayarlar), ardından **TV Service** (TV hizmeti) sekmesini seçin. Başka bir arayüz dili seçilince bu İngilizce etiketler çevrilir. Uygulama açıldığında Ana sayfaya geliyorsanız bu menü yolunu izleyin; kaydedilmiş bir kaynak ayarları bağlantısının doğru paneli açtığını varsaymayın.

**Add TV service** (TV hizmeti ekle) penceresini açmak için **Add playlist** (Oynatma listesi ekle) veya **Add provider** (Sağlayıcı ekle) seçin. İçindeki **M3U link** ve **Xtream login** sekmeleri, formu gerçekten aldığınız bilgilere göre seçmenizi sağlar.

Bir şey girmeden önce başka kaynak olup olmadığını kontrol edin. Aynı kaynağı iki kez eklemek, yinelenmiş görünen kategoriler oluşturabilir ve sonraki teşhisi karmaşıklaştırabilir.

**Gözlenebilir sonuç:** Bir kaynak ekleme formu veya desteklenen bağlantı seçeneği görünür.

## 3. adım: Belgelenmiş, uyumlu bir yöntem seçin

Bir şey yapıştırmadan önce şu ayrımı kullanın:

| Elinizdeki bilgi | Norva’daki seçim | İlk kontrol |
| --- | --- | --- |
| Tam bir oynatma listesi adresi | M3U link | Tam URL, uygulama indirme sayfasından değil, yetkili kaynağınızdan gelir. |
| Uyumlu sunucu adresi ve giriş bilgileri veya tam Xtream bağlantısı | Xtream login | Kaynak sahibi bu biçimi ve bağlantı izninizi doğrular. |
| Yalnızca başka bir uygulamaya ait kullanıcı adı ve parola | My provider only gave me an app login | Uyumlu kaynak biçimini isteyin; sunucu adresini tahmin etmeyin. |

![Playlist URL alanını, isteğe bağlı hizmet adını ve Add düğmesini gösteren Norva M3U kaynak formu.](/assets/blog/source-m3u-live-web-20260910.jpg "10 Eylül 2026 tarihli canlı web M3U formu. Alanlar boştur; bu görsel tamamlanmış bir M3U içe aktarımının kanıtı değildir.")

**M3U link** için tam adresi **Playlist URL** (Oynatma listesi URL’si) alanına girin. Norva formu bir `http` veya `https` adresi tanımlar; `.m3u`, `.m3u8` ve `get.php` ifadelerini yaygın ipuçları olarak verir, izin veya uyumluluk kanıtı olarak değil. **Service name** (Hizmet adı) isteğe bağlıdır: tarafsız bir takma ad, giriş bilgilerini açığa çıkarmadan kaynakları ayırt etmeye yardımcı olur.

![İlk bağlantı adımını ve tam bağlantı ya da elle sunucu bilgisi girme seçeneklerini gösteren Norva Xtream bağlantı formu.](/assets/blog/source-xtream-live-web-20260910.jpg "Test erişimi girilmeden önce alınmış canlı Xtream giriş adımı. Continue, tamamlanmış içe aktarıma doğrudan değil, erişim dönemi seçimine götürür.")

**Xtream login** için güncel akış **Connect provider** (Sağlayıcıyı bağla) ile başlar. **Provider URL or complete Xtream link** (Sağlayıcı URL’si veya tam Xtream bağlantısı) alanını kullanın; size verilen biçim buysa **Enter server login manually** (Sunucu giriş bilgilerini elle gir) seçeneğini genişletin. **Continue** (Devam) düğmesini kaynağın zaten bağlandığının onayı saymak yerine, sonraki her ekran adımını inceleyin.

İstenen her değeri kaynağın resmî bilgileriyle eşleştirin. Kaynak belgeleri söylemedikçe boşluk eklemeyin, büyük/küçük harfi değiştirmeyin veya bir adresi “düzeltmeyin”.

Norva’nın gizlilik politikası, kaynak ayarlarının hizmeti kullanıcı adına kaynağa bağlamak için kullanıldığını belirtir. Hassas ayarları göndermeden önce bu politikayı inceleyin.

### Yalnızca uygulama giriş bilginiz varsa

**My provider only gave me an app login** (Sağlayıcım bana yalnızca uygulama giriş bilgisi verdi) seçeneğini seçin. Yardım paneli, ayrı bir uygulamanın giriş bilgilerinin neden doğrudan Norva kaynağı olarak içe aktarılamayacağını açıklar ve uyumlu bir M3U bağlantısı veya Xtream sunucu bilgileri isteyen bir mesaj sunar. Kaynak sahibine resmî kanalından sorun; parolaları herkese açık destek iletilerine yapıştırmayın.

![Uygulama giriş bilgilerinin bağlanabilmesi için uyumlu kaynak bilgilerinin gerektiğini açıklayan Norva yardım paneli.](/assets/blog/source-app-login-help-live-web-20260910.jpg "Yalnızca uygulama giriş bilgileri için canlı web yönlendirmesi; sağlayıcı hesabı veya özel bağlantı gösterilmez.")

## 4. adım: Ayarları gizliliği koruyarak girin

Uygun olduğunda kopyala-yapıştır kullanın, ardından gizli olmayan her değerin başını ve sonunu inceleyin. Parolaları, özel bağlantıları, kullanıcı adlarını ve erişim belirteçlerini şuralardan uzak tutun:

- ekran görüntüleri;
- ekran kayıtları;
- herkese açık destek yazışmaları;
- analitik notları;
- paylaşılan belgeler;
- güvenmediğiniz pano geçmişi araçları.

Televizyonda güvenli giriş yapmak zorsa giriş bilgilerini görünür kılmak yerine belgelenmiş eşleştirme veya hesap akışını kullanın.

**Gözlenebilir sonuç:** Zorunlu alanlar bir sır açığa çıkmadan tamamlanır.

## 5. adım: Bir kez kaydedin ve ilk yüklemeye izin verin

M3U formunda URL’yi kontrol ettikten sonra **Add** (Ekle) düğmesini bir kez kullanın. Xtream için **Continue**, **Provider access period** (Sağlayıcı erişim dönemi) ekranını açar. Görünür seçenekler **Duration bought** (Satın alınan süre), **Start and end dates** (Başlangıç ve bitiş tarihleri) ve **Add this later** (Bunu daha sonra ekle) şeklindedir. Yalnızca gerçekten bildiğiniz koşulları kaydedin; bu, Norva planınızdan ayrıdır.

Testimizde erişim tarihleri verilmediği için **Add this later**, ardından **Continue** seçtik; **Add later / No new dates** (Daha sonra ekle / Yeni tarih yok) özetini inceledik ve **Finish without dates** (Tarih olmadan bitir) düğmesini bir kez kullandık. Bu kısa akışta adım sayacı beş adımdan üç adıma değişti. Sırf kurulumu tamamlamak için tarih uydurmayın.

![Add this later seçili olan, adım sayacı üçün ikisini gösteren Norva erişim dönemi seçimi.](/assets/blog/source-access-period-live-web-20260910.jpg "Gerçek test yolu: erişim dönemi kaydetmeden devam etme. Bu rehberde satın alma, yenileme veya hatırlatma yapılandırılmadı.")

Norva ardından **Preparing your catalog** (Kataloğunuz hazırlanıyor) panelini açtı, **Importing** (İçe aktarılıyor) gösterdi ve bağlantı kontrolünü **Done** (Tamamlandı) olarak işaretledi. Katalog hazırlığı sürerken tespit edilen başlık sayıları artmaya başladı. Bunlar ayrı gözlemlerdir: giriş bilgilerinin kabul edilmesi, her başlığın oynatmaya hazır olduğu anlamına gelmez.

![Tarafsız ad verilmiş test kaynağı için Importing durumunu, ayrı bağlantı ve katalog aşamalarını gösteren Norva katalog hazırlama paneli.](/assets/blog/source-importing-live-web-20260910.jpg "Tamamlanmış katalog değil, gerçek bir ara içe aktarma durumu. Sayılar ve ilerleme, çekim anındaki test kaynağını yansıtır; hız veya kapasite vaadi değildir.")

Oynatıcının kategorileri, katalog bilgilerini veya rehber verilerini alması zaman gerektirebilir. Normal yükleme sürerken kaynağı tekrar tekrar göndermeyin veya kaldırmayın.

Herkes için geçerli bir yükleme süresi vaat edilemez. Kaynak büyüklüğü, bağlantı ve cihaz ilk sonucu etkileyebilir.

**Gözlenebilir sonuç:** Norva ayarları kabul eder veya belirli, kaydedilebilir bir hata gösterir.

## 6. adım: Bildiğiniz bir öğeyi doğrulayın

Kitaplık kararlı bir duruma ulaştığında:

1. beklenen ana bölümü kontrol edin;
2. beklenen bir kategoriyi açın;
3. bildiğiniz bir öğeyi arayın;
4. mevcutsa başlığı, yılı veya bölüm kimliğini doğrulayın;
5. kaynağın sağladığı dil veya altyazı bilgilerini inceleyin;
6. isteğe bağlı üstverinin eksik olmasını tüm bağlantının başarısızlığı saymayın.

Örneğin, kaynak sahibinin mevcut olduğunu doğruladığı bir başlık seçin. Kategorisi yüklenip başlık görünmüyorsa bu belirli sonucu kaydedin. Görünüyor ancak oynatılamıyorsa katalog yüklemesi başarılıdır; oynatma için hâlâ ayrı kontrol gerekir. Bu gözlemlerden hiçbiri bütün kaynağın çalıştığını veya bozuk olduğunu kanıtlamaz.

**Sonraki kontrolde gözlenenler:** Aynı kaynak **Settings → TV Service** içinde **Ready** olarak işaretlenmişti. **Movies** (Filmler) bölümünü açtık, **Source** (Kaynak) altında **Blog walkthrough test** seçtik ve **Audio language → Albanian** (Ses dili → Arnavutça) kullandık. Gelen kartlar **Albanian** gösteriyordu. **Clear all** (Tümünü temizle) sonrasında bilinen bir başlığı aramak; on iki sürüm, bir yıl ve özet içeren ayrıntılarını açtı. Yinelenen kaynak veya elle yeniden gönderim gerekmedi.

![Test kaynağı ve Arnavutça ses seçili Norva film filtreleri; yanında ayrı kategori ve altyazı kontrolleri.](/assets/blog/catalog-audio-filter-live-web-20260910.jpg "Kaynak Ready durumuna ulaştıktan sonraki kontrol, 10 Eylül 2026. Gösterilen sayı, bu kullanıcının test kaynağının anlık görüntüsüdür; Norva içeriği veya katalog kapasitesi vaadi değildir.")

### Kaynak etiketini doğrulanmış ses parçasıyla karıştırmayın

Güncel ses filtresi, tanınan dil etiketleriyle dosyalarda tespit edilen ses parçalarına ilişkin bilgileri aynı gezinme kontrolünde toplar. Bu, kaynak etiketini bir sürümü bulmak için yararlı kılar; ancak ülkeyi, koleksiyon adını veya başlık önekini o dosyanın içindeki ses parçalarına dair kanıta dönüştürmez. Gerçek parça bilgisi mevcutsa sürümü seçmek için onu kullanın. **Nordic languages** (Nordik diller) gibi bölgesel bir gösterge, tek bir konuşma dilini tanımlamaz.

Her katman için ayrı kontrol kullanın:

| Görünür sonuç | Neyi ortaya koyar? | Hâlâ ne kontrol edilmeli? |
|---|---|---|
| Kaynak Ready gösteriyor | Norva kataloğu hazır olarak bildiriyor | Her öğenin üstverisi ve oynatma uyumluluğu |
| Seçili kaynak altında bir başlık görünüyor | Öğenin güncel katalogda bulunabildiği | Diğer öğeler ve seçili sürüm |
| Kaynak kategorisi görünüyor | Bir gruplama etiketinin alındığı | Doğrulanmış film türünün bulunup bulunmadığı |
| Dil filtresi bir sürüm getiriyor | Mevcut dil bilgisi filtreyle eşleşti | O dosya ve oynatıcıdaki gerçekten seçilebilir parçalar |
| Language unidentified (Dil belirlenemedi) | Kullanılabilir ses dili sonucu gösterilmiyor | Gerçek parça kullanılabilirliği ve analiz durumu |
| Oynatıcı sayfası açılıyor | Oynatıcıya gezinme çalıştı | Video kareleri, ilerleyen oynatma ve kullanılabilir ses |

Son kontrol katalogda gezinmeyi sınadı; video oynatmayı değil. Önceki kurulum denemesinde oynatıcı açıldı, ancak **Back** (Geri) ile dönmeden önce ilerleyen video doğrulanmadı. Bu nedenle Ready durumunu, dil rozetlerini veya görselleri başarılı bir izleme oturumunun kanıtı olarak sunmuyoruz.

## 7. adım: Bir hesap işlemini sınayın

Bir favori ekleyin veya kısa bir oynatma ilerlemesi kaydedin. Kitaplığa dönün ve görünür durumu doğrulayın.

Bu, kaynak verisiyle hesap bağlamı arasındaki farkı sınar. Her öğenin, biçimin veya cihazın uyumlu olduğunu kanıtlamaz.

Test favorimiz daha sonra katalog yeniden açıldığında mevcuttu. Ardından onu kaldırdık ve başlangıç durumunu doğrulamak için yeniden yükledik. Ayrıntılardan ilk dönüşte güncellenmiş durum görünmemişti; dolayısıyla bu gözlem o öğenin kalıcılığını doğrular, anlık geri bildirimi veya cihazlar arası senkronizasyonu değil.

Daha kapsamlı ilk oturum planı [Norva ile başlangıç](/blog/norva-getting-started/) rehberindedir.

## Bağlantı kısmen başarılıysa

Kısmi sonuç, “çalışmıyor” ifadesinden daha bilgilendiricidir. Hangi katmanın başarılı olduğunu kaydedin:

- Ayarlar kabul edildi mi?
- Herhangi bir kategori göründü mü?
- Başlıklar yüklenirken görseller başarısız mı oldu?
- Katalog bilgileri yüklenirken rehber verileri boş mu kaldı?
- Bilinen bir öğe açıldı mı?
- Oynatma yalnızca bir cihazda mı başarısız oldu?

Her seferinde tek değişkeni değiştirin. Uygulamayı yeniden kurmadan önce kaynak bilgilerini tekrar kontrol edin. Hatanın hassas bilgileri gizlenmiş ekran görüntüsünü, yalnızca giriş bilgisi içermediğini doğruladıktan sonra saklayın.

## Güvenlik ve hesap temizliği

Başarılı kurulumdan sonra:

- güvenilen cihazları inceleyin;
- artık kontrol etmediğiniz cihazları kaldırın;
- kaynak kaydını gizli tutun;
- izin ve koşulların nereden incelenebileceğini not edin;
- yetki sona ererse kaynağın bağlantısını kesin;
- açığa çıkan giriş bilgilerini kaynak sahibinin resmî süreciyle değiştirin.

Norva’nın gizlilik ve hesap silme sayfaları, Norva hesap verileri için mevcut kontrolleri açıklar.

## Sınırlamalar

Başarılı bağlantı; her kaynak alanının eksiksiz olduğu, her medya biçiminin her cihazda çalıştığı veya çevrimdışı erişimin mevcut olduğu anlamına gelmez. Diller ve altyazılar kaynağa ve medyaya bağlıdır. Çevrimdışı kullanım cihaza, kaynağa ve ilgili haklara bağlıdır.

Kanıtlar güncel web kontrollerini, bir Xtream gönderimini, sonraki Ready durumunu, kaynağa özgü ses filtrelemeyi, tek başlık için arama/ayrıntıları ve yeniden açılış sonrasında bir favorinin kalıcılığını/kaldırılmasını kapsar. Her katalog kaydının eksiksiz veya oynatılabilir olduğunu ortaya koymaz. Başarılı oynatma ve anlık favori geri bildirimi doğrulanmadı. Bu web testiyle M3U içe aktarımı, yerel telefon/TV akışı, çevrimdışı kullanım veya cihazlar arası devamlılık kabul edilmedi.

## Sık sorulan sorular

### Başlangıçta neden yalnızca bir kaynak eklemeliyim?

Bu, açık bir başlangıç referansı sağlar. Bir kategori, başlık veya hata göründüğünde hangi kaynağın ürettiğini bilirsiniz.

### Bağlantı ekran görüntüsünü destekle paylaşmalı mıyım?

Yalnızca tüm parolaları, özel bağlantıları, kullanıcı adlarını, erişim belirteçlerini ve kişisel tanımlayıcıları gizledikten sonra. Norva’nın resmî destek kanalını kullanın.

### Norva ayarları kabul ediyor ama hiçbir şey görünmüyorsa?

Normal ilk yüklemeyi bekleyin, ardından bilgileri ve bağlantıyı doğrulayın. Destekle iletişim kurmadan önce sonucun tamamen boş mu yoksa kısmen yüklenmiş mi olduğunu kaydedin.

## Sonraki adımınız

[Norva’yı açın ve kaynağınızı bağlayın](https://norva.tv/app)

Oturum açtıktan sonra yukarıda gösterildiği gibi hesap menüsünü, **Settings**, ardından **TV Service** bölümünü kullanın.

## Kaynaklar

- [Norva nasıl çalışır?](https://norva.tv/#how-it-works)
- [Norva Kullanım Koşulları](https://norva.tv/terms)
- [Norva Gizlilik Politikası](https://norva.tv/privacy)
- [Norva destek](https://norva.tv/support)
