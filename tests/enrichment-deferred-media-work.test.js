'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { decideLanguageMetadataCapacity } = require('../services/media-gateway/src/language-background-capacity');
const { passiveResourcesAvailable } = require('../services/media-gateway/src/passive-lid-capture');
const source = fs.readFileSync(path.join(__dirname, '../services/media-gateway/src/index.js'), 'utf8').replace(/\r\n/g, '\n');
function section(start, end) {
    const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
    assert.ok(a >= 0 && b > a, `Missing actual Gateway section: ${start}`);
    return source.slice(a, b);
}
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
    for (let n = 0; n < 30; n++) { if (predicate()) return; await tick(); }
    assert.fail('Fixture did not reach the expected queue state');
}
function harness() {
    const queues = { transcribe: [], ocr: [], translate: [] }, waiting = new Map(), runs = [];
    const JOB_PRIORITY = { viewer: 0, service: 1, pregen: 2 };
    const jobPrio = job => Number.isInteger(job?.prio) ? job.prio : 1;
    const insertByPriority = (queue, job) => { queue.push(job); queue.sort((a,b) => jobPrio(a)-jobPrio(b)); };
    const state = { gate: job => job.blocked === true, heartbeats: [], failed: [] };
    const context = {
        JOB_PRIORITY, jobPrio, insertByPriority, JOB_GATE_MAX_DEFERRALS: 20, JOB_GATE_POLL_MS: 5,
        transcribeQueue: queues.transcribe, ocrQueue: queues.ocr, translateQueue: queues.translate,
        transcribeBusy: false, ocrBusy: false, translateBusy: false,
        transcribeWakeState: {name:'transcribe',version:0}, ocrWakeState: {name:'ocr',version:0},
        localViewerTranscriptionSource: () => null,
        backgroundJobBlockedByViewer: job => job.viewerBlocked === true,
        accountSlotBusyLocally: () => false, storyboardCoolingDown: () => false, transcribeCoolingDown: () => false,
        shouldDeferJob: job => state.gate(job),
        postJobHeartbeat: (job,stage) => state.heartbeats.push([job.jobId,stage]),
        postDeferFailCallback: (_kind,job) => state.failed.push(job.jobId),
        waitForQueueWake: wake => new Promise(resolve => waiting.set(wake.name, resolve)),
        console: {warn(){}},
    };
    for (const name of ['transcribe','ocr']) context[name==='ocr'?'runOcrJob':'runTranscribeJob'] = job =>
        new Promise((resolve,reject) => runs.push({name,job,resolve,reject}));
    const code = section('const languageMediaQueueWork =', 'function backgroundJobBlockedByViewer')
        + section('async function nextRunnableJob', '// Phase 3 transcription job queue')
        + section('async function drainTranscribeQueue', 'async function runTranscribeJob')
        + section('async function drainOcrQueue', '// Extract one image-subtitle track');
    const api = vm.runInNewContext(`(()=>{${code}; return {languageForegroundWorkSnapshot,drainTranscribeQueue,drainOcrQueue};})()`, context);
    return { ...api, queues, waiting, runs, state, context,
        wake(name) { const resolve=waiting.get(name); waiting.delete(name); resolve?.(); } };
}

for (const lane of ['transcribe','ocr']) test(`${lane}: confirmed deferred pregen work is not an executing operation`, async () => {
    const h = harness(), queue = h.queues[lane];
    queue.push({jobId:'background',prio:2,blocked:true});
    assert.equal(h.languageForegroundWorkSnapshot().busy, true, 'uninspected jobs must still block');
    const draining = h[lane==='ocr'?'drainOcrQueue':'drainTranscribeQueue']();
    await until(()=>h.waiting.has(lane));
    assert.equal(h.context[lane+'Busy'],true,'legacy busy flag includes the sleeping scheduler');
    let snapshot=h.languageForegroundWorkSnapshot();
    assert.equal(snapshot.busy,false);
    assert.equal(snapshot.activeOperations,0);
    assert.equal(snapshot.admissionChecks,0);
    assert.equal(snapshot.deferredBackgroundJobs,1);
    assert.equal(h.runs.length,0);
    const sample={at:1000,cpuRatio:.1,memoryRatio:.1,hostLoadRatio:.1};
    const activity={viewer:false,starting:false,foregroundInference:snapshot.busy,benchmark:false};
    assert.equal(decideLanguageMetadataCapacity(sample,activity,{maximum:2,active:0},true,1000).maxWorkers,2);
    assert.equal(decideLanguageMetadataCapacity(sample,activity,{maximum:2,active:2},true,1000).maxWorkers,0);
    assert.equal(decideLanguageMetadataCapacity(sample,{...activity,viewer:true},{maximum:2,active:0},true,1000).maxWorkers,0);
    queue[0].blocked=false; h.wake(lane);
    await until(()=>h.runs.length===1);
    snapshot=h.languageForegroundWorkSnapshot();
    assert.equal(snapshot.busy,true);
    assert.equal(snapshot.activeOperations,1);
    assert.equal(h.runs[0].job._languageAdmissionDeferred,false);
    h.runs[0].resolve(); await draining;
    assert.equal(h.languageForegroundWorkSnapshot().busy,false);
    assert.equal(h.context[lane+'Busy'],false);
});

