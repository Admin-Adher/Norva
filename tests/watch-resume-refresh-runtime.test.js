const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function fixture(resolve) {
  const signal = new AbortController().signal;
  const calls = [];
  const context = { window: {}, console, API: { proxy: { xtream: { getStreamUrl: resolve } } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/pages/WatchPage.js'), 'utf8'), context);
  const page = Object.create(context.window.WatchPage.prototype);
  Object.assign(page, {
    readResumeSnapshot: () => ({content: {type:'movie',id:'movie-1',sourceId:'owned-source'},position:42,duration:100}),
    getResumeRestorePosition: () => 42,
    beginPlaybackAttempt: () => 7,
    playbackResolveSignalForAttempt: (id) => { assert.equal(id,7); return signal; },
    isStalePlaybackAttempt: () => false,
    normalizeDuration: n => n,
    titleEl: {},subtitleEl: {},showLoading: () => calls.push('loading'),
    releasePlaybackPipelineForRetry: async () => {},
    getGatewaySeekPlan: () => ({sessionStart:42,target:42}),
    buildResumePlaybackHint: () => ({}),
    playbackMetadataFromResult: r => ({sessionId:r.sessionId}),
    play: async () => calls.push('play'),
    showPlaybackError: () => calls.push('error'),
    cleanupStaleCloudPlaybackSession: async id => calls.push(['cleanup',id])
  });
  return {page,signal,calls};
}
test('resume refresh exposes provider failure instead of leaving loading unresolved',async()=>{
  const {page,calls}=fixture(async()=>{throw new Error('gateway_502');});
  assert.equal(await page.restoreFromResumeSnapshot(),false);
  assert.deepEqual(calls,['loading','error']);
  assert.equal(page._resumeRestorePromise,null);
});
test('resume refresh carries its own abort signal and starts the resolved media',async()=>{
  let received;
  const {page,signal,calls}=fixture(async(...args)=>{received=args[5].signal;return {url:'https://media.example/video',sessionId:'session-1'};});
  assert.equal(await page.restoreFromResumeSnapshot(),true);
  assert.equal(received,signal);
  assert.deepEqual(calls,['loading','play']);
});
test('navigation during refresh cleans the late session without starting playback',async()=>{
  let done, started;
  const waiting = new Promise(r => { started = r; });
  const {page,calls}=fixture(()=>new Promise(r=>{done=r; started();}));
  const result=page.restoreFromResumeSnapshot();
  await waiting;
  page.isStalePlaybackAttempt=()=>true;
  done({url:'https://media.example/video',sessionId:'late-session'});
  assert.equal(await result,false);
  assert.deepEqual(calls,['loading',['cleanup','late-session']]);
});
