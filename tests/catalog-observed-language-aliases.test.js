'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const aliases = {
  afr:'af', aze:'az', glg:'gl', guj:'gu', kan:'kn', kaz:'kk', khm:'km',
  kir:'ky', lat:'la', mal:'ml', mar:'mr', nep:'ne', oci:'oc', ori:'or',
  pan:'pa', scr:'hr', tgl:'tl', yor:'yo', zul:'zu',
};
function extract(source, start, end) {
  const offset = source.indexOf(start);
  assert.ok(offset >= 0, start);
  const stop = source.indexOf(end, offset + start.length);
  assert.ok(stop > offset, end);
  return source.slice(offset, stop);
}
const web = { window:{}, Intl, document:{documentElement:{lang:'en'}} };
vm.runInNewContext(read('public/js/utils/mediaUtils.js'), web);
const catalog = vm.runInNewContext(stripTypeScriptTypes(extract(
  read('supabase/functions/norva-catalog/index.ts'),
  'const FILE_LANGUAGE_ALIASES:', '\nfunction canonicalFileLanguages(',
)) + '; canonicalFileLanguage;');
const playback = vm.runInNewContext(stripTypeScriptTypes(extract(
  read('supabase/functions/norva-playback/index.ts'),
  'function normalizeIsoLang(', '\ntype BasicLidEvidence',
)) + '; normalizeIsoLang;');

test('all 19 observed missing audio/subtitle tags normalize consistently in Edge and WebView', () => {
  for (const [raw, canonical] of Object.entries(aliases)) {
    for (const value of [raw, raw.toUpperCase(), `${raw}_IN`, ` ${raw} `]) {
      assert.equal(catalog(value), canonical, `catalogue ${value}`);
      assert.equal(playback(value), canonical, `playback ${value}`);
      assert.equal(web.window.MediaUtils.normalizeLanguagePreference(value), canonical, `WebView ${value}`);
    }
  }
});

test('the migration is parser-only, keeps all old aliases and preserves service-only privileges', () => {
  const sql = read('supabase/migrations/20260910184900_catalog_observed_language_aliases.sql');
  const previous = read('supabase/migrations/20260830153000_catalog_language_canonicalization_v1.sql');
  for (const [raw, canonical] of Object.entries(aliases)) assert.ok(sql.includes(`when '${raw}' then '${canonical}'`));
  for (const match of previous.slice(0, previous.indexOf('$function$;')).matchAll(/when '([a-z]+)' then ('[a-z]+'|null)/g)) {
    assert.ok(sql.includes(match[0]), `preserve ${match[0]}`);
  }
  assert.match(sql, /immutable[\s\S]*strict[\s\S]*parallel safe/);
  assert.match(sql, /revoke all[\s\S]*from public, anon, authenticated/);
  assert.match(sql, /grant execute[\s\S]*to service_role/);
  assert.doesNotMatch(sql, /security definer|\b(?:update|delete from|insert into) public\./i);
});

test('unknown, multilingual and arbitrary labels remain unclassified; prefixes do not prove audio', () => {
  for (const value of ['', null, 'und', 'mul', 'zxx', 'subtitles', 'not-a-language']) {
    assert.equal(catalog(value), null);
    assert.equal(playback(value), null);
  }
  const utils = web.window.MediaUtils;
  for (const raw of ['FR | Film', 'AR | Film', 'IN | HINDI | Film', 'ML | Film']) {
    assert.equal(utils.versionDescriptor({raw_title:raw,item_type:'movie',audio_language_validation_status:'not_analyzed'}).headline,
      'Language unidentified');
  }
  for (const [raw, canonical] of Object.entries(aliases)) {
    const item = {item_type:'movie', audio_tracks:[{index:1,lang:raw}], audio_tracks_scope:'file',
      audio_probed_at:'2026-09-10T10:00:00Z',audio_language_validation_status:'probed',
      audio_languages:[canonical],audio_languages_scope:'file',audio_languages_observed:true};
    assert.notEqual(utils.versionDescriptor(item).headline, 'Language unidentified', raw);
  }
});
