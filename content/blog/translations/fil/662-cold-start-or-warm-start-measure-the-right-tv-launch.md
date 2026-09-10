---
language: "fil"
source_slug: "cold-start-or-warm-start-measure-the-right-tv-launch"
source_sha256: "1d98978ab5f697cccbc66a8ab0cd8d60492abc5f7897a76ab52c9df291edcdcb"
title: "Cold start o warm start: Bakit nag-iiba ang pagbukas ng TV app"
seo_title: "Cold at warm start ng TV app: Sukatin ang oras nang patas"
meta_description: "Bakit minsan mabilis at minsan mabagal bumukas ang TV app? Ihiwalay ang sariwang pagbukas, pagbabalik, unang larawan at nagagamit na navigation sa isang halimbawa."
excerpt: "Hindi laging sariwang pagbukas ang pagbabalik mula sa Home. Ihambing ang parehong panimulang kalagayan at ihiwalay ang unang larawan sa navigation na tumutugon."
topic_cluster: "Performance ng Smart TV"
sources_heading: "Mga sanggunian"
next_step_heading: "Ang susunod mong hakbang"
translation_status: "approved"
translation_method: "ai_assisted"
---

# Cold start o warm start: Bakit nag-iiba ang pagbukas ng TV app

> **Sa madaling sabi:** Maaaring magsimula mula sa wala ang isang TV app, buuin muli ang screen gamit ang napanatiling state, o bumalik na may malaking bahagi ng interface na nasa memory pa. Magkakaibang gawain ang mga iyon. Ihambing ang magkaparehong panimulang kondisyon at sukatin ang oras hanggang sa unang larawan ng app at hanggang sa nagagamit nang navigation sa remote. Hindi patunay na handa ang katalogo ang paglitaw ng logo.

Para ang gabay na ito sa manonood na gustong ilarawan ang pabago-bagong oras ng pagbukas, hindi para markahan ang TV ayon sa unibersal na target ng bilis. Maaaring pamahalaan ng TV operating system ang mga process nang hindi nakikita. Kapag hindi mo matiyak ang internal state, itala ang ginawa mo sa halip na mag-imbento ng teknikal na label.

## Tukuyin ang apat na kalagayan

Inilalarawan ng Android ang **cold**, **warm** at **hot** start. Lumilikha ng app mula sa simula ang cold start; gumagawa ng ilang gawain sa pagsisimula gamit ang napanatiling state ang warm start; ibinabalik sa harap ng hot start ang napanatiling activity. Hiwalay na obserbasyon ng navigation ang pagbalik sa screen sa loob ng app, hindi ikaapat na kategorya ng Android startup.

Para sa praktikal na tala ng TV, ihiwalay ang apat na nakikitang sitwasyong ito:

| Sitwasyong maitatala mo | Ano ang sinasabi nito | Ano ang hindi pa alam |
|---|---|---|
| Pagbukas matapos ang opisyal na pag-restart ng TV | Na-restart ang system bago binuksan ang app | Gaano karami sa delay ang mula sa paghahanda ng system o network |
| Muling pagbukas matapos lumabas gamit ang Back | Nilabasan ang app gamit ang normal nitong control | Kung napanatili ang process o screen nito |
| Pagbalik matapos pindutin ang Home at maghintay ng 30 segundo | Nagkaroon ng maikling panahon sa background | Kung pinanatiling buhay ng system ang app |
| Pagbalik sa mga pelikula mula sa ibang screen ng app | Nanatili sa loob ng app ang navigation | Aling mga resource ng katalogo o artwork ang nagamit muli |

Inihihiwalay ng [gabay sa bawat layer](/blog/smart-tv-media-app-performance-a-layer-by-layer-guide/) ang lifecycle mula sa network at rendering.

## Tukuyin ang dalawang puntong pagtatapusan ng oras

Maaaring lumitaw ang unang frame bago gumana ang focus, mag-load ang artwork, o tumugon ang navigation. Hiwalay na itala ang “unang frame ng app” at “nagagamit na screen.” Idagdag lamang ang “matatag na artwork” kung iyon ang tanong. Pinag-iiba ng TTID at TTFD ng Android ang unang display at ganap na kahandaan, ngunit hindi awtomatikong katumbas ng alinman sa mga instrumented metric na iyon ang mano-manong timing mo mula sa remote hanggang sa screen.

