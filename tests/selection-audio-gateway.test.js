const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const lib = import('../supabase/functions/_shared/selection-audio-gateway.mjs');
const gatewayToken = 'test-selection-gateway-secret-32';
const jobId = '12345678-1234-4234-8234-123456789012';
const subjectId = 'norva-selection-audio';
const drain = { providerDrained:true, providerDrainProtocol:1 };
const rawProfile = () => ({ probeSource:'gateway_probe', fileSizeBytes:123456789, durationSeconds:600,
  probedAt:'2026-09-09T12:00:00.000Z', audioTracks:[{ index:1, language:'und', codec:'aac' }], subtitles:[] });
const json = (payload, status = 200) => Response.json(payload, { status });
const probePayload = () => ({ ...drain, probeComplete:true, audioProbeComplete:true,
  audioTracks:rawProfile().audioTracks, subtitles:[], codecProfile:rawProfile() });
const receipt = n => 'a'.repeat(40) + '.' + String(n).repeat(40);
const successPayload = () => ({ ...drain, verified:true, confident:true, language:'es', validationStatus:'verified',
  method:'whisper-strict-consensus-v4', evaluatedWindowCount:6, sampleCount:4, consensus:4,
  minSampleProbability:.98, minSampleWordCount:18, minSampleUniqueWordCount:12, rejectedSpeechSampleCount:0,
  candidate:'es', sample:'This speech must never be retained.',
  samples:[40,140,240,340].map(offset => ({ language:'es', offset, probability:.98, wordCount:18, uniqueWordCount:12,
    sample:'This speech must never be retained.' })) });

async function setup(responder) {
  const { createSelectionAudioGateway, getSelectionAudioManifest } = await lib;
  const file = (await getSelectionAudioManifest())[0];
  const calls = [];
  const gateway = createSelectionAudioGateway({ gatewayUrl:'https://gateway.example', gatewayToken,
    now:() => Date.parse('2026-09-09T12:00:00Z'), fetchImpl:async (url, options) => {
      calls.push({ url, options });
      return responder ? responder(url, options, calls.length) : json(probePayload());
    } });
  return { gateway, file, calls };
}

test('only immutable audited file + URL digest may reach the gateway', async () => {
  const { gateway, file, calls } = await setup();
  for (const changed of [
    { ...file, url:'https://127.0.0.1/private' },
    { ...file, externalId:'norva-selection:movie:' + 'f'.repeat(64) },
    { ...file, urlSha256:'0'.repeat(64) },
  ]) await assert.rejects(gateway.probe(changed), { code:'SELECTION_AUDIO_FILE_NOT_AUDITED' });
  assert.equal(calls.length, 0);
});

