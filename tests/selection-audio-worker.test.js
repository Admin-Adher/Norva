const test = require('node:test');
const assert = require('node:assert/strict');
const workerModule = import('../ops/hetzner/services/selection-audio-worker.mjs');
const gatewayModule = import('../supabase/functions/_shared/selection-audio-gateway.mjs');
const clone = value => JSON.parse(JSON.stringify(value));
const file = { externalId:'norva-selection:movie:' + 'a'.repeat(64), url:'https://example.invalid/a.mp4', urlSha256:'b'.repeat(64) };
const baseJob = () => ({ id:'12345678-1234-4234-8234-123456789012', external_id:file.externalId, url_sha256:file.urlSha256,
  lease_token:'23456789-1234-4234-8234-123456789012', profile:{}, progress:{} });
const profile = () => ({ externalId:file.externalId, urlSha256:file.urlSha256, fingerprint:'c'.repeat(64),
  durationSeconds:600, fileSizeBytes:123456, audioTracks:[{ index:1, lang:null, codec:'aac' }], subtitleTracks:[], windowCount:6 });
const receipt = ordinal => 'receipt-' + ordinal;
const verified = index => ({ verified:true, lang:'es', providerDrained:true,
  evidence:{ protocol:1, method:'whisper-strict-consensus-v4', streamIndex:index, consensus:4 } });

async function harness({ job = baseJob(), givenProfile = profile(), analyze, finalize, checkpoint, hydrate, finish, givenFile = file } = {}) {
  const { processSelectionAudioJob } = await workerModule;
  const events = [], checkpoints = [], finishes = [];
  const repository = {
    async checkpoint(current, savedProfile, savedProgress) {
      events.push('checkpoint'); checkpoints.push({ profile:clone(savedProfile), progress:clone(savedProgress) });
      return checkpoint ? checkpoint(current, savedProfile, savedProgress, checkpoints.length) : true;
    },
    async finish(current, result, errorCode = null, retryable = false) {
      events.push('finish'); finishes.push({ result:clone(result), errorCode, retryable });
      return finish ? finish(current, result, errorCode, retryable) : true;
    },
    async hydrate(current) { events.push('hydrate'); return hydrate ? hydrate(current) : 1; },
    async acknowledgeHydration() { events.push('acknowledge'); return true; },
  };
  const windows = [], finals = [];
  const gateway = {
    async probe() { events.push('probe'); return clone(givenProfile); },
    async analyzeTrackWindow(args) {
      events.push('window'); windows.push({ ...args, receipts:undefined });
      return analyze ? analyze(args) : { providerDrained:true, receipt:receipt(args.windowOrdinal), windowCount:6 };
    },
    async finalizeTrack(args) { events.push('finalize'); finals.push({ ...args, receipts:[...args.receipts] }); return finalize ? finalize(args) : verified(args.trackIndex); },
  };
  return { events, checkpoints, finishes, windows, finals, repository, gateway, job,
    run:options => processSelectionAudioJob({ repository, gateway, file:givenFile, job, ...options }) };
}

test('a completed analysis checkpoints each window then the next track before saving and hydration', async () => {
  const run = await harness();
  const result = await run.run();
  assert.equal(result.state, 'completed');
  assert.deepEqual(run.windows.map(window => window.windowOrdinal), [1,2,3,4,5,6]);
  assert.ok(run.windows.every(window => window.jobId === run.job.id));
  assert.deepEqual(run.finals[0].receipts, [1,2,3,4,5,6].map(receipt));
  assert.equal(run.checkpoints[0].progress.trackPosition, 0);
  assert.deepEqual(run.checkpoints.slice(1,7).map(checkpoint => checkpoint.progress.receipts.length), [1,2,3,4,5,6]);
  assert.equal(run.checkpoints.at(-1).progress.trackPosition, 1);
  assert.equal(run.finishes.length, 1);
  assert.equal(run.finishes[0].result.verified, true);
  assert.equal(run.finishes[0].result.audioTracks[0].lang, 'es');
  assert.deepEqual(run.events.slice(-3), ['finish','hydrate','acknowledge']);
});

test('retry resumes persisted receipts without probing or repeating completed windows', async () => {
  const job = { ...baseJob(), profile:profile(), progress:{ trackPosition:0, receipts:[receipt(1),receipt(2)], tracks:[], evidence:[] } };
  const run = await harness({ job });
  const result = await run.run();
  assert.equal(result.state, 'completed');
  assert.equal(run.events.includes('probe'), false);
  assert.deepEqual(run.windows.map(window => window.windowOrdinal), [3,4,5,6]);
  assert.ok(run.windows.every(window => window.jobId === job.id));
  assert.deepEqual(run.finals[0].receipts, [1,2,3,4,5,6].map(receipt));
});

