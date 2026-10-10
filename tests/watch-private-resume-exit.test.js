'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
function watch(window = {}) {
    const env = { window, console, Intl, document: { documentElement: { lang: 'fr' } }, setTimeout, clearTimeout };
    vm.runInNewContext(read('public/js/pages/WatchPage.js'), env);
    return Object.create(window.WatchPage.prototype);
}
function playing(page) {
    Object.assign(page, { contentType: 'movie', currentCloudPlaybackSessionId: 'current', streamStartOffset: 300,
        video: { currentTime: 15.5, readyState: 4, videoWidth: 1920, paused: false },
        _lastKnownPlaybackPosition: 900, resumeTime: 900 });
    return page;
}

test('queued errors from a detached or replaced resource cannot fail the incoming playback', () => {
    for (const src of [null, 'https://norva.invalid/new.mp4']) {
        const page=watch();
        page.video={getAttribute:()=>src,src:src||'',currentSrc:'https://norva.invalid/old.mp4',
            error:{code:4,message:'old resource failed'},dataset:{playbackAttemptId:'2'}};
        page.isStalePlaybackAttempt=()=>false;
        page.hasCurrentMedia=()=>assert.fail('old resource must be ignored before error recovery');
        page.onError({});
    }
});

test('an error on the currently attached resource still reaches playback recovery', async () => {
    const page=watch(); let recovered=false;
    page.video={getAttribute:()=> 'https://norva.invalid/current.mp4',src:'https://norva.invalid/current.mp4',
        currentSrc:'https://norva.invalid/current.mp4',error:{code:4,message:'format unsupported'},dataset:{playbackAttemptId:'2'}};
    page.isStalePlaybackAttempt=()=>false;page.hasCurrentMedia=()=>false;
    page.isCloudPlaybackMode=()=>false;page.retryGatewaySeekAfterFatalPlayback=()=>false;
    page.sendPlaybackEvent=()=>{};page.handlePlaybackFailure=async()=>{recovered=true;};
    page.onError({}); await Promise.resolve(); assert.equal(recovered,true);
});
test('resume capture uses decoded absolute position, never the stale history or requested seek destination', () => {
    const page = playing(watch());
    assert.equal(page.captureCloudResumePosition(), 315.5);
    page.contentType = 'series'; assert.equal(page.captureCloudResumePosition(), 315.5);
    for (const change of [p => p.contentType = 'channel', p => p.currentCloudPlaybackSessionId = null,
        p => p.video.currentTime = 0, p => p.video.readyState = 0, p => p.video.error = {},
        p => p.video.ended = true, p => p.video.seeking = true, p => p._pendingLocalSeekTarget = 15,
        p => p._pendingHlsAudioSwitch = {}, p => p.streamStartOffset = Infinity]) {
        const invalid = playing(watch()); change(invalid); assert.equal(invalid.captureCloudResumePosition(), null);
    }
});
test('one current-session clock cannot contaminate an old unclosed session', async () => {
    const calls = [];
    const page = playing(watch({ NorvaCloud: { token: 'fixture', playback: { expireSession: async (id, options) => {
        calls.push({ id, options }); return { session: { id, status: 'expired' }, gatewayErrors: 0 };
    } } } }));
    page.stopCloudPlaybackHeartbeat = () => {};
    page.activeCloudPlaybackSessionIds = new Set(['old', 'current']);
    page._unclosedCloudPlaybackSessionIds = new Set(['older']);
    await page.stopCloudPlaybackSessions({ strict: true, keepalive: true, resumePosition: 315.5 });
    assert.equal(calls.find(x => x.id === 'current').options.resumePosition, 315.5);
    for (const c of calls.filter(x => x.id !== 'current')) assert.equal(c.options.resumePosition, undefined);
    assert.ok(calls.every(c => c.options.keepalive === true && c.options.strict === undefined));
    assert.equal(page.currentCloudPlaybackSessionId, null);
});
test('page exit freezes the observed clock before history teardown and keeps expiry nonblocking', async () => {
    const page = playing(watch()); let sent;
    page.persistPlaybackStateForExit = () => { page.video.currentTime = 0; };
    page.stopCloudPlaybackSessions = async options => { sent = options; };
    page.persistPlaybackStateAndSessionsForExit();
    assert.equal(sent.resumePosition, 315.5); assert.equal(sent.keepalive, true);
});
function cloud(device) {
    const requests = [], token = device ? `nv_dev_${'D'.repeat(43)}` : 'fixture-access-token';
    const values = new Map([[device ? 'norva-cloud-device-token' : 'norva-cloud-token', token]]);
    const window = { location: { origin: 'https://norva.tv', search: '' } };
    const env = { window, localStorage: { getItem: k => values.get(k) || null, setItem: (k,v) => values.set(k,String(v)), removeItem: k => values.delete(k) },
        navigator: { userAgent: 'test', language: 'fr', languages: ['fr'] }, document: { readyState: 'loading', addEventListener() {} },
        fetch: async (url, options) => { requests.push({url, options}); return {ok:true,status:200,headers:{get:()=> 'application/json'},json:async()=>({gatewayErrors:0}),text:async()=>''}; },
        URL, URLSearchParams, AbortController, Intl, Date, Map, Set, WeakMap, Promise, Object, Array, String, Number, Boolean, RegExp, JSON, Math,
        console, performance:{now:()=>0}, setTimeout, clearTimeout };
    window.window=window; vm.runInNewContext(read('public/js/cloudApi.js'),env);
    return { api: device ? window.NorvaCloud.device.playback : window.NorvaCloud.playback, requests, token };
}
for (const device of [false, true]) test(`expiry transmits only a valid numeric clock with preserved ${device?'device':'user'} authentication`,async()=>{
    const {api,requests,token}=cloud(device);
    for(const value of [315.5, undefined, null, '315', NaN, Infinity, -1, 0, 86400]) await api.expireSession('session',{resumePosition:value,keepalive:true});
    assert.deepEqual(JSON.parse(requests[0].options.body),{resumePosition:315.5});
    for(const r of requests.slice(1)) assert.equal(r.options.body,undefined);
    for(const r of requests){assert.equal(r.options.headers.Authorization,`Bearer ${token}`); assert.equal(r.options.keepalive,true);assert.equal(r.options.resumePosition,undefined);}
});


