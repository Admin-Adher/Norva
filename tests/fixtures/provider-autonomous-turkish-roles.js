'use strict';
// Full-catalogue audit, not a country/language alias or a file-audio assertion.
const positives = [
    ['Example [Sub]', 'مسلسلات تركية مترجمة عربي | Turkish Series Arabic Sub'],
    ['Example [sub]', 'مسلسلات تركية مترجمة عربي | Turkish Series Arabic Sub'],
    ['Example [sUb]', 'Séries TURQUES SUB-AR'],
    ['AR-TR - Example', 'افلام تركية مترجمة'],
    ['AR-TR-S - Example', 'افلام تركية مترجمة'],
    ['AR-TR-S - Example', 'يعرض الآن تركي مترجم'],
    ['AR-SUBS - Example', 'يعرض الآن تركي مترجم'],
];
const cases = positives.map(([raw, category]) => [raw, category, 'tr']);
for (const [raw, category] of positives) {
    const base = raw.replace(/\s+\[sub\]$/i, '');
    const sub = raw.match(/\s+\[sub\]$/i)?.[0] || '';
    for (const suffix of ['[FR]', '[MULTI]', '[VOSTFR]', '[SUB FR]', 'مترجم']) {
        cases.push([`${base} ${suffix}${sub}`, category, null]);
    }
}
for (const separator of [' - ', ' — ', ' ▎ ', ': ']) {
    cases.push([`AR-TR${separator}Example`, 'افلام تركية مترجمة', 'tr']);
    cases.push([`AR-SUBS${separator}Example`, 'يعرض الآن تركي مترجم', 'tr']);
}
for (const [raw, category] of [
    ['AR-TR-D - Example', 'افلام تركية مترجمة'],
    ['[AR-TR] Example', 'افلام تركية مترجمة'],
    ['AR-TR-SIDE - Example', 'افلام تركية مترجمة'],
    ['AR-SUBS - Example', 'افلام تركية مترجمة'],
    ['AR-TR - Example', 'افلام تركية مترجمة DUB'],
    ['AR-TR-S - Example', 'AR | TURKEY'],
    ['AR-SUBS - Example', 'يعرض الآن أجنبي مترجم'],
    ['AR-SUBS - Example', 'أفلام أجنبية 2026'],
    ['Example [Sub]', 'Séries TURQUES SUB-AR DUB'],
    ['Example [SUBS]', 'Séries TURQUES SUB-AR'],
    ['IN - Example', 'IN - NEW RELEASE'],
    ['PH - Example', 'PH - PHILIPPINES FILM'],
    ['IR - Example', 'IRAN'],
]) cases.push([raw, category, null]);
module.exports = cases;