Huwag ihinto ang oras sa milestone na nagbibigay ng pinakamagandang resulta.

## Panatilihing tiyak ang konteksto

Itala ang modelo ng TV, OS, bersiyon ng app, input source, power state, output, wired o Wi-Fi na daanan, oras, sesyon na walang inilalantad na pribadong detalye ng account, availability ng source at gawain sa background. Panatilihing maihahambing ang state ng network at source.

Dapat banggitin sa mano-manong timing ang kawalang-katiyakan dahil sa bilis ng reaksiyon ng nagmamasid.

## Orihinal na halimbawa: Pamamaraan ng pagsukat ng pagbukas

Mga **kathang-isip na halimbawang panturo, hindi mga pagsukat ng Norva**, ang mga halaga sa ibaba. Gumagamit ang isang manonood ng iisang TV, bersiyon ng app, account at katalogo. Nagsisimula ang bawat test sa pagpindot sa remote na nagbubukas ng app. Ang “nagagamit” ay nangangahulugang nakikita ang nilalayong screen, tumutugon ang isang paggalaw ng D-pad at wala nang nakaharang na overlay. Nasa segundo mula sa parehong panimulang pangyayari ang lahat ng oras.

| Test | Naobserbahang paghahanda | Unang frame ng app | Nagagamit na navigation | Matatag na artwork |
|---|---|---|---|---|
| A | Opisyal na restart; handa ang home screen ng TV at network | 1.8 s | 4.6 s | 6.2 s |
| B | Home, maghintay ng 30 segundo, bumalik | 0.7 s | 1.2 s | 1.9 s |
| C | Parehong maikling pagbabalik | 0.8 s | 1.4 s | 2.0 s |
| D | Ulitin ang paghahandang ginamit sa A | 1.9 s | 4.4 s | 6.0 s |

Umaabot sa nagagamit na navigation ang dalawang obserbasyon matapos ang restart sa 4.4–4.6 segundo, samantalang 1.2–1.4 segundo ang maiikling pagbabalik. Ipinahihiwatig nito ang nauulit na pagkakaiba sa pagitan ng mga paghahandang ito. **Hindi** nito natutukoy kung gaano karaming oras ang natipid ng partikular na cache, napapatunayan ang warm o hot na process state, o nahuhulaan ang resulta ng ibang TV.

Ang mahalagang obserbasyon para sa suporta ay ang pagitan ng unang frame at tumutugong navigation sa A at D. Matatakpan ang puwang na iyon kung sasabihing “handa ang app sa 1.8 segundo.” Kasama rin sa mano-manong timing ang error sa reaksiyon ng nagmamasid: huwag ituring na pagbuti ng performance ang pagkakaibang ikasampu ng segundo nang walang mas eksaktong pagsukat.

## Maghanda ng cold state nang ligtas

Gamitin lamang ang opisyal na gabay sa pagpapatigil ng app, pag-restart ng TV o power. Huwag bunutin ang kuryente, gumamit ng service menu, o mag-clear ng data para lamang gumawa ng cold state. Kung hindi matitiyak ng platform na hindi tumatakbo ang app, tawagin itong “pagbukas matapos ang restart.”

Mas mahalaga ang kaligtasan at integridad ng device kaysa sa perpektong kondisyon ng eksperimento.

## Maghanda ng warm state

Walang pangkalahatang sunod-sunod na pagpindot sa Home o Back na gumagarantiya ng warm process state. Kung hindi mo ito matitiyak sa pamamagitan ng instrumentation ng platform, itala ang isang **maikling pagbabalik**: abutin ang parehong screen, lumabas gamit ang dokumentadong control, maghintay ng nakapirming panahon, at bumalik. Itala kung nanatili ang screen, focus o artwork nang hindi nagbibigay ng hindi napatunayang lifecycle label.

Maaaring magbago ang napanatiling state sa pagitan ng mga test, kaya panatilihin sa tala ang mga hindi inaasahang muling pag-load.

## Baligtarin ang pagkakasunod at magpahinga

Kung praktikal, gamitin ang pagkakasunod na matapos ang restart, maikling pagbabalik, maikling pagbabalik, matapos ang restart, na may nakapirming pahinga sa pagitan. Maaaring magpakita ang pagbaligtad ng pagkakasunod ng pattern na naaayon sa pagbabago ng cache, temperatura, network o source; hindi nito natutukoy ang sanhi. Huwag gumawa ng dose-dosenang pagbukas; magtakda muna ng maliit na bilang.

