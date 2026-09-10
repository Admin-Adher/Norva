---
language: "fil"
source_slug: "volume-and-loudness-why-they-are-not-identical"
source_sha256: "c5afea01c019d7d716ee9c9381688084918f14896336a67afc5e83d8a17ed1d1"
title: "Volume at loudness: Bakit hindi sila magkapareho"
seo_title: "Volume at loudness: Ano ang pagkakaiba?"
meta_description: "Hindi panukat ng loudness ang volume slider. Ihambing ang gain, lakas ng programa, mga peak, dynamic range at output nang hindi nanghuhula mula sa isang numero."
excerpt: "Maaaring magkaiba ang naririnig na lakas sa parehong volume setting. Ihiwalay ang gain, loudness, mga peak at output gamit ang kalkulasyon at talaan ng paghahambing."
topic_cluster: "Pag-unawa sa kalidad ng audio"
sources_heading: "Mga sanggunian"
next_step_heading: "Ang susunod mong hakbang"
translation_status: "approved"
translation_method: "ai_assisted"
---

# Volume at loudness: Bakit hindi sila magkapareho

> **Sa madaling sabi:** Binabago ng volume control ang gain sa isang bahagi ng proseso ng pag-play. Ang loudness ay kung gaano kalakas ang pakiramdam natin sa tunog; tinatantiya ito ng pagsukat ng programme loudness mula sa audio signal gamit ang isang tiyak na paraan. Naaapektuhan ang signal na iyon ng recording, mix at pagproseso, habang naaapektuhan din ng output device at kapaligiran ng pakikinig ang naririnig mo. Hindi ginagarantiyahan ng parehong posisyon ng slider ang parehong lakas ng pakikinig.

Kung mas malakas ang isang pelikula kaysa sa isa pa kahit hindi mo ginalaw ang remote, hindi nangangahulugang nagbago ang volume control. Maaaring ibang mix, track o processing mode ang naririnig mo. Magsimula sa paghihiwalay ng setting ng control at ng audio na binabago nito, sa halip na ituring ang ipinapakitang numero bilang sukat ng buong karanasan.

## Itala ang bawat yugto ng gain

