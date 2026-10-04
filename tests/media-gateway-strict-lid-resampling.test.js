const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { strictLidTimelineOffsets } = require('../services/media-gateway/src/strict-lid-batch');
const { planStrictSpeechWindow } = require('../services/media-gateway/src/strict-lid-speech-window');
const { normalizeStrictLidWindowBinding, createStrictLidWindowReceipt,
    openStrictLidWindowReceipt } = require('../services/media-gateway/src/strict-lid-window-checkpoint');

test('seven passes explore disjoint speech regions without changing the original plan', () => {
    for (const duration of [2880, 2880.01, 5400, 7248.048, 86400]) {
        const intervals = [];
        for (let pass = 0; pass <= 6; pass++) for (let ordinal = 1; ordinal <= 6; ordinal++) {
            const plan = planStrictSpeechWindow(duration, ordinal, pass);
            assert.ok(plan);
            assert.equal(plan.searchDurationSeconds, 60);
            assert.equal(plan.sampleDurationSeconds, 20);
            assert.ok(plan.searchStartSeconds >= plan.stratumStartSeconds);
            assert.ok(plan.searchStartSeconds + 60 <= plan.stratumEndSeconds);
            intervals.push([plan.searchStartMilliseconds, plan.searchStartMilliseconds + 60000]);
            if (pass === 0) assert.deepEqual(plan, planStrictSpeechWindow(duration, ordinal));
        }
        intervals.sort((a,b) => a[0]-b[0]);
        for (let i=1;i<intervals.length;i++) assert.ok(intervals[i][0] >= intervals[i-1][1]);
    }
});

test('invalid or overlapping resampling requests fail closed', () => {
    for (const pass of [null, '1', -1, 1.5, 7, NaN, Infinity]) {
        assert.equal(strictLidTimelineOffsets(6000,20,pass),null);
        assert.equal(planStrictSpeechWindow(6000,1,pass),null);
    }
    assert.equal(planStrictSpeechWindow(2879,1,1),null);
    assert.ok(planStrictSpeechWindow(2879,1));
});

test('sampling pass is authenticated and cannot reuse an earlier receipt or capture binding', () => {
    const plan = planStrictSpeechWindow(6000,1,1);
    const binding = { jobId:'123e4567-e89b-42d3-a456-426614174000', profileFingerprint:'a'.repeat(64),
        userId:'synthetic-owner',trackIndex:1,fileSizeBytes:1000000,durationSeconds:6000,
        windowOrdinal:1,windowCount:6,offsetMilliseconds:plan.anchorOffsetMilliseconds,
        method:'whisper-strict-consensus-v4',configDigest:'b'.repeat(64),modelDigest:'c'.repeat(64),
        selectionProtocol:1,samplingPass:1 };
    assert.equal(normalizeStrictLidWindowBinding(binding).samplingPass,1);
    assert.throws(()=>normalizeStrictLidWindowBinding({...binding,samplingPass:0}));
    const evidence = { disposition:'accepted', diversity:{fingerprint:'d'.repeat(64),shingles:['abc','def']},
        result:{ language:'en',candidate:'en',confidence:0.99,confident:true,verified:false,
            validationStatus:'pending',method:'whisper-strict-consensus-v4',consensus:0,
            whisperLang:'en',transcriptLang:'en',transcriptAgrees:true,minProbability:0.95,
            wordCount:20,uniqueWordCount:18,transcriptEvidenceBasis:'whitespace-words',
            scriptCharacterCount:0,uniqueScriptCharacterCount:0,uniqueScriptBigramCount:0,scriptDensity:0,
            offset:plan.anchorOffsetSeconds },
        selection:{protocol:1,searchStartMilliseconds:plan.searchStartMilliseconds,
            searchDurationMilliseconds:60000,selectedOffsetMilliseconds:plan.anchorOffsetMilliseconds,
            selectedDurationMilliseconds:20000,speechMilliseconds:19000,selector:'silero-vad-max-speech-v1'} };
    const secret='synthetic-only-secret-for-unit-tests';
    const token=createStrictLidWindowReceipt({secret,binding,evidence});
    assert.ok(openStrictLidWindowReceipt({secret,receipt:token,binding}));
    const next=planStrictSpeechWindow(6000,1,2);
    assert.throws(()=>openStrictLidWindowReceipt({secret,receipt:token,binding:{...binding,samplingPass:2,
        offsetMilliseconds:next.anchorOffsetMilliseconds}}));
});

test('real gateway claim parsing carries only a bounded signed pass into capture and finalization', () => {
    const src=fs.readFileSync(path.join(__dirname,'../services/media-gateway/src/index.js'),'utf8');
    const fragment=src.slice(src.indexOf('function strictLidWindowClaimContext('),src.indexOf('function strictLidWindowConsensusPayload('));
    const api=vm.runInNewContext(`(() => {${fragment}; return {strictLidWindowClaimContext,strictLidWindowReceiptBinding};})()`,{
        STRICT_LID_WINDOW_CHECKPOINT_PROTOCOL:1,STRICT_LID_WINDOW_METHOD:'whisper-strict-consensus-v4',
        STRICT_LID_SAMPLE_DURATION_CAP_SECONDS:20,strictLidTimelineOffsets,
        normalizeStrictLidFileSize:n=>Number.isSafeInteger(n)&&n>0?n:null,
        normalizeStrictLidTimelineDurationSeconds:n=>typeof n==='number'&&n>0?n:null,
        strictLidWindowRuntimeBinding:()=>({modelDigest:'a'.repeat(64),configDigest:'b'.repeat(64)})
    });
    const claims={windowCheckpointProtocol:1,jobId:'123e4567-e89b-42d3-a456-426614174000',
        profileFingerprint:'a'.repeat(64),uid:'synthetic-owner',windowCount:6,windowOrdinal:1,
        fileSizeBytes:1000000,durationSeconds:6000,samplingPass:1};
    const context=api.strictLidWindowClaimContext(claims,1);
    const binding=api.strictLidWindowReceiptBinding(context,1);
    assert.equal(binding.samplingPass,1);
    assert.equal(binding.offsetMilliseconds,planStrictSpeechWindow(6000,1,1).anchorOffsetMilliseconds);
    const {windowOrdinal,...final}=claims;
    assert.equal(api.strictLidWindowClaimContext({...final,windowFinalize:true},1,{finalize:true}).samplingPass,1);
    for (const samplingPass of [null,'1',7,-1,1.2]) assert.equal(api.strictLidWindowClaimContext({...claims,samplingPass},1),null);
});
