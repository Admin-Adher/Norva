'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const root = path.join(__dirname, '..');

// Raw labels from the individual 2026-09-13 audit, plus counterexamples that
// prevent title prose, country bundles and subtitle tags becoming audio claims.
const cases = [
    ['DK ▎ Busters Verden', 'SCANDINAVIA', 'da'],
    ['SE ▎ Example', 'SCANDINAVIA', 'sv'],
    ['NO ▎ Example', 'SCANDINAVIA', 'no'],
    ['Example [DK]', 'Nordic', 'da'],
    ['Example', 'Nordic | Swedish', 'sv'],
    ['SW ▎ Example', 'SCANDINAVIA', 'nordic'],
    ['RO ▎ Example', 'SCANDINAVIA', null],
    ['TH ▎ Example', 'SCANDINAVIA', null],
    ['DK ▎ Example', 'Nordic / Swedish', null],
    ['DK ▎ Example [NO]', 'SCANDINAVIA', null],
    ['DK ▎ Example', 'Nordic / Hindi', null],
    ['SE ▎ Robots - SUB', 'SCANDINAVIA', null],
    ['SW ▎ Example - SUB', 'SCANDINAVIA', null],
    ['DK-SUBS ▎ Example', 'SCANDINAVIA', null],
    ['DK ▎ Example', 'Danish Subtitles', null],
    ['SW ▎ Dual', 'SCANDINAVIA', 'nordic'],
    ['IT ▎ Dual', 'IT ▎HBO', 'it'],
    ['EN ▎ Dutch', 'EN ▎HBO', 'en'],
    ['EXYU ▎ Dutch', 'EXYU', null],
    ['DE ▎ Zulu', 'DE ▎PRIME VIDEO', 'de'],
    ['EN ▎ Zulu', 'EN ▎HBO', 'en'],
    ['FR ▎ South Park (NE CONVIENT PAS AUX ENFANTS)', 'FR ▎KIDS', 'fr'],
    ['EN ▎ Example (The English Patient)', 'EN ▎HBO', 'en'],
    ['Example (NE CONVIENT PAS AUX ENFANTS)', '', null],
    ['Example (The English Patient)', '', null],
    ['Example [NO ADS]', '', null],
    ['Dual', '', null], ['Dutch', '', null], ['Zulu', '', null],
    ['Example - Dual', 'EN', null],
    ['EN ▎ Example [MULTI]', 'EN', null],
    ['EN ▎ Example [FR]', 'EN', null],
    ['Example [NE]', '', 'ne'],
    ['Example [English Hindi Dubbed]', '', 'hi'],
    ['Example [English / Hindi]', '', null],
    ['Example [English Subtitles]', '', null],
    ['Example', 'DK MOVIES', 'da'],
    ['Example', 'SE FILMS', 'sv'],
    ['Example', 'NO SERIES', 'no'],
    ['Example', 'NO ADS', null],
    ['Example', 'NO MOVIES AVAILABLE', null],
    ['Example', 'FILMES DE AÇÃO', null],
    ['Example', 'SHOW EN MOVIES', null],
    ['DK MOVIES', '', null],
    ['KU ▎ San Andreas', 'IRAN', 'ku'],
    ['MT ▎ Luzzu', 'MALTA', 'mt'],
    ['Example [KU]', '', 'ku'],
    ['Example [MT]', '', 'mt'],
    ['Example', 'Kurdish', 'ku'],
    ['Example', 'Maltese', 'mt'],
    ['Example', 'IRAN', null],
    ['Example', 'MALTA', null],
    ['IR ▎ House of Paper', 'IRAN', null],
    ['AF ▎ Example', 'AFRICAN MOVIES', null],
    ['PK ▎ Example', 'PAKISTAN', null],
    ['EXYU ▎ Example', 'EXYU', null],
    ['KU SUBS ▎ Example', 'KURDISH SUBTITLES', null],
    ['MT ▎ Example', 'EN', null],
    ['KU KU', '', null], ['Mt - Example', '', null],
    ['Example [MT EVEREST]', '', null],
    ['Example', 'A TRIP TO MT EVEREST', null],
    // Regional/category qualifiers do not erase a bounded supplier language.
    ['AR-IN-S - Hidimbha (2023)', 'أفلام هندية 2023', 'ar'],
    ['AR-XMAS - The Christmas Chronicles (2018)', '', 'ar'],
    ['AR-SHAM - عيلة 6 نجوم', '', 'ar'],
    ['AR-POD - Example', '', 'ar'],
    ['AR-EG - الاسطورة', '', 'ar'],
    ['AR-CH - القديس يوحنا ذهبي الفم', '', 'ar'],
    ['AR-AS - No Tears for the Dead (2014)', '', 'ar'],
    ['AR-KH - باي باي عرب', '', 'ar'],
    ['AR-DOC-D - Bye Bye Tiberias (2024)', '', 'ar'],
    ['AR-DOC-S - In the Eye of the Storm: Chasers (2026) (US)', '', 'ar'],
    ['AR-MA - كاينة ضروف', '', 'ar'],
    ['AF-EN - Emem', 'AF - IROKO TV', 'en'],
    ['AF-FR - MIEL AMER', 'AFRICA CINAF TV SERIES', 'fr'],
    ['AR-IN-S ▎ Example', '', 'ar'],
    ['AR-EG | Example', '', 'ar'],
    ['AR-DOC-D : Example', '', 'ar'],
    ['AF-EN — Example', '', 'en'],
    ['AF-FR – Example', '', 'fr'],
    ['AR-EG - Dual', '', 'ar'],
    ['AF-EN - Dutch', '', 'en'],
    ['AR-DOC-D - Zulu', '', 'ar'],
    ['AR-EG - Example (NE CONVIENT PAS AUX ENFANTS)', '', 'ar'],
    ['AR-EG - Example [FR]', '', null],
    ['AR-EN - Example', '', null],
    ['AF-FR - Example', 'EN', null],
    ['AR-SUBS - Example', '', null],
    ['AR-EG-SUBS - Example', '', null],
    ['AR-EG - Example - SUB', '', null],
    ['AF-EN - Example [MULTI]', '', null],
    ['AR-IN-S - Example', 'English Subtitles', null],
    ['[NE CONVIENT PAS AUX ENFANTS] Example', '', null],
    ['(The English Patient) Example', '', null],
    ['[NO ADS] Example', '', null],
    ['[MT EVEREST] Example', '', null],
    ['AR-IN-S Hidimbha (2023)', '', null],
    ['Ar-Eg - Example', '', null],
    ['AF - Example', '', null],
    ['IR-EG - Example', '', null],
    ['PK-DOC - Example', '', null],
    ['EXYU-DOC - Example', '', null],
    ['Game of Death II', '', null],
    ['Kisi Ka Bhai Kisi Ki Jaan', '', null],
    ['Satyaprem Ki Katha', '', null],
    ['Band on the Run', '', null],
    ['Cha Cha Real Smooth', '', null],
    ['Bring Her Back', '', null],
    ['Stranger in a Cab', '', null],
    ['VP-NL - Example', '', 'nl'],
    ['4K-ES-HDR - Example', '', 'es'],
    ['4K-DE-DV - Example', '', 'de'],
    ['4K-AR-DO - Example', '', 'ar'],
    ['DE-JO - Example', '', 'de'],
    ['AR-DSC+S - Example', '', 'ar'],
    ['AR-KIDS - Example', '', 'ar'],
    ['ES-DO - Example', '', 'es'],
    ['NF - Dutch', 'NETFLIX MOVIES', null],
    ['THE-ENGLISH-PATIENT: Behind the scenes', '', null],
    ['IT-WAS-JUST-AN-ACCIDENT: Commentary', '', null],
    ['NO-COUNTRY-FOR-OLD-MEN: Making of', '', null],
    ['Example [Japanese-Language Version]', '', 'ja'],
    ['Example [English-Language Version]', '', 'en'],
    ['Example [French Language Version]', '', 'fr'],
    ['Example [The Japanese-Language Version]', '', null],
    ['Example [Japanese-Language Version Extras]', '', null],
    ['[AR-IN-S] Example', '', null],
    ['Example [AR-XMAS]', '', null],
    ['AR-AS  Castaway on the Moon (2009)', 'أفلام أسيوية قديمه', 'ar'],
    ['AR-AS\t\tCastaway on the Moon (2009)', '', 'ar'],
    ['AR-AS \tCastaway on the Moon (2009)', '', 'ar'],
    ['AR-IN-S  Hidimbha (2023)', '', 'ar'],
    ['4K-ES-HDR  Example', '', 'es'],
    ['AF-EN  Example', '', 'en'],
    ['AR-EN  Example', '', null],
    ['AR-SUBS  Example', '', null],
    ['AR-AS  Example (NE CONVIENT PAS AUX ENFANTS)', '', 'ar'],
    ['AR-AS  Example [FR]', '', null],
    ['NO  TITLE', '', null],
    ['EN  TITLE', '', null],
    ['NO\t\tTITLE', '', null],
    ['AR-AS Example', '', null],
    ['AR-AS\tExample', '', null],
    ['THE-ENGLISH-PATIENT  Behind the scenes', '', null],
    ['IT-WAS-JUST-AN-ACCIDENT  Commentary', '', null],
    ['NO-COUNTRY-FOR-OLD-MEN  Making of', '', null],
    ['[AR-AS]  Example', '', null],
    ['Example AR-AS  Extra', '', null],
];
module.exports = { cases };

