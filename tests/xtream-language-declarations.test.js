'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const { transformSync } = require('esbuild');
const ROOT = path.join(__dirname, '..');
const SHARED = path.join(ROOT, 'supabase/functions/_shared');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8').replace(/\r\n/g, '\n');
const helper = import(pathToFileURL(path.join(SHARED, 'xtream-language-declarations.mjs')).href);
const fields = value => Object.fromEntries(value.declarations.map(d => [d.field, { role: d.role, values: d.values }]));

test('explicit audio, subtitle, generic, and original languages retain independent roles', async () => {
  const { xtreamLanguageDeclarations: capture } = await helper;
  const result = capture({ audio_languages: ['EN', 'FR'], subtitle_language: 'NL', language: 'German', original_language: 'ko' });
  assert.deepEqual(result, {
    schemaVersion: 1, providerType: 'xtream', evidence: 'provider_declaration', declarations: [
      { field: 'audio_languages', role: 'audio', values: ['EN', 'FR'] },
      { field: 'subtitle_language', role: 'subtitle', values: ['NL'] },
      { field: 'language', role: 'unspecified', values: ['German'] },
      { field: 'original_language', role: 'original', values: ['ko'] },
    ],
  });
  assert.equal(result.audioLanguages, undefined);
  assert.equal(result.audioObserved, undefined);
  assert.equal(result.verifiedAt, undefined);
});

test('raw spelling, unknown labels, language lists and unicode survive without alias inference', async () => {
  const { xtreamLanguageDeclarations: capture } = await helper;
  assert.deepEqual(fields(capture({ audioLanguage: '  Néerlandais / हिन्दी  ', audio_languages: ['IR', 'NL HINDI', 'und', 'EN', 'EN', 'pt-BR'] })), {
    audioLanguage: { role: 'audio', values: ['Néerlandais / हिन्दी'] },
    audio_languages: { role: 'audio', values: ['IR', 'NL HINDI', 'und', 'EN', 'pt-BR'] },
  });
});

test('only fixed nested info/movie_data fields and track-language fields are preserved', async () => {
  const { xtreamLanguageDeclarations: capture } = await helper;
  const result = capture({
    info: { audio: { codec_name: 'aac', tags: { language: 'eng', title: 'secret title' } }, subtitle_tracks: [{ language: 'spa', url: 'https://private.test/a' }] },
    movie_data: { audio_language: 'fr' },
    metadata: { audio_language: 'do not copy arbitrary envelopes' },
  });
  assert.deepEqual(fields(result), {
    'info.audio.tags.language': { role: 'audio', values: ['eng'] },
    'info.subtitle_tracks[0].language': { role: 'subtitle', values: ['spa'] },
    'movie_data.audio_language': { role: 'audio', values: ['fr'] },
  });
  assert.doesNotMatch(JSON.stringify(result), /secret|private|aac|https/);
});

test('provider track tags with common uppercase language keys retain their original role', async () => {
  const { xtreamLanguageDeclarations: capture } = await helper;
  assert.deepEqual(fields(capture({
    info: {
      audio_tracks: [{ tags: { LANGUAGE: 'eng', title: 'private' } }],
      subtitle_tracks: [{ tags: { LANG: 'fr' } }],
    },
  })), {
    'info.audio_tracks[0].tags.LANGUAGE': { role: 'audio', values: ['eng'] },
    'info.subtitle_tracks[0].tags.LANG': { role: 'subtitle', values: ['fr'] },
  });
});

test('track declarations cannot impersonate observed tracks or import codec/profile objects', async () => {
  const { xtreamLanguageDeclarations: capture } = await helper;
  const result = capture({
    audioTracks: [{ language: 'eng', audioObserved: true, verifiedAt: '2026-01-01', codec_name: 'aac', channels: 2 }],
    codecProfile: { audioTracks: [{ language: 'fr' }], audioObserved: true },
    audio: 'aac', audioObserved: true,
    providerLanguageDeclarations: { evidence: 'verified_audio', declarations: [{ role: 'audio', values: ['fr'] }] },
  });
  assert.deepEqual(fields(result), { 'audioTracks[0].language': { role: 'audio', values: ['eng'] } });
  assert.doesNotMatch(JSON.stringify(result), /verified_audio|audioObserved|verifiedAt|codec|channels/);
});

test('country, market, title, URL and user/account information are never harvested', async () => {
  const { xtreamLanguageDeclarations: capture } = await helper;
  assert.equal(capture({ country: 'Iran', region: 'NL', name: 'Hindi Medium', category_name: 'IRAN', url: 'https://provider.test', username: 'secret', password: 'secret' }), null);
});