for (const prio of [0,1,undefined,3,-1]) test(`pending priority ${prio} cannot be downgraded by a deferral marker`, () => {
    const h=harness(); h.queues.transcribe.push({prio,_languageAdmissionDeferred:true});
    assert.equal(h.languageForegroundWorkSnapshot().busy,true);
    assert.equal(h.languageForegroundWorkSnapshot().pendingPriorityJobs,1);
});

test('only an inspected, deferred automatic storyboard yields during an existing viewer playback', async () => {
    const h=harness();h.queues.transcribe.push({jobId:'storyboard',kind:'storyboard',prio:1,viewerBlocked:true});
    assert.equal(h.languageForegroundWorkSnapshot().busy,true,'an uninspected storyboard still blocks');
    const draining=h.drainTranscribeQueue();await until(()=>h.waiting.has('transcribe'));
    const snapshot=h.languageForegroundWorkSnapshot();
    assert.equal(snapshot.busy,false);assert.equal(snapshot.activeOperations,0);
    assert.equal(snapshot.admissionChecks,0);assert.equal(snapshot.deferredBackgroundJobs,1);
    assert.equal(h.runs.length,0,'no storyboard process or provider read has started');
    const now=Date.now(),sample={at:now,cpuRatio:.1,memoryRatio:.1,hostLoadRatio:.1};
    assert.equal(passiveResourcesAvailable(sample,{viewer:true,foreground:snapshot.busy},now),true,
        'already received viewer segments may be processed locally');
    assert.equal(decideLanguageMetadataCapacity(sample,{viewer:true,foregroundInference:snapshot.busy},
        {maximum:2,active:0},true,now).maxWorkers,0,'viewer priority still forbids new enrichment streams');
    h.queues.transcribe[0].viewerBlocked=false;h.wake('transcribe');await until(()=>h.runs.length===1);
    assert.equal(h.languageForegroundWorkSnapshot().busy,true);
    assert.equal(h.languageForegroundWorkSnapshot().activeOperations,1);
    assert.equal(h.runs[0].job._languageAdmissionDeferred,false);
    h.runs[0].resolve();await draining;assert.equal(h.languageForegroundWorkSnapshot().busy,false);
});

test('queued storyboard exceptions cannot cover viewer jobs, other services, malformed priority or OCR', () => {
    for(const change of [{prio:0},{prio:undefined},{prio:null},{prio:'1'},{prio:3},{prio:-1},{kind:'transcribe'},{kind:'ocr'},
        {kind:undefined},{_languageAdmissionDeferred:false}]) {
        const h=harness();h.queues.transcribe.push({kind:'storyboard',prio:1,_languageAdmissionDeferred:true,...change});
        assert.equal(h.languageForegroundWorkSnapshot().busy,true,JSON.stringify(change));
    }
    const h=harness();h.queues.ocr.push({kind:'storyboard',prio:1,_languageAdmissionDeferred:true});
    assert.equal(h.languageForegroundWorkSnapshot().busy,true);
});

test('a deferred service storyboard reserves the entire asynchronous admission check', async () => {
    const h=harness();let releaseGate;
    h.queues.transcribe.push({kind:'storyboard',prio:1,_languageAdmissionDeferred:true});
    h.state.gate=()=>new Promise(resolve=>{releaseGate=resolve;});
    const draining=h.drainTranscribeQueue();await until(()=>!!releaseGate);
    assert.equal(h.languageForegroundWorkSnapshot().admissionChecks,1);
    assert.equal(h.languageForegroundWorkSnapshot().busy,true);
    releaseGate(false);await until(()=>h.runs.length===1);
    assert.equal(h.languageForegroundWorkSnapshot().activeOperations,1);
    h.runs[0].resolve();await draining;
});