test('probe returns a serializable exact-file fingerprint and normalizes und without inventing a language', async () => {
  const { gateway, file, calls } = await setup();
  const profile = await gateway.probe(file);
  assert.equal(profile.externalId, file.externalId);
  assert.equal(profile.urlSha256, file.urlSha256);
  assert.equal(profile.probeSource, 'gatewayprobe');
  assert.equal(profile.audioTracks[0].lang, null);
  assert.match(profile.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(profile.windowCount, 6);
  assert.deepEqual(JSON.parse(JSON.stringify(profile)), profile);
  assert.equal(calls[0].options.redirect, 'error');
});

test('strict windows use service auth + signed header claims and durable receipts before finalization', async () => {
  let ordinal = 0;
  const { gateway, file, calls } = await setup(url => {
    if (url.endsWith('/probe-audio')) return json(probePayload());
    if (url.includes('/finalize')) return json(successPayload());
    return json({ ...drain, windowCheckpointProtocol:1, windowOrdinal:++ordinal, windowCount:6, receipt:receipt(ordinal) });
  });
  const profile = await gateway.probe(file), receipts = [];
  for (let windowOrdinal = 1; windowOrdinal <= profile.windowCount; windowOrdinal++) {
    const result = await gateway.analyzeTrackWindow({ file, profile, jobId, subjectId, trackIndex:1, windowOrdinal });
    receipts.push(result.receipt);
  }
  const result = await gateway.finalizeTrack({ file, profile, jobId, subjectId, trackIndex:1, receipts });
  assert.equal(result.verified, true);
  assert.equal(result.lang, 'es');
  assert.equal(result.evidence.independentWindows, 4);
  assert.equal(result.evidence.profileFingerprint, profile.fingerprint);
  assert.equal(JSON.stringify(result).includes('This speech'), false);
  assert.equal(JSON.stringify(result).includes('candidate'), false);
  for (const { url, options } of calls.slice(1)) {
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, `Bearer ${gatewayToken}`);
    const [encoded, signature] = options.headers['X-Norva-Byte-Pipe-Token'].split('.');
    const raw = Buffer.from(encoded, 'base64url').toString('utf8');
    assert.equal(createHmac('sha256', gatewayToken).update(raw).digest('base64url'), signature);
    const claims = JSON.parse(raw);
    assert.equal(claims.url, file.url);
    assert.equal(claims.uid, subjectId);
    assert.equal(claims.scope, 'lid-legacy-full');
    assert.equal(claims.selectionEnrichmentProtocol, 1);
    assert.equal(claims.selectionFeedId, file.feedId);
    assert.equal(claims.profileFingerprint, profile.fingerprint);
    assert.equal(claims.fileSizeBytes, profile.fileSizeBytes);
    assert.equal(claims.durationSeconds, profile.durationSeconds);
    assert.equal(claims.windowCheckpointProtocol, 1);
    assert.equal(claims.exp, Date.parse('2026-09-09T12:05:00Z') / 1000);
    assert.equal(url.includes(encoded), false);
    assert.equal(url.includes(encodeURIComponent(file.url)), false);
  }
  const finalize = calls.at(-1);
  const claims = JSON.parse(Buffer.from(finalize.options.headers['X-Norva-Byte-Pipe-Token'].split('.')[0], 'base64url'));
  assert.equal(claims.windowFinalize, true);
  assert.equal(Object.hasOwn(claims, 'windowOrdinal'), false);
  assert.deepEqual(JSON.parse(finalize.options.body), { receipts });
});

test('profile, index, file and checkpoint mismatches fail before network I/O', async () => {
  const { gateway, file, calls } = await setup();
  const profile = await gateway.probe(file);
  const args = { file, profile, jobId, subjectId, trackIndex:1, windowOrdinal:1 };
  for (const changed of [
    { ...args, profile:{ ...profile, fileSizeBytes:profile.fileSizeBytes + 1 } },
    { ...args, profile:{ ...profile, fingerprint:undefined } },
    { ...args, profile:{ ...profile, urlSha256:'0'.repeat(64) } },
    { ...args, trackIndex:2 },
    { ...args, windowOrdinal:7 },
  ]) await assert.rejects(gateway.analyzeTrackWindow(changed), error => error.code.startsWith('SELECTION_AUDIO_'));
  assert.equal(calls.length, 1);
});

test('a missing drain cannot advance the job even when a successful receipt is returned', async () => {
  const { gateway, file } = await setup(url => url.endsWith('/probe-audio') ? json(probePayload())
    : json({ windowCheckpointProtocol:1, windowOrdinal:1, windowCount:6, receipt:receipt(1) }));
  const profile = await gateway.probe(file);
  await assert.rejects(gateway.analyzeTrackWindow({ file, profile, jobId, subjectId, trackIndex:1, windowOrdinal:1 }),
    { code:'SELECTION_AUDIO_GATEWAY_DRAIN_UNCONFIRMED', retryable:true, providerDrained:false });
});

