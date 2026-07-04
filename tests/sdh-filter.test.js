// SDH (hearing-impaired) annotation stripping — Norva's AI subtitles are dialogue subtitles.
// The SAME logic lives in two places (gateway stripSdhAnnotations + WatchPage._stripSdhAnnotations);
// both are extracted from the real sources and run against the forms observed in production
// (« Bagarre » transcript, 2026-07-04) plus guardrails proving real speech is never harmed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

function extract(source, anchor, endAnchor) {
    const i = source.indexOf(anchor);
    assert.ok(i >= 0, `anchor not found: ${anchor.slice(0, 50)}`);
    const j = source.indexOf(endAnchor, i);
    assert.ok(j > i, `end anchor not found after: ${anchor.slice(0, 50)}`);
    return source.slice(i, j);
}

function gatewayStrip() {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'media-gateway', 'src', 'index.js'), 'utf8');
    const code = extract(src, 'const SDH_BARE_LINE', '\n}\n') + '\n}\nreturn stripSdhAnnotations;';
    return new Function(code)();
}

function playerStrip() {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'pages', 'WatchPage.js'), 'utf8');
    const body = extract(src, '_stripSdhAnnotations(text) {', '\n    }\n');
    const code = 'return function stripSdh(text) {' + body.slice(body.indexOf('{') + 1) + '\n};';
    return new Function(code)();
}

const DROPPED = [
    '*musique du générique*',
    "*musique de l'entraînement*",
    '(musique)',
    '[bruit de porte]',
    '*Musique*',
    '(Rires)',
    '(Bruits de la porte)',
    '[Bruit de crie]',
    '[Cri de joie]',
    "*Musique d'outro*",
    'Musique de générique',
    'Musique',
    'Applaudissements',
    'Rires',
    '♪♪♪',
    '♪ la la la ♪',
    '[music playing]',
    '(laughter)',
];
const KEPT = [
    ['Qu\'est-ce que tu fais là ?', 'Qu\'est-ce que tu fais là ?'],
    ['*Musique* "C\'est un bon moment"', '"C\'est un bon moment"'],       // mixed → speech survives
    ['La musique de ce film est magnifique, tu trouves pas ?', 'La musique de ce film est magnifique, tu trouves pas ?'],
    ['Il a crié toute la nuit.', 'Il a crié toute la nuit.'],
    ['Cristina arrive demain matin', 'Cristina arrive demain matin'],     // "cris…" prefix must not match
    ['Le générique de fin annonce une suite, regarde !', 'Le générique de fin annonce une suite, regarde !'],
];

for (const [name, make] of [['gateway', gatewayStrip], ['player', playerStrip]]) {
    test(`${name}: pure sound annotations are dropped`, () => {
        const strip = make();
        for (const s of DROPPED) assert.strictEqual(strip(s), '', `should drop: ${s}`);
    });
    test(`${name}: real speech survives untouched (mixed cues keep the speech)`, () => {
        const strip = make();
        for (const [input, expected] of KEPT) assert.strictEqual(strip(input), expected, `should keep: ${input}`);
    });
}