test('normal stop captures before resetting the media clock; internal teardown keeps expiry body empty', async () => {
    for (const enqueueStoryboard of [true,false]) {
        const calls=[];
        const page=playing(watch({NorvaCloud:{token:'fixture',playback:{expireSession:async(id,options)=>{calls.push({id,options});}}}}));
        for (const name of ['clearPlaybackErrorRefreshTimer','hideLoading','abortPlaybackResolution','resetSubtitleSwitchFeedback',
            'cancelPendingHlsAudioSwitch','cancelFirstFrameTelemetryObserver','cancelDeferredEngineTrackEnrichment','clearPrivateMediaCacheAccess',
            'destroyEngine','stopSubtitleEngine','stopHistoryTracking','updateTranscodeStatus','clearExternalSubtitleTracks','updateDurationState',
            'stopCloudPlaybackHeartbeat']) page[name]=()=>{};
        page.stopTranscodeSession=async()=>{};
        page.activeCloudPlaybackSessionIds=new Set(['current']);
        let detached=false;
        page.video.pause=()=>{};
        page.video.removeAttribute=name=>{assert.equal(name,'src');detached=true;};
        Object.defineProperty(page.video,'src',{get:()=>detached?'':'https://norva.invalid/previous.mp4',
            set:()=>assert.fail('teardown must not navigate the media element to an empty document URL')});
        page.video.load=()=>{assert.equal(detached,true);page.video.currentTime=0;};
        await page.stop({enqueueStoryboard});
        assert.equal(calls.length,1);assert.equal(calls[0].options.resumePosition,enqueueStoryboard?315.5:null);
        assert.equal(page.video.currentTime,0);
    }
});
