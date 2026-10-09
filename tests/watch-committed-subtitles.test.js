'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const watchSource = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'pages', 'WatchPage.js'),
  'utf8',
);

function fakeElement() {
  return {
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    dataset: {},
    style: {},
    setAttribute() {},
    removeAttribute() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    appendChild() {},
    remove() {},
    textContent: '',
    innerHTML: '',
  };
}

function loadWatchPage(fetcher) {
  const forbidden = () => { throw new Error('unexpected network operation'); };
  const context = {
    window: { location: { href: 'https://norva.tv/app', protocol: 'https:' } },
    document: {
      getElementById() { return fakeElement(); },
      querySelector() { return fakeElement(); },
      createElement() { return fakeElement(); },
      documentElement: fakeElement(),
      body: fakeElement(),
    },
    navigator: {},
    location: { origin: 'https://norva.tv' },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    console: { ...console, log() {}, warn() {} },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    URL,
    URLSearchParams,
    fetch: fetcher || forbidden,
    VTTCue: class { constructor(startTime,endTime,text) { Object.assign(this,{startTime,endTime,text}); } },
    API: {},
    MediaUtils: {},
  };
  vm.runInNewContext(watchSource, context, { filename: 'WatchPage.js' });
  return context.window.WatchPage;
}


const topology = { protocol:1,enabled:true,cacheEligible:true,reason:'enabled',
    sourceTrackCount:2,preparedTrackCount:2,
    delivery:{protocol:1,kind:'committed-webvtt',clock:'source-pes-v1',streamIndexes:[2,3]} };
function page(fetcher) {return Object.create(loadWatchPage(fetcher).prototype);}
test('delivery contract is exact, bounded and refuses malformed or legacy metadata',()=>{
    const p=page(),r=[{streamIndex:2},{streamIndex:3}];
    assert.deepEqual([...p.committedSubtitleStreams(topology,r)],[2,3]);
    for(const d of [null,{...topology.delivery,clock:'guessed'}, {...topology.delivery,streamIndexes:[2,2]},
        {...topology.delivery,streamIndexes:[3,2]}, {...topology.delivery,streamIndexes:[2]}])
        assert.equal(p.committedSubtitleStreams({...topology,delivery:d},r),null);
    assert.equal(p.committedSubtitleStreams(topology,[{streamIndex:2},{streamIndex:4}]),null);
});
test('clock requires the current main HLS origin, clears old cues only on a rebase',()=>{
    const p=page(); let removed=0;
    p._committedSubtitleStreams=new Set([2]);
    p._subEngine={committed:true,seenCues:new Set(['old']),trackEl:{track:{cues:[{}],removeCue(){removed++}}}};
    assert.equal(p.acceptCommittedSubtitleClock({id:'audio',initPTS:20,timescale:1}),false);
    assert.equal(p.acceptCommittedSubtitleClock({id:'main',initPTS:20,timescale:0}),false);
    assert.equal(p.acceptCommittedSubtitleClock({id:'main',initPTS:1800000,timescale:90000}),true);
    assert.equal(p._committedSubtitleClock,20);assert.equal(removed,1);
    p.acceptCommittedSubtitleClock({id:'main',initPTS:20,timescale:1});assert.equal(removed,1);
});
test('polling waits for the HLS clock and never declares completeness after silence',async()=>{
    const p=page();let fetched=0;
    const e={committed:true,mode:'gateway-session',gatewaySubtitleUrl:'fixture',trackEl:{track:{cues:[{endTime:999}]}}};
    p._subEngine=e;p.fetchSubtitleCues=async()=>{fetched++;return 0};p.getDisplayDuration=()=>100;
    p._committedSubtitleClock=null;await p.subtitleSessionTick(e);assert.equal(fetched,0);
    p._committedSubtitleClock=20;
    for(let i=0;i<65;i++)await p.subtitleSessionTick(e);
    assert.equal(fetched,65);assert.notEqual(e.done,true);
});
test('late response cannot restore cues after off, track change or clock rebase',async()=>{
    for(const revoke of [p=>{p._subEngine=null},p=>{p._subEngine={}},p=>{p._subEngine.clockVersion++}]){
        let resolve;const p=page(()=>new Promise(r=>resolve=r));
        const e={committed:true,clockVersion:0,trackEl:{track:{addCue(){throw Error('stale cue')}}},seenCues:new Set()};
        p._subEngine=e;const pending=p.fetchSubtitleCues(e,'fixture',-20);
        revoke(p);resolve({ok:true,headers:{get:()=>null},text:async()=> 'WEBVTT\n\n00:00:25.000 --> 00:00:27.000\nFuture\n'});
        assert.equal(await pending,-1);
    }
});
test('rebased committed cues preserve id/settings, skip past cues and deduplicate',async()=>{
    const p=page(async()=>({ok:true,headers:{get:()=>null},text:async()=>
        'WEBVTT\n\n00:00:02.000 --> 00:00:05.000\nPast\n\nfuture\n00:00:25.000 --> 00:00:27.000 align:start position:25% size:50% line:80%\nFuture\n'}));
    const cues=[];const e={committed:true,trackEl:{track:{addCue:c=>cues.push(c)}},seenCues:new Set()};
    p._subEngine=e;p.maybeInferSubtitleLanguage=()=>false;
    assert.equal(await p.fetchSubtitleCues(e,'fixture',-20),1);
    assert.equal(await p.fetchSubtitleCues(e,'fixture',-20),0);
    assert.equal(cues[0].startTime,5);assert.equal(cues[0].endTime,7);assert.equal(cues[0].id,'future');
    assert.equal(cues[0].align,'start');assert.equal(cues[0].position,25);assert.equal(cues[0].line,80);
});
