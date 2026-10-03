'use strict';
const pairs=[
 ['BR','[BR] FILMES','pt'],['BR','BR - MOVIES','pt'],['HU','VOD - HUNGARIA [HU]','hu'],
 ['IS','ÍSLANDS MOVIES','is'],['IS','VIAPLAY ÍSLANDS KVIKMYNDIR','is'],['QC','QC - FILMS VIEILLE','fr'],
 ['IR','[IR] IRANIAN MOVIES','fa'],['IL','IL - FREE TV - סרטים','he'],['MY','[MY] MALAYSIA','ms'],
 ['PH','PH - PHILIPPINES FILM','fil'],['CH','[CH] CHINA','zh'],['CN','CN - CHINA FILM','zh'],
 ['SW','[SW] SWEED','sv'],['PB','VOD - INDIA','pa'],['SC','NORDIC FILM NEW RELEASE','nordic']
];
const cases=pairs.flatMap(([tag,category,language])=>[
 [`${tag} - Example`,category,language],
 [`${tag}|Example`,category,language],
 [`${tag} - Example [VOSTFR]`,category,null],
 [`${tag} - Example [MULTI-AUDIO]`,category,null],
 [`${tag} - Example [Japanese]`,category,null],
 [`${tag} - Example`,'PLATFORM MOVIES',null],
]);
// SW is not a general alias; the others with existing aliases retain theirs.
for(const item of cases)if(item[1]==='PLATFORM MOVIES'&&item[0].startsWith('SC'))item[2]=null;
module.exports=[...cases,
 ['4K-IS - Example','ÍSLANDS MOVIES ⁴ᴷ ³⁸⁴⁰ᴾ','is'],
 ['4K-SC - Example','NORDIC KIDS','nordic'],
 ['CH - Example','SWISS MOVIES',null],['CN - Example','NETFLIX ASIA',null],
 ['PH - Example','PH - TAGALOG SUB MOVIES',null],['IR - Example','IR - PERSIAN SUB/DUB','fa'],
 ['HU - Example','VOD - HUNGARIA [HU] SUBS',null],
 ['BRavo - Example','[BR] FILMES',null],['BR Example','[BR] FILMES',null],
 ['MA - Phantom','VOD - INDIA',null],['KD - Fittrat','VOD - INDIA',null],
 ['AF - Example','VOD - AFRICAN [AF]',null],['AS - Example','ASIA MOVIES (MULTI-SUBS)',null],
 ['IN - Example','VOD - INDIA',null],['STH - Example','VOD - INDIA',null],
 ['BL| Example','[IN] BOLLYWOOD',null],
 ['IN|TELUGU|Example [MULTI-AUDIO]','[IN] TELUGU','te'],
 ['INI|TELUGU|Example [MULTI-AUDIO]','[IN] TELUGU','te'],
 ['IN|KANNADA|Example [MULTI-AUDIO]','[IN] KANADA','kn'],
 ['IN|Example [MULTI-AUDIO]','[IN] GUJARTI','gu'],
 ['IN|Example [MULTI-AUDIO]','[IN] TAMIL','ta'],
 ['IN|Example [MULTI-AUDIO]','[IN] MALAYALAM','ml'],
 ['IN|Example [MULTI-AUDIO]','[IN] SOUTH INDIA',null],
 ['IN|Example [MULTI-SUB]','[IN] TAMIL',null],
 ['IN|Example [English] [MULTI-AUDIO]','[IN] TAMIL',null],
 ['IN|TELUGU|Example [MULTI-AUDIO]','[IN] TAMIL',null],
 ['IN|ENGLISH|Example [MULTI-AUDIO]','[IN] TAMIL',null],
 ['IN|EN|Example [MULTI-AUDIO]','[IN] TAMIL',null],
 ['IN|Example [SUB] [MULTI-AUDIO]','[IN] TAMIL',null],
 ['IN|Example (English) [MULTI-AUDIO]','[IN] TAMIL',null],
 ['IN|Example (2020) [MULTI-AUDIO]','[IN] TAMIL','ta'],
 ['EN|Example [MULTI-AUDIO]','[IN] TAMIL',null]
];