for (const lane of ['transcribe','ocr']) test(`${lane}: admission checks and execution errors release only their own activity marker`, async () => {
    const h=harness(); let releaseGate;
    h.queues[lane].push({jobId:'pregen',prio:2,_languageAdmissionDeferred:true});
    h.state.gate=()=>new Promise(resolve=>{releaseGate=resolve;});
    const draining=h[lane==='ocr'?'drainOcrQueue':'drainTranscribeQueue']();
    await until(()=>!!releaseGate);
    assert.equal(h.languageForegroundWorkSnapshot().admissionChecks,1);
    assert.equal(h.languageForegroundWorkSnapshot().busy,true,'shifted job still reserves the admission-check interval');
    releaseGate(false); await until(()=>h.runs.length===1);
    assert.equal(h.languageForegroundWorkSnapshot().admissionChecks,0);
    assert.equal(h.languageForegroundWorkSnapshot().activeOperations,1);
    h.runs[0].reject(Error('fixture failure')); await draining;
    assert.equal(h.languageForegroundWorkSnapshot().activeOperations,0);
    assert.equal(h.languageForegroundWorkSnapshot().busy,false);
    h.state.gate=()=>{throw Error('fixture gate failure');};
    h.queues[lane].push({prio:2});
    await assert.rejects(h[lane==='ocr'?'drainOcrQueue':'drainTranscribeQueue'](),/fixture gate failure/);
    assert.equal(h.languageForegroundWorkSnapshot().admissionChecks,0);
    assert.equal(h.context[lane+'Busy'],false);
});

test('queued interactive work immediately takes priority over a sleeping background queue', async () => {
    const h=harness();h.queues.transcribe.push({jobId:'pregen',prio:2,blocked:true});
    const draining=h.drainTranscribeQueue(); await until(()=>h.waiting.has('transcribe'));
    assert.equal(h.languageForegroundWorkSnapshot().busy,false);
    h.queues.transcribe.unshift({jobId:'viewer',prio:0});
    assert.equal(h.languageForegroundWorkSnapshot().busy,true);
    h.wake('transcribe');await until(()=>h.runs.length===1);
    assert.equal(h.runs[0].job.jobId,'viewer');
    h.queues.transcribe.length=0;h.runs[0].resolve();await draining;
    assert.equal(h.languageForegroundWorkSnapshot().busy,false);
});

test('concurrent queue drains cannot release another lane admission or executing reservation', async () => {
    const h=harness(); let releaseOcrGate;
    h.state.gate=job=>job.jobId==='ocr-job'
        ? new Promise(resolve=>{releaseOcrGate=resolve;}) : false;
    h.queues.transcribe.push({jobId:'transcribe-job',prio:2});
    h.queues.ocr.push({jobId:'ocr-job',prio:2});
    const transcribing=h.drainTranscribeQueue(), recognizing=h.drainOcrQueue();
    await until(()=>h.runs.length===1 && !!releaseOcrGate);
    assert.equal(h.languageForegroundWorkSnapshot().activeOperations,1);
    assert.equal(h.languageForegroundWorkSnapshot().admissionChecks,1);
    h.runs[0].resolve();await transcribing;
    assert.equal(h.languageForegroundWorkSnapshot().activeOperations,0);
    assert.equal(h.languageForegroundWorkSnapshot().admissionChecks,1);
    assert.equal(h.languageForegroundWorkSnapshot().busy,true);
    releaseOcrGate(false);await until(()=>h.runs.length===2);
    assert.equal(h.languageForegroundWorkSnapshot().activeOperations,1);
    assert.equal(h.languageForegroundWorkSnapshot().admissionChecks,0);
    assert.equal(h.languageForegroundWorkSnapshot().busy,true);
    h.runs[1].resolve();await recognizing;
    assert.equal(h.languageForegroundWorkSnapshot().busy,false);
});

test('translation work and backlog remain blocking, with counts only in diagnostics', () => {
    const h=harness();h.context.translateBusy=true;
    assert.equal(h.languageForegroundWorkSnapshot().activeOperations,1);
    h.context.translateBusy=false;h.queues.translate.push({vtt:'private text',url:'private source',prio:2,_languageAdmissionDeferred:true});
    const value=h.languageForegroundWorkSnapshot();assert.equal(value.busy,true);
    assert.equal(value.pendingPriorityJobs,1);
    assert.doesNotMatch(JSON.stringify(value),/private|url|vtt/);
});

test('all enrichment admission paths use the precise snapshot; benchmark remains strictly idle-only', () => {
    assert.equal((source.match(/languageForegroundWorkSnapshot\(\)\.busy/g)||[]).length,4);
    assert.match(source,/languageForegroundWork: languageForegroundWorkSnapshot\(\)/);
    assert.match(section('function lidProductionCpuBusy()', 'function rejectWhileLidBenchmarkRuns'),/transcribeBusy/);
});
