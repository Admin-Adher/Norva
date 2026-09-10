---
language: "fil"
source_slug: "built-in-and-separate-subtitle-tracks-what-viewers-need-to-know"
source_sha256: "98b9d0bbd83440fb5f247e1595988ce7cc53b352a8396f7bd1e88988ce55ed90"
title: "Mga built-in at hiwalay na subtitle track: ang kailangang malaman ng mga manonood"
seo_title: "Paliwanag sa naka-embed, external at burned-in na subtitle"
meta_description: "Ihambing ang naka-embed na subtitle track, external na subtitle file at burned-in na teksto. Alamin kung ano talaga ang ipinapakita ng container, track selector at off switch."
excerpt: "Hindi burned-in na teksto ang naka-embed na track. Ihambing ang pagkaka-package ng mga subtitle gamit ang napunang halimbawa, saka ihiwalay ang pinatutunayan ng selector sa hindi pa alam."
topic_cluster: "Pamamahala ng subtitle"
sources_heading: "Mga sanggunian"
next_step_heading: "Ang susunod mong hakbang"
translation_status: "approved"
translation_method: "ai_assisted"
---

# Mga built-in at hiwalay na subtitle track: ang kailangang malaman ng mga manonood

> **Sa madaling sabi:** Nakaimbak sa loob ng media container ang data ng naka-embed na subtitle; hiwalay namang nakaimbak at naka-ugnay sa media ang external na subtitle. Maaaring maging napipiling track ang alinman kapag sinusuportahan. Bahagi na ng mismong larawan ng video ang burned-in na subtitle at hindi ito mapapatay bilang track. Pinatutunayan ng gumaganang subtitle selector na gumagana ang isang kontrol, hindi kung saan nakaimbak ang data ng subtitle.

Madalas gamitin ang “built-in” kapwa para sa naka-embed na track at sa tekstong permanenteng iginuhit sa larawan. Mahalaga ang kalabuang iyon: maaaring napipili ang isa, samantalang bahagi ng mismong larawan ang isa pa. Magsimula sa kung paano naka-package ang media, saka suriin kung ano ang inilalantad ng player na ito para sa napiling bersiyon.

## Tukuyin ang tatlong praktikal na kategorya

- **Naka-embed na napipiling track:** data ng subtitle na naka-package sa loob ng media container, hiwalay sa mga larawan ng video nito, at inilalantad bilang pagpipilian kapag sinusuportahan.
- **Hiwalay na naka-ugnay na track:** data ng subtitle na nakaimbak nang hiwalay sa media at iniuugnay sa pamamagitan ng source o konteksto ng pag-play. Kung minsan, tinatawag na sidecar file ang isang hiwalay na file.
- **Burned-in na teksto:** mga pixel na naroon na sa larawan ng video; walang selector na makapag-aalis sa mga ito nang hiwalay.

Pinagsasama ng isang **container**, gaya ng MKV o MP4, ang mga media stream at metadata. Hindi ito mismo subtitle track o garantiya ng suporta ng decoder. Inihihiwalay ng [gabay ng MDN sa mga container](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Containers) ang container sa mga codec na nasa loob nito. Kaya hindi sinasabi ng MKV extension lamang kung aling mga subtitle ang naroon o kung ilalantad ang mga ito ng isang partikular na player.