test('original-language metadata is retained without becoming audio evidence', async () => {
  const { xtreamLanguageDeclarations: capture } = await helper;
  const result = capture({ original_language: 'en', info: { language: 'tr' } });
  assert(result.declarations.every(d => d.role !== 'audio'));
  assert.deepEqual(result.declarations.map(d => d.role), ['original', 'unspecified']);
});

test('preserved declarations do not silently change the existing language resolver', async () => {
  const { xtreamLanguageDeclarations: capture } = await helper;
  const { providerCatalogLanguage } = await import(pathToFileURL(path.join(SHARED, 'provider-catalog-language.mjs')).href);
  const providerLanguageDeclarations = capture({ audio_languages: ['fr', 'en'], original_language: 'ko' });
  assert.equal(providerCatalogLanguage({ source_id: 'source', raw_title: 'Unlabelled film', metadata: { providerLanguageDeclarations } }), null);
});

for (const [label, value] of [
  ['URL', 'https://user:password@example.test/movie'],
  ['bare host', 'example.com'], ['HTML', '<img src=x>'], ['email', 'user@example.test'],
  ['credential phrase', 'Bearer private-token'], ['control characters', 'en\nfr'],
  ['access token key', 'access_token abcdef'], ['refresh token key', 'refresh-token abcdef'],
  ['camel-case token key', 'accessToken abcdef'], ['client secret key', 'client_secret abcdef'],
  ['camel-case secret key', 'clientSecret abcdef'], ['username key', 'user_name abcdef'],
  ['camel-case username key', 'userName abcdef'], ['API key', 'api_key abcdef'],
  ['full-width credential key', 'ａｃｃｅｓｓ＿ｔｏｋｅｎ abcdef'],
  ['UUID identifier', 'a1234567-89ab-4def-abcd-0123456789ab'],
  ['UUID embedded in list', 'en / a1234567-89ab-4def-abcd-0123456789ab'],
  ['long hex identifier', 'abcdef0123456789abcdef0123456789'],
  ['long hex embedded in list', 'en / abcdef0123456789abcdef0123456789'],
  ['object', { language: 'en' }], ['boolean', true], ['number', 1], ['oversize', 'e'.repeat(81)],
]) {
  test(`rejects malformed ${label} in a language field`, async () => {
    const { xtreamLanguageDeclarations: capture } = await helper;
    assert.equal(capture({ audio_language: value }), null);
  });
}

test('credential rejection does not alter BCP-47 regions or ordinary multilingual labels', async () => {
  const { xtreamLanguageDeclarations: capture } = await helper;
  assert.deepEqual(fields(capture({ audio_languages: ['es-419', 'pt-BR', 'zh-Hant', 'Français / English', 'العربية'] })), {
    audio_languages: { role: 'audio', values: ['es-419', 'pt-BR', 'zh-Hant', 'Français / English', 'العربية'] },
  });
});

test('null, array and unrelated objects are ignored; inherited fields are not trusted', async () => {
  const { xtreamLanguageDeclarations: capture } = await helper;
  for (const input of [null, undefined, [], 'en', 42, {}, Object.create({ audio_language: 'en' })]) assert.equal(capture(input), null);
  const input = JSON.parse('{"__proto__":{"audio_language":"en"},"audio_language":"fr"}');
  assert.deepEqual(fields(capture(input)), { audio_language: { role: 'audio', values: ['fr'] } });
  assert.equal({}.audio_language, undefined);
});

test('field cardinality, track cardinality, byte size and deterministic truncation are bounded', async () => {
  const { xtreamLanguageDeclarations: capture } = await helper;
  const labels = Array.from({ length: 10000 }, (_, i) => `language-${i}`);
  const source = { audio_languages: labels, audioTracks: labels.map(language => ({ language, lang: language, tags: { language } })) };
  const result = capture(source);
  assert.equal(result.truncated, true);
  assert.equal(result.declarations[0].values.length, 8);
  assert(result.declarations.length <= 32);
  assert(result.declarations.every(d => !/\[(?:1[6-9]|[2-9]\d|\d{3,})\]/.test(d.field)));
  assert(Buffer.byteLength(JSON.stringify(result)) <= 8192);
  assert.deepEqual(capture(source), result);
  assert.equal(source.audio_languages.length, 10000);
});

test('utf8 byte bound is applied to multilingual labels, not just JS character count', async () => {
  const { xtreamLanguageDeclarations: capture } = await helper;
  const longLabels = Array.from({ length: 8 }, (_, i) => '界'.repeat(75) + i);
  const input = { audio_languages: longLabels, audioLanguage: longLabels, audioLanguages: longLabels, language: longLabels, info: { audio_languages: longLabels } };
  const result = capture(input);
  assert.equal(result.truncated, true);
  assert(Buffer.byteLength(JSON.stringify(result)) <= 8192);
});

