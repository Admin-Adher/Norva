'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const { finiteTsProfileEligible } = require('../services/media-gateway/src/finite-ts-startup');
const source = fs.readFileSync(path.join(__dirname, '../supabase/functions/norva-playback/index.ts'), 'utf8');
const between = (start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a);
  return source.slice(a, b);
};
const recordOrEmpty = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const normalizeCodecToken = value => String(value || '').toLowerCase().replace(/[^a-z0-9.]+/g, '');
const bind = vm.runInNewContext(`(() => {
  ${stripTypeScriptTypes(between('function bindServerFiniteTsPlaybackHint(', '\nfunction playbackCostScoreForObservation('), {mode:'strip'})}
  ${stripTypeScriptTypes(between('function playbackHintForObservedContainer(', '\nasync function sourceContainerAuthorityFromObservation('), {mode:'strip'})}
  return bindServerFiniteTsPlaybackHint;
})()`, {
  recordOrEmpty, normalizeCodecToken,
  firstUsefulCodecProfile: (...values) => values.find(v => v && Object.keys(v).length) || {},
  canonicalVodContainer: value => ['ts','mpegts'].includes(normalizeCodecToken(value)) ? 'ts' : value,
  hasReliableVodCodecProfile: p => Boolean(p.videoCodec && p.audioCodec && p.probedAt && Array.isArray(p.audioTracks) && Array.isArray(p.subtitles)),
  stringOrNull: value => typeof value === 'string' && value ? value : null,
  compactRecord: value => Object.fromEntries(Object.entries(value).filter(([,v]) => v !== undefined && v !== null)),
  stripMkvH264FastStartProof: value => Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'mkvH264FastStartProof')),
});
const profile = () => ({container:'mpegts', probeSource:'gateway_probe', probedAt:new Date().toISOString(),
  videoCodec:'h264', audioCodec:'aac', durationSeconds:6888.72, fileSizeBytes:1303019352,
  audioTracks:[{index:1,codec:'aac',channels:2}], subtitles:[]});

test('a trusted TS profile corrects stale MP4 hints and restores actual Gateway eligibility', () => {
  const owned = {codecProfile:profile()};
  const stale = {container:'mp4',codecProfile:{container:'mp4',videoCodec:'hevc'},videoCodec:'hevc',
    seekOffset:17,audioStreamIndex:1,subtitleStreamIndex:2,gatewayMode:'remux'};
  const session = hint => ({playbackHint:hint,codecProfile:hint.codecProfile,codecProfileSource:'request',playbackIdentity:{itemType:'movie'},audioStreamIndex:hint.audioStreamIndex});
  assert.equal(finiteTsProfileEligible(session({...stale,codecProfile:owned.codecProfile})),false);
  const result = bind(stale,owned,'ts');
  assert.equal(result.container,'ts');
  assert.equal(result.containerExplicit,true);
  assert.equal(result.codecProfile.videoCodec,'h264');
  assert.equal(result.videoCodec,undefined);
  assert.equal(result.seekOffset,17);
  assert.equal(result.audioStreamIndex,1);
  assert.equal(result.subtitleStreamIndex,2);
  assert.equal(result.gatewayMode,'remux');
  assert.equal(finiteTsProfileEligible(session(result)),true);
  assert.equal(stale.container,'mp4');
  assert.equal(owned.codecProfile.container,'mpegts');
});

test('client hints, partial probes and conflicting server observations cannot authorize finite TS', () => {
  const stale = {container:'mp4',codecProfile:profile()};
  for (const [owned, authority] of [[{},'ts'],[{codecProfile:profile()},'mp4'],
    [{codecProfile:{...profile(),probeSource:'provider'}},'ts'],
    [{codecProfile:{...profile(),probeSource:'gateway_inband'}},'ts'],
    [{codecProfile:{...profile(),container:'mkv'}},'ts'],
    [{codecProfile:{...profile(),audioTracks:undefined}},'ts']]) {
    assert.equal(bind(stale,owned,authority),stale);
  }
});

test('Gateway still rejects invalid tracks, duration, invalid/future proof and explicit full probe', () => {
  const result = bind({container:'mp4'},{codecProfile:profile()},'ts');
  const session = {playbackHint:result,codecProfile:result.codecProfile,codecProfileSource:'request',playbackIdentity:{itemType:'movie'}};
  for (const patch of [{durationSeconds:0},{fileSizeBytes:0},{videoCodec:'hevc'},
    {probedAt:'invalid'},{probedAt:new Date(Date.now()+86400000).toISOString()},
    {audioTracks:[{index:1,codec:'unknown'}]}]) {
    assert.equal(finiteTsProfileEligible({...session,codecProfile:{...session.codecProfile,...patch}}),false);
  }
  assert.equal(finiteTsProfileEligible({...session,forceFullInputProbe:true}),false);
  assert.equal(finiteTsProfileEligible({...session,audioStreamIndex:9}),false);
});

test('session creation binds only movie-owned profiles and does not rewrite provider targets', () => {
  assert.match(source,/bindServerFiniteTsPlaybackHint\(\s*requestedPlaybackHint,\s*itemType === "movie" \? resolved\.playbackHint : \{\},\s*authoritativeVodContainer,/);
  const body = between('function bindServerFiniteTsPlaybackHint(', '\nfunction playbackCostScoreForObservation(');
  assert.doesNotMatch(body,/rewriteVodContainerUrl|targetUrl\s*=/);
});
