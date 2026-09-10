---
language: "fil"
source_slug: "legibility-and-readability-two-different-viewing-problems"
source_sha256: "1b55217a33e5761ed80d94c9865abae96810f3ab7ef102102082a65f06d9dd9b"
title: "Linaw ng mga titik at kadalian ng pagbasa: Dalawang magkaibang problema sa panonood"
seo_title: "Linaw ng titik at kadalian ng pagbasa: Dalawang halimbawang may larawan"
meta_description: "Tingnan ang kaibahan ng pagkilala at pag-unawa sa label. Gumamit ng dalawang kontroladong halimbawa at nauulit na gawain para ilarawan ang hadlang sa pagbasa."
excerpt: "Pagkakaibang batay sa gawain sa pagitan ng pagkilala ng karakter at kontrol, at mahusay na pag-unawa sa salita, hirarkiya, label, at ayos."
topic_cluster: "Biswal na ginhawa at accessibility"
sources_heading: "Mga sanggunian"
next_step_heading: "Ang susunod mong hakbang"
translation_status: "approved"
translation_method: "ai_assisted"
---

# Linaw ng mga titik at kadalian ng pagbasa: Dalawang magkaibang problema sa panonood

> **Sa madaling sabi:** Ang linaw ng mga titik, o legibility, ay tungkol sa pagkilala sa bawat karakter sa teksto. Ang kadalian ng pagbasa, o readability, ay tungkol sa gaano kadaling basahin at maunawaan ang teksto. Sa media interface, ginagamit namin ang parehong praktikal na pagkakaiba para ihiwalay ang pagkilala sa mga label at katayuan ng kontrol mula sa pag-unawa sa pagpapangkat at gawain. Hindi garantiya ng malinaw na desisyon ang malinaw na mga titik; maaari pa ring may tekstong mahirap makilala sa makatuwirang ayos.

Mahihinang solusyon ang resulta ng maling pagtukoy sa problema. Maaaring luminaw ang mga titik kapag pinalaki ang teksto ngunit may maputol na nilalaman na nagpapahirap sa pagbasa; maaaring dumali ang pagtingin sa mga label kapag pinasimple, ngunit hindi nito maaayos ang mababang contrast.

## Tingnan ang kaibahan gamit ang parehong salita

Una, ihambing ang dalawang bersiyon ng **“Episode 18”** sa ibaba. Pareho ang salita, font, laki, at background; contrast lamang ng teksto ang nagbabago. Ang tanong ay “Matutukoy ko ba nang tama ang numero?” Inihihiwalay nito ang isang posibleng hadlang sa pagkilala. Hindi nito sinusukat kung gaano ka kabilis magbasa o ginagaya ang aktuwal na kapaligiran ng panonood.

Pagkatapos, ihambing ang **“Audio English Subtitles Off”** (“Audio Ingles Mga Subtitle Naka-off”) sa parehong mga salitang inayos sa dalawang hanay. Malinaw pa rin ang bawat salita, ngunit nagbago ang pagpapangkat. Itanong, “Ang English ba ay setting ng audio o ng subtitle?” Ang gawain ngayon ay iugnay ang mga label sa halaga, hindi kilalanin ang mga titik.

![Inuulit ng pares sa contrast ang Episode 18 sa mapusyaw at maliwanag na teksto. Ipinapakita ng pares sa pagpapangkat ang Audio English Subtitles Off sa iisang hanay, saka bilang Audio: English at Subtitles: Off na magkatapat ang label at halaga.](/assets/blog/legibility-readability-paired-example.svg "Orihinal na mga halimbawang nagpapaliwanag, hindi screenshot ng interface ng Norva. Inuulit sa artikulo ang teksto para hindi larawan lamang ang paraan ng pag-unawa sa mga halimbawa.")

Posibleng pagpapabuti ang ikalawang ayos, hindi napatunayang nanalo sa sukat. Maaaring magbago ang resulta sa ibang wika, mas mahabang halaga, o mas makitid na screen. Sinusuportahan ng gabay ng W3C sa cognitive accessibility ang malinaw na pagpapangkat at pagitan; kailangan pa ring subukan sa aktuwal na gawain ang paglalapat ng mga ideyang iyon.

