---
language: "fil"
source_slug: "bandwidth-throughput-latency-and-jitter-explained"
source_sha256: "1187d6fb8fd3c55e3350243076646f12a474e161b0a321d197fcb55237b068da"
title: "Pag-unawa sa bandwidth, throughput, latency at jitter"
seo_title: "Bandwidth, throughput, latency at jitter sa video"
meta_description: "Unawain ang bandwidth, throughput, latency at jitter sa isang halimbawa para sa video. Alamin ang limitasyon ng speed test at ng iisang jitter limit."
excerpt: "Magkakaiba ang kapasidad, nasukat na transfer rate, delay at pagbabago ng delay. Suriin ang isang network comparison bago isisi ang buffering sa iisang numero."
topic_cluster: "Mga batayan ng home network para sa video"
sources_heading: "Mga sanggunian"
next_step_heading: "Ang susunod mong hakbang"
translation_status: "approved"
translation_method: "ai_assisted"
---

# Pag-unawa sa bandwidth, throughput, latency at jitter

> **Sa madaling sabi:** Ang bandwidth ay konsepto ng available o nominal na kapasidad; ang throughput ay ang kapaki-pakinabang na rate na nasukat sa isang tiyak na test. Delay ang latency, samantalang inilalarawan ng jitter ang pagbabago ng delay ayon sa isang tinukoy na paraan. Hiwalay pa ang packet loss. Maaaring makaapekto sa video ang isa o ilan sa mga ito, kaya itala ang paraan at daanan ng koneksiyon bago bigyang-kahulugan ang numero.

Bahagi lamang ng kabuuan ang ipinapakita ng bawat sukatan. Kahit pareho ang yunit, maaaring magkaiba ang endpoint, protocol, direksiyon, tagal, ruta o kalagayan ng trapiko na sinusukat ng dalawang test.

## Hindi aktuwal na resulta ng paghahatid ang bandwidth

Madalas gamitin ang bandwidth bilang maikling tawag sa bilis, ngunit hindi sinasabi ng mga label ng kapasidad kung gaano karaming application data ang dumating sa isang partikular na panahon. Maaaring mabawasan ang nakikitang throughput dahil sa magkakahating koneksiyon, protocol overhead, congestion, kondisyon ng radyo, limitasyon ng device at remote endpoint.

Dahil dito, magkakaibang halaga ang rate ng internet plan, Wi-Fi link rate, Ethernet label at application throughput. Itala kung alin ang ipinapakita ng screen bago ihambing sa iba.

## Kailangan ng konteksto ng test ang throughput

Ang throughput ay nasukat na transfer rate. Inilalarawan ng RFC 6349 ang balangkas para sa TCP throughput testing at binibigyang-diin ang paraan ng pagsusuri. Dapat kasama ng resulta ang endpoint, direksiyon, protocol, tagal, bilang ng mga koneksiyon, device, ruta at oras nito.

Inilalarawan ng [gabay sa mga batayan ng home network](/blog/the-complete-guide-to-home-network-basics-for-video/) ang daanan sa pagitan ng device at source. Hindi ginagaya ng malapit na test server ang bawat daanan patungo sa awtorisadong source, at hindi dapat ilahad ang maikling peak bilang tuluy-tuloy na performance ng application.

## Ang latency ay lumipas na oras ng pagkaantala

Inilalarawan ng latency kung gaano katagal bumiyahe ang data o sagot sa sinusukat na daanan. Kailangan ng one-way delay ang pagkakasabay ng mga orasan at pagtukoy sa kawalang-katiyakan ng timing ayon sa paraan ng RFC 7679; round trip naman ang iniuulat ng maraming consumer tool. Hindi maaaring ipagpalit ang mga resultang iyon.

Maaaring maging mabilis o mabagal ang pagsisimula ng video, mga control, authentication at mga request ng segment dahil sa magkakaibang dahilan. Hindi awtomatikong nangangahulugan ng mababang latency ang mataas na throughput.

## Pagbabago ng delay ang jitter, hindi simpleng kabagalan

Tinutukoy ng RFC 3393 ang mga sukatan ng packet delay variation. Sa mga karaniwang tool, maaaring gumamit ang “jitter” ng ibang kalkulasyon, direksiyon, panahon o estadistika. Basahin ang depinisyon ng tool bago maghambing ng mga halaga.

Maaaring sapat ang average throughput ng koneksiyon ngunit hindi regular ang pagdating ng mga packet, o pare-pareho ang delay ngunit kulang ang tuluy-tuloy na throughput. Maaaring magkapareho ang average ng palaging 80 ms na round trip at ng pabago-bago sa pagitan ng 20 at 140 ms, kahit magkaiba ang kilos nila. Inilalarawan ng halimbawang iyon ang pagbabago, hindi formula ng jitter o katanggap-tanggap na limitasyon.

