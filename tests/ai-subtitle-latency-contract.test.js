'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8').replace(/\r\n?/g, '\n');

const migration = read('supabase', 'migrations', '20260830075932_generated_subtitle_latency_stages_v1.sql');
const edge = read('supabase', 'functions', 'norva-playback', 'index.ts');
const watch = read('public', 'js', 'pages', 'WatchPage.js');
const gateway = read('services', 'media-gateway', 'src', 'index.js');

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

test('the durable subtitle row records every server latency milestone and resets them atomically on reclaim', () => {
  for (const column of [
    'requested_at',
    'resolved_at',
    'enqueued_at',
    'extraction_started_at',
    'whisper_started_at',
    'first_vtt_at',
    'ready_at',
  ]) {
    assert.match(migration, new RegExp(`add column if not exists ${column} timestamptz`));
  }

  const claim = between(
    migration,
    'create or replace function public.claim_generated_subtitle_job(',
    '\nrevoke all on function public.claim_generated_subtitle_job',
  );
  assert.match(claim, /language plpgsql\s+security definer\s+set search_path = public, pg_temp/);
  assert.match(claim, /on conflict \(provider_key, item_type, external_id, kind, lang\) do update/);
  assert.match(claim, /vtt = null[\s\S]*stage = null[\s\S]*requested_at = clock_timestamp\(\)[\s\S]*resolved_at = clock_timestamp\(\)[\s\S]*enqueued_at = null[\s\S]*extraction_started_at = null[\s\S]*whisper_started_at = null[\s\S]*first_vtt_at = null[\s\S]*ready_at = null/);
  assert.match(migration, /revoke all on function public\.claim_generated_subtitle_job[\s\S]*from public/);
  assert.match(migration, /grant execute on function public\.claim_generated_subtitle_job[\s\S]*to service_role/);
});

test('stage writes are service-only, first-write timestamps and cannot mark a non-processing job', () => {
  const stage = between(
    migration,
    'create or replace function public.mark_generated_subtitle_stage(',
    '\nrevoke all on function public.mark_generated_subtitle_stage',
  );
  assert.match(stage, /security definer\s+set search_path = public, pg_temp/);
  assert.match(stage, /p_stage not in \('queued', 'deferred', 'extracting', 'transcribing', 'first_vtt'\)/);
  for (const column of ['enqueued_at', 'extraction_started_at', 'whisper_started_at', 'first_vtt_at']) {
    assert.match(stage, new RegExp(`${column} = case[\\s\\S]*coalesce\\(${column}, p_at\\)`));
  }
  assert.match(stage, /where job_id = p_job_id\s+and status = 'processing'/);
  assert.match(migration, /revoke all on function public\.mark_generated_subtitle_stage[\s\S]*from authenticated/);
  assert.match(migration, /grant execute on function public\.mark_generated_subtitle_stage[\s\S]*to service_role/);
});

test('Edge reports starting until a real gateway enqueue or heartbeat exists', () => {
  const incumbent = between(
    edge,
    'async function generatedSubtitleIncumbentResponse(',
    '\n// Phase 3 (3a) ASYNC enqueue',
  );
  assert.match(incumbent, /select\("status, job_id, stage, enqueued_at"\)/);
  assert.match(incumbent, /status: "error"[\s\S]*subtitle job was not durably created/);
  assert.match(incumbent, /status: "starting"[\s\S]*stage: "enqueueing"/);

  const getter = between(
    edge,
    'async function getGeneratedSubtitle(',
    '\nfunction storyboardPath(',
  );
  assert.match(getter, /if \(persistedStatus === "processing" && !jobId\) \{[\s\S]*status: "none"/);
  assert.match(getter, /persistedStatus === "processing" && !gatewayEvidence \? "starting" : persistedStatus/);
  assert.match(getter, /requestedAt:[\s\S]*resolvedAt:[\s\S]*enqueuedAt:[\s\S]*extractionStartedAt:[\s\S]*whisperStartedAt:[\s\S]*firstVttAt:[\s\S]*readyAt:/);
});

test('Edge only marks queued after HTTP 202 and marks a failed durable row otherwise', () => {
  const enqueue = between(edge, 'async function transcribeEnqueue(', '\n// Phase 4: OCR');
  const fetchIndex = enqueue.indexOf('const gw = await fetch(asyncUrl');
  const refusalIndex = enqueue.indexOf('if (gwStatus !== 202)');
  const queuedIndex = enqueue.indexOf('p_stage: "queued"');
  assert.ok(fetchIndex >= 0 && refusalIndex > fetchIndex && queuedIndex > refusalIndex);
  assert.match(enqueue, /gwStatus !== 202[\s\S]*status: "failed"/);
  assert.match(enqueue, /REAL accepted enqueue[\s\S]*recordViewerTranscribeRequest/);

  const callback = between(edge, 'async function runTranscribeCallback(', '\n// Resolve the \'pending-transcript\'');
  assert.match(callback, /p_stage: stage/);
  assert.match(callback, /p_stage: "first_vtt"/);
  assert.match(callback, /first_vtt_at|ready_at/);
});

test('the player polls only durable jobs at 2-5 seconds and records the first visible cue', () => {
  const apply = between(watch, '    _applyAiSubtitleResponse(', '\n    startAiSubtitlePolling(');
  assert.match(apply, /status === 'starting' \|\| status === 'processing'/);
  assert.match(apply, /if \(!durableJobId\)[\s\S]*subtitle job was not durably created/);

  const polling = between(watch, '    startAiSubtitlePolling(', '\n    // One-shot cache probe');
  assert.match(polling, /if \(!this\._aiJobId\) return false/);
  assert.match(polling, /stage === 'extracting' \|\| stage === 'transcribing' \? 2000 : 5000/);
  assert.doesNotMatch(polling, /20000/);
  assert.match(watch, /sendPlaybackEvent\('subtitle_first_cue'/);
  assert.match(watch, /requestToFirstCueVisibleMs:[\s\S]*cacheHit:/);
  assert.match(migration, /'subtitle_first_cue'/);
  assert.match(edge, /"subtitle_first_cue"/);
});

test('gateway emits a 60-90 second first chunk then 300-second chunks with honest stages', () => {
  assert.match(gateway, /TRANSCRIBE_FIRST_CHUNK_SEC = clampInt\([^\n]+, 90, 60, 90\)/);
  assert.match(gateway, /TRANSCRIBE_CHUNK_SEC = clampInt\([^\n]+, 300,/);
  assert.match(gateway, /'-segment_times', segmentTimes/);
  assert.match(gateway, /return firstChunkSec \+ \(\(index - 1\) \* chunkSec\)/);
  assert.match(gateway, /postJobHeartbeat\(job, 'extracting'\)/);
  assert.match(gateway, /postJobHeartbeat\(job, 'transcribing'\)/);
});