## Direktang subukan ang linaw ng mga titik

Hilingin sa manonood na kilalanin ang:

- magkahawig na titik o numero;
- kahulugan ng icon kasama ang label;
- kontrol na may focus kumpara sa napili;
- aktibong katayuan kumpara sa hindi available;
- metadata sa normal na distansiya;
- bantas ng caption at marka ng nagsasalita.

Itala ang mga pagkakamali at pagsisikap, hindi lamang kung nakasagot ang manonood sa bandang huli.

## Subukan ang kadalian ng pagbasa sa mga gawain

Hilingin sa manonood na:

- tingnan ang isang hanay at pumili ng pamagat;
- unawain ang isang grupo ng filter;
- basahin ang buod at metadata;
- ihambing ang mga bersiyon;
- mag-navigate sa dialog at kumpirmahin ang nilalayong aksiyon;
- bumalik sa dating konteksto.

Naipapakita ng gawain ang problema sa hirarkiya, pagpapangkat, pananalita, siksik na nilalaman, at pagkakasunod.

## Gamitin ang magkaparis na card sa pagtukoy ng problema

| Antas | Pagsubok | Resulta | Hadlang | Salik na susubukan |
|---|---|---|---|---|
| Linaw ng titik | Kilalanin ang karakter/katayuan ng kontrol | Pumasa/may problema | Laki, contrast, hugis, focus | Isang salik |
| Kadalian ng pagbasa | Kumpletuhin ang nabigasyon/pagbasa | Pumasa/may problema | Siksik na nilalaman, hirarkiya, pananalita, muling pagdaloy ng ayos | Isang salik |

Subukang muli ang isang posibleng salik sa bawat pagkakataon.

## Mga karaniwang salik sa linaw ng titik

Maaaring makaapekto sa pagkilala ang laki ng karakter, hugis at kapal ng font, pagitan, contrast, silaw, distansiya, pagproseso ng gilid, at pagguhit ng display. Maaaring hindi makilala ang mga kontrol kapag kulay lamang ang palatandaan ng katayuan, kahit nababasa ang teksto.

Gamitin ang aktuwal na kapaligiran sa halip na malapitang screenshot.

## Mga karaniwang salik sa kadalian ng pagbasa

Maaaring mahirap unawain ang interface dahil sa mahahabang label, paulit-ulit na metadata, mahihinang heading, hindi pare-parehong termino, siksik na kontrol, mahinang pagpapangkat, hindi inaasahang pagkakasunod ng focus, at sirang muling pagdaloy ng layout.

Nakadepende sa wika at gawain ang kadalian ng pagbasa. Isama ang mga gumagamit na mahusay sa wika para sa nilalamang maraming wika.

## Subukan ang ugnayan ng dalawa

Lakihan ang teksto nang isang suportadong antas. Kung luminaw ang mga karakter ngunit nagsapawan ang mga kontrol o nawala ang nilalaman, ibinunyag ng pagpapalinaw ang hadlang sa pag-aayos muli ng layout. Itala ang setting at nawawala o nagsasapawang elemento sa halip na ibalik ang setting ng gumagamit at sabihing nalutas na ang problema.

Gawin ang paghahambing gamit ang parehong pamagat, wika, gawain, viewport, at input. Una, hilinging kilalanin ang partikular na label o katayuan; pagkatapos, hilinging gamitin ito para matapos ang gawain. Itala lamang ang tagal ng pagkilala kapag talagang kapaki-pakinabang ang oras, at isama ang paliwanag ng manonood. Hindi patunay ng kalinawan ang mabilis na hula. Kung pinadali ng pagbabago ang pagkilala ngunit dumami ang pagkakamali sa nabigasyon, idokumento ang parehong resulta sa halip na pagsamahin sa isang pasado o bagsak.

Para sa mga icon, subukan muna ang simbolo kasama ang nakikitang label bago husgahan ang icon lamang. Maaaring magmukhang malinaw sa bihasang tagasuri ang malabong simbolo dahil pamilyar na siya rito. Maaaring umasa sa label, posisyon, at nakapaligid na hirarkiya ang baguhan o paminsan-minsang gumagamit.

## Isama ang kapaligiran

