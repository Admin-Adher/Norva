'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'services', 'media-gateway', 'src', 'index.js'),
  'utf8',
).replace(/\r\n/g, '\n');

function section(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end).trim();
}

function fakeChild(pid = 1001) {
  return {
    pid,
    killSignals: [],
    kill(signal) {
      this.killSignals.push(signal);
      return true;
    },
  };
}

test('viewer priority spans reservations, raw pumps, ready sessions and stopping sessions', () => {
  const reservationSource = section(
    'const viewerStartupReservations',
    'function sha256Hex',
  );
  const activeSource = section(
    'function viewerPlaybackActiveLocally',
    'function pickProxyAgent',
  );
  const sessions = new Map();
  const rawPumps = new Set();
  const harness = vm.runInNewContext(
    `(() => {
      ${reservationSource}
      ${activeSource}
      return { reserveViewerStartup, releaseViewerStartup, viewerPlaybackActiveLocally };
    })()`,
    {
      Symbol,
      sessions,
      rawPumps,
      wakePlaybackBlockedQueues() {},
      isSessionBlockingProviderSlot: (session) =>
        ['starting', 'ready', 'stopping'].includes(session?.status),
    },
  );

  assert.equal(harness.viewerPlaybackActiveLocally(), false);
  const first = harness.reserveViewerStartup();
  const second = harness.reserveViewerStartup();
  assert.equal(harness.viewerPlaybackActiveLocally(), true);
  harness.releaseViewerStartup(first);
  assert.equal(harness.viewerPlaybackActiveLocally(), true, 'one remaining reservation keeps QoS');
  harness.releaseViewerStartup(second);
  assert.equal(harness.viewerPlaybackActiveLocally(), false);

  rawPumps.add({ sid: 'same-session' });
  assert.equal(harness.viewerPlaybackActiveLocally(), true);
  rawPumps.clear();
  sessions.set('s1', { status: 'stopping' });
  assert.equal(harness.viewerPlaybackActiveLocally(), true, 'FFmpeg teardown remains viewer work');
  sessions.get('s1').status = 'ended';
  assert.equal(harness.viewerPlaybackActiveLocally(), false);
});

test('global extraction preemption spares other-account viewer work but same-account playback wins', () => {
  let viewerBusy = false;
  const viewerQosStats = { globalExtractionPreemptions: 0 };
  const ledgerSource = section(
    'const accountExtractions',
    '// Provider extraction and Whisper inference',
  );
  const harness = vm.runInNewContext(
    `(() => {
      ${ledgerSource}
      return {
        registerAccountExtraction,
        preemptAccountExtractions,
        preemptBackgroundExtractionsGlobally,
      };
    })()`,
    {
      Map,
      Set,
      console: { log() {} },
      viewerPlaybackActiveLocally: () => viewerBusy,
      viewerQosStats,
    },
  );

  const service = fakeChild(1);
  const auxiliaryViewer = fakeChild(2);
  harness.registerAccountExtraction('provider/service', service, true, true);
  harness.registerAccountExtraction('provider/viewer', auxiliaryViewer, true, false);

  assert.equal(harness.preemptBackgroundExtractionsGlobally('provider/playback', 'viewer'), 1);
  assert.deepEqual(service.killSignals, ['SIGKILL']);
  assert.deepEqual(auxiliaryViewer.killSignals, [], 'other-account viewer auxiliary survives');
  assert.equal(harness.preemptBackgroundExtractionsGlobally('provider/playback', 'again'), 0);

  assert.equal(harness.preemptAccountExtractions('provider/viewer', 'same single-slot account'), 1);
  assert.deepEqual(auxiliaryViewer.killSignals, ['SIGKILL'], 'same-account provider slot must yield once');
  assert.equal(harness.preemptAccountExtractions('provider/viewer', 'again'), 0);

  viewerBusy = true;
  const lostSpawnRace = fakeChild(3);
  harness.registerAccountExtraction('provider/race', lostSpawnRace, true, true);
  assert.deepEqual(lostSpawnRace.killSignals, ['SIGKILL']);
  assert.equal(viewerQosStats.globalExtractionPreemptions, 1);
  const explicitViewer = fakeChild(4);
  harness.registerAccountExtraction('provider/explicit-viewer', explicitViewer, true, false);
  assert.deepEqual(explicitViewer.killSignals, []);
});

