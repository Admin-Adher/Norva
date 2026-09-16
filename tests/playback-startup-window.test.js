'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { createPlaybackStartupWindowPolicy } = require('../services/media-gateway/src/playback-startup-window');
const brokerHarness = require('./fixtures/finite-ts-index-broker');
const owner = 'a'.repeat(64), mib = 1024 * 1024;

test('2 MiB transport is owner-scoped, off by default and never enlarges an exact small range', () => {
    for (const settings of [{}, {enabled:true}, {enabled:true,ownerHashes:'invalid'},
        {enabled:false,ownerHashes:owner}, {enabled:true,ownerHashes:'b'.repeat(64)}]) {
        const p = createPlaybackStartupWindowPolicy(settings);
        assert.equal(p.bytes(owner,8*mib),8*mib);
        assert.equal(p.requestEnd(owner,0,10*mib),10*mib);
    }
    const p = createPlaybackStartupWindowPolicy({enabled:true,ownerHashes:owner});
    assert.equal(p.bytes(owner,8*mib),2*mib);
    assert.equal(p.bytes(owner,65536),65536);
    assert.equal(p.requestEnd(owner,0,10*mib),2*mib-1);
    assert.equal(p.requestEnd(owner,2*mib,10*mib),4*mib-1);
    assert.equal(p.requestEnd(owner,2*mib,2*mib+24),2*mib+24);
});

test('large MP4 index and continuous TS/MKV-sized payload stream exactly through sequential 2 MiB windows', async t => {
    const bytes = Buffer.alloc(7*mib,37), requests = [];
    let active=0, peak=0;
    const origin = http.createServer((req,res) => {
        const m=/^bytes=(\d+)-(\d+)$/.exec(req.headers.range||'');
        assert.ok(m); const start=Number(m[1]),end=Number(m[2]);
        requests.push([start,end]); active++; peak=Math.max(peak,active);
        let done=false;const finish=()=>{if(!done){done=true;active--;}};
        res.once('finish',finish);res.once('close',finish);
        res.writeHead(206,{'content-range':`bytes ${start}-${end}/${bytes.length}`,'content-length':end-start+1});
        res.end(bytes.subarray(start,end+1));
    }).listen(0,'127.0.0.1'); await once(origin,'listening');
    const broker=await brokerHarness().createStrictLidBroker({
        sourceUrl:`http://127.0.0.1:${origin.address().port}/fixture.mp4`,fileSizeBytes:bytes.length,
        dispatcher:null,pathPrefix:'finite-mkv-seek',finiteWindowBytes:2*mib,
        finiteSequentialWindowBytes:2*mib,finiteWarmupWindowBytes:0,releaseDelayMs:0,
    });
    t.after(async()=>{await broker.close();await new Promise(r=>origin.close(r));});
    const response=await fetch(broker.inputUrl,{headers:{range:`bytes=0-${bytes.length-1}`}});
    assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
    assert.deepEqual(requests,[[0,2*mib-1],[2*mib,4*mib-1],[4*mib,6*mib-1],[6*mib,7*mib-1]]);
    assert.equal(peak,1);
    assert.equal(broker.interruptedProviderFetches,0);
});

test('finite MP4 transport does not depend on cacheable audio/subtitle topology', () => {
    const p = createPlaybackStartupWindowPolicy({ enabled: true, ownerHashes: owner });
    const finite = { finite: true, knownProfile: true, fileSizeBytes: 50 * mib };
    assert.equal(p.mp4Session(owner, { ...finite, multiAudioHls: true, exactSubtitleHls: true }), true);
    for (const patch of [{ finite: false }, { knownProfile: false }, { fileSizeBytes: 0 }, { fileSizeBytes: NaN }])
        assert.equal(p.mp4Session(owner, { ...finite, ...patch }), false);
    assert.equal(p.mp4Session('b'.repeat(64), finite), false);
    assert.equal(createPlaybackStartupWindowPolicy().mp4Session(owner, finite), false);
    const source = require('node:fs').readFileSync(require('node:path').join(__dirname,
        '../services/media-gateway/src/index.js'), 'utf8');
    assert.match(source, /\(windowedMp4Transport \|\| privateResumeHlsBindingForSession\(session\)\).*privateResumeFormat\(session\) === 'mp4'/);
});
