'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { stripTypeScriptTypes } = require('node:module');

const edge = fs.readFileSync(path.join(__dirname, '../supabase/functions/norva-playback/index.ts'), 'utf8');
function slice(start, end) {
  const a = edge.indexOf(start), b = edge.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `missing function markers: ${start}`);
  return stripTypeScriptTypes(edge.slice(a, b));
}
const code = [
  slice('async function languageValidationProfileFingerprint(', '\nasync function runLanguageValidationRetryWorker('),
  slice('async function loadLanguageValidationIdentity(', '\nasync function hasActiveLanguageValidationJob('),
  slice('function exactCachedAudioTracks(', '\nasync function assertLanguageValidationIdle('),
  slice('function exactLanguageValidationProfileFromGateway(', '\nfunction exactLanguageValidationProfileFromSnapshot('),
  slice('async function enqueueAutomaticStrictLanguageValidation(', '\n// Automatic UNTAGGED audio enrichment'),
].join('\n');
const profile = () => ({ metadataComplete:true, probeSource:'gateway_probe', probedAt:'2026-09-10T12:00:00Z',
  container:'matroska', durationSeconds:6000, fileSizeBytes:987654321,
  audioTracks:[{ index:1, codec:'aac', channels:2, default:true }], subtitles:[] });

function harness() {
  const cache = new Map(), owners = new Map([['A/source-A','provider-P'],['B/source-B','provider-P'],['C/source-C','provider-Q']]);
  const reads = [], jobs = [], repairs = [];
  const context = {
    LANGUAGE_VALIDATION_PROTOCOL:2, LANGUAGE_VALIDATION_METHOD:'whisper-strict-consensus-v4',
    LANGUAGE_VALIDATION_MIN_SAMPLES:4, LANGUAGE_VALIDATION_MIN_PROBABILITY:.95,
    LANGUAGE_VALIDATION_MIN_WORDS:12, LANGUAGE_VALIDATION_MIN_UNIQUE_WORDS:8,
    PLAYBACK_SESSION_UUID_PATTERN:/^[0-9a-f-]{36}$/i,
    recordOrEmpty:value => value && typeof value === 'object' && !Array.isArray(value) ? value : {},
    stringOr:(value,fallback) => typeof value === 'string' ? value : fallback,
    stringOrNull:value => typeof value === 'string' && value ? value : null,
    normalizeIsoLang:value => ({fre:'fr',eng:'en'})[value] || value || null,
    normalizeCodecToken:value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g,''),
    boundedNullableInt:value => value == null ? null : Number(value),
    sameIntegerSet:(a,b) => a.length === b.length && a.every(x => b.includes(x)),
    sha256Hex:async value => createHash('sha256').update(value).digest('hex'),
    normalizeCodecProfile:value => value,
    // These dependencies are deliberately fixtures: this is an Edge behavioral
    // test, not production RLS, Gateway profile validation or SQL fanout proof.
    hasExactGatewayInbandVodProfile:() => true,
    requireStrictLidWindowCount:duration => { assert.ok(duration >= 80); return 6; },
    getLidDetectionPolicy:async () => ({enabled:true}),
    assertSourceCatalogVisible:async (source,user) => { if (!owners.has(`${user}/${source}`)) throw Error('access-denied'); },
    shareFileTracks:async (...args) => { repairs.push(args); return false; },
    HttpError:Error,
    throwDb:error => { throw error; },
    fetch:() => { throw Error('unexpected-provider-I/O'); },
    Date,
  };
  const db = {
    from(table) {
      const filters = {};
      const q = { select:() => q, eq:(key,value) => { filters[key] = value; return q; },
        async maybeSingle() {
          reads.push({table,filters:{...filters}});
          if (table === 'catalog_source_provider_identities') return {data:{identity_id:owners.get(`${filters.user_id}/${filters.source_id}`)},error:null};
          assert.equal(table,'catalog_file_tracks');
          return {data:cache.get(`${filters.server_host}/${filters.item_type}/${filters.external_id}`) || null,error:null};
        } };
      return q;
    },
    async rpc(name,args) {
      assert.equal(name,'start_automatic_catalog_file_audio_validation_job');
      jobs.push(args);
      return {data:{jobId:'10000000-0000-4000-8000-000000000001'},error:null};
    },
  };
  const api = vm.runInNewContext(code + '; ({languageValidationProfileFingerprint,cachedStrictLanguageValidation,enqueueAutomaticStrictLanguageValidation});', context);
  const expected = async p => ({profileFingerprint:await api.languageValidationProfileFingerprint(p,p.audioTracks,p.fileSizeBytes),
    profileProbedAt:p.probedAt,fileSizeBytes:p.fileSizeBytes});
  const proof = async (p=profile()) => ({audio_probed_at:p.probedAt,audio_lang_verified_at:'2026-09-10T12:30:00Z',
    audio_tracks:[{index:1,lang:'fr',codec:'aac'}],audio_lang_retry_at:null,
    audio_lang_verification:{protocol:2,status:'verified',method:'whisper-strict-consensus-v4',allTracksVerified:true,
      trackCount:1,minConsensus:4,...await expected(p),tracks:[{index:1,language:'fr',method:'whisper-strict-consensus-v4',
        consensus:4,sampleCount:6,rejectedSpeechSampleCount:0,minSampleProbability:.99,minSampleWordCount:20,minSampleUniqueWordCount:12}]} });
  const enqueue = (user,changes={}) => api.enqueueAutomaticStrictLanguageValidation({db,userId:user,sourceId:`source-${user}`,
    identityKey:user==='C'?'provider-Q':'provider-P',itemType:'movie',itemId:'file-7',variantId:`variant-${user}`,profile:profile(),...changes});
  return {api,cache,owners,reads,jobs,repairs,expected,proof,enqueue};
}