test('attested local capacity preserves the checkpoint and returns the admission debit without finalizing', async () => {
  for (const owned of [false,true]) {
    const job = { ...baseJob(), profile:profile(), progress:{ trackPosition:0, receipts:[receipt(1)], tracks:[], evidence:[] } };
    const run = await harness({ job, analyze:() => { throw Object.assign(Error('capacity'), {
      code:'SELECTION_AUDIO_CAPACITY_BUSY', providerDrained:true, retryable:true,
    }); } });
    let deferred = 0;
    run.repository.deferAdmission = async current => { assert.equal(current, job); deferred++; return owned; };
    assert.equal((await run.run()).state, owned ? 'retry_wait' : 'lease_lost');
    assert.equal(deferred, 1); assert.equal(run.finishes.length, 0); assert.equal(run.windows.length, 1);
    assert.deepEqual(job.progress.receipts, [receipt(1)]);
  }
});

test('ambiguous audio completes durably as unidentified and never promotes a candidate', async () => {
  const run = await harness({ finalize:() => ({ verified:false, lang:null, candidate:'es', providerDrained:true }) });
  assert.equal((await run.run()).state, 'completed');
  assert.equal(run.finishes[0].result.verified, false);
  assert.equal(run.finishes[0].result.audioTracks[0].lang, null);
  assert.deepEqual(run.finishes[0].result.verification.tracks, []);
  assert.equal(JSON.stringify(run.finishes[0].result).includes('candidate'), false);
});

test('lease loss after a receipt stops all later windows and prevents final save or hydration', async () => {
  const run = await harness({ checkpoint:(_job, _profile, _progress, count) => count < 2 });
  assert.equal((await run.run()).state, 'lease_lost');
  assert.equal(run.windows.length, 1);
  assert.equal(run.finals.length, 0);
  assert.equal(run.finishes.length, 0);
  assert.equal(run.events.includes('hydrate'), false);
});

test('lease heartbeat loss aborts the gateway operation already in flight', async t => {
  t.mock.timers.enable({ apis:['setInterval'] });
  let started;
  const inFlight = new Promise(resolve => { started = resolve; });
  let aborted = false;
  const run = await harness({ checkpoint:(_job, _profile, _progress, count) => count < 2,
    analyze:args => new Promise((_resolve, reject) => {
      args.signal.addEventListener('abort', () => {
        aborted = true;
        reject(Object.assign(new Error('aborted'), { code:'SELECTION_AUDIO_ABORTED', retryable:true }));
      }, { once:true });
      started();
    }) });
  const completion = run.run();
  await inFlight;
  t.mock.timers.tick(30_000);
  assert.equal((await completion).state, 'lease_lost');
  assert.equal(aborted, true);
  assert.equal(run.windows.length, 1);
  assert.equal(run.finishes.length, 0);
});

test('viewer-busy retry preserves existing checkpoints and records a bounded retry state', async () => {
  const run = await harness({ analyze:args => {
    if (args.windowOrdinal === 3) throw Object.assign(new Error('busy'), { code:'SELECTION_AUDIO_VIEWER_BUSY', retryable:true });
    return { providerDrained:true, receipt:receipt(args.windowOrdinal), windowCount:6 };
  } });
  const result = await run.run();
  assert.equal(result.state, 'retry_wait');
  assert.deepEqual(run.checkpoints.at(-1).progress.receipts, [receipt(1),receipt(2)]);
  assert.equal(run.finishes[0].retryable, true);
  assert.equal(run.finishes[0].result, null);
  assert.equal(run.events.includes('hydrate'), false);
});

test('expired receipt reset clears profile and progress before scheduling retry', async () => {
  const job = { ...baseJob(), profile:profile(), progress:{ trackPosition:0, receipts:[1,2,3,4,5,6].map(receipt), tracks:[], evidence:[] } };
  const run = await harness({ job, finalize:() => { throw Object.assign(new Error('reset'), {
    code:'SELECTION_AUDIO_CHECKPOINT_RESET_REQUIRED', retryable:true, resetRequired:true,
  }); } });
  assert.equal((await run.run()).state, 'retry_wait');
  assert.equal(run.windows.length, 0);
  assert.deepEqual(run.checkpoints.at(-1).profile, {});
  assert.deepEqual(run.checkpoints.at(-1).progress.receipts, []);
  assert.equal(run.checkpoints.at(-1).progress.trackPosition, 0);
  assert.equal(run.finishes[0].retryable, true);
});

test('a lease lost while resetting receipts cannot finish or enqueue the stale attempt', async () => {
  const job = { ...baseJob(), profile:profile(), progress:{ trackPosition:0, receipts:[1,2,3,4,5,6].map(receipt), tracks:[], evidence:[] } };
  const run = await harness({ job, checkpoint:() => false, finalize:() => { throw Object.assign(new Error('reset'), {
    code:'SELECTION_AUDIO_CHECKPOINT_RESET_REQUIRED', retryable:true, resetRequired:true,
  }); } });
  assert.equal((await run.run()).state, 'lease_lost');
  assert.equal(run.finishes.length, 0);
  assert.equal(run.events.includes('hydrate'), false);
});

