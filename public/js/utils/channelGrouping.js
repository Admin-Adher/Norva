/**
 * Channel grouping + country ordering.
 *
 * Providers ship the same channel many times with quality/codec/country
 * decorations ("TF1 HD", "4K | TF1", "FR | TF1 [H265]"...). This module
 * canonicalises each raw name, groups the variants into one logical channel,
 * and (for the user's country) orders them by the national channel number.
 *
 * It is intentionally framework-agnostic and side-effect free so the same
 * logic can later run server-side at sync time. Exposed as window.ChannelGrouping.
 */
(function () {
    'use strict';

    // Real channel logos from the public tv-logos repo (raw.githubusercontent,
    // CDN-backed, reliable) — used when the provider's logo host is dead/empty
    // (the FR nationals all point to the now-defunct aptvpix.net).
    const LOGO_BASE = 'https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/france/';
    const TVL = 'https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/';

    // National line-ups. `kind: 'national'` channels are ordered by `lcn` and
    // pinned to the top. `aliases` must be the *canonical core* after
    // normalisation (lowercase, de-accented, quality/codec/country stripped).
    const COUNTRY_LINEUPS = {
        FR: [
            { key: 'tf1', lcn: 1, name: 'TF1', aliases: ['tf1'], logo: LOGO_BASE + 'tf1-fr.png' },
            { key: 'france2', lcn: 2, name: 'France 2', aliases: ['france 2'], logo: LOGO_BASE + 'france-2-fr.png' },
            { key: 'france3', lcn: 3, name: 'France 3', aliases: ['france 3'], logo: LOGO_BASE + 'france-3-fr.png' },
            { key: 'france4', lcn: 4, name: 'France 4', aliases: ['france 4'], logo: LOGO_BASE + 'france-4-fr.png' },
            { key: 'france5', lcn: 5, name: 'France 5', aliases: ['france 5'], logo: LOGO_BASE + 'france-5-fr.png' },
            { key: 'm6', lcn: 6, name: 'M6', aliases: ['m6'], logo: LOGO_BASE + 'm6-fr.png' },
            { key: 'arte', lcn: 7, name: 'Arte', aliases: ['arte'], logo: LOGO_BASE + 'arte-fr.png' },
            { key: 'c8', lcn: 8, name: 'C8', aliases: ['c8'], logo: LOGO_BASE + 'c8-fr.png' },
            { key: 'w9', lcn: 9, name: 'W9', aliases: ['w9'], logo: LOGO_BASE + 'w9-fr.png' },
            { key: 'tmc', lcn: 10, name: 'TMC', aliases: ['tmc'], logo: LOGO_BASE + 'tmc-fr.png' },
            { key: 'tfx', lcn: 11, name: 'TFX', aliases: ['tfx'], logo: LOGO_BASE + 'tfx-fr.png' },
            { key: 'nrj12', lcn: 12, name: 'NRJ 12', aliases: ['nrj 12', 'nrj12'], logo: LOGO_BASE + 'nrj-12-fr.png' },
            { key: 'lcp', lcn: 13, name: 'LCP', aliases: ['lcp', 'public senat'], logo: LOGO_BASE + 'lcp-fr.png' },
            { key: 'bfmtv', lcn: 15, name: 'BFM TV', aliases: ['bfm tv', 'bfmtv'], logo: LOGO_BASE + 'bfm-tv-fr.png' },
            { key: 'cnews', lcn: 16, name: 'CNews', aliases: ['cnews'], logo: LOGO_BASE + 'c-news-fr.png' },
            { key: 'cstar', lcn: 17, name: 'CStar', aliases: ['cstar'], logo: LOGO_BASE + 'c-star-fr.png' },
            { key: 'gulli', lcn: 18, name: 'Gulli', aliases: ['gulli'], logo: LOGO_BASE + 'gulli-fr.png' },
            { key: 'tf1sf', lcn: 19, name: 'TF1 Séries Films', aliases: ['tf1 series films', 'tf1 series film', 'tf1 series et films'], logo: LOGO_BASE + 'tf1-series-films-fr.png' },
            { key: 'lequipe', lcn: 21, name: "L'Équipe", aliases: ['l equipe', 'lequipe'], logo: LOGO_BASE + 'lequipe-fr.png' },
            { key: '6ter', lcn: 22, name: '6ter', aliases: ['6ter'], logo: LOGO_BASE + '6ter-fr.png' },
            { key: 'rmcstory', lcn: 23, name: 'RMC Story', aliases: ['rmc story'], logo: LOGO_BASE + 'rmc-story-fr.png' },
            { key: 'rmcdecouverte', lcn: 24, name: 'RMC Découverte', aliases: ['rmc decouverte'], logo: LOGO_BASE + 'rmc-decouverte-fr.png' },
            { key: 'cherie25', lcn: 25, name: 'Chérie 25', aliases: ['cherie 25', 'cherie25'] },
            { key: 'lci', lcn: 26, name: 'LCI', aliases: ['lci'], logo: LOGO_BASE + 'lci-fr.png' },
            { key: 'franceinfo', lcn: 27, name: 'Franceinfo', aliases: ['france info', 'franceinfo'], logo: LOGO_BASE + 'franceinfo-fr.png' }
        ],
        US: [
            { key: 'abc', rank: 1, name: 'ABC', aliases: ['abc'], logo: TVL + 'united-states/abc-us.png' },
            { key: 'cbs', rank: 2, name: 'CBS', aliases: ['cbs'], logo: TVL + 'united-states/cbs-logo-white-us.png' },
            { key: 'nbc', rank: 3, name: 'NBC', aliases: ['nbc'], logo: TVL + 'united-states/nbc-us.png' },
            { key: 'fox', rank: 4, name: 'FOX', aliases: ['fox'], logo: TVL + 'united-states/fox-us.png' },
            { key: 'thecw', rank: 5, name: 'The CW', aliases: ['the cw', 'cw'], logo: TVL + 'united-states/the-cw-us.png' },
            { key: 'pbs', rank: 6, name: 'PBS', aliases: ['pbs'], logo: TVL + 'united-states/pbs-us.png' },
            { key: 'cnn', rank: 7, name: 'CNN', aliases: ['cnn'], logo: TVL + 'united-states/cnn-us.png' },
            { key: 'foxnews', rank: 8, name: 'Fox News', aliases: ['fox news'], logo: TVL + 'united-states/fox-news-us.png' },
            { key: 'msnbc', rank: 9, name: 'MSNBC', aliases: ['msnbc'], logo: TVL + 'united-states/msnbc-hz-us.png' },
            { key: 'cnbc', rank: 10, name: 'CNBC', aliases: ['cnbc'], logo: TVL + 'united-states/cnbc-us.png' },
            { key: 'espn', rank: 11, name: 'ESPN', aliases: ['espn'], logo: TVL + 'united-states/espn-us.png' },
            { key: 'espn2', rank: 12, name: 'ESPN2', aliases: ['espn 2', 'espn2'], logo: TVL + 'united-states/espn-2-us.png' },
            { key: 'fs1', rank: 13, name: 'Fox Sports 1', aliases: ['fox sports 1', 'fs1'], logo: TVL + 'united-states/fox-sports-1-us.png' },
            { key: 'hbo', rank: 14, name: 'HBO', aliases: ['hbo'], logo: TVL + 'united-states/hbo-us.png' },
            { key: 'amc', rank: 15, name: 'AMC', aliases: ['amc'], logo: TVL + 'united-states/amc-us.png' },
            { key: 'tnt', rank: 16, name: 'TNT', aliases: ['tnt'], logo: TVL + 'united-states/tnt-us.png' },
            { key: 'tbs', rank: 17, name: 'TBS', aliases: ['tbs'], logo: TVL + 'united-states/tbs-us.png' },
            { key: 'discovery', rank: 18, name: 'Discovery', aliases: ['discovery', 'discovery channel'], logo: TVL + 'united-states/discovery-channel-us.png' },
            { key: 'history', rank: 19, name: 'History', aliases: ['history', 'history channel'], logo: TVL + 'united-states/history-channel-us.png' },
            { key: 'cartoonnetwork', rank: 20, name: 'Cartoon Network', aliases: ['cartoon network'], logo: TVL + 'united-states/cartoon-network-us.png' },
            { key: 'nickelodeon', rank: 21, name: 'Nickelodeon', aliases: ['nickelodeon'], logo: TVL + 'united-states/nickelodeon-us.png' },
            { key: 'disneychannel', rank: 22, name: 'Disney Channel', aliases: ['disney channel'], logo: TVL + 'united-states/disney-channel-us.png' },
            { key: 'hgtv', rank: 23, name: 'HGTV', aliases: ['hgtv'], logo: TVL + 'united-states/hgtv-us.png' },
            { key: 'foodnetwork', rank: 24, name: 'Food Network', aliases: ['food network'], logo: TVL + 'united-states/food-network-us.png' },
            { key: 'comedycentral', rank: 25, name: 'Comedy Central', aliases: ['comedy central'], logo: TVL + 'united-states/comedy-central-us.png' },
            { key: 'mtv', rank: 26, name: 'MTV', aliases: ['mtv'], logo: TVL + 'united-states/mtv-us.png' },
            { key: 'tlc', rank: 27, name: 'TLC', aliases: ['tlc'], logo: TVL + 'united-states/tlc-us.png' },
            { key: 'bravo', rank: 28, name: 'Bravo', aliases: ['bravo'], logo: TVL + 'united-states/bravo-us.png' },
            { key: 'bet', rank: 29, name: 'BET', aliases: ['bet'], logo: TVL + 'united-states/bet-us.png' },
            { key: 'paramountnetwork', rank: 30, name: 'Paramount Network', aliases: ['paramount network'], logo: TVL + 'united-states/paramount-network-us.png' }
        ],
        IN: [
            { key: 'starplus', rank: 1, name: 'Star Plus', aliases: ['star plus'], logo: TVL + 'india/star-plus-in.png' },
            { key: 'colors', rank: 2, name: 'Colors', aliases: ['colors'], logo: TVL + 'india/colors-in.png' },
            { key: 'sonytv', rank: 3, name: 'Sony Entertainment Television', aliases: ['sony entertainment television', 'sony tv'], logo: TVL + 'india/sony-entertainment-television-in.png' },
            { key: 'zeetv', rank: 4, name: 'Zee TV', aliases: ['zee tv'], logo: TVL + 'india/zee-tv-in.png' },
            { key: 'starbharat', rank: 5, name: 'Star Bharat', aliases: ['star bharat'], logo: TVL + 'india/star-bharat-in.png' },
            { key: 'sonysab', rank: 6, name: 'Sony SAB', aliases: ['sony sab', 'sab tv'], logo: TVL + 'india/sony-sab-in.png' },
            { key: 'andtv', rank: 7, name: '&TV', aliases: ['and tv'], logo: TVL + 'india/and-tv-in.png' },
            { key: 'stargold', rank: 8, name: 'Star Gold', aliases: ['star gold'], logo: TVL + 'india/star-gold-in.png' },
            { key: 'zeecinema', rank: 9, name: 'Zee Cinema', aliases: ['zee cinema'], logo: TVL + 'india/zee-cinema-in.png' },
            { key: 'sonymax', rank: 10, name: 'Sony Max', aliases: ['sony max'], logo: TVL + 'india/sony-max-in.png' },
            { key: 'aajtak', rank: 11, name: 'Aaj Tak', aliases: ['aaj tak'], logo: TVL + 'india/aaj-tak-in.png' },
            { key: 'ndtv24x7', rank: 12, name: 'NDTV 24x7', aliases: ['ndtv 24x7', 'ndtv 24 7'], logo: TVL + 'india/ndtv-24x7-in.png' },
            { key: 'indiatoday', rank: 13, name: 'India Today', aliases: ['india today'], logo: TVL + 'india/india-today-in.png' },
            { key: 'republictv', rank: 14, name: 'Republic TV', aliases: ['republic tv'], logo: TVL + 'india/republic-tv-in.png' },
            { key: 'timesnow', rank: 15, name: 'Times Now', aliases: ['times now'], logo: TVL + 'india/times-now-in.png' },
            { key: 'zeenews', rank: 16, name: 'Zee News', aliases: ['zee news'], logo: TVL + 'india/zee-news-in.png' },
            { key: 'ndtvindia', rank: 17, name: 'NDTV India', aliases: ['ndtv india'], logo: TVL + 'india/ndtv-india-in.png' },
            { key: 'starsports1', rank: 18, name: 'Star Sports 1', aliases: ['star sports 1'], logo: TVL + 'india/star-sports-1-in.png' },
            { key: 'sonyten1', rank: 19, name: 'Sony Ten 1', aliases: ['sony ten 1'], logo: TVL + 'india/sony-ten-1-in.png' },
            { key: 'starmaa', rank: 20, name: 'Star Maa', aliases: ['star maa'], logo: TVL + 'india/star-maa-in.png' },
            { key: 'asianet', rank: 21, name: 'Asianet', aliases: ['asianet'], logo: TVL + 'india/asianet-in.png' },
            { key: 'zeebangla', rank: 22, name: 'Zee Bangla', aliases: ['zee bangla'], logo: TVL + 'india/zee-bangla-in.png' }
        ],
        // ── Additional markets ────────────────────────────────────────────────────────
        // These lineups carry canonical name + aliases + rank (ordering) but no curated
        // logo: the provider's own channel logo is used, so there are never broken
        // images. `rank` is national prominence order, not an official LCN. Aliases are
        // the normalised core (lowercase, de-accented, quality/codec stripped) so they
        // match how IPTV providers label the feed ("UK | BBC ONE HD" → core "bbc one").
        GB: [
            { key: 'bbcone', rank: 1, name: 'BBC One', aliases: ['bbc one', 'bbc 1'] },
            { key: 'bbctwo', rank: 2, name: 'BBC Two', aliases: ['bbc two', 'bbc 2'] },
            { key: 'itv1', rank: 3, name: 'ITV1', aliases: ['itv1', 'itv 1', 'itv'] },
            { key: 'channel4', rank: 4, name: 'Channel 4', aliases: ['channel 4', 'c4'] },
            { key: 'channel5', rank: 5, name: 'Channel 5', aliases: ['channel 5', 'c5'] },
            { key: 'itv2', rank: 6, name: 'ITV2', aliases: ['itv2', 'itv 2'] },
            { key: 'bbcthree', rank: 7, name: 'BBC Three', aliases: ['bbc three', 'bbc 3'] },
            { key: 'bbcfour', rank: 8, name: 'BBC Four', aliases: ['bbc four', 'bbc 4'] },
            { key: 'e4', rank: 9, name: 'E4', aliases: ['e4'] },
            { key: 'film4', rank: 10, name: 'Film4', aliases: ['film4', 'film 4'] },
            { key: 'more4', rank: 11, name: 'More4', aliases: ['more4', 'more 4'] },
            { key: 'itv3', rank: 12, name: 'ITV3', aliases: ['itv3', 'itv 3'] },
            { key: 'itv4', rank: 13, name: 'ITV4', aliases: ['itv4', 'itv 4'] },
            { key: 'dave', rank: 14, name: 'Dave', aliases: ['dave'] },
            { key: 'skymax', rank: 15, name: 'Sky Max', aliases: ['sky max', 'sky one'] },
            { key: 'skynews', rank: 16, name: 'Sky News', aliases: ['sky news'] },
            { key: 'bbcnews', rank: 17, name: 'BBC News', aliases: ['bbc news'] }
        ],
        DE: [
            { key: 'daserste', rank: 1, name: 'Das Erste', aliases: ['das erste', 'ard'] },
            { key: 'zdf', rank: 2, name: 'ZDF', aliases: ['zdf'] },
            { key: 'rtl', rank: 3, name: 'RTL', aliases: ['rtl', 'rtl television'] },
            { key: 'sat1', rank: 4, name: 'SAT.1', aliases: ['sat 1', 'sat1'] },
            { key: 'prosieben', rank: 5, name: 'ProSieben', aliases: ['prosieben', 'pro sieben', 'pro 7'] },
            { key: 'vox', rank: 6, name: 'VOX', aliases: ['vox'] },
            { key: 'kabeleins', rank: 7, name: 'kabel eins', aliases: ['kabel eins', 'kabel 1', 'kabeleins'] },
            { key: 'rtlzwei', rank: 8, name: 'RTL ZWEI', aliases: ['rtl zwei', 'rtl 2', 'rtl2'] },
            { key: 'dreisat', rank: 9, name: '3sat', aliases: ['3sat'] },
            { key: 'arte', rank: 10, name: 'arte', aliases: ['arte'] },
            { key: 'zdfneo', rank: 11, name: 'ZDFneo', aliases: ['zdfneo', 'zdf neo'] },
            { key: 'superrtl', rank: 12, name: 'Super RTL', aliases: ['super rtl', 'superrtl'] },
            { key: 'ntv', rank: 13, name: 'n-tv', aliases: ['n tv', 'ntv'] },
            { key: 'welt', rank: 14, name: 'WELT', aliases: ['welt'] },
            { key: 'sixx', rank: 15, name: 'sixx', aliases: ['sixx'] },
            { key: 'nitro', rank: 16, name: 'RTL NITRO', aliases: ['nitro', 'rtl nitro'] },
            { key: 'tele5', rank: 17, name: 'Tele 5', aliases: ['tele 5', 'tele5'] }
        ],
        ES: [
            { key: 'la1', rank: 1, name: 'La 1', aliases: ['la 1', 'tve 1', 'la1'] },
            { key: 'la2', rank: 2, name: 'La 2', aliases: ['la 2', 'tve 2', 'la2'] },
            { key: 'antena3', rank: 3, name: 'Antena 3', aliases: ['antena 3', 'antena3'] },
            { key: 'cuatro', rank: 4, name: 'Cuatro', aliases: ['cuatro'] },
            { key: 'telecinco', rank: 5, name: 'Telecinco', aliases: ['telecinco', 'tele 5'] },
            { key: 'lasexta', rank: 6, name: 'laSexta', aliases: ['lasexta', 'la sexta'] },
            { key: 'neox', rank: 7, name: 'Neox', aliases: ['neox'] },
            { key: 'nova', rank: 8, name: 'Nova', aliases: ['nova'] },
            { key: 'energy', rank: 9, name: 'Energy', aliases: ['energy'] },
            { key: 'fdf', rank: 10, name: 'FDF', aliases: ['fdf', 'factoria de ficcion'] },
            { key: 'divinity', rank: 11, name: 'Divinity', aliases: ['divinity'] },
            { key: 'clan', rank: 12, name: 'Clan', aliases: ['clan', 'clan tve'] },
            { key: 'mega', rank: 13, name: 'Mega', aliases: ['mega'] },
            { key: 'atreseries', rank: 14, name: 'Atreseries', aliases: ['atreseries'] },
            { key: 'teledeporte', rank: 15, name: 'Teledeporte', aliases: ['teledeporte', 'tdp'] },
            { key: 'canal24h', rank: 16, name: '24h', aliases: ['24h', 'canal 24 horas', '24 horas'] }
        ],
        IT: [
            { key: 'rai1', rank: 1, name: 'Rai 1', aliases: ['rai 1', 'rai1', 'rai uno'] },
            { key: 'rai2', rank: 2, name: 'Rai 2', aliases: ['rai 2', 'rai2', 'rai due'] },
            { key: 'rai3', rank: 3, name: 'Rai 3', aliases: ['rai 3', 'rai3', 'rai tre'] },
            { key: 'rete4', rank: 4, name: 'Rete 4', aliases: ['rete 4', 'rete4', 'retequattro'] },
            { key: 'canale5', rank: 5, name: 'Canale 5', aliases: ['canale 5', 'canale5', 'canale cinque'] },
            { key: 'italia1', rank: 6, name: 'Italia 1', aliases: ['italia 1', 'italia1', 'italia uno'] },
            { key: 'la7', rank: 7, name: 'LA7', aliases: ['la7', 'la 7'] },
            { key: 'tv8', rank: 8, name: 'TV8', aliases: ['tv8', 'tv 8'] },
            { key: 'nove', rank: 9, name: 'NOVE', aliases: ['nove', 'canale nove'] },
            { key: 'rai4', rank: 10, name: 'Rai 4', aliases: ['rai 4', 'rai4'] },
            { key: 'rai5', rank: 11, name: 'Rai 5', aliases: ['rai 5', 'rai5'] },
            { key: 'raimovie', rank: 12, name: 'Rai Movie', aliases: ['rai movie', 'raimovie'] },
            { key: 'rainews24', rank: 13, name: 'Rai News 24', aliases: ['rai news 24', 'rainews24', 'rai news'] },
            { key: 'iris', rank: 14, name: 'Iris', aliases: ['iris'] },
            { key: 'cielo', rank: 15, name: 'Cielo', aliases: ['cielo'] },
            { key: 'realtime', rank: 16, name: 'Real Time', aliases: ['real time', 'realtime'] }
        ],
        PT: [
            { key: 'rtp1', rank: 1, name: 'RTP1', aliases: ['rtp1', 'rtp 1'] },
            { key: 'rtp2', rank: 2, name: 'RTP2', aliases: ['rtp2', 'rtp 2'] },
            { key: 'sic', rank: 3, name: 'SIC', aliases: ['sic'] },
            { key: 'tvi', rank: 4, name: 'TVI', aliases: ['tvi'] },
            { key: 'rtp3', rank: 5, name: 'RTP3', aliases: ['rtp3', 'rtp 3'] },
            { key: 'sicnoticias', rank: 6, name: 'SIC Notícias', aliases: ['sic noticias'] },
            { key: 'cmtv', rank: 7, name: 'CMTV', aliases: ['cmtv', 'cm tv'] },
            { key: 'rtpmemoria', rank: 8, name: 'RTP Memória', aliases: ['rtp memoria'] },
            { key: 'sicradical', rank: 9, name: 'SIC Radical', aliases: ['sic radical'] },
            { key: 'sicmulher', rank: 10, name: 'SIC Mulher', aliases: ['sic mulher'] },
            { key: 'rtpafrica', rank: 11, name: 'RTP África', aliases: ['rtp africa'] },
            { key: 'portocanal', rank: 12, name: 'Porto Canal', aliases: ['porto canal'] }
        ],
        NL: [
            { key: 'npo1', rank: 1, name: 'NPO 1', aliases: ['npo 1', 'npo1', 'nederland 1'] },
            { key: 'npo2', rank: 2, name: 'NPO 2', aliases: ['npo 2', 'npo2', 'nederland 2'] },
            { key: 'npo3', rank: 3, name: 'NPO 3', aliases: ['npo 3', 'npo3', 'nederland 3'] },
            { key: 'rtl4', rank: 4, name: 'RTL 4', aliases: ['rtl 4', 'rtl4'] },
            { key: 'rtl5', rank: 5, name: 'RTL 5', aliases: ['rtl 5', 'rtl5'] },
            { key: 'sbs6', rank: 6, name: 'SBS6', aliases: ['sbs6', 'sbs 6'] },
            { key: 'rtl7', rank: 7, name: 'RTL 7', aliases: ['rtl 7', 'rtl7'] },
            { key: 'net5', rank: 8, name: 'Net5', aliases: ['net5', 'net 5'] },
            { key: 'rtl8', rank: 9, name: 'RTL 8', aliases: ['rtl 8', 'rtl8'] },
            { key: 'veronica', rank: 10, name: 'Veronica', aliases: ['veronica'] }
        ],
        BE: [
            { key: 'laune', rank: 1, name: 'La Une', aliases: ['la une', 'rtbf la une'] },
            { key: 'tipik', rank: 2, name: 'Tipik', aliases: ['tipik', 'rtbf tipik'] },
            { key: 'latrois', rank: 3, name: 'La Trois', aliases: ['la trois', 'rtbf la trois'] },
            { key: 'rtltvi', rank: 4, name: 'RTL-TVI', aliases: ['rtl tvi', 'rtltvi'] },
            { key: 'clubrtl', rank: 5, name: 'Club RTL', aliases: ['club rtl'] },
            { key: 'plugrtl', rank: 6, name: 'Plug RTL', aliases: ['plug rtl'] },
            { key: 'ab3', rank: 7, name: 'AB3', aliases: ['ab3', 'ab 3'] },
            { key: 'een', rank: 8, name: 'één', aliases: ['een', 'vrt 1', 'vrt een'] },
            { key: 'canvas', rank: 9, name: 'Canvas', aliases: ['canvas', 'vrt canvas'] },
            { key: 'vtm', rank: 10, name: 'VTM', aliases: ['vtm'] },
            { key: 'play4', rank: 11, name: 'Play4', aliases: ['play4', 'play 4', 'vier'] },
            { key: 'play5', rank: 12, name: 'Play5', aliases: ['play5', 'play 5', 'vijf'] }
        ],
        IE: [
            { key: 'rteone', rank: 1, name: 'RTÉ One', aliases: ['rte one', 'rte 1', 'rteone'] },
            { key: 'rte2', rank: 2, name: 'RTÉ2', aliases: ['rte2', 'rte 2', 'rte two'] },
            { key: 'virginmediaone', rank: 3, name: 'Virgin Media One', aliases: ['virgin media one', 'virgin media 1', 'tv3'] },
            { key: 'virginmediatwo', rank: 4, name: 'Virgin Media Two', aliases: ['virgin media two', 'virgin media 2', '3e'] },
            { key: 'virginmediathree', rank: 5, name: 'Virgin Media Three', aliases: ['virgin media three', 'virgin media 3'] },
            { key: 'tg4', rank: 6, name: 'TG4', aliases: ['tg4', 'tg 4'] },
            { key: 'rtenews', rank: 7, name: 'RTÉ News', aliases: ['rte news'] }
        ],
        CH: [
            { key: 'srf1', rank: 1, name: 'SRF 1', aliases: ['srf 1', 'srf1'] },
            { key: 'srfzwei', rank: 2, name: 'SRF zwei', aliases: ['srf zwei', 'srf 2', 'srf2'] },
            { key: 'rts1', rank: 3, name: 'RTS 1', aliases: ['rts 1', 'rts un', 'rts1'] },
            { key: 'rts2', rank: 4, name: 'RTS 2', aliases: ['rts 2', 'rts deux', 'rts2'] },
            { key: 'rsila1', rank: 5, name: 'RSI LA 1', aliases: ['rsi la 1', 'rsi 1', 'rsi la1'] },
            { key: 'rsila2', rank: 6, name: 'RSI LA 2', aliases: ['rsi la 2', 'rsi 2', 'rsi la2'] },
            { key: 'srfinfo', rank: 7, name: 'SRF info', aliases: ['srf info'] }
        ],
        AT: [
            { key: 'orf1', rank: 1, name: 'ORF 1', aliases: ['orf 1', 'orf1', 'orf eins'] },
            { key: 'orf2', rank: 2, name: 'ORF 2', aliases: ['orf 2', 'orf2', 'orf zwei'] },
            { key: 'orf3', rank: 3, name: 'ORF III', aliases: ['orf iii', 'orf 3', 'orf3'] },
            { key: 'servustv', rank: 4, name: 'ServusTV', aliases: ['servustv', 'servus tv'] },
            { key: 'atv', rank: 5, name: 'ATV', aliases: ['atv'] },
            { key: 'puls4', rank: 6, name: 'Puls 4', aliases: ['puls 4', 'puls4'] },
            { key: 'puls24', rank: 7, name: 'Puls 24', aliases: ['puls 24', 'puls24'] }
        ],
        SE: [
            { key: 'svt1', rank: 1, name: 'SVT1', aliases: ['svt1', 'svt 1'] },
            { key: 'svt2', rank: 2, name: 'SVT2', aliases: ['svt2', 'svt 2'] },
            { key: 'tv3', rank: 3, name: 'TV3', aliases: ['tv3', 'tv 3'] },
            { key: 'tv4', rank: 4, name: 'TV4', aliases: ['tv4', 'tv 4'] },
            { key: 'kanal5', rank: 5, name: 'Kanal 5', aliases: ['kanal 5', 'kanal5'] },
            { key: 'tv6', rank: 6, name: 'TV6', aliases: ['tv6', 'tv 6'] },
            { key: 'sjuan', rank: 7, name: 'Sjuan', aliases: ['sjuan', 'tv7'] },
            { key: 'tv8', rank: 8, name: 'TV8', aliases: ['tv8', 'tv 8'] },
            { key: 'kanal9', rank: 9, name: 'Kanal 9', aliases: ['kanal 9', 'kanal9'] },
            { key: 'svt24', rank: 10, name: 'SVT24', aliases: ['svt24', 'svt 24'] }
        ],
        NO: [
            { key: 'nrk1', rank: 1, name: 'NRK1', aliases: ['nrk1', 'nrk 1'] },
            { key: 'nrk2', rank: 2, name: 'NRK2', aliases: ['nrk2', 'nrk 2'] },
            { key: 'tv2no', rank: 3, name: 'TV 2', aliases: ['tv 2', 'tv2'] },
            { key: 'tvnorge', rank: 4, name: 'TVNorge', aliases: ['tvnorge', 'tv norge'] },
            { key: 'tv3no', rank: 5, name: 'TV3', aliases: ['tv3', 'tv 3'] },
            { key: 'maxno', rank: 6, name: 'MAX', aliases: ['max'] },
            { key: 'femno', rank: 7, name: 'FEM', aliases: ['fem'] },
            { key: 'voxno', rank: 8, name: 'VOX', aliases: ['vox'] },
            { key: 'nrk3', rank: 9, name: 'NRK3', aliases: ['nrk3', 'nrk 3'] }
        ],
        DK: [
            { key: 'dr1', rank: 1, name: 'DR1', aliases: ['dr1', 'dr 1'] },
            { key: 'dr2', rank: 2, name: 'DR2', aliases: ['dr2', 'dr 2'] },
            { key: 'tv2dk', rank: 3, name: 'TV 2', aliases: ['tv 2', 'tv2'] },
            { key: 'tv3dk', rank: 4, name: 'TV3', aliases: ['tv3', 'tv 3'] },
            { key: 'kanal5dk', rank: 5, name: 'Kanal 5', aliases: ['kanal 5', 'kanal5'] },
            { key: 'sekseren', rank: 6, name: "6'eren", aliases: ['6eren', '6 eren'] },
            { key: 'tv2zulu', rank: 7, name: 'TV 2 Zulu', aliases: ['tv 2 zulu', 'tv2 zulu'] },
            { key: 'tv2charlie', rank: 8, name: 'TV 2 Charlie', aliases: ['tv 2 charlie', 'tv2 charlie'] },
            { key: 'ramasjang', rank: 9, name: 'DR Ramasjang', aliases: ['dr ramasjang', 'ramasjang'] }
        ],
        FI: [
            { key: 'yletv1', rank: 1, name: 'Yle TV1', aliases: ['yle tv1', 'yle tv 1'] },
            { key: 'yletv2', rank: 2, name: 'Yle TV2', aliases: ['yle tv2', 'yle tv 2'] },
            { key: 'mtv3', rank: 3, name: 'MTV3', aliases: ['mtv3', 'mtv 3'] },
            { key: 'nelonen', rank: 4, name: 'Nelonen', aliases: ['nelonen'] },
            { key: 'yleteema', rank: 5, name: 'Yle Teema/Fem', aliases: ['yle teema', 'teema', 'yle teema fem'] },
            { key: 'subfi', rank: 6, name: 'Sub', aliases: ['sub'] },
            { key: 'jim', rank: 7, name: 'Jim', aliases: ['jim'] },
            { key: 'liv', rank: 8, name: 'Liv', aliases: ['liv'] },
            { key: 'tv5fi', rank: 9, name: 'TV5', aliases: ['tv5', 'tv 5'] }
        ],
        PL: [
            { key: 'tvp1', rank: 1, name: 'TVP1', aliases: ['tvp1', 'tvp 1'] },
            { key: 'tvp2', rank: 2, name: 'TVP2', aliases: ['tvp2', 'tvp 2'] },
            { key: 'polsat', rank: 3, name: 'Polsat', aliases: ['polsat'] },
            { key: 'tvn', rank: 4, name: 'TVN', aliases: ['tvn'] },
            { key: 'tv4pl', rank: 5, name: 'TV4', aliases: ['tv4', 'tv 4'] },
            { key: 'tvn7', rank: 6, name: 'TVN7', aliases: ['tvn7', 'tvn 7'] },
            { key: 'tvpuls', rank: 7, name: 'TV Puls', aliases: ['tv puls', 'puls'] },
            { key: 'tvpinfo', rank: 8, name: 'TVP Info', aliases: ['tvp info'] },
            { key: 'polsatnews', rank: 9, name: 'Polsat News', aliases: ['polsat news'] },
            { key: 'tvpsport', rank: 10, name: 'TVP Sport', aliases: ['tvp sport'] },
            { key: 'tvn24', rank: 11, name: 'TVN24', aliases: ['tvn24', 'tvn 24'] }
        ],
        GR: [
            { key: 'ert1', rank: 1, name: 'ERT1', aliases: ['ert1', 'ert 1'] },
            { key: 'ert2', rank: 2, name: 'ERT2', aliases: ['ert2', 'ert 2'] },
            { key: 'ert3', rank: 3, name: 'ERT3', aliases: ['ert3', 'ert 3'] },
            { key: 'megagr', rank: 4, name: 'Mega', aliases: ['mega', 'mega channel'] },
            { key: 'ant1', rank: 5, name: 'ANT1', aliases: ['ant1', 'ant 1', 'antenna'] },
            { key: 'alphagr', rank: 6, name: 'Alpha', aliases: ['alpha', 'alpha tv'] },
            { key: 'stargr', rank: 7, name: 'Star', aliases: ['star', 'star channel'] },
            { key: 'skaigr', rank: 8, name: 'Skai', aliases: ['skai', 'skai tv'] },
            { key: 'opengr', rank: 9, name: 'Open', aliases: ['open', 'open tv'] }
        ],
        RO: [
            { key: 'tvr1', rank: 1, name: 'TVR1', aliases: ['tvr1', 'tvr 1'] },
            { key: 'tvr2', rank: 2, name: 'TVR2', aliases: ['tvr2', 'tvr 2'] },
            { key: 'protv', rank: 3, name: 'Pro TV', aliases: ['pro tv', 'protv'] },
            { key: 'antena1', rank: 4, name: 'Antena 1', aliases: ['antena 1', 'antena1'] },
            { key: 'kanaldro', rank: 5, name: 'Kanal D', aliases: ['kanal d', 'kanald'] },
            { key: 'primatv', rank: 6, name: 'Prima TV', aliases: ['prima tv', 'prima'] },
            { key: 'digi24', rank: 7, name: 'Digi24', aliases: ['digi24', 'digi 24'] },
            { key: 'antena3ro', rank: 8, name: 'Antena 3 CNN', aliases: ['antena 3', 'antena3'] },
            { key: 'pro2', rank: 9, name: 'Pro 2', aliases: ['pro 2', 'pro2', 'acasa'] }
        ],
        TR: [
            { key: 'trt1', rank: 1, name: 'TRT 1', aliases: ['trt 1', 'trt1'] },
            { key: 'atvtr', rank: 2, name: 'ATV', aliases: ['atv'] },
            { key: 'showtv', rank: 3, name: 'Show TV', aliases: ['show tv', 'showtv'] },
            { key: 'startv', rank: 4, name: 'Star TV', aliases: ['star tv', 'startv'] },
            { key: 'kanaldtr', rank: 5, name: 'Kanal D', aliases: ['kanal d', 'kanald'] },
            { key: 'nowtr', rank: 6, name: 'NOW', aliases: ['now', 'fox tv', 'fox'] },
            { key: 'tv8tr', rank: 7, name: 'TV8', aliases: ['tv8', 'tv 8'] },
            { key: 'kanal7', rank: 8, name: 'Kanal 7', aliases: ['kanal 7', 'kanal7'] },
            { key: 'trthaber', rank: 9, name: 'TRT Haber', aliases: ['trt haber'] },
            { key: 'ntvtr', rank: 10, name: 'NTV', aliases: ['ntv'] },
            { key: 'cnnturk', rank: 11, name: 'CNN Türk', aliases: ['cnn turk'] }
        ],
        RU: [
            { key: 'channelone', rank: 1, name: 'Channel One', aliases: ['channel one', 'perviy kanal', 'pervyy', '1 kanal', 'ort'] },
            { key: 'russia1', rank: 2, name: 'Russia 1', aliases: ['russia 1', 'rossiya 1', 'rossia 1'] },
            { key: 'ntvru', rank: 3, name: 'NTV', aliases: ['ntv'] },
            { key: 'tnt', rank: 4, name: 'TNT', aliases: ['tnt'] },
            { key: 'sts', rank: 5, name: 'STS', aliases: ['sts'] },
            { key: 'rentv', rank: 6, name: 'REN TV', aliases: ['ren tv', 'rentv'] },
            { key: 'channel5ru', rank: 7, name: 'Channel 5', aliases: ['channel 5', '5 kanal', 'pyatiy kanal'] },
            { key: 'russia24', rank: 8, name: 'Russia 24', aliases: ['russia 24', 'rossiya 24'] },
            { key: 'matchtv', rank: 9, name: 'Match TV', aliases: ['match tv', 'match'] },
            { key: 'tv3ru', rank: 10, name: 'TV3', aliases: ['tv3', 'tv 3'] }
        ],
        CZ: [
            { key: 'ct1', rank: 1, name: 'ČT1', aliases: ['ct1', 'ct 1'] },
            { key: 'ct2', rank: 2, name: 'ČT2', aliases: ['ct2', 'ct 2'] },
            { key: 'novacz', rank: 3, name: 'Nova', aliases: ['nova', 'tv nova'] },
            { key: 'prima', rank: 4, name: 'Prima', aliases: ['prima'] },
            { key: 'ct24', rank: 5, name: 'ČT24', aliases: ['ct24', 'ct 24'] },
            { key: 'ctsport', rank: 6, name: 'ČT sport', aliases: ['ct sport'] },
            { key: 'primacool', rank: 7, name: 'Prima COOL', aliases: ['prima cool'] },
            { key: 'novacinema', rank: 8, name: 'Nova Cinema', aliases: ['nova cinema'] },
            { key: 'barrandov', rank: 9, name: 'Barrandov', aliases: ['barrandov', 'tv barrandov'] }
        ],
        HU: [
            { key: 'm1hu', rank: 1, name: 'M1', aliases: ['m1'] },
            { key: 'm2hu', rank: 2, name: 'M2', aliases: ['m2'] },
            { key: 'rtlhu', rank: 3, name: 'RTL', aliases: ['rtl', 'rtl klub'] },
            { key: 'tv2hu', rank: 4, name: 'TV2', aliases: ['tv2', 'tv 2'] },
            { key: 'duna', rank: 5, name: 'Duna', aliases: ['duna'] },
            { key: 'm4sport', rank: 6, name: 'M4 Sport', aliases: ['m4 sport', 'm4'] },
            { key: 'm5hu', rank: 7, name: 'M5', aliases: ['m5'] },
            { key: 'dunaworld', rank: 8, name: 'Duna World', aliases: ['duna world'] },
            { key: 'atvhu', rank: 9, name: 'ATV', aliases: ['atv'] }
        ],
        CA: [
            { key: 'cbc', rank: 1, name: 'CBC', aliases: ['cbc', 'cbc television'] },
            { key: 'ctv', rank: 2, name: 'CTV', aliases: ['ctv'] },
            { key: 'globalca', rank: 3, name: 'Global', aliases: ['global', 'global tv'] },
            { key: 'citytv', rank: 4, name: 'Citytv', aliases: ['citytv', 'city tv'] },
            { key: 'ctvtwo', rank: 5, name: 'CTV Two', aliases: ['ctv two', 'ctv 2'] },
            { key: 'radiocanada', rank: 6, name: 'Radio-Canada', aliases: ['radio canada', 'ici radio canada', 'src'] },
            { key: 'tva', rank: 7, name: 'TVA', aliases: ['tva'] },
            { key: 'noovo', rank: 8, name: 'Noovo', aliases: ['noovo', 'v tele'] },
            { key: 'telequebec', rank: 9, name: 'Télé-Québec', aliases: ['tele quebec'] },
            { key: 'cbcnews', rank: 10, name: 'CBC News Network', aliases: ['cbc news'] }
        ],
        BR: [
            { key: 'globo', rank: 1, name: 'Globo', aliases: ['globo', 'rede globo', 'tv globo'] },
            { key: 'sbt', rank: 2, name: 'SBT', aliases: ['sbt'] },
            { key: 'record', rank: 3, name: 'Record', aliases: ['record', 'record tv'] },
            { key: 'band', rank: 4, name: 'Band', aliases: ['band', 'bandeirantes'] },
            { key: 'redetv', rank: 5, name: 'RedeTV!', aliases: ['redetv', 'rede tv'] },
            { key: 'cultura', rank: 6, name: 'TV Cultura', aliases: ['cultura', 'tv cultura'] },
            { key: 'tvbrasil', rank: 7, name: 'TV Brasil', aliases: ['tv brasil'] },
            { key: 'globonews', rank: 8, name: 'GloboNews', aliases: ['globo news', 'globonews'] },
            { key: 'sportv', rank: 9, name: 'SporTV', aliases: ['sportv'] }
        ],
        MX: [
            { key: 'lasestrellas', rank: 1, name: 'Las Estrellas', aliases: ['las estrellas', 'canal de las estrellas', 'canal 2'] },
            { key: 'canal5mx', rank: 2, name: 'Canal 5', aliases: ['canal 5', 'canal5'] },
            { key: 'aztecauno', rank: 3, name: 'Azteca Uno', aliases: ['azteca uno', 'azteca 1', 'azteca 13'] },
            { key: 'azteca7', rank: 4, name: 'Azteca 7', aliases: ['azteca 7', 'azteca7'] },
            { key: 'imagentv', rank: 5, name: 'Imagen Televisión', aliases: ['imagen television', 'imagen tv', 'imagen'] },
            { key: 'canalonce', rank: 6, name: 'Canal Once', aliases: ['canal once', 'once tv', 'canal 11'] },
            { key: 'canal22', rank: 7, name: 'Canal 22', aliases: ['canal 22', 'canal22'] },
            { key: 'forotv', rank: 8, name: 'Foro TV', aliases: ['foro tv', 'forotv'] },
            { key: 'adn40', rank: 9, name: 'adn40', aliases: ['adn40', 'adn 40'] }
        ],
        AR: [
            { key: 'eltrece', rank: 1, name: 'El Trece', aliases: ['el trece', 'canal 13', 'trece'] },
            { key: 'telefe', rank: 2, name: 'Telefe', aliases: ['telefe'] },
            { key: 'americatv', rank: 3, name: 'América TV', aliases: ['america tv', 'america'] },
            { key: 'elnueve', rank: 4, name: 'El Nueve', aliases: ['el nueve', 'canal 9', 'nueve'] },
            { key: 'tvpublica', rank: 5, name: 'TV Pública', aliases: ['tv publica', 'television publica', 'canal 7'] },
            { key: 'nettv', rank: 6, name: 'Net TV', aliases: ['net tv'] },
            { key: 'c5n', rank: 7, name: 'C5N', aliases: ['c5n'] },
            { key: 'todonoticias', rank: 8, name: 'Todo Noticias', aliases: ['todo noticias', 'tn'] }
        ],
        AU: [
            { key: 'abcau', rank: 1, name: 'ABC', aliases: ['abc', 'abc tv'] },
            { key: 'sevenau', rank: 2, name: 'Seven', aliases: ['seven', 'channel seven', '7 network'] },
            { key: 'nineau', rank: 3, name: 'Nine', aliases: ['nine', 'channel nine'] },
            { key: 'tenau', rank: 4, name: 'Ten', aliases: ['ten', 'network 10', 'channel ten'] },
            { key: 'sbsau', rank: 5, name: 'SBS', aliases: ['sbs'] },
            { key: 'abcnewsau', rank: 6, name: 'ABC News', aliases: ['abc news'] },
            { key: 'sevenmate', rank: 7, name: '7mate', aliases: ['7mate'] },
            { key: 'seventwo', rank: 8, name: '7two', aliases: ['7two'] },
            { key: 'ninegem', rank: 9, name: '9Gem', aliases: ['9gem'] },
            { key: 'ninego', rank: 10, name: '9Go!', aliases: ['9go'] }
        ],
        MA: [
            { key: 'alaoula', rank: 1, name: 'Al Aoula', aliases: ['al aoula', 'aloula', 'al oula', 'tvm'] },
            { key: 'deuxm', rank: 2, name: '2M', aliases: ['2m', '2m maroc'] },
            { key: 'arryadia', rank: 3, name: 'Arryadia', aliases: ['arryadia', 'arriadia'] },
            { key: 'almaghribia', rank: 4, name: 'Al Maghribia', aliases: ['al maghribia', 'almaghribia'] },
            { key: 'medi1tv', rank: 5, name: 'Medi1 TV', aliases: ['medi1 tv', 'medi 1 tv', 'medi1'] },
            { key: 'chadatv', rank: 6, name: 'Chada TV', aliases: ['chada tv', 'chada'] },
            { key: 'tamazight', rank: 7, name: 'Tamazight', aliases: ['tamazight', 'al aoula tamazight'] },
            { key: 'athaqafia', rank: 8, name: 'Athaqafia', aliases: ['athaqafia', 'arrabiaa'] }
        ],
        DZ: [
            { key: 'eptv', rank: 1, name: 'EPTV', aliases: ['programme national', 'eptv', 'algerie 1'] },
            { key: 'canalalgerie', rank: 2, name: 'Canal Algérie', aliases: ['canal algerie'] },
            { key: 'a3dz', rank: 3, name: 'A3', aliases: ['a3', 'algerie 3'] },
            { key: 'elbahia', rank: 4, name: 'El Bahia TV', aliases: ['el bahia', 'bahia tv'] },
            { key: 'echorouk', rank: 5, name: 'Echorouk TV', aliases: ['echorouk tv', 'echorouk', 'chorouk'] },
            { key: 'ennahar', rank: 6, name: 'Ennahar TV', aliases: ['ennahar tv', 'ennahar', 'nahar'] },
            { key: 'eldjazairia', rank: 7, name: 'El Djazairia', aliases: ['el djazairia', 'djazairia'] },
            { key: 'numidianews', rank: 8, name: 'Numidia News', aliases: ['numidia news', 'numidia'] }
        ],
        TN: [
            { key: 'watania1', rank: 1, name: 'El Watania 1', aliases: ['el watania 1', 'watania 1', 'tunisie 1'] },
            { key: 'watania2', rank: 2, name: 'El Watania 2', aliases: ['el watania 2', 'watania 2', 'tunisie 2'] },
            { key: 'hannibal', rank: 3, name: 'Hannibal TV', aliases: ['hannibal tv', 'hannibal'] },
            { key: 'nessma', rank: 4, name: 'Nessma', aliases: ['nessma', 'nessma tv'] },
            { key: 'elhiwar', rank: 5, name: 'El Hiwar El Tounsi', aliases: ['el hiwar el tounsi', 'elhiwar', 'hiwar tounsi'] },
            { key: 'attessia', rank: 6, name: 'Attessia', aliases: ['attessia', 'attessia tv'] },
            { key: 'telvza', rank: 7, name: 'Telvza TV', aliases: ['telvza', 'telvza tv'] }
        ],
        EG: [
            { key: 'aloulaeg', rank: 1, name: 'Al Oula', aliases: ['al oula', 'channel 1', 'egypt 1', 'masr 1'] },
            { key: 'althania', rank: 2, name: 'Al Thania', aliases: ['al thania', 'channel 2', 'egypt 2'] },
            { key: 'cbceg', rank: 3, name: 'CBC', aliases: ['cbc', 'cbc egypt'] },
            { key: 'mbcmasr', rank: 4, name: 'MBC Masr', aliases: ['mbc masr', 'mbc egypt'] },
            { key: 'dmc', rank: 5, name: 'DMC', aliases: ['dmc'] },
            { key: 'alnahareg', rank: 6, name: 'Al Nahar', aliases: ['al nahar', 'alnahar', 'nahar'] },
            { key: 'alhayah', rank: 7, name: 'Al Hayah', aliases: ['al hayah', 'al hayat', 'alhayah'] },
            { key: 'sadaelbalad', rank: 8, name: 'Sada El Balad', aliases: ['sada el balad', 'sada elbalad'] },
            { key: 'ontve', rank: 9, name: 'ON', aliases: ['on e', 'ontv', 'on tv'] }
        ],
        SA: [
            { key: 'alsaudiya', rank: 1, name: 'Al Saudiya', aliases: ['al saudiya', 'saudi tv', 'saudi 1', 'ksa 1'] },
            { key: 'alekhbariya', rank: 2, name: 'Al Ekhbariya', aliases: ['al ekhbariya', 'alekhbariya', 'ekhbariya'] },
            { key: 'ssc1', rank: 3, name: 'SSC 1', aliases: ['ssc 1', 'ssc1', 'saudi sports'] },
            { key: 'mbc1sa', rank: 4, name: 'MBC 1', aliases: ['mbc 1', 'mbc1'] },
            { key: 'rotanakhalijia', rank: 5, name: 'Rotana Khalijia', aliases: ['rotana khalijia'] },
            { key: 'alriyadiah', rank: 6, name: 'Al Riyadiah', aliases: ['al riyadiah', 'riyadiah'] }
        ],
        AE: [
            { key: 'dubaitv', rank: 1, name: 'Dubai TV', aliases: ['dubai tv', 'dubai'] },
            { key: 'abudhabitv', rank: 2, name: 'Abu Dhabi TV', aliases: ['abu dhabi tv', 'abu dhabi'] },
            { key: 'dubaione', rank: 3, name: 'Dubai One', aliases: ['dubai one'] },
            { key: 'mbc1ae', rank: 4, name: 'MBC 1', aliases: ['mbc 1', 'mbc1'] },
            { key: 'mbc2ae', rank: 5, name: 'MBC 2', aliases: ['mbc 2', 'mbc2'] },
            { key: 'mbc4ae', rank: 6, name: 'MBC 4', aliases: ['mbc 4', 'mbc4'] },
            { key: 'mbcaction', rank: 7, name: 'MBC Action', aliases: ['mbc action'] },
            { key: 'samadubai', rank: 8, name: 'Sama Dubai', aliases: ['sama dubai'] },
            { key: 'sharjahtv', rank: 9, name: 'Sharjah TV', aliases: ['sharjah tv', 'sharjah'] }
        ]
    };

    const QUALITY_TOKENS = { '4k': '4K', 'uhd': '4K', 'hdr': 'HDR', 'fhd': 'FHD', 'superhd': 'Super HD', 'hd': 'HD', 'sd': 'SD' };
    const CODEC_TOKENS = new Set(['h265', 'hevc', 'h264', 'avc']);
    // Country prefixes that mark a *foreign* feed (not the user's national channel).
    const FOREIGN_PREFIXES = new Set(['ar', 'br', 'ca', 'de', 'it', 'pl', 'es', 'us', 'uk', 'nl', 'be', 'ch', 'pt', 'ro', 'tr', 'ru', 'gr', 'dz', 'ma', 'tn', 'sa', 'ae', 'qa', 'al', 'rs', 'bg', 'hu', 'cz', 'in', 'pk']);

    /** Decode circled / styled unicode letters to plain ASCII, then strip diacritics. */
    function destyle(s) {
        let out = '';
        for (const ch of String(s || '')) {
            const c = ch.codePointAt(0);
            if (c >= 0x24B6 && c <= 0x24CF) out += String.fromCharCode(65 + (c - 0x24B6));        // Ⓐ–Ⓩ
            else if (c >= 0x24D0 && c <= 0x24E9) out += String.fromCharCode(97 + (c - 0x24D0));   // ⓐ–ⓩ
            else if (c >= 0x1D400 && c <= 0x1D419) out += String.fromCharCode(65 + (c - 0x1D400)); // bold A–Z
            else if (c >= 0x1D41A && c <= 0x1D433) out += String.fromCharCode(97 + (c - 0x1D41A)); // bold a–z
            else out += ch;
        }
        return out.normalize('NFKD').replace(/[̀-ͯ]/g, '');
    }

    /**
     * Parse a raw channel name into its canonical core + quality/codec/country signals.
     * @returns {{coreStr:string, quals:string[], codec:boolean, foreign:string|null}}
     */
    function parseName(raw) {
        let work = destyle(raw).toLowerCase();
        let prefix = '';
        const pm = work.match(/^([a-z0-9 \-]+?)\s*\|\s*/);
        if (pm) { prefix = pm[1].trim(); work = work.slice(pm[0].length); }
        // Detect the codec BEFORE stripping brackets — providers tag it as
        // "[H265]", and stripping first would lose the signal (collapsing an
        // H265 feed and an H264 feed into one deduped label).
        const codecHint = /\b(h265|hevc)\b/.test(work) || /\b(h265|hevc)\b/.test(prefix);
        work = work.replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ');

        const quals = [];
        let codec = codecHint, foreign = null;
        prefix.split(/[^a-z0-9]+/).filter(Boolean).forEach(t => {
            if (QUALITY_TOKENS[t]) quals.push(QUALITY_TOKENS[t]);
            else if (t === 'fr' || t === 'kids') { /* fr / kids-fr → keep */ }
            else if (FOREIGN_PREFIXES.has(t)) foreign = t;
        });

        const core = [];
        work.replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean).forEach(t => {
            if (QUALITY_TOKENS[t]) quals.push(QUALITY_TOKENS[t]);
            else if (CODEC_TOKENS.has(t)) codec = (t === 'h265' || t === 'hevc') || codec;
            else core.push(t);
        });
        return { coreStr: core.join(' '), quals, codec, foreign };
    }

    function qualityLabel(p) {
        let base = 'HD';
        if (p.quals.includes('4K')) base = '4K';
        else if (p.quals.includes('FHD')) base = 'FHD';
        else if (p.quals.includes('Super HD')) base = 'Super HD';
        else if (p.quals.includes('HD')) base = 'HD';
        else if (p.quals.includes('SD')) base = 'SD';
        if (p.quals.includes('HDR')) base += ' HDR';
        if (p.codec) base += ' · H265';
        return base;
    }

    // Lower rank = higher quality. Used for ordering + default pick.
    function rankOf(label) {
        if (label.startsWith('4K')) return 0;
        if (label.startsWith('Super HD') || label.startsWith('FHD')) return 1;
        if (label.startsWith('HD')) return 2;
        if (label.startsWith('SD')) return 3;
        return 2;
    }

    function buildAliasMap(country) {
        const lineup = COUNTRY_LINEUPS[country] || [];
        const map = {};
        lineup.forEach(d => d.aliases.forEach(a => { map[a] = d; }));
        return { lineup, map };
    }

    function healthRank(ch) {
        const m = (ch.playbackMode || ch.playback_mode || 'unknown');
        if (m === 'broken' || m === 'hs') return 3;
        if (m === 'directHls' || m === 'transcoding' || m === 'ok') return 0;
        return 1; // unknown
    }

    /**
     * Default-pick preference (lower = preferred as the auto-start variant).
     * HD is the safe default the list advertises: lightest, fastest to start,
     * most reliable. FHD/Super HD come next, then SD; 4K is never auto-started.
     * H.265 feeds are slightly deprioritised because they need a full transcode
     * (slower start) where H.264 can be remux-copied.
     */
    function defaultPref(v) {
        const label = String(v.label || '');
        let base;
        if (label.startsWith('HD')) base = 0;
        else if (label.startsWith('FHD') || label.startsWith('Super HD')) base = 1;
        else if (label.startsWith('SD')) base = 2;
        else if (label.startsWith('4K')) base = 4;
        else base = 1;
        if (/h265|hevc/i.test(label)) base += 0.5;
        return base;
    }

    /**
     * Pick the default variant: the HD feed when available (what the list shows
     * by default), preferring healthy ones, then FHD/SD, never auto-opening 4K.
     * Falls back to the best available.
     */
    function pickDefault(variants) {
        const ok = variants.filter(v => v.healthRank < 3);
        const pool = (ok.length ? ok : variants).slice();
        pool.sort((a, b) => (a.healthRank - b.healthRank) || (defaultPref(a) - defaultPref(b)) || (a.rank - b.rank));
        return pool[0] || variants[0] || null;
    }

    /**
     * Build the ordered list of variants for the next-best fallback chain,
     * starting after `current` - HD first, matching the default-pick order so
     * the HD feed is always tried first.
     */
    function fallbackOrder(variants, currentStreamId) {
        return variants
            .filter(v => String(v.streamId) !== String(currentStreamId))
            .sort((a, b) => (a.healthRank - b.healthRank) || (defaultPref(a) - defaultPref(b)) || (a.rank - b.rank));
    }

    function variantFrom(ch, p) {
        const label = qualityLabel(p);
        return {
            label,
            rank: rankOf(label),
            healthRank: healthRank(ch),
            streamId: ch.streamId != null ? ch.streamId : (ch.stream_id != null ? ch.stream_id : ch.id),
            sourceId: ch.sourceId || ch.source_id,
            raw: ch.name || ch.title || '',
            channel: ch
        };
    }

    function dedupeVariants(variants) {
        const seen = new Set(); const out = [];
        for (const v of variants.slice().sort((a, b) => a.rank - b.rank)) {
            if (seen.has(v.label)) continue;
            seen.add(v.label); out.push(v);
        }
        return out;
    }

    /**
     * Classify a non-national FR-ish name into a regional destination
     * (own content) vs. a multiplex/overflow feed (ephemeral).
     */
    function classifyExtra(coreStr) {
        if (/\b(corse|via stella|noa|alsace|bretagne|paris ile|cote d azur|aquitaine|occitanie|nord|grand est|africa|afrique)\b/.test(coreStr)) return 'regional';
        if (/\b(live|event|foot|sport|multiplex|hd \d+|\d+)$/.test(coreStr) || /\blive\b/.test(coreStr)) return 'multiplex';
        return 'regional';
    }

    /**
     * Group a flat channel list into logical channels for a country.
     * @returns {{primary:Object[], regional:Object[], multiplex:Object[], other:Object[]}}
     *   primary  – national channels, ordered by lcn, each {key,name,lcn,variants[],defaultVariant}
     *   regional – sub-channels with own content (own logical entries)
     *   multiplex– overflow/event feeds (collapsed by default)
     *   other    – everything else, untouched (kept for the rest of the list)
     */
    // Provider prefix(es) that count as "native" for a region — usually just the
    // lowercased region code, but some markets are prefixed with a different tag than
    // their ISO code (UK feeds carry "UK |", not "GB |"). Without this, "UK | BBC One"
    // would be flagged foreign for a GB user and dropped from the national lineup.
    const NATIVE_PREFIXES = {
        GB: ['gb', 'uk']
    };

    function nativePrefixesFor(country) {
        const code = String(country || 'FR').toUpperCase();
        return NATIVE_PREFIXES[code] || [code.toLowerCase()];
    }

    // A "XX |" prefix only marks a foreign feed when it differs from the user's
    // own country (for a US user, "US | ESPN" is a national channel, not foreign).
    function isForeignTo(p, country) {
        return !!p.foreign && !nativePrefixesFor(country).includes(p.foreign);
    }

    function group(channels, country) {
        const { lineup, map } = buildAliasMap(country);
        const groups = {};       // key -> logical channel
        const regional = [];
        const multiplex = [];
        const other = [];

        for (const ch of (channels || [])) {
            const name = ch.name || ch.title || '';
            const p = parseName(name);
            if (isForeignTo(p, country)) { other.push(ch); continue; }
            const d = map[p.coreStr];
            if (d) {
                if (!groups[d.key]) groups[d.key] = { key: d.key, name: d.name, lcn: d.lcn ?? d.rank, country, logo: d.logo || null, variants: [] };
                groups[d.key].variants.push(variantFrom(ch, p));
                continue;
            }
            // not an exact national match — is it a sub-channel of a known one?
            let parent = null;
            for (const d2 of lineup) {
                if (d2.aliases.some(a => p.coreStr.startsWith(a + ' '))) { parent = d2; break; }
            }
            if (parent) {
                const kind = classifyExtra(p.coreStr);
                const entry = { name: name.replace(/^[^|]*\|\s*/, '').trim() || name, parentKey: parent.key, parentName: parent.name, country, variants: [variantFrom(ch, p)], channel: ch };
                (kind === 'multiplex' ? multiplex : regional).push(entry);
            } else {
                other.push(ch);
            }
        }

        const primary = Object.values(groups)
            .map(g => {
                g.variants = dedupeVariants(g.variants);
                g.defaultVariant = pickDefault(g.variants);
                return g;
            })
            .sort((a, b) => a.lcn - b.lcn);

        return { primary, regional, multiplex, other };
    }

    /**
     * Find every variant of the logical channel that `channel` belongs to,
     * searching the full catalog. Used by the player to build its quality menu
     * without requiring the whole list to be pre-grouped.
     * @returns {{name:string, variants:Object[], defaultVariant:Object}|null}
     */
    function variantsForChannel(channel, allChannels, country) {
        const { map } = buildAliasMap(country);
        const p = parseName(channel.name || channel.title || '');
        const d = !isForeignTo(p, country) ? map[p.coreStr] : null;
        const sameSource = (c) => (c.sourceId || c.source_id) === (channel.sourceId || channel.source_id);

        let variants;
        if (d) {
            variants = (allChannels || []).filter(c => {
                if (!sameSource(c)) return false;
                const pp = parseName(c.name || c.title || '');
                return !isForeignTo(pp, country) && map[pp.coreStr] === d;
            }).map(c => variantFrom(c, parseName(c.name || c.title || '')));
        } else {
            // Unknown channel: group purely by canonical core (generic dedupe).
            variants = (allChannels || []).filter(c => {
                if (!sameSource(c)) return false;
                const pp = parseName(c.name || c.title || '');
                return !isForeignTo(pp, country) && pp.coreStr === p.coreStr;
            }).map(c => variantFrom(c, parseName(c.name || c.title || '')));
        }

        variants = dedupeVariants(variants);
        if (!variants.length) return null;
        return {
            name: d ? d.name : (channel.name || channel.title || '').replace(/^[^|]*\|\s*/, '').trim(),
            logo: d ? (d.logo || null) : null,
            variants,
            defaultVariant: pickDefault(variants)
        };
    }

    /**
     * Curated real logo for a raw or canonical channel name, or null if the
     * channel isn't a known national channel for the country.
     */
    function logoForName(name, country) {
        const { map } = buildAliasMap(country);
        const p = parseName(name);
        if (isForeignTo(p, country)) return null;
        const d = map[p.coreStr];
        return (d && d.logo) || null;
    }

    window.ChannelGrouping = {
        COUNTRY_LINEUPS,
        destyle,
        parseName,
        qualityLabel,
        group,
        variantsForChannel,
        logoForName,
        pickDefault,
        fallbackOrder
    };
})();
