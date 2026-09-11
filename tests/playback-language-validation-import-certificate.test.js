'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { stripTypeScriptTypes } = require('node:module');
const edge = fs.readFileSync(path.join(__dirname, '../supabase/functions/norva-playback/index.ts'), 'utf8');
const migration = fs.readFileSync(path.join(__dirname,
  '../supabase/migrations/20260911034623_read_owned_movie_language_certificate.sql'), 'utf8');
function slice(start, end) {
  const a = edge.indexOf(start), b = edge.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, start);
  return stripTypeScriptTypes(edge.slice(a, b));
}
const code = [
  slice('async function loadOwnedMovieLanguageCertificate(', '\nasync function loadExactLanguageValidationProfile('),
  slice('function exactLanguageValidationProfileFromSnapshot(', '\nasync function loadExactEpisodeLanguageValidationProfile('),
  slice('async function languageValidationProfileFingerprint(', '\nasync function runLanguageValidationRetryWorker('),
  slice('function exactCachedAudioTracks(', '\nasync function assertLanguageValidationIdle('),
].join('\n');
class HttpError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}
function harness() {
  const calls = [];
  const context = {
    LANGUAGE_VALIDATION_PROTOCOL: 2, LANGUAGE_VALIDATION_METHOD: 'whisper-strict-consensus-v4',
    LANGUAGE_VALIDATION_MIN_SAMPLES: 4, LANGUAGE_VALIDATION_MIN_PROBABILITY: .95,
    LANGUAGE_VALIDATION_MIN_WORDS: 12, LANGUAGE_VALIDATION_MIN_UNIQUE_WORDS: 8,
    recordOrEmpty: v => v && typeof v === 'object' && !Array.isArray(v) ? v : {},
    stringOr: (v, fallback) => typeof v === 'string' ? v : fallback,
    stringOrNull: v => typeof v === 'string' && v ? v : null,
    normalizeCodecToken: v => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, ''),
    normalizeIsoLang: v => ['fr', 'en'].includes(v) ? v : null,
    boundedNullableInt: v => v == null ? null : Number(v),
    sameIntegerSet: (a, b) => a.length === b.length && a.every(v => b.includes(v)),
    sha256Hex: async v => createHash('sha256').update(v).digest('hex'),
    // Unit boundary: HTTP integration separately uses the real normalizer,
    // response serializer, role grants, visibility views and PostgreSQL snapshot.
    normalizeCodecProfile: v => v,
    canonicalVodContainer: v => ['matroska', 'mkv', 'mp4'].includes(v) ? v : null,
    languageValidationResponse: v => v,
    throwDb: error => { throw error; }, HttpError, Date,
  };
  const api = vm.runInNewContext(code + '; ({loadOwnedMovieLanguageCertificate,languageValidationProfileFingerprint});', context);
  const db = { async rpc(name, args) { calls.push({name, args}); return { data: db.cache, error: db.error }; } };
  const profile = {metadataComplete: true, probeSource: 'gatewayprobe', probedAt: '2026-09-10T20:00:00Z',
    container: 'matroska', durationSeconds: 600, fileSizeBytes: 40000000,
    audioTracks: [{index: 1, codec: 'aac', channels: 2, default: true}]};
  async function seed() {
    const fingerprint = await api.languageValidationProfileFingerprint(profile, profile.audioTracks, profile.fileSizeBytes);
    db.cache = {audio_probed_at: profile.probedAt, audio_lang_verified_at: profile.probedAt,
      audio_tracks: [{index: 1, lang: 'fr'}], observed_profile_fingerprint: fingerprint,
      observed_profile_probed_at: profile.probedAt, observed_profile_snapshot: structuredClone(profile),
      audio_lang_verification: {protocol: 2, status: 'verified', method: 'whisper-strict-consensus-v4',
        allTracksVerified: true, trackCount: 1, minConsensus: 4, profileFingerprint: fingerprint,
        profileProbedAt: profile.probedAt, fileSizeBytes: profile.fileSizeBytes,
        tracks: [{index: 1, language: 'fr', method: 'whisper-strict-consensus-v4', consensus: 4,
          sampleCount: 6, rejectedSpeechSampleCount: 0, minSampleProbability: .99,
          minSampleWordCount: 20, minSampleUniqueWordCount: 12}]}};
  }
  const read = (indices = [1]) => api.loadOwnedMovieLanguageCertificate(db, 'owner-B', 'source-B', 'file-7', indices);
  return {api, db, calls, seed, read};
}

test('an imported owner receives only the existing bound proof from one read RPC', async () => {
  const h = harness(); await h.seed();
  const before = JSON.stringify(h.db.cache), result = await h.read();
  assert.equal(result.cached, true);
  assert.equal(result.audioTracks[0].language, 'fr');
  assert.equal(JSON.stringify(h.db.cache), before);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0])), {
    name: 'read_owned_movie_language_certificate',
    args: {p_user_id: 'owner-B', p_source_id: 'source-B', p_external_id: 'file-7'},
  });
  assert.equal(result.profile, undefined);
  assert.equal(result.identityKey, undefined);
});

test('client indices cannot select a subset or redefine the certified inventory', async () => {
  for (const indices of [[], [2], [1, 2], [1, 1]]) {
    const h = harness(); await h.seed();
    await assert.rejects(h.read(indices), e => e.status === 409 && e.details.code === 'AUDIO_INDEX_MAP_MISMATCH');
  }
});

