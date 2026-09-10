'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const edge = fs.readFileSync(path.join(__dirname, '../supabase/functions/norva-playback/index.ts'), 'utf8');
const from = edge.indexOf('async function shareObservedGatewayProfileTracks(');
const to = edge.indexOf('\nfunction mergePlaybackHints(', from);
assert.ok(from > 0 && to > from);
const snippet = stripTypeScriptTypes(edge.slice(from, to));
const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
function harness(overrides = {}) {
  const shares = [], filters = [];
  const context = {
    recordOrEmpty:record, Date,
    stringOr:(v,fallback) => typeof v === 'string' ? v : fallback,
    stringOrNull:v => typeof v === 'string' && v ? v : null,
    normalizeCodecToken:v => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, ''),
    compactRecord:v => Object.fromEntries(Object.entries(v).filter(([,x]) => x != null)),
    boundedNullableInt:v => v == null ? null : Number(v),
    booleanOrNull:v => typeof v === 'boolean' ? v : null,
    normalizeIsoLang:v => ({fre:'fr',mal:'ml',pan:'pa',pol:'pl'})[v] || v || null,
    readActiveCatalogGenerationSnapshot:async () => ({generationId:'generation-current'}),
    resolveSourceIdentity:async () => ({key:'server-verified-identity'}),
    shareFileTracks:async (...args) => { shares.push(args.slice(1)); return true; },
    ...overrides,
  };
  const query = {
    select:()=>query,
    eq:(key,value) => {filters.push([key,value]);return query;},
    limit:async () => ({data:[{id:'owned-variant',codec_profile:{probedAt:'2026-09-10T10:00:00Z'}}],error:null}),
  };
  const db = {from:table => {assert.equal(table,'cloud_catalog_visible_title_variants');return query;}};
  const run = vm.runInNewContext(snippet + '; shareObservedGatewayProfileTracks;', context);
  return {run:options => run(db,options), shares, filters, query};
}
const options = () => ({userId:'owner',sourceId:'source',itemId:'exact-file',codecProfileSource:'request+gateway_probe',
  codecProfile:{probeSource:'gateway_probe',probedAt:'2026-09-10T10:00:00Z',metadataComplete:false,
    audioTracks:[{index:1,language:'fre',codec:'aac'}],subtitles:[{index:3,language:'pol',codec:'srt'}]}});

test('authenticated real probe shares the exact movie map through canonical upsert/fenced fanout', async () => {
  const h = harness();
  assert.equal(await h.run(options()),true);
  assert.equal(h.shares.length,1);
  assert.deepEqual(JSON.parse(JSON.stringify(h.shares[0])),['server-verified-identity','movie','exact-file',
    [{index:1,lang:'fr',codec:'aac'}],[{index:3,lang:'pl',codec:'srt'}],true,true]);
  for (const filter of [['user_id','owner'],['source_id','source'],['generation_id','generation-current'],['item_type','movie'],['external_id','exact-file']]) {
    assert.ok(h.filters.some(row => row[0]===filter[0] && row[1]===filter[1]));
  }
});

test('request-only echoes and incomplete in-band maps never become cross-account evidence', async () => {
  for (const change of [
    {codecProfileSource:'request'}, {codecProfileSource:null},
    {codecProfileSource:'complete_hls_cache'},
    {codecProfile:{...options().codecProfile,probeSource:'browser'}},
    {codecProfile:{...options().codecProfile,probeSource:'gateway_inband',metadataComplete:false}},
    {codecProfile:{...options().codecProfile,audioTracks:[{index:1},{index:1}]}},
    {codecProfile:{...options().codecProfile,audioTracks:[{index:'1'}]}},
    {codecProfile:{...options().codecProfile,subtitles:undefined}},
    {codecProfile:{...options().codecProfile,probedAt:'invalid'}},
  ]) {
    const h = harness();assert.equal(await h.run({...options(),...change}),false);
    assert.equal(h.shares.length,0);
  }
  const h = harness();
  assert.equal(await h.run({...options(),codecProfileSource:'request+gateway_inband',
    codecProfile:{...options().codecProfile,probeSource:'gateway_inband',metadataComplete:true}}),true);
});

test('source-local identities, changed generations/profiles and database failures defer safely', async () => {
  const local = harness({resolveSourceIdentity:async () => ({key:'source:unverified'})});
  assert.equal(await local.run(options()),false);assert.equal(local.shares.length,0);
  const stale = harness(); stale.query.limit = async () => ({data:[{codec_profile:{probedAt:'older'}}],error:null});
  assert.equal(await stale.run(options()),false);assert.equal(stale.shares.length,0);
  const error = harness({readActiveCatalogGenerationSnapshot:async () => {throw Error('superseded');}});
  assert.equal(await error.run(options()),false);assert.equal(error.shares.length,0);
});

test('sharing is background-only after successful movie persistence and preserves canonical speech evidence', () => {
  assert.match(edge,/if \(profilePersisted && itemType === "movie"\)[\s\S]{0,400}runBackground\(shareObservedGatewayProfileTracks/);
  assert.match(edge,/codecProfileSource: stringOrNull\(gatewayBody\.codecProfileSource\)/);
  const share = edge.slice(edge.indexOf('async function shareFileTracks('),edge.indexOf('// Distributed crawler lease:'));
  assert.match(share,/canonicalArgs = \{[\s\S]*p_audio_tracks: Array\.isArray\(row\.audio_tracks\)/);
  assert.match(share,/norva_fanout_file_tracks_to_users_fenced/);
  assert.doesNotMatch(snippet,/fetch\(|probeEngineTracks|tmdb|providerAudio|raw_title/);
});