test('global viewer gate defers background without consuming its failure budget', async () => {
  let viewerBusy = true;
  let localSlotBusy = false;
  const heartbeats = [];
  const failed = [];
  const nextRunnableSource = section(
    'async function nextRunnableJob',
    '// Phase 3 transcription job queue',
  );
  const JOB_PRIORITY = { viewer: 0, service: 1, pregen: 2 };
  const jobPrio = (job) => Number.isInteger(job?.prio) ? job.prio : 1;
  const insertByPriority = (queue, job) => {
    const priority = jobPrio(job);
    let index = queue.length;
    while (index > 0 && jobPrio(queue[index - 1]) > priority) index -= 1;
    queue.splice(index, 0, job);
  };
  const harness = vm.runInNewContext(
    `(() => { ${nextRunnableSource}; return { nextRunnableJob }; })()`,
    {
      JOB_PRIORITY,
      JOB_GATE_MAX_DEFERRALS: 2,
      jobPrio,
      backgroundJobBlockedByViewer: (job) => jobPrio(job) !== 0 && viewerBusy,
      accountSlotBusyLocally: () => localSlotBusy,
      storyboardCoolingDown: () => false,
      transcribeCoolingDown: () => false,
      shouldDeferJob: async () => false,
      postJobHeartbeat: (job, stage) => heartbeats.push([job.jobId, stage]),
      postDeferFailCallback: async (_kind, job) => failed.push(job.jobId),
      insertByPriority,
      console: { warn() {} },
    },
  );
  const service = { jobId: 'service', prio: 1, gateDeferrals: 2 };
  const pregen = { jobId: 'pregen', prio: 2, gateDeferrals: 2 };
  const queue = [service, pregen];

  assert.equal(await harness.nextRunnableJob(queue, 'transcribe'), null);
  assert.deepEqual(queue.map((job) => job.jobId), ['service', 'pregen']);
  assert.deepEqual(heartbeats, [['service', 'deferred'], ['pregen', 'deferred']]);
  assert.equal(service.gateDeferrals, 2);
  assert.equal(pregen.gateDeferrals, 2);
  assert.deepEqual(failed, []);

  insertByPriority(queue, { jobId: 'viewer', prio: 0 });
  assert.equal((await harness.nextRunnableJob(queue, 'transcribe')).jobId, 'viewer');
  viewerBusy = false;
  assert.equal((await harness.nextRunnableJob(queue, 'transcribe')).jobId, 'service');

  viewerBusy = true;
  localSlotBusy = true;
  const sameAccountViewerQueue = [{ jobId: 'viewer-aux', prio: 0, gateDeferrals: 2 }];
  for (let scan = 0; scan < 5; scan += 1) {
    assert.equal(await harness.nextRunnableJob(sameAccountViewerQueue, 'transcribe'), null);
  }
  assert.equal(sameAccountViewerQueue[0].gateDeferrals, 2,
    'same-account viewing never burns the auxiliary viewer job budget');
  assert.deepEqual(failed, []);
});