test('tagged tracks are preserved while only und tracks receive speech analysis', async () => {
  const givenProfile = profile();
  givenProfile.audioTracks = [{ index:1, lang:'pt', codec:'aac' }, { index:2, lang:null, codec:'aac' }];
  const run = await harness({ givenProfile });
  assert.equal((await run.run()).state, 'completed');
  assert.equal(run.windows.length, 6);
  assert.ok(run.windows.every(window => window.trackIndex === 2));
  assert.deepEqual(run.finishes[0].result.audioTracks.map(track => [track.index,track.lang]), [[1,'pt'],[2,'es']]);
  assert.equal(run.finishes[0].result.verified, false, 'a probed tag must not be relabelled as speech-verified');
  assert.equal(run.finishes[0].result.verification.tracks.length, 1);
});

test('hydration failure preserves the completed audio result without scheduling another media probe', async () => {
  const run = await harness({ hydrate:() => { throw new Error('transient projection failure'); } });
  const result = await run.run();
  assert.equal(result.state, 'completed');
  assert.equal(result.hydrationPending, true);
  assert.equal(run.finishes.length, 1);
  assert.equal(run.finishes[0].result.verified, true);
  assert.equal(run.finishes[0].errorCode, null);
  assert.equal(run.events.includes('acknowledge'), false);
  assert.equal(run.windows.length, 6);
  assert.equal(run.events.filter(event => event === 'probe').length, 1);
});

test('losing the final save lease never hydrates a result that was not accepted', async () => {
  const run = await harness({ finish:() => false });
  assert.equal((await run.run()).state, 'lease_lost');
  assert.equal(run.events.includes('hydrate'), false);
});

test('repository hydration rechecks current owner generation on each retry', async () => {
  const { createSelectionAudioRepository } = await workerModule;
  let generation = 1, failure = true;
  const writes = [], calls = [];
  const repository = createSelectionAudioRepository({ baseUrl:'https://database.example', serviceKey:'test-only-key',
    fetchImpl:async (url, options) => {
      const name = url.split('/').at(-1), body = JSON.parse(options.body); calls.push(name);
      if (name === 'selection_audio_job_owners') return Response.json([{ user_id:'user-a', source_id:'source-a' }]);
      if (name === 'norva_get_catalog_write_snapshot') return Response.json({ isCatalogVisible:true,
        generationId:`generation-${generation}`, headRevision:generation, configRevision:2, sourceVisibilityEpoch:3, userVisibilityEpoch:4 });
      if (name === 'hydrate_selection_audio_results') {
        writes.push(body);
        if (failure) return Response.json({}, { status:503 });
        return Response.json(1);
      }
      throw new Error('Unexpected RPC ' + name);
    } });
  await assert.rejects(repository.hydrate(baseJob()), { code:'SELECTION_AUDIO_DATABASE_ERROR' });
  generation = 2; failure = false;
  assert.equal(await repository.hydrate(baseJob()), 1);
  assert.equal(writes[0].p_generation_id, 'generation-1');
  assert.equal(writes[1].p_generation_id, 'generation-2');
  assert.deepEqual(writes[1].p_external_ids, [file.externalId]);
  assert.equal(writes[1].p_user_id, 'user-a');
  assert.equal(writes[1].p_source_id, 'source-a');
  assert.equal(writes[1].p_head_revision, 2);
  assert.equal(calls.filter(name => name === 'norva_get_catalog_write_snapshot').length, 2);
});

test('a tampered media URL is rejected by the real immutable registry helper before provider network I/O', async () => {
  const { createSelectionAudioGateway, getSelectionAudioManifest } = await gatewayModule;
  const canonical = (await getSelectionAudioManifest())[0];
  let network = 0;
  const gateway = createSelectionAudioGateway({ gatewayUrl:'https://gateway.example', gatewayToken:'test-only-secret-long-enough',
    fetchImpl:async () => { network++; throw new Error('must not fetch'); } });
  const run = await harness({ givenFile:{ ...canonical, url:'https://127.0.0.1/private' },
    job:{ ...baseJob(), external_id:canonical.externalId, url_sha256:canonical.urlSha256 } });
  const { processSelectionAudioJob } = await workerModule;
  const result = await processSelectionAudioJob({ repository:run.repository, gateway, job:run.job,
    file:{ ...canonical, url:'https://127.0.0.1/private' } });
  assert.equal(result.state, 'failed');
  assert.equal(network, 0);
  assert.equal(run.finishes[0].errorCode, 'SELECTION_AUDIO_FILE_NOT_AUDITED');
  assert.equal(run.finishes[0].retryable, false);
});

test('manifest exposes incomplete and mixed track inventories for queue admission', async () => {
  const { getSelectionAudioManifest } = await gatewayModule;
  const manifest = await getSelectionAudioManifest();
  assert.ok(manifest.length > 0);
  assert.ok(manifest.every(entry => typeof entry.hasUnknownAudioTracks === 'boolean'));
  assert.ok(manifest.some(entry => entry.hasUnknownAudioTracks));
  assert.ok(manifest.some(entry => !entry.hasUnknownAudioTracks && entry.knownAudioLanguages.length));
});