Maaaring mabawasan ang nakikitang linaw at madagdagan ang hirap sa pagbasa dahil sa silaw, distansiya, ilaw, at anggulo ng screen. Gamitin ang [gabay sa ergonomiya ng TV interface](/blog/tv-interface-ergonomics-guide/) para panatilihing bahagi ng paghahambing ang distansiya sa panonood at paraan ng input. Para sa hindi malinaw na focus, nakatutulong ang [checklist sa remote at D-pad](/blog/remote-dpad-navigation-qa/) sa paglalarawan kung saan lumipat ang focus at ano ang sumunod na nangyari.

Iniuugnay ng [kumpletong gabay sa biswal na ginhawa](/blog/the-complete-guide-to-visual-comfort-in-media-interfaces/) ang mga natuklasan sa zoom, kulay, focus, at galaw.

## Iwasan ang medikal na konklusyon

Itanong kung ano ang nakikilala at natatapos ng manonood. Huwag ipaliwanag ang hirap gamit ang ipinagpalagay na kondisyon. Maaaring aksiyunan ang nauulit na hadlang sa gawain nang walang diyagnosis.

## Mag-ulat nang tiyak

Sabihin ang konteksto, distansiya, zoom o scaling, gawain, eksaktong elemento, inaasahang resulta, naobserbahang error, pansamantalang lunas, at screenshot na ligtas sa pagkapribado. Palitan ang “pangit ang teksto” ng “hindi mapag-iba ang taon at rating sa normal na distansiya sa TV”.

Para sa kongkretong ulat sa Norva, pumili ng item mula sa compatible na source na pag-aari mo o awtorisado mong gamitin. Subukang hanapin ang taon nito, pagkatapos ipaliwanag ang nilalayong aksiyon sa screen bago piliin ito. Iulat kung aling bahagi ang pumalya: pagkilala sa taon, pag-unawa sa aksiyon, o pagsunod sa focus. Itala kung nangyayari sa telepono, TV, o web. Huwag isama ang pagkakakilanlan ng account, kredensiyal ng source, o pribadong pamagat ng media sa ibinabahaging larawan; ulitin gamit ang hindi sensitibong materyal kung maaari.

## Mga karaniwang pagkakamali at limitasyon

Iwasang pagpalitin ang mga salita, sumubok sa hindi makatotohanang lapit, baguhin nang sabay ang font at ayos, o ipagpalagay na nilulutas ng mas malaking laki ang bawat problema sa pagbasa.

Kasangkapan sa pagtukoy ng problema ang pagkakaibang ito, hindi pormal na medikal na pagtatasa. Kailangan pa ring opisyal na beripikahin ang kasalukuyang mga kontrol ng produkto.

## Mga madalas itanong

### Maaari bang malinaw ang mga titik ngunit mahirap basahin ang teksto?

Oo. Maaaring malinaw ang bawat karakter ngunit mahirap ang gawain dahil sa siksik na pananalita, mahinang hirarkiya, o mahinang ayos.

### Maaari bang may hindi makilalang kontrol sa madaling basahing ayos?

Oo. Maaaring makatuwiran ang pagkakasunod ngunit natatago ng maliit na teksto, mababang contrast, o hindi malinaw na focus ang ilang elemento.

### Aling problema ang dapat unahing ayusin?

Unahin ayon sa epekto ang mga hadlang sa pagkilala at pagkumpleto ng gawain, saka muling subukan dahil maaaring makaapekto sa kabila ang pagbabago sa isang antas.

## Ang susunod mong hakbang

[Magpadala ng nauulit na ulat ng hadlang sa pagbasa sa Suporta ng Norva](https://norva.tv/support), gamit ang magkaparis na card sa itaas. Isang tiyak na screen, gawain, at naobserbahang hirap ang nagbibigay sa pangkat ng maaaring siyasatin nang hindi hinuhulaan ang sanhi.

## Mga sanggunian

- [W3C: Paggawang madaling gamitin ng nilalaman para sa mga taong may kapansanan sa pag-iisip at pagkatuto](https://www.w3.org/TR/coga-usable/)
- [W3C: Contrast (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)
- [Mga feature ng Norva](https://norva.tv/#features)