Mas tiyak na matutukoy ng instrumentation ang process state at mga hangganan ng timing, ngunit hindi kailangan ng manonood ang developer mode o pribadong log upang mag-ulat ng nauulit na nakikitang delay.

## Unawain ang mga pagkakaiba

Maaaring magpahiwatig ng napanatiling state o naka-cache na resource ang mas mabilis na warm start kaysa sa cold start, ngunit hindi nito nasusukat kung aling cache ang dahilan. Maaaring magmukhang cold start ang warm start dahil sa pagtigil ng app, update, kakulangan ng available na memory, o pagpili sa implementasyon.

Itala bilang mga obserbasyon ang paulit-ulit na pagkawala ng posisyon o hindi inaasahang muling pag-load, hindi bilang patunay na kailangan ng TV ng mas maraming memory. Kung ang paglipat lamang ng panonood sa pagitan ng mga screen ang mukhang mabagal, tukuyin muna ang mekanismo sa [gabay sa handoff, mirroring at casting](/blog/handoff-mirroring-or-casting-know-which-workflow-you-need/).

## Ihambing matapos ang pagbabago

Pagkatapos ng update ng app, ulitin ang parehong pamamaraan at itala ang konteksto ng bersiyon. Panatilihin ang mga tala bago at pagkatapos sa halip na umasa sa alaala. Huwag ihambing ang lumang pagbukas matapos ang restart sa bagong maikling pagbabalik.

Nakadepende sa device, bersiyon at nakakonektang source ang pagbukas ng Norva sa TV. Player ang Norva para sa compatible na media na awtorisado kang gamitin, hindi kasamang katalogo. Hindi pinatutunayan ng mga halimbawang ito ang bilis ng pagbukas o performance ng pag-play nito.

## Kontrolin ang pagkakasunod ng test at kahandaan

Madalas mauna ang mga cold test, kaya maaaring hindi patas na pabigatin ang mga ito ng maintenance sa pagsisimula, muling pagkonekta sa network o paghahanda ng nagmamasid. Salit-salitin ang pagkakasunod sa iba't ibang sesyon kapag pinahihintulutan ng platform ang dokumentadong state, at maghintay ng parehong nakapirming panahon bago ang bawat pagbukas. Itala kung handa na ang home screen, remote, network at output.

Tukuyin ang “nagagamit” bago magsukat: halimbawa, nakikita ang nilalayong screen, tumutugon nang isang beses ang focus at wala nang nakaharang na overlay. Huwag tapusin ang timing dahil lamang lumitaw ang logo. Iulat ang median kasama lamang ng mga indibidwal na halaga at saklaw; maaaring itago ng iisang buod ang naantalang o nabigong pagbukas na mas mahalaga kaysa sa maliit na pagkakaiba ng average.

## Mga madalas itanong

### Pareho ba ang pagbukas ng power ng TV at cold start ng app?

Hindi. Kasama rito ang pagsisimula ng system at maaaring iba ang paraan ng pagpapanumbalik ng state ng app.

### Ilang test ang kailangan?

Gumamit ng ilang paunang itinakdang test na sapat upang makita ang saklaw nang hindi pinahihirapan ang device o source.

### Dapat bang gawing sukatan ng pagbukas ang pagkumpleto ng artwork?

Tanging kung kahandaan ng artwork ang sinusuri; panatilihing magkahiwalay ang unang frame at nagagamit na focus.

## Ang susunod mong hakbang

[Humingi ng tulong sa nauulit na problema sa pagbukas ng TV app](https://norva.tv/support). Isama ang modelo ng TV, OS at bersiyon ng app, mga hakbang sa paghahanda, inaasahang screen at parehong milestone ng timing. Huwag isama sa mga screenshot ang mga identifier ng account, address ng source o credential.

## Mga sanggunian

- [Android Developers: Oras ng pagsisimula ng app](https://developer.android.com/topic/performance/vitals/launch-time)
- [Tulong sa Google TV: Ayusin ang mabagal o laggy na Google TV device](https://support.google.com/googletv/answer/12364830?hl=en)