## Isa pang dimensiyon ang packet loss

Tinutukoy ng RFC 7680 ang isang sukatan ng one-way packet loss na may malinaw na paraan. Maaaring ipagpalagay naman ng mga consumer result ang loss mula sa hindi dumating na mga sagot, at maaaring mas mababa ang prayoridad ng diagnostic traffic sa ilang device. Hindi pinatutunayan ng iniulat na zero na dumating ang bawat application packet; kailangang tingnan ang pag-uulit at saklaw ng resultang hindi zero.

Ihiwalay sa iyong mga tala ang nawawalang packet at nahuling packet. Nakikitang sintomas ang paghinto ng pag-play, hindi diagnosis sa antas ng packet.

## Orihinal na halimbawa: Talasalitaan ng mga sukatan

| Sukatan | Tanong sa simpleng wika | Kailangang konteksto | Hindi nito mapatutunayan nang mag-isa |
|---|---|---|---|
| Bandwidth o kapasidad | Ano ang kayang dalhin ng koneksiyong ito ayon sa depinisyon nito? | Koneksiyon, label, direksiyon | Paghahatid ng application |
| Throughput | Anong kapaki-pakinabang na rate ang nasukat? | Endpoint, protocol, tagal, ruta | Bawat daanan ng source |
| Latency | Gaano katagal ang delay na naobserbahan ng paraan? | One-way o round-trip, mga orasan, daanan | Tuluy-tuloy na kapasidad |
| Jitter | Paano nagbago ang delay? | Formula, sample, estadistika | Average throughput |
| Loss | Aling inaasahang mga packet ang hindi dumating? | Uri ng probe, direksiyon, panahon | Eksaktong sanhi ng problema sa pag-play |

Lagyan ng yunit ang bawat halaga at panatilihin ang raw results kung pinahihintulutan ng privacy.

### Kumpletong halimbawa: Mabilis na plan at hindi matatag na koneksiyon sa gabi

Mga **kathang-isip na resultang panturo** ang mga ito, hindi test ng Norva o ng isang source. May plan na may label na 100 Mbps ang isang sambahayan. Sinusuri nito ang parehong laptop sa parehong lokasyon ng Wi-Fi laban sa parehong malapit na endpoint, gamit ang magkaparehong download setting at tatlong 30-segundong test sa bawat panahon.

| Obserbasyon | Panahong kaunti ang aktibidad sa network | Panahong mataas ang aktibidad sa network | Interpretasyon |
|---|---|---|---|
| Download throughput, tatlong test | 82, 80, 84 Mbps | 28, 14, 31 Mbps | Bumababa ang median mula 82 tungo sa 28 Mbps; 14–31 Mbps ang saklaw kapag mataas ang aktibidad sa network |
| Median round-trip delay na iniulat ng tool sa parehong kondisyon ng load | 18 ms | 65 ms | Mas mabagal sumagot ang sinusuring daanan kapag mataas ang aktibidad sa network |
| Ipinapakitang jitter ng tool, parehong formula at sampling setting | 3 ms | 24 ms | Mas pabago-bago ang delay ayon sa depinisyon ng tool; hindi ito pasado o bagsak na marka |
| Awtorisadong video kapag mataas ang aktibidad sa network | Hindi sinuri | Dalawang paghinto ang naitala | Kasabay ng mas mahinang resulta ang mga paghinto, ngunit hindi nasukat ang endpoint ng video |

Ang makatuwirang susunod na hakbang ay ulitin ang test sa oras ng sintomas, at kung maaari ay ang lokal na koneksiyon lamang ang palitan ng Ethernet kapag suportado. **Hindi** ito dahilan upang agad bumili ng mas mabilis na plan. Kahit ang sample na 14 Mbps ay hindi sapat upang matukoy kung dapat gumana ang video: hindi alam ang aktuwal na pangangailangan ng bersiyon, mga panandaliang pagbaba, daanan ng source at kilos ng buffering.

Ihiwalay ang Mbps o megabit bawat segundo sa MB/s o megabyte bawat segundo: katumbas ng 1 MB/s ang 8 Mbps bago isaalang-alang ang depinisyon ng overhead ng pagsukat. Oras ang inilalarawan ng millisecond, hindi data rate. Hindi maaaring ihambing ang mga yunit na ito na para bang laging mas magandang koneksiyon ang mas malaking numero.

## Bumuo ng maliit na pangkat ng mga pagsukat