test('two authorized owners reuse the same exact cache without queueing another validation', async () => {
  const h=harness(); h.cache.set('provider-P/movie/file-7',await h.proof());
  assert.equal(await h.enqueue('A'),true);
  assert.equal(await h.enqueue('B'),true);
  assert.equal(h.jobs.length,0); assert.equal(h.repairs.length,0);
  assert.deepEqual(h.reads.filter(r => r.table==='catalog_source_provider_identities').map(r=>r.filters.user_id),['A','B']);
  assert.ok(h.reads.filter(r=>r.table==='catalog_file_tracks').every(r=>r.filters.server_host==='provider-P' && r.filters.external_id==='file-7'));
});

test('a newer shared observed version blocks an old owner before cache repair or queueing', async () => {
  const h=harness(), p=profile(), cache=await h.proof(p);
  const newer={...p,probedAt:'2026-09-10T13:00:00Z',fileSizeBytes:987654322};
  Object.assign(cache,{observed_profile_fingerprint:(await h.expected(newer)).profileFingerprint,
    observed_profile_probed_at:newer.probedAt,observed_profile_snapshot:newer});
  h.cache.set('provider-P/movie/file-7',cache);
  assert.equal(await h.enqueue('B'),false);
  assert.equal(h.jobs.length,0);assert.equal(h.repairs.length,0);
  assert.equal(h.api.cachedStrictLanguageValidation(cache,[1],await h.expected(p)),null);
});

test('a certificate matching the shared observed version is reusable across owners', async () => {
  const h=harness(), p=profile(), cache=await h.proof(p);
  Object.assign(cache,{observed_profile_fingerprint:(await h.expected(p)).profileFingerprint,
    observed_profile_probed_at:p.probedAt,observed_profile_snapshot:p});
  h.cache.set('provider-P/movie/file-7',cache);
  assert.equal(await h.enqueue('A'),true);assert.equal(await h.enqueue('B'),true);
  assert.equal(h.jobs.length,0);assert.equal(h.repairs.length,0);
});

test('partial, malformed or mismatched global bindings fail closed', async () => {
  for (const change of [{observed_profile_fingerprint:'invalid'},
    {observed_profile_probed_at:'2026-09-10T12:00:00Z'},
    {observed_profile_snapshot:{fileSizeBytes:'987654321'}},
    {observed_profile_snapshot:{fileSizeBytes:987654322}}]) {
    const h=harness(),p=profile(),cache=await h.proof(p);
    Object.assign(cache,{observed_profile_fingerprint:(await h.expected(p)).profileFingerprint,
      observed_profile_probed_at:p.probedAt,observed_profile_snapshot:p},change);
    if(Object.keys(change)[0]==='observed_profile_probed_at') delete cache.observed_profile_fingerprint;
    h.cache.set('provider-P/movie/file-7',cache);
    assert.equal(await h.enqueue('A'),false);assert.equal(h.jobs.length,0);assert.equal(h.repairs.length,0);
  }
});

test('a different provider or a changed account/source binding cannot reuse an identically numbered file', async () => {
  const h=harness(); h.cache.set('provider-P/movie/file-7',await h.proof());
  assert.equal(await h.enqueue('C'),false);
  assert.equal(await h.enqueue('B',{identityKey:'provider-Q'}),false);
  await assert.rejects(h.enqueue('B',{sourceId:'source-A'}),/access-denied/);
  assert.equal(h.jobs.length,0);
});