test('a missing row or a database error never falls through to a provider job', async () => {
  const h = harness(); assert.equal(await h.read(), null);
  h.db.error = new Error('db unavailable');
  await assert.rejects(h.read(), /db unavailable/);
  assert.ok(h.calls.every(c => c.name === 'read_owned_movie_language_certificate'));
});

const invalid = [
  ['legacy cache', c => { delete c.observed_profile_fingerprint; delete c.observed_profile_probed_at; delete c.observed_profile_snapshot; }],
  ['missing fingerprint', c => { delete c.observed_profile_fingerprint; }],
  ['malformed fingerprint', c => { c.observed_profile_fingerprint = 'invalid'; }],
  ['missing observed time', c => { delete c.observed_profile_probed_at; }],
  ['invalid observed time', c => { c.observed_profile_probed_at = 'invalid'; }],
  ['missing raw probe', c => { delete c.audio_probed_at; }],
  ['invalid raw probe time', c => { c.audio_probed_at = 'invalid'; }],
  ['missing snapshot', c => { delete c.observed_profile_snapshot; }],
  ['provider-only snapshot', c => { c.observed_profile_snapshot.probeSource = 'provider'; }],
  ['incomplete inband', c => { c.observed_profile_snapshot.probeSource = 'gatewayinband'; c.observed_profile_snapshot.metadataComplete = false; }],
  ['wrong snapshot size', c => { c.observed_profile_snapshot.fileSizeBytes++; }],
  ['wrong snapshot duration', c => { c.observed_profile_snapshot.durationSeconds++; }],
  ['wrong snapshot timestamp', c => { c.observed_profile_snapshot.probedAt = '2026-09-10T21:00:00Z'; }],
  ['wrong snapshot codec', c => { c.observed_profile_snapshot.audioTracks[0].codec = 'ac3'; }],
  ['wrong snapshot index', c => { c.observed_profile_snapshot.audioTracks[0].index = 2; }],
  ['duplicate snapshot index', c => { c.observed_profile_snapshot.audioTracks.push(c.observed_profile_snapshot.audioTracks[0]); }],
  ['certificate invalidated', c => { c.audio_lang_verified_at = null; }],
  ['inconclusive proof', c => { c.audio_lang_verification.status = 'inconclusive'; }],
  ['wrong audio language', c => { c.audio_tracks[0].lang = 'en'; }],
  ['conflicting speech', c => { c.audio_lang_verification.tracks[0].rejectedSpeechSampleCount = 1; }],
  ['too few words', c => { c.audio_lang_verification.tracks[0].minSampleWordCount = 7; }],
  ['too few independent windows', c => { c.audio_lang_verification.tracks[0].consensus = 3; }],
];
for (const [label, mutate] of invalid) {
  test(`read-only import certificate rejects ${label}`, async () => {
    const h = harness(); await h.seed(); mutate(h.db.cache);
    assert.equal(await h.read(), null);
    assert.equal(h.calls.length, 1);
  });
}

test('fallback is limited to the authenticated movie-start profile miss, not worker validation', () => {
  const start = slice('async function startPlaybackLanguageValidation(', '\nfunction exactLanguageValidationIndices(');
  assert.ok(start.indexOf('assertOwnedSource(') < start.indexOf('loadOwnedMovieLanguageCertificate('));
  assert.ok(start.indexOf('requireLanguageValidationEntitlement(') < start.indexOf('loadOwnedMovieLanguageCertificate('));
  assert.match(start, /error instanceof HttpError && error.status === 409/);
  assert.match(start, /LANGUAGE_VALIDATION_CODEC_PROFILE_REQUIRED/);
  assert.match(start, /if \(shared\) return \{ status: 200, body: shared \}/);
  assert.match(start, /throw error;/);
  assert.equal((edge.match(/await loadOwnedMovieLanguageCertificate\(/g) || []).length, 1);
  assert.doesNotMatch(code, /shareFileTracks|start_catalog|upsert|assertLanguageValidationIdle|fetch\(/);
});

test('SQL contract is read-only, invoker, service-only and binds current visibility and provider in one snapshot', () => {
  assert.match(migration, /language sql stable security invoker/);
  assert.match(migration, /set search_path = ''/);
  assert.match(migration, /cloud_catalog_visible_title_variants/);
  assert.match(migration, /variant.user_id = p_user_id/);
  assert.match(migration, /variant.source_id = p_source_id/);
  assert.match(migration, /variant.external_id = p_external_id/);
  assert.match(migration, /limit 2/);
  assert.match(migration, /count\(\*\) from owned\) = 1/);
  assert.match(migration, /coalesce\(owned.codec_profile, '\{\}'::jsonb\) = '\{\}'::jsonb/);
  assert.match(migration, /cache.server_host = identity.identity_id::text/);
  assert.match(migration, /identity.verified_at is not null/);
  assert.match(migration, /from public, anon, authenticated/);
  assert.match(migration, /grant execute[\s\S]+to service_role/);
  const body = migration.split('as $function$')[1].split('$function$')[0];
  assert.doesNotMatch(body, /\b(update|insert|delete|for update|for share)\b/i);
});