Ang gain ay pag-scale ng signal sa isang partikular na yugto. Minumultiply ng simpleng digital gain ang bawat sample sa isang halaga; ipinapakita ng [dokumentasyon ng GainNode sa MDN](https://developer.mozilla.org/en-US/docs/Web/API/GainNode) ang prinsipyong iyon. Hindi kailangang direktang ipakita ng isang consumer slider ang multiplier na iyon, at ang setting na “50” ay hindi unibersal na acoustic level o garantiya ng kalahati ng nararamdamang lakas.

Itala ang mga control na talagang naaangkop: volume ng player, media level ng operating system, level ng TV o receiver, mga control ng headphone, at anumang pagsasaayos para sa bawat track. Maaaring magkaugnay ang ilang control, samantalang maaaring nakapirmi o nilalaktawan ang ibang yugto para sa napiling daanan ng audio. Tiyakin kung aling device ang tumutunog bago baguhin ang tig-isang control.

## Unawain ang programme loudness

Tinutukoy ng [ITU-R BS.1770](https://www.itu.int/rec/R-REC-BS.1770/en) ang mga algorithm para sa pagsukat ng programme loudness at true peak. Inilalarawan ng programme-loudness reading ang isang audio signal ayon sa paraang iyon; hindi nito direktang sinusukat ang sound pressure sa iyong mga tainga. Sinasabi rin ng rekomendasyon na tinatantiya ng sinusukat na loudness ang pandama, na may ilang kawalang-katiyakan depende sa tagapakinig, materyal at kalagayan ng pakikinig.

Maaaring makita mo ang **LUFS**, mga yunit ng loudness na may sanggunian sa digital full scale. Saklaw ng integrated reading ang sinuring programa o sipi, samantalang inilalarawan ng mga panandaliang reading ang mas maikling saklaw. Tukuyin ang paraan, mga channel, sinuring panahon, at kung ginawa ang pagsukat bago o pagkatapos ng pagproseso. Huwag ilahad ang resulta ng maikling usapan bilang resulta para sa buong pelikula.

Gumagamit ang [EBU R 128](https://tech.ebu.ch/publications/r128) ng mga pagsukat ng loudness sa isang balangkas ng broadcast normalisation at pinag-iiba ang loudness at pinakamataas na true-peak level. Hindi ito unibersal na target para sa bawat consumer app, at hindi nito ginagawang panukat ang volume slider.

## Ihiwalay ang mga peak at dynamic range

Inilalarawan ng sample peaks ang pinakamalalaking absolute value ng mga naitalang sample; tinatantiya ng true-peak measurement ang mga peak ng waveform na maaaring mangyari sa pagitan ng mga sample. Hindi sinasabi ng alinman kung gaano katagal nananatiling malakas ang programa. Maaaring umabot sa parehong peak ang maikling impact at tuluy-tuloy na usapan kahit magkaiba ang pangkalahatang naririnig na lakas.

Tumutukoy ang dynamic range sa pagkakaiba ng mahina at malakas na materyal. Kapag tinaasan ang nakapirming volume setting, parehong lumalakas ang mga ito; hindi nito pinapalapit nang pili ang mahihinang usapan sa malalakas na sound effect. Ibang problema ang tinutugunan ng dynamic-range processing. Halimbawa, inilalarawan ng [opisyal na gabay ng Sony](https://www.sony.com/electronics/support/televisions-projectors/articles/00203665) ang mga setting na nagbabago sa pagkakaibang ito sa mga tinukoy na TV at audio format. Halimbawa iyon para sa partikular na device, hindi pahayag na may kaparehong setting ang Norva.

## Orihinal na halimbawa: Talaan ng gain at loudness

Isa itong **binuong halimbawa ng aritmetika**, hindi sinusukat na media, pagsubok sa pakikinig, o volume setting ng Norva. Ipagpalagay ang dalawang digital signal na may sample peaks sa ibaba at simpleng linear gain na 0.5. Ang mga peak value na walang yunit ay bahagi ng digital full scale, hindi decibel o sukat ng sound pressure. Walang ibang pagproseso na kasama.

| Binuong signal | Pinakamalaking absolute input sample | Gain multiplier | Kinalkulang output sample peak | Programme loudness o level sa mga tainga |
| --- | --- | --- | --- | --- |
| A | 0.20 | 0.5 | 0.20 × 0.5 = 0.10 | Hindi malalaman mula sa mga halagang ito |
| B | 0.60 | 0.5 | 0.60 × 0.5 = 0.30 | Hindi malalaman mula sa mga halagang ito |

Magkaiba pa rin ang output peaks sa parehong gain dahil magkaiba ang input signals. Tatlong ulit ng kinalkulang sample peak ng A ang sa B, ngunit **hindi** iyon nangangahulugang tatlong ulit ang nararamdamang lakas ng B. Hindi natin tinukoy ang natitirang bahagi ng bawat signal, tagal nito, output equipment, o kalagayan ng pakikinig.

Kahit pagtugmain ang mga peak na iyon, hindi pa rin mapatutunayan ang magkaparehong programme loudness. Sadyang humihinto ang talaang ito sa pinatutunayan ng aritmetika; hindi ito makapagbibigay ng LUFS reading, ranggo ng kalidad, o ligtas na headphone level. Hindi rin nangangahulugan ang multiplier na 0.5 na dapat itakda sa 50% ang slider ng isang partikular na produkto.

## Ihambing ang mga track sa magkalapit na level

Kung ang tanong ay kung aling track ang mas malinaw, huwag hayaang maging hindi kontroladong pagkakaiba ang level. Gamitin ang maikling pamamaraang ito sa media na awtorisado kang i-play:

1. Tukuyin ang mga label at papel ng parehong track. Hindi kaparehong mix ng pangunahing soundtrack ang commentary track; gamitin ang [gabay sa listahan ng audio track](/blog/how-to-read-an-audio-track-list-before-playback/) kung hindi malinaw ang mga label.
2. Piliin ang parehong bahagi sa dalawang bersiyon. Itala ang oras ng simula at wakas, at isama ang usapan at mas malakas na sandali kung iyon ang problemang sinusuri mo.
3. Panatilihing pareho ang device, output path, posisyon ng pakikinig at processing state. Itala ang mga hindi alam na setting sa halip na ipagpalagay na naka-off ang mga ito.
4. Ihambing sa mababa at komportableng level. Hinaan ang track na mukhang mas malakas kapag tinatantiya mong pagtugmain ang nararamdamang level; huwag lakasan ang mas mahina hanggang maging hindi komportable ang malakas na effect. Kung gumagamit ng wastong loudness meter, hiwalay na itala ang paraan at saklaw nito.
5. Salit-salitin ang pagkakasunod at itala ang isang tiyak na obserbasyon, gaya ng “mahirap pa ring sundan ang usapan matapos halos pagtugmain ang level.” Huwag gawing pahayag ng nasukat na kahusayan ang isang impormal na kagustuhan.

Tantiya lamang ang pagtutugma gamit ang pandinig, hindi resulta ng pagsunod sa isang pamantayan. Kung hindi maihahambing nang komportable ang bahagi, itigil ang paghahambing.

## Isama ang normalisation

Inaayos ng loudness normalisation ang gain ng programa o pag-play tungo sa isang tinukoy na ugnayan ng loudness. Pamantayan ng peak naman ang ginagamit ng peak normalisation. Hindi nangangahulugan ang alinman, nang mag-isa, na pinapalapit ang mahihinang usapan at malalakas na effect sa loob ng programa; kailangan nitong baguhin ang kanilang relatibong level.

Nakadepende sa implementasyon ang mga target, saklaw ng pagsukat, paghawak sa mga peak at mga control ng user. Suriin ang dokumentasyon ng app, TV, receiver o headphone para sa anumang aktibong normalisation o dynamic processing. Hindi nagtatakda ang artikulong ito ng target ng normalisation para sa Norva o nagsasabing ipinapatupad ng Norva ang EBU R 128.

## Isama ang sensitivity ng output at ang silid

Maaaring maglabas ang mga headphone at speaker ng magkaibang acoustic level mula sa parehong digital signal o ipinapakitang setting. Nakaaapekto rin sa pakikinig ang fit, layo, mga repleksiyon sa silid, ingay sa paligid at pagproseso ng device. Kung nagpalit ka ng output, nagbago ang paghahambing kahit pareho pa rin ang numero sa screen.

Kung natatakpan ng ingay sa silid ang mahihinang detalye, suriin ang kapaligiran o gumamit ng naaangkop na [saklaw ng mga caption](/blog/captions-and-subtitles-why-the-accessibility-goals-can-differ/) sa halip na patuloy na taasan ang volume. Binibigyang-diin ng [gabay ng WHO sa ligtas na pakikinig](https://www.who.int/news-room/questions-and-answers/item/deafness-and-hearing-loss-safe-listening) ang parehong sound level at tagal ng pagkakalantad, at inirerekomenda ang mga pahinga at pagbawas sa pangangailangang taasan ang volume sa maingay na lugar. Hindi pagsukat ng pagkakalantad ang pagiging komportable lamang.

## Mag-ulat ng pagkakaiba sa level

Itala ang item o bersiyon, eksaktong mga label ng track, oras ng sipi, naaangkop na mga volume control, processing state, output path at device, kalagayan ng silid, paraan ng paghahambing at resulta. Isama lamang ang mga wastong pagsukat kapag available, kasama ang saklaw ng mga ito. Mas kapaki-pakinabang ang “Walang pagsukat ng loudness; hindi alam ang pagproseso ng TV” kaysa sa inimbentong tantiya ng decibel mula sa slider.

Inilalarawan ng [kumpletong gabay sa kalidad ng audio](/blog/the-complete-guide-to-understanding-audio-quality/) ang natitirang bahagi ng proseso.

## Mga karaniwang pagkakamali at limitasyon

Iwasang ihambing ang mga numero ng slider sa magkakaibang device, ituring ang pagtutugma ng peak bilang pagtutugma ng loudness, o gumamit ng hindi napatunayang phone sound-level reading bilang calibrated na ebidensiya. Hindi rin direktang sukat ng tunog sa loob ng mga headphone ang mikropono ng teleponong malapit sa speaker. Hindi pormal na pagsubok sa loudness compliance, pagsusuri sa pandinig, o patunay na mas mahusay ang codec o player ang impormal na pakikinig.

## Suriin ang level matapos magpalit ng daanan ng audio

Kapag lumilipat mula sa mga speaker patungo sa headphone o receiver, suriin ang level ng destinasyon bago simulan o ipagpatuloy ang pag-play at magsimula sa mababa. Itala ang mga aktibong yugto ng gain sa halip na kopyahin ang dating numero. Kung sabay mong binago ang daanan at ang media, bumalik sa kilalang bahagi sa mababang level bago magpasiyang ang bagong track ang sanhi ng pagkakaiba.

## Mga madalas itanong

### Magkapareho ba ang volume at programme loudness?

Hindi. Itinatakda ng volume control ang gain sa isang yugto ng pag-play. Inilalarawan ng programme-loudness reading ang signal gamit ang tinukoy na paraan ng pagsukat; hindi natutukoy ng alinman nang mag-isa ang acoustic level sa iyong mga tainga.

### Pareho ba ang loudness sa dalawang device kung pareho ang halaga ng slider?

Hindi. Magkakaiba ang gain structure, amplifier, sensitivity ng output, mga speaker o headphone, silid at pagproseso.

### Magkapareho ba ang peak normalisation at loudness normalisation?

Hindi. Magkaibang katangian ang inilalarawan ng mga pagsukat ng peak at loudness, at magkaibang gawain ang sinusuportahan ng mga ito.

## Ang susunod mong hakbang

Bago maghambing ng isa pang bersiyon, itala ang track at output path na talagang ginamit mo. Pagkatapos, [tuklasin ang mga feature ng pag-play sa Norva](https://norva.tv/#features) nang hindi ipinagpapalagay ang isang hindi dokumentadong normalisation mode. Media-player software ang Norva, na walang kasamang content o TV subscription; dapat manggaling ang iyong media sa compatible na source na awtorisado kang gamitin.

## Mga sanggunian

- [MDN: Digital gain at ang GainNode](https://developer.mozilla.org/en-US/docs/Web/API/GainNode)
- [ITU-R BS.1770: Programme loudness at true peak](https://www.itu.int/rec/R-REC-BS.1770/en)
- [EBU R 128: Loudness normalisation](https://tech.ebu.ch/publications/r128)
- [Sony: Mga setting ng dynamic range at naaangkop na mga format](https://www.sony.com/electronics/support/televisions-projectors/articles/00203665)
- [WHO: Ligtas na pakikinig, level at tagal ng pagkakalantad](https://www.who.int/news-room/questions-and-answers/item/deafness-and-hearing-loss-safe-listening)
- [Mga feature ng Norva](https://norva.tv/#features)