Hindi laging plain text ang data ng subtitle. Inilalarawan ng [espesipikasyon ng subtitle ng Matroska](https://www.matroska.org/technical/subtitles.html) ang mga subtitle na batay sa teksto at mga format na batay sa larawan, gaya ng VobSub. Hiwalay pa rin sa larawan ng video ang isang subtitle track na batay sa larawan; hindi nangangahulugang “burned in” ang “image-based.” Inilalarawan ng mga kategoryang ito ang pagkaka-package, hindi ang kalidad ng salin o pagkakumpleto para sa accessibility.

## Tukuyin ang kategorya sa pamamagitan ng kilos nito

Buksan ang subtitle selector para sa eksaktong item at bersiyon at itala ang mga entry bago baguhin ang anuman. Pumili ng isang track, itala ang label nito, at suriin ang eksenang may cue, o tekstong lumilitaw sa isang takdang oras. Kung may kontrol para patayin ito, gamitin iyon at balikan ang parehong sandali; kung dalawang magkaibang sandali ang ihahambing, maaaring inihahambing mo lamang ang isang cue sa isang pagitan na walang subtitle.

Kung nawawala ang napiling teksto, pinatutunayan nitong nakokontrol iyon sa kontekstong ito. **Hindi** nito pinag-iiba ang naka-embed na track at ang external na track. Kung nananatili ang teksto, isa sa mga posibilidad ang burned-in na teksto, ngunit suriin muna kung may isa pang aktibong layer ng caption o feature ng caption sa antas ng device bago magpasyang bahagi ito ng video. Tiyakin ang paraan ng pag-iimbak gamit ang impormasyon tungkol sa ibinigay na media, hindi batay lamang sa itsura.

## Ituring na may mga kundisyon ang suporta sa hiwalay na track

Kailangang naka-ugnay ang isang hiwalay na resource sa tamang item at nasa format na sinusuportahan ng konteksto ng pag-play. Halimbawa, tahasang tumutukoy ang [HTML track element](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/track) sa isang external na resource at maaari itong magbigay ng wika at label. Tinutukoy ng [draft na espesipikasyon ng WebVTT](https://www.w3.org/TR/webvtt1/) ang isang format ng tekstong may takdang oras na ginagamit para rito. Halimbawa ito sa web platform, hindi paglalarawan ng mga kontrol ng Norva sa pag-import.

Hindi awtomatikong naka-ugnay sa video ang isang file na nasa tabi nito sa bawat player. Suriin ang dokumentadong paraan para sa device at source na ginagamit mo. Hindi pinatutunayan ng pagkakaroon ng mga external na subtitle track, sa sarili nito, ang pag-import ng anumang lokal na file, awtomatikong pagtutugma ng filename, o suporta sa lahat ng format sa Norva.

## Orihinal na ebidensiya: talaan ng pagkaka-package

Gumagamit ang **halimbawang binuo para sa paliwanag** na ito ng isang kathang-isip na clip, Harbour Gate, na may linyang “The gate is open” (“Bukas ang tarangkahan”) sa 00:18. Walang mga sample file na mada-download at walang obserbasyon sa pag-play ng Norva. Tinutukoy ng mga row A–C ang magkakaibang paraan kung paano maaaring ihanda ng may-ari ang clip na iyon; ipinapalagay ng kilos ng mga kontrol na sinusuportahan ng player ang tinukoy na resource.

| Bersiyon | Impormasyon sa pagkaka-package na ibinigay sa halimbawa | Inaasahang kilos ng mga kontrol | Konklusyong may sapat na batayan |
| --- | --- | --- | --- |
| A | Naglalaman ang isang MKV container ng video, audio at hiwalay na English subtitle track sa loob nito | Ipinapakita ang cue kapag pinili ang English; itinatago ito kapag pinatay ang track na iyon | Naka-embed na subtitle track, dahil tahasang alam kung saan ito nakaimbak |
| B | Tahasang naka-ugnay ang isang MP4 video sa isang hiwalay na English WebVTT file na naglalaman ng cue | Ipinapakita ang cue kapag pinili ang English; itinatago ito kapag pinatay | External na resource ng subtitle, dahil alam ang ugnayan at hiwalay na pag-iimbak |
| C | Isinama ng may-ari ang linyang Ingles sa mga larawan ng video; walang ibinigay na subtitle track | Hindi maaalis ng kontrol na pang-off ng subtitle ang mga pixel na iyon | Burned-in na teksto, dahil ganoon tinukoy ang ibinigay na video |
| D | Isang entry sa player na may label na English lamang ang alam; naipapakita at naitatago nito ang cue | Gumagana ang toggle, gaya ng sa A at B | Napipiling subtitle track; hindi pa nakukumpirma kung naka-embed o external ang pag-iimbak |

Maaaring magkapareho ang itsura ng mga row A at B sa player. Ang row D ang mahalagang hangganan: hindi mapag-iiba ang dalawa sa pagsubok ng off switch. Maaari ring pagsamahin ng isang tunay na item ang burned-in na teksto at isang napipiling salin, kaya maaaring higit sa isang kategorya ang umangkop sa magkakaibang nakikitang linya.

Upang magamit muli ang talaan, itala ang item/bersiyon, kumpletong listahan sa selector, napiling label, oras ng cue, resulta habang naka-off, at pinanggalingan ng anumang impormasyon sa pagkaka-package. Isulat ang “hindi pa nakukumpirma” saanman hindi nagbibigay ng sapat na detalye ang media source.

## Maingat na ihambing ang mga bersiyon

Maaaring iba ang pagkaka-package ng subtitle o ibang pangkat ng mga ito ang iniaalok ng isang bersiyon. Panatilihing pareho ang device, profile at media source habang naghahambing ng mga bersiyon, at itala ang bawat kumpletong listahan ng track. Tiyakin ang edisyon at haba pati ang pamagat: maaaring hindi tumugma ang isang subtitle resource na itinakda ang mga oras para sa ibang cut sa pelikulang may parehong pamagat.

Hindi patunay na nabigong mag-load ang isang hiwalay na resource ang pagkawala ng isang track pagkatapos magpalit ng bersiyon.

## Siyasatin ang nawawalang hiwalay na track

Tiyakin muna kung bakit mo inaasahan ang track na iyon. Magkakaibang uri ng ebidensiya ang label sa katalogo, file na ibinigay ng may-ari, at track na aktuwal na nakalista para sa bersiyong ito. Itanong kung kinukumpirma ng may-ari ng source ang resource at ang ugnayan nito sa napiling bersiyon.

Itala ang inaasahang wika at papel ng track, device, bersiyon ng app o browser, koneksiyon, at kumpletong selector. Pag-ibahin ang “hindi nakalista,” “nakalista ngunit hindi mapili,” at “napili ngunit walang nakikitang cue sa sinuring sandali.” Magkakaibang tanong ang tinutukoy ng mga obserbasyong iyon; wala sa mga ito, nang nag-iisa, ang nagpapatunay ng depekto sa player. Panatilihin ang ebidensiyang ito bago magpalit ng pangalan ng mga file, maglipat ng mga resource, mag-alis ng source, mag-clear ng data o muling mag-install.

## Unawain ang mga pagkakaiba sa feature

Parehong makapagbibigay ng kapaki-pakinabang na subtitle ang naka-embed at external na mga track. Nakadepende sa format at renderer ang mga opsiyon sa estilo; hindi kinakailangang mag-alok ng parehong mga kontrol ang mga resource na batay sa teksto at sa larawan. Hindi mapapalitan nang hiwalay ang estilo o mapapatay ang burned-in na teksto sa pamamagitan ng subtitle selector. Pinag-iiba rin ng [gabay ng W3C sa caption](https://www.w3.org/WAI/media/av/captions/) ang mga caption na maaaring itago ng manonood at ang mga open caption na nananatiling nakikita.

Ipinapaliwanag ng [kumpletong gabay sa pamamahala ng subtitle](/blog/the-complete-guide-to-managing-subtitle-tracks/) ang mga pagsusuri sa wika, papel ng track, timing, estado at device na naaangkop pagkatapos matagpuan ang isang track.

Pagkatapos, suriin ang nilalaman ng track: [maaaring tugunan ng mga caption at subtitle ng diyalogo ang magkakaibang pangangailangan sa impormasyon](/blog/captions-and-subtitles-why-the-accessibility-goals-can-differ/). Kung may mga cue ngunit mahirap basahin, pag-ibahin ang [linaw ng mga titik at kadalian ng pagbasa](/blog/legibility-and-readability-two-different-viewing-problems/) sa halip na sisihin ang paraan ng pag-iimbak.

## Protektahan ang mga karapatan sa source at privacy

Gumamit ng media at mga resource ng subtitle na pag-aari mo o awtorisado kang ma-access. Ang Norva ay media player, na walang kasamang nilalaman o TV subscription; hindi nagbibigay ng mga karapatan dito ang pagkonekta ng isang resource. Huwag mag-upload ng media o mga subtitle file sa support nang walang kinakailangang pahintulot. Magsimula ng ulat gamit ang mga hindi sensitibong label, hakbang at timestamp; suriin ang mga screenshot para sa mga pribadong address ng source o detalye ng account bago ibahagi ang mga ito.

## Mga karaniwang pagkakamali at limitasyon

Iwasang tawaging naka-embed na napipiling track ang burned-in na teksto, mangako ng awtomatikong pagtutugma, ipagpalagay na sinusuportahan ang bawat format, at baguhin ang mga source file bago mapanatili ang ebidensiya.

Maaaring manatiling hindi malinaw ang pagkaka-package kapag isang opsiyong napi-play lamang ang inilalantad ng source. Ilarawan ang naobserbahang kilos ng selector sa halip na hulaan ang paraan ng pag-iimbak.

## Mga madalas itanong

### Maaari bang patayin ang burned-in na subtitle?

Hindi bilang hiwalay na track dahil bahagi ng larawan ang teksto. Maaaring iba ang isa pang bersiyon ng media, ngunit tiyakin ang availability nito.

### Lagi bang text file ang mga hiwalay na subtitle track?

Hindi. Mga halimbawang batay sa teksto ang WebVTT at SubRip, ngunit maaari ring nakabatay sa larawan ang mga resource ng subtitle, gaya ng VobSub. Inilalarawan ng “hiwalay” kung saan nakaimbak ang resource kaugnay ng media, hindi kung paano naka-encode ang mga cue nito. Suriin ang aktuwal na format at dokumentadong suporta.

### Ibig bang sabihin ng nawawalang hiwalay na track na sira ang player?

Hindi. Tiyakin ang ugnayan, item/bersiyon, metadata ng source, suporta sa format at selector bago magtakda ng sanhi.

## Ang susunod mong hakbang

Kung kinukumpirma ng source ang isang resource ng subtitle ngunit hindi pa rin malinaw ang resulta, dalhin ang napunan mong talaan ng pagkaka-package sa [Norva support](https://norva.tv/support). Sabihin kung ano ang naobserbahan mo at kung ano ang hindi pa nakukumpirma; huwag isama ang mga media file at pribadong detalye ng koneksiyon sa paunang ulat.

## Mga sanggunian

- [MDN: mga media container at mga codec na nilalaman ng mga ito](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Containers)
- [Matroska: mga codec ng subtitle, kabilang ang mga track na batay sa teksto at larawan](https://www.matroska.org/technical/subtitles.html)
- [MDN: ang HTML track element at mga external na resource](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/track)
- [W3C: draft na espesipikasyon ng WebVTT](https://www.w3.org/TR/webvtt1/)
- [W3C: mga caption, subtitle, at open o closed na pagpapakita](https://www.w3.org/WAI/media/av/captions/)
- [Norva: mga feature at kinakailangan ng compatible na source](https://norva.tv/#features)