function browser() {
    const ctx = { window: {}, Intl, console };
    vm.runInNewContext(fs.readFileSync(path.join(root, 'public/js/utils/mediaUtils.js'), 'utf8'), ctx);
    return ctx.window.MediaUtils;
}
const make = (raw_title, categoryName) => ({ item_type: 'movie', raw_title,
    metadata: { categoryName }, audio_language_validation_status: 'not_analyzed' });

test('audited provider annotations agree in browser, catalogue and exact-variant filters', async () => {
    const { providerCatalogLanguage } = await import(pathToFileURL(path.join(root, 'supabase/functions/_shared/provider-catalog-language.mjs')));
    const { catalogProviderAudioLanguages, catalogVariantMatchesAudio } = await import(pathToFileURL(path.join(root, 'supabase/functions/_shared/selection-provider-languages.mjs')));
    const M = browser();
    for (const [raw, category, expected] of cases) {
        const item = make(raw, category), context = `${raw} / ${category}`;
        assert.equal(providerCatalogLanguage(item), expected, context);
        assert.deepEqual(catalogProviderAudioLanguages(item), expected ? [expected] : [], context);
        const result = M.versionDescriptor(item, { providerLanguageHints: true });
        assert.equal(result.headline, expected === 'nordic' ? 'Nordic languages'
            : expected ? M.languageDisplayFull(expected) : 'Language unidentified', context);
        assert.equal(result.audioSource === 'provider-label', Boolean(expected), context);
        assert.equal(catalogVariantMatchesAudio(item, 'unidentified'), !expected, context);
    }
});