test('viewer preemption, temporary saturation and checkpoint reset remain resumable', async () => {
  for (const [status, payload, expected] of [
    [409, { ...drain, code:'viewer_preempted' }, 'SELECTION_AUDIO_VIEWER_BUSY'],
    [429, { code:'background_busy' }, 'SELECTION_AUDIO_VIEWER_BUSY'],
    [503, { code:'busy' }, 'SELECTION_AUDIO_GATEWAY_REJECTED'],
    [409, { ...drain, code:'strict_lid_checkpoint_reset_required', resetRequired:true }, 'SELECTION_AUDIO_CHECKPOINT_RESET_REQUIRED'],
  ]) {
    const { gateway, file } = await setup(() => json(payload, status));
    await assert.rejects(gateway.probe(file), { code:expected, retryable:true });
  }
});

test('ambiguous evidence never promotes a candidate language and malformed verified evidence is rejected', async () => {
  for (const payload of [
    { ...drain, verified:false, language:null, candidate:'es', sample:'private speech' },
    { ...successPayload(), minSampleProbability:.5 },
    { ...successPayload(), language:'constructor', samples:successPayload().samples.map(sample => ({ ...sample, language:'constructor' })) },
    { ...successPayload(), minSampleProbability:'0.98' },
    { ...successPayload(), samples:successPayload().samples.map(sample => ({ ...sample, offset:40 })) },
    { ...successPayload(), samples:successPayload().samples.map(sample => ({ ...sample, language:'pt' })) },
  ]) {
    const { gateway, file } = await setup(url => url.endsWith('/probe-audio') ? json(probePayload()) : json(payload));
    const profile = await gateway.probe(file);
    const done = gateway.finalizeTrack({ file, profile, jobId, subjectId, trackIndex:1, receipts:[1,2,3,4,5,6].map(receipt) });
    if (payload.verified) await assert.rejects(done, { code:'SELECTION_AUDIO_EVIDENCE_INVALID' });
    else {
      const result = await done;
      assert.equal(result.verified, false);
      assert.equal(result.lang, null);
      assert.equal(JSON.stringify(result).includes('candidate'), false);
      assert.equal(JSON.stringify(result).includes('private speech'), false);
    }
  }
});

test('shutdown abort and upstream failures expose only bounded local error codes', async () => {
  const { gateway, file, calls } = await setup(() => { throw new Error('sensitive URL and credential'); });
  await assert.rejects(gateway.probe(file), error => error.code === 'SELECTION_AUDIO_GATEWAY_TRANSPORT'
    && !JSON.stringify(error).includes('sensitive') && error.retryable);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(gateway.probe(file, { signal:abort.signal }), { code:'SELECTION_AUDIO_ABORTED' });
  assert.equal(calls.length, 1);
});

test('Selection capture actions are signed and bound; compute has no network capture fallback', async () => {
  const captured = { ...drain, captureProtocol:1, captured:true, sha256:'e'.repeat(64),
    expiresAt:Date.parse('2026-09-09T12:30:00Z') };
  const { gateway, file, calls } = await setup(url => {
    if (url.endsWith('/probe-audio')) return json(probePayload());
    if (url.includes('/status?')) return json({ ...drain, captureProtocol:1, captured:false });
    if (url.includes('/capture/capture?')) return json(captured);
    if (url.includes('/infer?')) return json({ ...drain, windowCheckpointProtocol:1, windowOrdinal:1, windowCount:6, receipt:receipt(1) });
    return json({ ...drain, acknowledged:true });
  });
  const profile = await gateway.probe(file);
  const args = { file, profile, jobId, subjectId, trackIndex:1, windowOrdinal:1 };
  assert.equal((await gateway.getCaptureStatus(args)).captured, false);
  assert.equal((await gateway.captureWindow(args)).sha256, captured.sha256);
  await assert.rejects(gateway.computeCapture(args), { code:'SELECTION_AUDIO_CAPTURE_CLAIMS_INVALID' });
  const captureRelease = '23456789-1234-4234-8234-123456789012';
  assert.equal((await gateway.computeCapture({ ...args, captureRelease })).receipt, receipt(1));
  assert.equal((await gateway.acknowledgeCapture(args)).acknowledged, true);
  assert.equal(calls.length, 5);
  for (const [index, action] of ['status','capture','infer','ack'].entries()) {
    const { url, options } = calls[index + 1];
    const [encoded, signature] = options.headers['X-Norva-Byte-Pipe-Token'].split('.');
    const raw = Buffer.from(encoded, 'base64url').toString(); const claims = JSON.parse(raw);
    assert.equal(createHmac('sha256', gatewayToken).update(raw).digest('base64url'), signature);
    assert.equal(claims.captureProtocol, 1); assert.equal(claims.captureAction, action);
    assert.equal(claims.captureTrackIndex, 1); assert.deepEqual(claims.captureTrackIndices, [1]);
    assert.equal(claims.profileFingerprint, profile.fingerprint); assert.equal(options.body, undefined);
    assert.ok(url.includes(`/capture/${action}?index=1`)); assert.equal(url.includes(file.url), false);
    if (action === 'infer') assert.equal(claims.captureRelease, captureRelease);
  }
});