function extract(contents, start, end) {
  const from = contents.indexOf(start), to = contents.indexOf(end, from + start.length);
  assert(from >= 0 && to > from);
  return contents.slice(from, to);
}

async function loadIngestMappers() {
  const { xtreamLanguageDeclarations } = await helper;
  const sync = read('supabase/functions/_shared/xtream-sync.ts');
  const access = read('supabase/functions/norva-provider-access/index.ts');
  const functions = extract(sync, 'function xtreamRows(', '\ntype StagedCatalogItemType')
    + extract(access, 'function activeMediaRows(', '\nfunction activeTitlePayload(');
  const js = transformSync(functions, { loader: 'ts', format: 'cjs', target: 'node20' }).code;
  const compact = value => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null && v !== undefined && v !== ''));
  const nullable = value => typeof value === 'string' && value.trim() ? value.trim() : null;
  return Function('xtreamLanguageDeclarations', 'stringOr', 'stringOrNull', 'nullableString', 'compactRecord', 'compactActiveRecord', 'boundedProviderOverview', 'WorkerFault',
    js + '\nreturn {xtreamRows, activeMediaRows};')(
      xtreamLanguageDeclarations, (v, fallback) => nullable(v) ?? fallback, nullable, nullable, compact, compact,
      (...values) => values.find(v => typeof v === 'string' && v) || null, Error,
    );
}

for (const itemType of ['movie', 'series']) {
  test(`both ingestion paths preserve the same declarations for ${itemType} without changing playback hints`, async () => {
    const { xtreamRows, activeMediaRows } = await loadIngestMappers();
    const item = { stream_id: '123', name: 'A film', category_id: '1', category_name: 'A category', container_extension: 'mkv', audio_language: 'nl', subtitle_languages: ['en'], original_language: 'de', language: 'fr' };
    const before = JSON.stringify(item);
    const direct = xtreamRows('source', 'user', [item], itemType, new Map([['1', 'A category']]))[0];
    const staged = activeMediaRows({}, [item], itemType)[0];
    assert.deepEqual(direct.metadata.providerLanguageDeclarations, staged.metadata.providerLanguageDeclarations);
    assert.deepEqual(direct.playback_hint, { sourceType: 'xtream', streamId: '123', streamType: itemType, container: 'mkv', containerExplicit: true });
    assert.deepEqual(staged.playback_hint, direct.playback_hint);
    assert.equal(direct.metadata.audioLanguages, undefined);
    assert.equal(direct.metadata.original_language, undefined);
    assert.equal(direct.metadata.language, undefined);
    assert.equal(JSON.stringify(item), before);
  });
}

test('no-language items stay unchanged and live ingestion does not acquire VOD declarations', async () => {
  const { xtreamRows, activeMediaRows } = await loadIngestMappers();
  for (const [type, item] of [['movie', { stream_id: '1', name: 'Untitled' }], ['live', { stream_id: '1', name: 'Channel', audio_language: 'fr' }]]) {
    const direct = xtreamRows('source', 'user', [item], type, new Map())[0];
    const staged = activeMediaRows({}, [item], type)[0];
    assert.equal(direct.metadata.providerLanguageDeclarations, undefined);
    assert.equal(staged.metadata.providerLanguageDeclarations, undefined);
  }
});

test('both ingestion paths use the helper; projections preserve opaque metadata without new language resolution', () => {
  const sync = read('supabase/functions/_shared/xtream-sync.ts');
  const access = read('supabase/functions/norva-provider-access/index.ts');
  const projection = read('supabase/functions/_shared/vod-title-projection.ts');
  assert.match(sync, /providerLanguageDeclarations: itemType === "live" \? null : xtreamLanguageDeclarations\(item\)/);
  assert.match(access, /providerLanguageDeclarations: itemType === "live" \? null : xtreamLanguageDeclarations\(item\)/);
  assert.match(sync, /ignoreDuplicates: true/);
  assert.match(projection, /metadata: compactRecord\(\{\s*\.\.\.metadata,/);
  assert.doesNotMatch(projection, /providerLanguageDeclarations/);
  const titlePayload = extract(access, 'function activeTitlePayload(', '\nfunction ');
  assert.match(titlePayload, /metadata: compactActiveRecord\(\{ \.\.\.metadata,/);
  assert.doesNotMatch(titlePayload, /providerLanguageDeclarations/);
});