Gamitin ang apektadong device sa normal nitong lokasyon. Magtala ng tatlong sample na may pagitan kapag kaunti ang aktibidad sa network at tatlo sa panahong lumilitaw ang sintomas. Kung ligtas at suportado, ulitin sa isang alternatibong lokal na koneksiyon nang hindi binabago ang endpoint o mga setting ng test.

Pagkatapos ay ihambing ang mga median, saklaw at pag-uulit sa halip na piliin ang pinakamagandang numero. Itala ang sabay na mga upload, pagbabago sa mesh, power state ng device at lagay ng panahon kung direktang naobserbahan lamang; huwag mag-imbento ng mga sanhi mula sa mga nagkataong pangyayari.

## Unawain ang pinagsamang mga resulta

Maaaring maubos ng mababang tuluy-tuloy na throughput ang playback buffer. Maaaring maantala ng pabago-bagong delay at loss ang paghahatid kahit mukhang sapat ang maikling average rate. Maaaring pabagalin ng mataas na latency ang sunod-sunod na request at response nang hindi kinakailangang malimitahan ang mahabang paglilipat. Ang application, kilos ng transport, disenyo ng buffering at source ang tumutukoy sa nakikitang epekto.

Kung tuloy ang pag-play ngunit pangit ang larawan, gamitin ang [paghahambing ng kalidad ng larawan](/blog/the-complete-guide-to-understanding-video-quality/) sa halip na ituring ang labo bilang patunay ng mabagal na network. Nagpe-play ang Norva ng mga compatible at awtorisadong source; hindi ito nagbibigay ng katalogo o kumokontrol sa iyong router, daanan ng source o encoding nito.

## Mga karaniwang pagkakamali sa interpretasyon

Huwag ihambing ang bit sa byte, ipagkamali ang link rate sa throughput, tawaging “packet loss” ang lahat ng pagbabago ng delay, o ituring na garantiya ang resulta mula sa iisang server. Iwasang magsukat lamang pagkatapos sabay-sabay na baguhin ang router, device at source.

## Mga madalas itanong

### Aling sukatan ang pinakamahalaga para sa video?

Walang iisang sukatan na laging nangingibabaw. Ang paraan ng paghahatid ng bersiyon, daanan, device at sintomas ang tumutukoy kung aling mga pagsukat ang mahalaga.

### Maaari bang lumampas ang throughput sa label ng plan?

Nagkakaiba ang mga label, provisioning, paraan ng test, yunit at depinisyon ng overhead. Tiyakin kung ano ang kinakatawan ng bawat numero bago ituring na error ang pagkakaiba.

### Pareho ba ang paraan ng pagsukat ng jitter sa bawat tool?

Hindi. Suriin ang formula, direksiyon, uri ng probe, sampling period at iniulat na estadistika ng tool.

### Ano ang katanggap-tanggap na jitter para sa video streaming?

Walang unibersal na millisecond cutoff na makapagpapatunay ng maayos na pag-play ng video. Magkaiba ang pagtanggap sa delay ng buffered na on-demand video at interactive na tawag; magkaiba rin ang pagkalkula ng jitter ng mga tool. Ihambing ang mga paulit-ulit na resulta ng parehong paraan sa aktuwal na sintomas. Hindi dapat gawing pangkalahatang pangangailangan ng Norva ang limitasyong inilathala para sa isang application o protocol.

### Bakit nagbu-buffer ang video pagkatapos ng magandang speed test?

Maaaring ibang server, ruta, pattern ng paglilipat o panahon ang gamitin ng test. Maaaring hindi nito makita ang maiikling pagkagambala, at nakadepende rin ang pag-play sa source at device. Itala kung nangyayari ang delay bago ang unang frame o habang nagpe-play bago piliin ang susunod na test.

## Ang susunod mong hakbang

[Itugma ang sintomas ng pag-play sa susunod na pagsusuri](https://norva.tv/blog/a-symptom-pattern-atlas-for-video-buffering/). Isama sa anumang support request ang device, panahon, paraan ng test at isang nauulit na sintomas—hindi ang mga credential ng source.

## Mga sanggunian

- [RFC 6349: Pagsusuri ng TCP throughput](https://www.rfc-editor.org/rfc/rfc6349)
- [RFC 7679: Sukatan ng one-way delay](https://www.rfc-editor.org/rfc/rfc7679)
- [RFC 3393: Sukatan ng pagbabago ng delay](https://www.rfc-editor.org/rfc/rfc3393)
- [RFC 7680: Sukatan ng one-way packet loss](https://www.rfc-editor.org/rfc/rfc7680)