test('missing, expired, overlong or unbound private captures cannot reach compute or legacy routes', async () => {
  for (const defective of [{ captureProtocol:0 }, { captured:'true' }, { sha256:'private speech' },
    { expiresAt:Date.parse('2026-09-09T11:00:00Z') }, { expiresAt:Date.parse('2026-09-09T15:00:00Z') }]) {
    const { gateway, file, calls } = await setup(url => url.endsWith('/probe-audio') ? json(probePayload())
      : json({ ...drain, captureProtocol:1, captured:true, sha256:'f'.repeat(64), expiresAt:Date.parse('2026-09-09T12:30:00Z'), ...defective }));
    const profile = await gateway.probe(file); const args = { file, profile, jobId, subjectId, trackIndex:1, windowOrdinal:1 };
    await assert.rejects(gateway.getCaptureStatus(args), { code:'SELECTION_AUDIO_CAPTURE_INVALID' });
    await assert.rejects(gateway.captureWindow({ ...args, captureTrackIndices:[1,2] }), { code:'SELECTION_AUDIO_CAPTURE_CLAIMS_INVALID' });
    assert.equal(calls.length, 2);
  }
  const { gateway, file, calls } = await setup(url => url.endsWith('/probe-audio') ? json(probePayload())
    : json({ ...drain, code:'LID_CAPTURE_NOT_FOUND' }, 409));
  const profile = await gateway.probe(file);
  await assert.rejects(gateway.computeCapture({ file, profile, jobId, subjectId, trackIndex:1, windowOrdinal:1,
    captureRelease:'23456789-1234-4234-8234-123456789012' }), { code:'SELECTION_AUDIO_GATEWAY_REJECTED' });
  assert.equal(calls.length, 2); assert.ok(calls[1].url.includes('/capture/infer'));
});

test('local capacity is distinct from provider rejection and requires a drain attestation', async () => {
  for (const attested of [false,true]) {
    const { gateway, file } = await setup(() => json({ code:'LANGUAGE_ENRICHMENT_CAPACITY_BUSY', ...(attested ? drain : {}) }, 429));
    await assert.rejects(gateway.probe(file), { code:attested ? 'SELECTION_AUDIO_CAPACITY_BUSY' : 'SELECTION_AUDIO_GATEWAY_REJECTED', retryable:true });
  }
});

test('incomplete inventories and unknown file sizes cannot mint strict sampling claims', async () => {
  for (const payload of [
    { ...probePayload(), audioProbeComplete:false },
    { ...probePayload(), codecProfile:{ ...rawProfile(), fileSizeBytes:null } },
    { ...probePayload(), codecProfile:{ ...rawProfile(), durationSeconds:40 } },
    { ...probePayload(), audioTracks:[{ index:1 }, { index:1 }] },
  ]) {
    const { gateway, file } = await setup(() => json(payload));
    await assert.rejects(gateway.probe(file), error => error.code.startsWith('SELECTION_AUDIO_'));
  }
});