test('viewer enqueue wakes deferred transcription and OCR drains immediately', async () => {
  const wakeSource = section('function createQueueWakeState', 'const transcribeWakeState');
  const harness = vm.runInNewContext(
    `(() => { ${wakeSource}; return { createQueueWakeState, wakeQueueDrain, waitForQueueWake }; })()`,
    { Promise, setTimeout, clearTimeout },
  );
  const state = harness.createQueueWakeState();
  const startedAt = Date.now();
  const waiting = harness.waitForQueueWake(state, 60_000);
  harness.wakeQueueDrain(state);
  await waiting;
  assert.ok(Date.now() - startedAt < 250, 'wake must not wait for the 60 s gate poll');
  assert.equal(state.waiter, null);

  const lostWakeState = harness.createQueueWakeState();
  const observedVersion = lostWakeState.version;
  harness.wakeQueueDrain(lostWakeState);
  const lostWakeStartedAt = Date.now();
  await harness.waitForQueueWake(lostWakeState, 60_000, observedVersion);
  assert.ok(Date.now() - lostWakeStartedAt < 250,
    'a wake between queue scan and waiter registration must not be lost');

  const transcribeQueueSource = section('function enqueueTranscribe', 'async function drainTranscribeQueue');
  const ocrQueueSource = section('function enqueueOcr', 'async function drainOcrQueue');
  assert.match(transcribeQueueSource, /wakeQueueDrain\(transcribeWakeState\)/);
  assert.match(ocrQueueSource, /wakeQueueDrain\(ocrWakeState\)/);
  assert.match(source, /waitForQueueWake\([\s\S]*transcribeWakeState/);
  assert.match(source, /waitForQueueWake\([\s\S]*ocrWakeState/);
});

test('deferred queue heartbeats are rate-limited and viewer release wakes long polls', async () => {
  const heartbeatSource = section('function postJobHeartbeat', 'async function postDeferFailCallback');
  const calls = [];
  const harness = vm.runInNewContext(
    `(() => { ${heartbeatSource}; return { postJobHeartbeat }; })()`,
    {
      Date,
      JOB_DEFER_HEARTBEAT_MIN_INTERVAL_MS: 60_000,
      GATEWAY_TOKEN: 'test-token',
      AbortSignal,
      fetch: (...args) => {
        calls.push(args);
        return Promise.resolve({ ok: true });
      },
    },
  );
  const job = { jobId: 'queued', callbackUrl: 'https://edge.invalid/callback' };
  harness.postJobHeartbeat(job, 'deferred');
  harness.postJobHeartbeat(job, 'deferred');
  await Promise.resolve();
  assert.equal(calls.length, 1, 'a one-second drain scan cannot emit another deferred callback');
  harness.postJobHeartbeat(job, 'extracting');
  await Promise.resolve();
  assert.equal(calls.length, 2, 'real stage transitions remain immediate');
  job.lastDeferredHeartbeatAt -= 60_001;
  harness.postJobHeartbeat(job, 'deferred');
  await Promise.resolve();
  assert.equal(calls.length, 3, 'the bounded liveness heartbeat resumes after one minute');

  const transcribeDrain = section('async function drainTranscribeQueue', 'async function runTranscribeJob');
  const ocrDrain = section('async function drainOcrQueue', '// Extract one image-subtitle track');
  assert.match(transcribeDrain, /const wakeVersion = transcribeWakeState\.version[\s\S]*waitForQueueWake\(\s*transcribeWakeState,\s*JOB_GATE_POLL_MS,\s*wakeVersion/);
  assert.match(ocrDrain, /const wakeVersion = ocrWakeState\.version[\s\S]*waitForQueueWake\(\s*ocrWakeState,\s*JOB_GATE_POLL_MS,\s*wakeVersion/);
  assert.doesNotMatch(transcribeDrain + ocrDrain, /\?\s*1_000\s*:\s*JOB_GATE_POLL_MS/);

  const releaseReservation = section('function releaseViewerStartup', 'function sha256Hex');
  const releaseRaw = section('function releaseRawPump', '// Abort pumps matching');
  const stopSession = section('async function stopSession', 'async function stopConflictingSourceSessions');
  assert.match(releaseReservation, /wakePlaybackBlockedQueues\(\)/);
  assert.match(releaseRaw, /wakePlaybackBlockedQueues\(\)/);
  assert.match(stopSession, /sessions\.delete\(session\.id\)[\s\S]*wakePlaybackBlockedQueues\(\)/);
});

test('ready HLS sessions never re-stat their historical segment list', () => {
  const playlistRoute = section("app.get('/sessions/:id/playlist.m3u8'", "app.get('/sessions/:id/:file'");
  const waitSource = section('async function waitForPlaylist', 'async function stopSession');
  assert.match(playlistRoute, /if \(session\.status === 'starting'\)\s*\{\s*await waitForPlaylist/);
  assert.match(waitSource, /if \(session\.status === 'ready'\) return/);
});

test('transcode reservation is cleanup-safe and global QoS never authorizes a 458 retry', () => {
  const sessionsRoute = section("app.post('/sessions'", "app.delete('/raw-pumps'");
  const rawRoute = section("app.get('/raw/:token'", '// Tee the leading bytes');

  const reserve = sessionsRoute.indexOf('viewerStartupReservation = reserveViewerStartup()');
  const acquire = sessionsRoute.indexOf('await acquireViewerSessionStartupLocks');
  const firstPreemption = sessionsRoute.indexOf('await stopConflictingOwnerSessions');
  assert.ok(acquire >= 0 && acquire < reserve && reserve < firstPreemption);
  assert.match(
    sessionsRoute,
    /finally\s*\{\s*detachSessionRequestAbort\?\.\(\);\s*releaseViewerSessionStartupLock\?\.\(\);\s*releaseViewerSessionStartupAdmission\(viewerSessionStartupAdmission\);\s*releaseViewerStartup\(viewerStartupReservation\)/,
  );
  assert.match(sessionsRoute, /catch \(err\)[\s\S]*await stopSession\(createdSession\)/);
  assert.match(sessionsRoute, /req\.once\('aborted', abortSessionRequest\)/);
  assert.match(sessionsRoute, /abortSessionRequest[\s\S]*if \(createdSession\) stopSession\(createdSession\)/);
  assert.match(sessionsRoute, /sessionRequestAbortController\?\.signal\.aborted[\s\S]*await stopSession\(createdSession\)/);
  assert.doesNotMatch(
    sessionsRoute,
    /stoppedConflictingSessions\s*\+=\s*preemptBackgroundWorkGlobally/,
    'other-account CPU cleanup cannot create provider handoff retry eligibility',
  );
  assert.match(rawRoute, /preemptBackgroundWorkGlobally\(pumpProxyKey, rawPlaybackReason\)/);
  assert.doesNotMatch(rawRoute, /abortedForHandoff\s*\+=\s*preemptBackgroundWorkGlobally/);
});

test('OCR background work is preemptible, tree-killed and re-queued without a terminal callback', () => {
  const ocrRoute = section("app.post('/ocr-async/:token'", '// Seek-thumbnail storyboard');
  const ocrWorkers = section('function extractSubtitleSup', '// Detect the language of a');
  const playbackEdge = fs.readFileSync(
    path.join(__dirname, '..', 'supabase', 'functions', 'norva-playback', 'index.ts'),
    'utf8',
  );
  const ocrStart = playbackEdge.indexOf('async function ocrEnqueue(');
  const ocrEnd = playbackEdge.indexOf('// ISO 639-2', ocrStart);
  const ocrEdge = playbackEdge.slice(ocrStart, ocrEnd);

  assert.match(ocrRoute, /\?\? JOB_PRIORITY\.viewer/,
    'legacy Edge builds keep viewer-facing OCR compatibility during rollout');
  assert.match(
    ocrEdge,
    /replace\("\/raw\/", "\/ocr-async\/"\)[^\n]*&origin=\$\{encodeURIComponent\(origin\)\}/,
    'the Edge must explicitly propagate viewer/service/pregen to the Gateway',
  );
  assert.match(ocrEdge, /\["viewer", "service", "pregen"\][^\n]*\?[^\n]*:\s*"service"/,
    'invalid or absent internal origins normalize to service');
  assert.match(playbackEdge, /kind, "transcript"\) === "ocr"[\s\S]{0,900}origin: "viewer"/,
    'the authenticated player trigger remains explicitly viewer priority');
  assert.match(ocrWorkers, /extractSubtitleSup[\s\S]*registerAccountExtraction/);
  assert.match(ocrWorkers, /extractSubtitleFrames[\s\S]*registerAccountExtraction/);
  assert.match(ocrWorkers, /runOcrPython[\s\S]*registerBackgroundCpuProcess/);
  assert.match(ocrWorkers, /runOcrImgsubPython[\s\S]*registerBackgroundCpuProcess/);
  assert.equal((ocrWorkers.match(/setTimeout\(\(\) => killBackgroundProcessTree\(child\), OCR_TIMEOUT_MS\)/g) || []).length, 2);
  assert.match(ocrWorkers, /if \(payload\?\.requeue\)[\s\S]*postJobHeartbeat\(job, 'deferred'\)[\s\S]*insertByPriority\(ocrQueue, job\)[\s\S]*return/);
  const requeue = ocrWorkers.indexOf('if (payload?.requeue)');
  const callback = ocrWorkers.indexOf('await fetch(callbackUrl', requeue);
  assert.ok(requeue >= 0 && callback > requeue, 'requeue returns before any terminal callback');
});

test('browser-visible raw tokens cannot be replayed into heavy worker queues', () => {
  const helperSource = section('function bytePipeAllowsPurpose', 'function isHttpUrl');
  const harness = vm.runInNewContext(
    `(() => { ${helperSource}; return { bytePipeAllowsPurpose }; })()`,
  );
  const browserPlayback = { sid: 'a-real-playback-session-id' };
  assert.equal(harness.bytePipeAllowsPurpose(browserPlayback, 'transcribe-job'), false);
  assert.equal(harness.bytePipeAllowsPurpose(browserPlayback, 'ocr-job'), false);
  assert.equal(harness.bytePipeAllowsPurpose(browserPlayback, 'storyboard-job'), false);
  assert.equal(harness.bytePipeAllowsPurpose({ sid: 'transcribe-job' }, 'transcribe-job'), true);
  assert.equal(harness.bytePipeAllowsPurpose({ sid: 'ocr-job' }, 'ocr-job'), true);
  assert.equal(harness.bytePipeAllowsPurpose({ sid: 'storyboard-job' }, 'storyboard-job'), true);
  assert.equal(harness.bytePipeAllowsPurpose({ sid: 'transcribe-bench' }, 'transcribe-bench'), true);

  const syncTranscribe = section("app.get('/transcribe/:token'", '// Phase 3 async transcription');
  const asyncTranscribe = section("app.post('/transcribe-async/:token'", '// Phase 4 async OCR');
  const asyncOcr = section("app.post('/ocr-async/:token'", '// Seek-thumbnail storyboard');
  const asyncStoryboard = section("app.post('/storyboard-async/:token'", '// Phase 3b async translation');
  assert.match(syncTranscribe, /bytePipeAllowsPurpose\(claims, 'transcribe-bench'\)/);
  assert.match(asyncTranscribe, /bytePipeAllowsPurpose\(claims, 'transcribe-job'\)/);
  assert.match(asyncOcr, /bytePipeAllowsPurpose\(claims, 'ocr-job'\)/);
  assert.match(asyncStoryboard, /bytePipeAllowsPurpose\(claims, 'storyboard-job'\)/);
  for (const route of [syncTranscribe, asyncTranscribe, asyncOcr, asyncStoryboard]) {
    const purposeCheck = route.indexOf('bytePipeAllowsPurpose');
    const heavyStart = Math.min(
      ...['extractAudioWav', 'enqueueTranscribe', 'enqueueOcr'].map((needle) => {
        const index = route.indexOf(needle);
        return index < 0 ? Number.POSITIVE_INFINITY : index;
      }),
    );
    assert.ok(purposeCheck >= 0 && purposeCheck < heavyStart,
      'signed purpose must be enforced before extraction or queue admission');
  }
});

test('language detection requires a signed LID scope and viewer subtitle work is bounded and fair', async () => {
  const detectRoute = section('function validateDetectLanguageCapability(', "app.post('/extract-language-wav'");
  assert.match(detectRoute, /LID_ROUTE_SCOPES\.has\(scope\)/);
  assert.match(detectRoute, /requiredScope\s*&&\s*scope\s*!==\s*requiredScope/);
  assert.ok(
    detectRoute.indexOf('validateDetectLanguageCapability(capabilityToken, policy.requiredScope)') < detectRoute.indexOf('extractAudioWav'),
    'scope is checked before any provider or Whisper work',
  );
  assert.match(source, /const LID_LEGACY_FULL_SCOPE = 'lid-legacy-full'/);

  const playbackEdge = fs.readFileSync(
    path.join(__dirname, '..', 'supabase', 'functions', 'norva-playback', 'index.ts'),
    'utf8',
  );
  assert.match(playbackEdge, /untaggedScope:\s*"lid-legacy-full"/);
  assert.match(playbackEdge, /taggedScope:\s*"lid-legacy-full"/);
  assert.match(playbackEdge, /primary \? "lid-production-detect-only" : \(shadow \? "lid-shadow" : "lid-legacy-full"\)/);

  const admissionSource = section(
    'const activeViewerSubtitleOperations',
    'function registerRawPump',
  );
  const harness = vm.runInNewContext(
    `(() => { ${admissionSource}; return { reserveViewerSubtitleOperation }; })()`,
    {
      Set,
      Map,
      Date,
      Promise,
      setTimeout,
      clearTimeout,
      MAX_ACTIVE_VIEWER_SUBTITLE_OPERATIONS: 1,
      MAX_VIEWER_SUBTITLE_REQUESTS_PER_MINUTE: 2,
      MAX_PENDING_VIEWER_SUBTITLE_OPERATIONS: 4,
      VIEWER_SUBTITLE_QUEUE_WAIT_MS: 1000,
      proxyKeyFromUrl: (url) => String(url),
      sha256Hex: (value) => String(value),
    },
  );
  const claims = { uid: 'viewer-a', url: 'https://provider.invalid/account-a' };
  const viewerB = { uid: 'viewer-b', url: 'https://provider.invalid/account-b' };
  const viewerC = { uid: 'viewer-c', url: 'https://provider.invalid/account-c' };
  const first = await harness.reserveViewerSubtitleOperation(claims);
  assert.equal(first.ok, true);
  assert.equal((await harness.reserveViewerSubtitleOperation(claims)).reason, 'busy');
  assert.equal(
    (await harness.reserveViewerSubtitleOperation({ ...claims, url: 'https://provider.invalid/account-a-2' })).reason,
    'busy',
    'one subscriber cannot occupy or queue multiple provider accounts',
  );
  const waitingB = harness.reserveViewerSubtitleOperation(viewerB);
  first.release();
  const activeB = await waitingB;
  assert.equal(activeB.ok, true);
  assert.equal(activeB.principalKey.includes('viewer-b'), true);
  const waitingA = harness.reserveViewerSubtitleOperation(claims);
  const waitingC = harness.reserveViewerSubtitleOperation(viewerC);
  activeB.release();
  const second = await waitingA;
  assert.equal(second.ok, true);
  assert.equal(second.principalKey.includes('viewer-a'), true, 'oldest eligible principal wins FIFO');
  second.release();
  const activeC = await waitingC;
  assert.equal(activeC.ok, true);
  activeC.release();
  assert.equal((await harness.reserveViewerSubtitleOperation(claims)).reason, 'rate_limited');

  const subtitleRoute = section("app.get('/subtitle/:token'", '// Audio-language probe');
  assert.equal((subtitleRoute.match(/await reserveViewerSubtitleOperation\(claims, res\)/g) || []).length, 2);
  assert.match(subtitleRoute, /registerAccountExtraction\(operation\.proxyKey, child, true, false\)/);
  assert.match(subtitleRoute, /const releaseOperation = \(\) =>[\s\S]*extractionRegistration\.release[\s\S]*operation\.release/);
  assert.match(admissionSource, /queuedViewerSubtitlePrincipals/);
  assert.match(admissionSource, /drainViewerSubtitleWaitQueue/);
});