test('cache fingerprint rejects actual size, duration, container and codec changes', async () => {
  for (const change of [{fileSizeBytes:987654322},{durationSeconds:6010},{container:'mp4'},
    {audioTracks:[{index:1,codec:'ac3',channels:2,default:true}]}]) {
    const h=harness(); h.cache.set('provider-P/movie/file-7',await h.proof());
    assert.equal(await h.enqueue('B',{profile:{...profile(),...change}}),true);
    assert.equal(h.jobs.length,1,'changed profile queues fresh evidence instead of using cache');
  }
});

test('characterization: a timestamp-only reprobe currently queues again, even with unchanged media fields', async () => {
  const h=harness(); h.cache.set('provider-P/movie/file-7',await h.proof());
  assert.equal(await h.enqueue('B',{profile:{...profile(),probedAt:'2026-09-10T13:00:00Z'}}),true);
  assert.equal(h.jobs.length,1,'this is a conservative cache miss, not an optimal reuse proof');
});

test('a language mismatch or changed inventory cannot supply a cached certificate', async () => {
  const h=harness(), p=profile(), expected=await h.expected(p);
  for (const change of [{audio_tracks:[{index:1,lang:'en'}]},{audio_tracks:[{index:2,lang:'fr'}]},
    {audio_tracks:[{index:1,lang:'fr'},{index:1,lang:'fr'}]}]) {
    const cache={...await h.proof(p),...change};
    assert.equal(h.api.cachedStrictLanguageValidation(cache,[1],expected),null);
  }
});

test('missing, non-finite or impossible track evidence must never be reused', async () => {
  const h=harness(), expected=await h.expected(profile());
  for (const field of ['consensus','minSampleProbability','minSampleWordCount','minSampleUniqueWordCount']) {
    for (const value of [undefined,NaN,Infinity,'invalid']) {
      const cache=await h.proof(); cache.audio_lang_verification.tracks[0][field]=value;
      assert.equal(h.api.cachedStrictLanguageValidation(cache,[1],expected),null,`${field}=${String(value)}`);
    }
  }
  for (const change of [{consensus:7},{consensus:4.5},{minSampleProbability:1.1},
                       {minSampleWordCount:20.5},{minSampleUniqueWordCount:21}]) {
    const cache=await h.proof(); Object.assign(cache.audio_lang_verification.tracks[0],change);
    assert.equal(h.api.cachedStrictLanguageValidation(cache,[1],expected),null,JSON.stringify(change));
  }
});

test('provenance must describe exactly the inventory without duplicate or extra proofs', async () => {
  const h=harness(), expected=await h.expected(profile());
  for (const index of [1,2]) {
    const cache=await h.proof(); cache.audio_lang_verification.tracks.push({...cache.audio_lang_verification.tracks[0],index});
    assert.equal(h.api.cachedStrictLanguageValidation(cache,[1],expected),null);
  }
});

test('invalid verification timestamps and missing minimum consensus cannot count as verified cache', async () => {
  const h=harness(), expected=await h.expected(profile());
  const invalidDate=await h.proof(); invalidDate.audio_lang_verified_at='invalid';
  assert.equal(h.api.cachedStrictLanguageValidation(invalidDate,[1],expected),null);
  const incomplete=await h.proof(); delete incomplete.audio_lang_verification.minConsensus;
  assert.equal(h.api.cachedStrictLanguageValidation(incomplete,[1],expected),null);
});

if (process.env.NORVA_LID_CACHE_PROOF_SAMPLE) {
  test('redacted live proof formats remain compatible; this is not a profile identity or language audit', (t) => {
    const rows = JSON.parse(fs.readFileSync(process.env.NORVA_LID_CACHE_PROOF_SAMPLE, 'utf8'));
    assert.ok(Array.isArray(rows) && rows.length > 0 && rows.length <= 96);
    const h = harness();
    for (const cache of rows) {
      const proof = cache.audio_lang_verification;
      const indices = cache.audio_tracks.map(track => track.index);
      // Deliberately test format compatibility only against the profile recorded
      // by the proof. No assertion that it still matches a live physical file.
      assert.ok(h.api.cachedStrictLanguageValidation(cache, indices, {
        profileFingerprint:proof.profileFingerprint,
        profileProbedAt:proof.profileProbedAt,
        fileSizeBytes:proof.fileSizeBytes,
      }), `redacted sample ${cache.sample}`);
    }
    t.diagnostic(`Compatible redacted proof formats: ${rows.length}. No provider I/O.`);
  });
}
