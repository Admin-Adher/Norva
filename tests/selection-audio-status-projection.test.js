const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const load = () => import('../supabase/functions/_shared/catalog-audio-job-status.mjs');

test('only durable queued work or a live running lease constitutes audio activity', async () => {
  const { activeAudioJobState, audioJobFields, titleAudioJobState } = await load();
  const now = Date.parse('2026-09-09T20:00:00Z');
  for (const state of [undefined, 'pending', 'completed', 'failed', 'cancelled', 'not_analyzed']) {
    assert.equal(activeAudioJobState({ state }, now), null);
  }
  assert.equal(activeAudioJobState({ state: 'queued' }, now), 'queued');
  assert.equal(activeAudioJobState({ state: 'retry_wait' }, now), 'retry_wait');
  assert.equal(activeAudioJobState({ state: 'running', lease_until: '2026-09-09T20:01:00Z' }, now), 'running');
  assert.equal(activeAudioJobState({ state: 'running', lease_until: '2026-09-09T19:59:00Z' }, now), null);
  assert.equal(activeAudioJobState({ state: 'queued', queue_expires_at: '2026-09-09T19:59:00Z' }, now), null);
  assert.equal(titleAudioJobState([{ __audio_job_status: 'queued' }, { __audio_job_status: 'running' }]), 'running');
  assert.deepEqual(audioJobFields('pending'), { audio_language_validation_job_status: null, audioLanguageValidationJobStatus: null });
});

function fakeDatabase(tables) {
  return { from(table) {
    const filters = [];
    const query = {
      select() { return query; },
      eq(key, value) { filters.push(row => row[key] === value); return query; },
      in(key, values) { filters.push(row => values.includes(row[key])); return query; },
      then(resolve, reject) { return Promise.resolve({ data: (tables[table] || []).filter(row => filters.every(fn => fn(row))) }).then(resolve, reject); },
    };
    return query;
  } };
}

test('Selection activity is bound to current owner, canonical source and exact URL digest', async () => {
  const { attachAudioJobStates } = await load();
  const { discoverySourceId } = await import('../supabase/functions/_shared/discovery-catalog.mjs');
  const userId = '11111111-1111-4111-a111-111111111111';
  const sourceId = await discoverySourceId(userId, 3);
  const url = 'https://example.com/exact-file.mp4';
  const hash = crypto.createHash('sha256').update(url).digest('hex');
  const base = { id: 'variant', user_id: userId, source_id: sourceId, item_type: 'movie', external_id: 'file', playback_hint: { targetUrl: url } };
  const db = fakeDatabase({ catalog_selection_audio_jobs: [
    { external_id: 'file', url_sha256: hash, state: 'queued' },
    { external_id: 'file', url_sha256: 'c'.repeat(64), state: 'retry_wait' },
  ] });
  const valid = { ...base };
  const changed = { ...base, id: 'changed', playback_hint: { targetUrl: url + '?different=1' } };
  const spoofed = { ...base, id: 'spoofed', source_id: '22222222-2222-4222-a222-222222222222' };
  const foreign = { ...base, id: 'foreign', user_id: '33333333-3333-4333-a333-333333333333' };
  await attachAudioJobStates(db, [valid, changed, spoofed, foreign], userId);
  assert.equal(valid.__audio_job_status, 'queued');
  assert.equal(changed.__audio_job_status, null);
  assert.equal(spoofed.__audio_job_status, null);
  assert.equal(foreign.__audio_job_status, undefined);
});

test('legacy audio jobs cannot be borrowed from a sibling file or another owner', async () => {
  const { attachAudioJobStates } = await load();
  const variant = { id: 'variant', user_id: 'owner', source_id: 'source', item_type: 'movie', external_id: 'file' };
  const jobs = [
    { variant_id: 'variant', requested_by: 'other', source_id: 'source', external_id: 'file', state: 'queued' },
    { variant_id: 'variant', requested_by: 'owner', source_id: 'source', external_id: 'sibling', state: 'queued' },
  ];
  await attachAudioJobStates(fakeDatabase({ catalog_file_audio_validation_jobs: jobs }), [variant], 'owner');
  assert.equal(variant.__audio_job_status, null);
  jobs.push({ variant_id: 'variant', requested_by: 'owner', source_id: 'source', external_id: 'file', state: 'queued' });
  await attachAudioJobStates(fakeDatabase({ catalog_file_audio_validation_jobs: jobs }), [variant], 'owner');
  assert.equal(variant.__audio_job_status, 'queued');
});

test('public catalogue carries the safe job state without lease, receipt, URL or result internals', async () => {
  const { sanitizeCatalogMediaItem } = await import('../supabase/functions/_shared/catalog-public-view.mjs');
  const value = sanitizeCatalogMediaItem({ id: 'film', audio_language_validation_job_status: 'running', audioLanguageValidationJobStatus: 'running',
    lease_token: 'secret', receipt: 'secret', profile: { url: 'https://example.com/private' }, result: { verification: 'private' } });
  assert.equal(value.audio_language_validation_job_status, 'running');
  assert.equal(value.audioLanguageValidationJobStatus, 'running');
  assert.equal(JSON.stringify(value).includes('secret'), false);
  assert.equal(JSON.stringify(value).includes('private'), false);
});