test('new hints remain internal declarations and never override exact file audio or scoring', async () => {
    const { catalogVariantMatchesAudio } = await import(pathToFileURL(path.join(root, 'supabase/functions/_shared/selection-provider-languages.mjs')));
    const M = browser();
    for (const [raw, category, tag] of cases.filter(row => row[2])) {
        const item = make(raw, category), before = JSON.stringify(item);
        const scoring = JSON.stringify(M.analyzeLanguageCompatibility(item, { preferredAudioLanguage: tag }));
        const result = M.versionDescriptor(item, { providerLanguageHints: true });
        assert.equal(M.versionDescriptor(item).headline, 'Language unidentified');
        assert.equal(M.versionLanguageBadge(item), 'Language unidentified');
        assert.equal(M.providerAudioLanguages(item).length, 0);
        assert.equal(JSON.stringify(item), before);
        assert.equal(JSON.stringify(M.analyzeLanguageCompatibility(item, { preferredAudioLanguage: tag })), scoring);
        assert.equal(result.languageStatus, 'Provider · Unverified');
        assert.doesNotMatch([result.headline, result.accessibleHeadline, result.meta,
            M.languageBadgeHtml(M.catalogLanguageInfo(item), 'test')].join(' '), /Provider label|Unverified|to confirm/);
        const observedLanguage = tag === 'ja' ? 'en' : 'ja';
        const observed = { ...item, audio_language_validation_status: 'verified', audio_tracks_scope: 'file',
            audio_tracks: [{ index: 1, lang: observedLanguage }], __file_audio_observed: true, __file_audio_languages: [observedLanguage] };
        assert.equal(M.versionDescriptor(observed, { providerLanguageHints: true }).headline, M.languageDisplayFull(observedLanguage));
        assert.equal(catalogVariantMatchesAudio(observed, `catalog-${tag}`), false);
        assert.equal(catalogVariantMatchesAudio(observed, `catalog-${observedLanguage}`), true);
    }
});
