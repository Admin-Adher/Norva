'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const relay = fs.readFileSync(path.join(root, 'services/norva-relay/src/index.js'), 'utf8');
const edge = fs.readFileSync(path.join(root, 'supabase/functions/norva-playback/index.ts'), 'utf8');
const normalization = relay.slice(relay.indexOf('function normalizeRelayLang('), relay.indexOf('function parseTotalFromContentRange('));
assert.ok(normalization.startsWith('function normalizeRelayLang('));
const context = {};
vm.runInNewContext(normalization, context);
const normalize = context.normalizeRelayLang;

test('synthetic Matroska headers retain explicit ISO-639-2 audio and subtitle tags end to end', () => {
  const parserContext = {};
  vm.runInNewContext(relay.slice(relay.indexOf('function readVint('), relay.indexOf('function parseTotalFromContentRange(')), parserContext);
  const element = (id, payload) => {
    const bytes = Buffer.from(payload);
    assert.ok(bytes.length < 127, 'bounded fixture element');
    return Buffer.concat([Buffer.from(id), Buffer.from([0x80 | bytes.length]), bytes]);
  };
  const entry = (type, language) => element([0xae], Buffer.concat([
    element([0x83], [type]),
    ...(language ? [element([0x22, 0xb5, 0x9c], Buffer.from(language))] : []),
  ]));
  const bytes = element([0x18, 0x53, 0x80, 0x67], element([0x16, 0x54, 0xae, 0x6b], Buffer.concat([
    entry(1), entry(2, 'fil'), entry(17, 'tgl'), entry(2, 'fas'), entry(2, 'tam'), entry(2, 'und'),
  ])));
  const parsed = parserContext.parseMkvTracks(bytes, bytes.length);
  assert.deepEqual(JSON.parse(JSON.stringify(parserContext.normalizeRelayTracks(parsed.audioTracks))), [
    { index: 1, lang: 'tl' }, { index: 3, lang: 'fa' }, { index: 4, lang: 'ta' }, { index: 5, lang: null },
  ]);
  assert.equal(parsed.subtitleTracks[0].index, 2);
  assert.equal(parserContext.normalizeRelayLang(parsed.subtitleTracks[0].lang), 'tl');
});

test('relay preserves all ISO-639-2 stream aliases accepted by the Edge consumer', () => {
  const edgeNormalizer = edge.slice(edge.indexOf('function normalizeIsoLang('), edge.indexOf('type BasicLidEvidence ='));
  const aliases = [...edgeNormalizer.matchAll(/\b([a-z]{3}): "([a-z]{2})"/g)];
  assert.ok(aliases.length > 70, 'extract the complete Edge ISO-639-2 map');
  for (const [, source, expected] of aliases) {
    assert.equal(normalize(source), expected, source);
    assert.equal(normalize(` ${source.toUpperCase()}-Latn `), expected, `${source} BCP47`);
  }
});

test('Filipino, Persian and Indian-language tags survive ordered relay track normalization', () => {
  const tracks = [
    { index: 2, lang: 'fil' }, { index: 5, lang: 'tgl' },
    { index: 9, lang: 'per' }, { index: 10, lang: 'fas' },
    { index: 12, lang: 'tam' }, { index: 13, lang: 'tel' },
    { index: 15, lang: 'mal' }, { index: 17, lang: 'kan' },
    { index: 18, lang: 'und' }, { index: 19, lang: null },
  ];
  const before = JSON.stringify(tracks);
  assert.deepEqual(JSON.parse(JSON.stringify(context.normalizeRelayTracks(tracks))), [
    { index: 2, lang: 'tl' }, { index: 5, lang: 'tl' },
    { index: 9, lang: 'fa' }, { index: 10, lang: 'fa' },
    { index: 12, lang: 'ta' }, { index: 13, lang: 'te' },
    { index: 15, lang: 'ml' }, { index: 17, lang: 'kn' },
    { index: 18, lang: null }, { index: 19, lang: null },
  ]);
  assert.equal(JSON.stringify(tracks), before, 'do not mutate input track coordinates');
});

test('normalization neither truncates prose into language tags nor adds provider-country aliases', () => {
  for (const value of ['', null, 'un', 'und', 'mis', 'mul', 'zxx', 'nar', 'english', 'filipino', 'farsi', 'NETFLIX MOVIES']) {
    assert.equal(normalize(value), null, String(value));
  }
  // Preserve existing two-letter stream handling. No IN->hi, IR->fa,
  // PH->tl or LA->es provider-country shortcuts belong in this parser.
  for (const value of ['IN', 'IR', 'PH', 'LA']) {
    assert.equal(normalize(value), value.toLowerCase());
  }
  assert.equal(normalize('fr-FR'), 'fr');
  assert.equal(normalize('pt_BR'), 'pt');
  assert.deepEqual(JSON.parse(JSON.stringify(context.normalizeRelayLangs(['fil', 'tgl', 'tl', 'und']))), ['tl']);
});
