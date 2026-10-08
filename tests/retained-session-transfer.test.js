'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const http = require('node:http');
const { RetainedSessionTransfer } = require('../services/media-gateway/src/retained-session-transfer');
const { RetainedInputBarrier } = require('../services/media-gateway/src/retained-input-barrier');
const { canonicalResumeProfile } = require('../services/media-gateway/src/private-resume-profile');
const { sampleProof, samplesMatch } = require('../services/media-gateway/src/recent-resume-samples');
const { parseResumeMediaPlaylist } = require('../services/media-gateway/src/private-resume-hls-cache');
const source = fs.readFileSync(path.join(__dirname, '../services/media-gateway/src/index.js'), 'utf8').replace(/\r\n/g, '\n');
function section(start, end) {
    const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
    assert.ok(a >= 0 && b > a); return source.slice(a, b);
}
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
const N = 65536, target = 'c'.repeat(64), owner = 'a'.repeat(64);
const samples = [0, N, 2*N, 3*N].map(start => ({ start, payload: Buffer.alloc(N, 7) }));
const playlist = '#EXTM3U\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-MEDIA-SEQUENCE:0\n'
    + [0,1,2,3].map(n => `#EXTINF:4,\ns${n}.ts\n`).join('');
function harness({ drain, validation, gate = true } = {}) {
    const sessions = new Map(), activeVideoEncoderAdmissions = new Set(), counts = { stop: 0, releases: 0, validation: 0, commits: 0, socket: 1 };
    let timer, now = Date.now();
    const ctx = { RetainedSessionTransfer, crypto, Date, Set, Buffer, Number, Promise, AbortController,
        sampleProof, samplesMatch, canonicalResumeProfile, parseResumeMediaPlaylist,
        asRecord: x => x && typeof x === 'object' ? x : {}, sha256Hex: s => crypto.createHash('sha256').update(s).digest('hex'),
        retainedSessionOwnerGate: x => gate && x === owner, canUsePrivateResumeCache: () => gate,
        canUseRecentResumeSamples: () => gate, randomToken: () => crypto.randomBytes(32).toString('hex'),
        sessions, activeVideoEncoderAdmissions, DEFAULT_TTL_SECONDS: 600, exactSubtitleHlsEnabled: s => s.subtitles,
        multiAudioHlsEnabled: () => false, readPrivateResumeAsset: async s => Buffer.from(s.playlist),
        fileSizeBytesForSession: s => s.size, recentDeliveryRouteKey: s => s.route,
        timingSafeEqual: (a,b) => a === b,
        app: { delete: (_path, _auth, handler) => { ctx.deleteHandler = handler; } },
        requireGatewayAuth: () => {}, compactRecord: x => x,
        privateFinalCodecProfileForSession: () => null,
        privateFinalCodecProfileAfterPendingCacheWork: async () => { await ctx.profilePending; return null; },
        revalidateRecentResumeSession: async (lookup, plan, signal) => {
            counts.validation++; assert.equal(counts.socket, 0, 'old transport drained before validation');
            assert.equal(plan.kind, 'sampled-recent-v1');
            return validation ? validation(lookup, signal) : { samples, fileSizeBytes: 8*N, effectiveUrlIdentitySha256: target, effectiveUrlSha256: target };
        },
    };
    ctx.stopSession = async session => {
        if (session.stoppingPromise) return session.stoppingPromise;
        ctx.retainedSessionTransfer.forget(session); session.status = 'stopping';
        session.primaryViewerAttached = false;
        session.stoppingPromise = (async()=>{
            counts.stop++; await session.finiteMkvSeekBroker.close();
            session.ffmpeg.exitCode = 0; session.ffmpeg = null;
            counts.releases++; session.status = 'ended'; sessions.delete(session.id);
        })();
        return session.stoppingPromise;
    };
    ctx.retainedSessionTransfer = new RetainedSessionTransfer({ stop: s => ctx.stopSession(s),
        revoke: s => api.revokeSessionPlaybackAccess(s), now: () => now,
        setTimer: fn => { timer = fn; return 1; }, clearTimer: () => { timer = null; } });
    const code = section('function retainedSessionRequestBinding(', 'function privateResumeNeedsMp4Preparation(')
        + section('function requirePlaybackToken(', 'function cors(')
        + section('function isSessionBlockingProviderSlot(', 'function stopChildProcess(')
        + section("app.delete('/sessions/:id',", "app.get('/sessions/:id/playlist.m3u8',");
    const api = vm.runInNewContext(`(()=>{${code};return { retainedSessionRequestBinding, tryParkRetainedSession,
        tryResumeRetainedSession, acknowledgeRetainedViewerSegment, revokeSessionPlaybackAccess, requirePlaybackToken, isSessionBlockingProviderSlot };})()`, ctx);
    const session = { id: 'old', ownerKey: owner, retainedRequestBinding: 'binding', retainedInputScope: {},
        boundedHlsOutput: true, hlsOutputReservation: {}, status: 'ready', sourceUrl: 'http://synthetic.invalid/movie',
        size: 8*N, route: 'pinned', actualStartOffset: 100, seekOffset: 100, playlist,
        expiresAt: new Date(Date.now()+60000), ffmpeg: { exitCode: null, signalCode: null },
        primaryViewerAttached: true, accessToken: 'old-token', startupTimings: {},
        vodInputEffectiveUrlIdentitySha256: target, vodInputEffectiveUrlSha256: target, playbackSessionId: 'old-playback',
        viewerAttachments: { clear() {}, authorize() { return null; } } };
    let barrier;
    barrier = new RetainedInputBarrier({ scope: session.retainedInputScope, ttlMs: 10000,
        onClose: () => { counts.socket = 0; if(session.retainedSessionState) session.retainedInputInterrupted = true; } });
    session.finiteMkvSeekBroker = {
        parkRetainedInput: scope => barrier.park(scope, async()=> { if(drain) await drain.promise; counts.socket = 0; }),
        resumeRetainedInput: (token, scope, validate, commit) => barrier.resume(token, scope, validate, () => {
            assert.equal(counts.socket, 0); counts.commits++; const ok = commit(); counts.socket = ok ? 1 : 0; return ok;
        }),
        snapshotRecentSamples: () => samples,
        close: async()=> { barrier.close(); await barrier.waitForValidation(); },
    };
    sessions.set(session.id, session);
    const lookup = { ownerKey: owner, seekOffset: 105, size: 8*N, route: 'pinned' };
    const request = (extra={}) => ({ lookup: { ...lookup }, binding: 'binding', playbackSessionId: 'new-playback',
        signal: new AbortController().signal, expiresAt: new Date(Date.now()+90000).toISOString(), ...extra });
    const remove = async () => {
        const req = { params: { id: 'old' }, query: { resumePosition: 105 } };
        const res = { statusCode: 200, status(n) { this.statusCode=n;return this; }, json(payload) { this.payload=payload;return this; } };
        await ctx.deleteHandler(req,res);return res;
    };
    return { ...api, session, sessions, activeVideoEncoderAdmissions, counts, request, remove, setProfilePending: p => { ctx.profilePending=p; }, transfer: ctx.retainedSessionTransfer,
        getTimer: () => timer,
        stop: () => ctx.stopSession(session), expire: async()=> { now += 10001; await timer?.(); },
        setNow: x => { now = x; }, get now() { return now; } };
}

test('session transfer revokes first, drains, revalidates and atomically rekeys the same decoder', async t => {
    const drain = deferred(), h = harness({ drain }); t.after(h.stop);
    const child = h.session.ffmpeg, reservation = h.session.hlsOutputReservation;
    const parked = h.tryParkRetainedSession(h.session, 105);
    await new Promise(setImmediate);
    assert.equal(h.session.primaryViewerAttached, false); assert.notEqual(h.session.accessToken, 'old-token');
    assert.equal(h.isSessionBlockingProviderSlot(h.session), true); assert.equal(h.counts.socket, 1);
    drain.resolve(); assert.equal(await parked, true);
    assert.equal(h.isSessionBlockingProviderSlot(h.session), false);
    const result = await h.tryResumeRetainedSession(h.request());
    assert.equal(result, h.session); assert.notEqual(result.id, 'old'); assert.equal(h.sessions.has('old'), false);
    assert.equal(result.ffmpeg, child); assert.equal(result.hlsOutputReservation, reservation);
    assert.equal(result.seekOffset, 100); assert.equal(result.actualStartOffset, 100);
    assert.equal(result.localSeekTarget, 5); assert.equal(result.retainedResumePosition, 105);
    assert.equal(result.playbackSessionId, 'new-playback'); assert.equal(result.status, 'ready');
    assert.equal(h.counts.validation, 1); assert.equal(h.counts.commits, 1); assert.equal(h.counts.releases, 0);
    assert.equal(await h.tryResumeRetainedSession(h.request()), null, 'no replay');
});

test('encoder reservation follows the adopted session and releases through the ordinary cleanup', async t => {
    const h=harness();t.after(h.stop);
    h.session.videoEncoderAdmissionHeld=true;h.activeVideoEncoderAdmissions.add('old');
    assert.equal(await h.tryParkRetainedSession(h.session,105),true);
    const result=await h.tryResumeRetainedSession(h.request());assert.equal(result,h.session);
    assert.equal(h.activeVideoEncoderAdmissions.has('old'),false);
    assert.equal(h.activeVideoEncoderAdmissions.has(result.id),true);
    assert.equal(h.activeVideoEncoderAdmissions.size,1);
    const release=vm.runInNewContext(`(${section('function releaseVideoEncoderAdmission(', '// sourceUrl ->')})`,
        {activeVideoEncoderAdmissions:h.activeVideoEncoderAdmissions});
    release(result);assert.equal(h.activeVideoEncoderAdmissions.size,0);
});

test('a sliding retained playlist rebases the new viewer while preserving the decoder clock', async t => {
    const h=harness();t.after(h.stop);
    h.session.playlist=playlist.replace('MEDIA-SEQUENCE:0','MEDIA-SEQUENCE:7');
    let origin=28;
    h.session.hlsOutputAdmission={resumePlaylistClock:{originFor:()=>origin}};
    assert.equal(await h.tryParkRetainedSession(h.session,133),true);
    const result=await h.tryResumeRetainedSession(h.request({lookup:{...h.request().lookup,seekOffset:133}}));
    assert.equal(result,h.session);
    assert.equal(result.actualStartOffset,100,'encoder origin remains unchanged');
    assert.equal(result.retainedViewerStartOffset,128);
    assert.equal(result.localSeekTarget,5);
    assert.equal(result.retainedViewerStartOffset+result.localSeekTarget,133);
    assert.equal(result.retainedViewerFirstPlaylist.text,h.session.playlist);
    h.acknowledgeRetainedViewerSegment(result, 'subtitle_0-00001.vtt', result.id);
    assert.ok(result.retainedViewerFirstPlaylist, 'subtitle does not release video origin');
    h.acknowledgeRetainedViewerSegment(result, 'not-in-snapshot.ts', result.id);
    assert.ok(result.retainedViewerFirstPlaylist, 'unrelated output does not release video origin');
    h.acknowledgeRetainedViewerSegment(result, result.retainedViewerFirstPlaylist.segments[0], 'old');
    assert.ok(result.retainedViewerFirstPlaylist, 'late old response cannot release the new viewer origin');
    h.acknowledgeRetainedViewerSegment(result, result.retainedViewerFirstPlaylist.segments[0], result.id);
    assert.equal(result.retainedViewerFirstPlaylist, null);
});

test('the resume position is checked again after identity validation advances the window', async t => {
    let h;
    h=harness({validation:async()=>{
        h.session.playlist=playlist.replace('MEDIA-SEQUENCE:0','MEDIA-SEQUENCE:9');
        h.session.hlsOutputAdmission={resumePlaylistClock:{originFor:()=>36}};
        return {samples,fileSizeBytes:8*N,effectiveUrlIdentitySha256:target,effectiveUrlSha256:target};
    }});t.after(h.stop);
    assert.equal(await h.tryParkRetainedSession(h.session,105),true);
    assert.equal(await h.tryResumeRetainedSession(h.request()),null);
    assert.equal(h.counts.commits,0);
    assert.equal(h.counts.releases,1);
});

test('missing encoder reservation refuses adoption before exposing a new access', async t => {
    const h=harness();t.after(h.stop);h.session.videoEncoderAdmissionHeld=true;
    assert.equal(await h.tryParkRetainedSession(h.session,105),true);
    assert.equal(await h.tryResumeRetainedSession(h.request()),null);
    assert.equal(h.session.id,'old');assert.equal(h.counts.stop,1);
});

test('real HTTP old media response is destroyed and old token stays revoked after transfer', async t => {
    const h = harness(); t.after(h.stop);
    const server = http.createServer((req,res) => {
        const url = new URL(req.url, 'http://localhost');
        req.params = { id: url.pathname.slice(1) }; req.query = Object.fromEntries(url.searchParams);
        res.status = n => { res.statusCode = n; return res; }; res.send = text => res.end(text);
        h.requirePlaybackToken(req,res,()=> { res.write('media'); if(!url.searchParams.has('hold')) res.end(); });
    });
    await new Promise(r => server.listen(0,'127.0.0.1',r));
    t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const old = await fetch(origin+'/old?token=old-token&hold=1'); const reader = old.body.getReader();
    assert.equal((await reader.read()).done, false);
    const ended = reader.read().then(()=>false,()=>true);
    assert.equal(await h.tryParkRetainedSession(h.session,105), true); assert.equal(await ended,true);
    assert.equal((await fetch(origin+'/old?token=old-token')).status,401);
    await h.tryResumeRetainedSession(h.request());
    assert.equal((await fetch(origin+'/old?token=old-token')).status,404);
    assert.equal((await fetch(origin+'/'+h.session.id+'?token=old-token')).status,401);
    const next = await fetch(origin+'/'+h.session.id+'?token='+h.session.accessToken);
    assert.equal(next.status,200); assert.equal(await next.text(),'media');
});

test('actual DELETE handler duplicates wait for drain and cannot kill the adopted session', async t=>{
    const drain=deferred(),h=harness({drain});t.after(h.stop);
    const first=h.remove();await new Promise(setImmediate);
    let duplicateSettled=false;const duplicate=h.remove().then(r=>{duplicateSettled=true;return r;});
    await new Promise(setImmediate);assert.equal(duplicateSettled,false);
    drain.resolve();assert.equal((await first).payload.success,true);assert.equal((await duplicate).payload.success,true);
    await h.tryResumeRetainedSession(h.request());
    assert.equal((await h.remove()).statusCode,404);assert.equal(h.session.status,'ready');assert.equal(h.counts.stop,0);
});
test('late DELETE that captured the old object before handoff rechecks its ID after awaiting work',async t=>{
    const wait=deferred(),h=harness();t.after(h.stop);h.setProfilePending(wait.promise);
    const late=h.remove();await new Promise(setImmediate);
    await h.tryParkRetainedSession(h.session,105);await h.tryResumeRetainedSession(h.request());
    wait.resolve();assert.equal((await late).statusCode,404);assert.equal(h.counts.stop,0);
});

for (const [label, mutate] of [
    ['another owner', r => { r.binding='different-owner'; }],
    ['another file or track', r => { r.binding='changed-profile'; }],
]) test(`${label} cannot acquire the parked decoder`, async t => {
    const h=harness();t.after(h.stop);await h.tryParkRetainedSession(h.session,105);
    const r=h.request();mutate(r);assert.equal(await h.tryResumeRetainedSession(r),null);
    assert.equal(h.counts.validation,0);assert.equal(h.session.status,'retained');
});
for (const [label, mutate] of [
    ['different route', r => { r.lookup.route='changed'; }],
    ['different size', r => { r.lookup.size++; }],
    ['arbitrary seek', r => { r.lookup.seekOffset=109; }],
]) test(`${label} disposes the decoder before ordinary fallback`, async t => {
    const h=harness();t.after(h.stop);await h.tryParkRetainedSession(h.session,105);
    const r=h.request();mutate(r);assert.equal(await h.tryResumeRetainedSession(r),null);
    assert.equal(h.counts.validation,0);assert.equal(h.counts.releases,1);assert.equal(h.session.retainedInputInterrupted,true);
});
test('changed source bytes at identical target and size are rejected after fresh validation', async t=>{
    const h=harness({validation:async()=>({samples:samples.map(s=>({...s,payload:Buffer.alloc(N,8)})),
        fileSizeBytes:8*N,effectiveUrlIdentitySha256:target,effectiveUrlSha256:target})});t.after(h.stop);
    await h.tryParkRetainedSession(h.session,105);assert.equal(await h.tryResumeRetainedSession(h.request()),null);
    assert.equal(h.counts.validation,1);assert.equal(h.counts.commits,0);assert.equal(h.counts.releases,1);
});
test('expiry and a late timer cannot admit the decoder or certify its exit as complete', async t=>{
    const h=harness();t.after(h.stop);await h.tryParkRetainedSession(h.session,105);
    h.setNow(h.now+10000);assert.equal(await h.tryResumeRetainedSession(h.request()),null);
    assert.equal(h.session.retainedInputInterrupted,true);assert.equal(h.counts.releases,1);
});
for(const [name,changed] of [['rotated signed URL',{effectiveUrlSha256:'f'.repeat(64)}],
    ['changed validator',{validator:{kind:'etag',value:'"new"'}}]]) test(`${name} refuses equal samples for the retained original transport`,async t=>{
    const h=harness({validation:async()=>({samples,fileSizeBytes:8*N,effectiveUrlIdentitySha256:target,
        effectiveUrlSha256:target,...changed})});t.after(h.stop);
    await h.tryParkRetainedSession(h.session,105);assert.equal(await h.tryResumeRetainedSession(h.request()),null);
    assert.equal(h.counts.commits,0);assert.equal(h.counts.releases,1);
});
test('FFmpeg exit zero after interrupted retention cannot promote a complete HLS cache',async()=>{
    const {EventEmitter}=require('node:events');
    for(const interrupted of [false,true]) {
        const child=new EventEmitter(),done=deferred(),session={status:'ready',retainedInputInterrupted:interrupted};
        const code=section("    child.on('exit', async (code, signal) => {\n        try {\n            releaseVideoEncoderAdmission(session);", "    child.on('close', async () => {\n        await exitFinalization;");
        vm.runInNewContext(code,{child,session,releaseVideoEncoderAdmission:()=>{},applyFiniteMkvSeekBrokerFailure:()=>{},
            pumpedMkvInput:false,inputPump:null,outputAdmission:null,linearSeekBridge:null,
            wakePlaybackBlockedQueues:()=>{},resolveExitFinalization:done.resolve});
        child.emit('exit',0,null);await done.promise;
        assert.equal(session.completeHlsCacheFfmpegCompletedCleanly,!interrupted);
    }
});
test('clock rollback rejects transfer', async t=>{
    const h=harness();t.after(h.stop);await h.tryParkRetainedSession(h.session,105);
    h.setNow(h.now-1);assert.equal(await h.tryResumeRetainedSession(h.request()),null);assert.equal(h.counts.releases,1);
});
test('a late old expiry callback cannot stop an adopted or newly parked session',async t=>{
    const h=harness();t.after(h.stop);await h.tryParkRetainedSession(h.session,105);const oldTimer=h.getTimer();
    await h.tryResumeRetainedSession(h.request());oldTimer();await new Promise(setImmediate);
    assert.equal(h.counts.stop,0);assert.equal(h.session.status,'ready');
    await h.tryParkRetainedSession(h.session,105);oldTimer();await new Promise(setImmediate);
    assert.equal(h.counts.stop,0);assert.equal(h.session.status,'retained');
});
test('request abort and owner revocation wait for validation drain before releasing reservations', async t=>{
    const enter=deferred(), drain=deferred();let validationSignal;
    const h=harness({validation:async(_,signal)=>{validationSignal=signal;enter.resolve();await drain.promise;return null;}});t.after(h.stop);
    await h.tryParkRetainedSession(h.session,105);const abort=new AbortController();
    const resumed=h.tryResumeRetainedSession(h.request({signal:abort.signal}));await enter.promise;
    assert.equal(h.isSessionBlockingProviderSlot(h.session),true);
    assert.equal(await h.tryResumeRetainedSession(h.request()),null,'parallel transfer cannot validate twice');
    abort.abort();const stopped=h.stop();await new Promise(setImmediate);
    assert.equal(validationSignal.aborted,true);assert.equal(h.counts.releases,0);
    drain.resolve();await stopped;assert.equal(await resumed,null);assert.equal(h.counts.releases,1);
    assert.equal(h.counts.validation,1);assert.equal(h.sessions.size,0);
});
test('failed drain revokes old media and releases resources',async t=>{
    const h=harness({drain:{promise:Promise.resolve()}});t.after(h.stop);
    h.session.finiteMkvSeekBroker.parkRetainedInput=async()=>{throw Error('drain failed');};
    assert.equal(await h.tryParkRetainedSession(h.session,105),false);assert.equal(h.counts.releases,1);
    assert.equal(h.session.primaryViewerAttached,false);
});
test('park requires output reservation, running decoder and available timeline',async t=>{
    for(const change of [s=>{s.hlsOutputReservation=null;},s=>{s.ffmpeg.exitCode=0;},
        s=>{s.playlist+='#EXT-X-ENDLIST\n';},s=>{s.actualStartOffset=1000;},s=>{s.privateResumeLease={};}]) {
        const h=harness();t.after(h.stop);change(h.session);
        assert.equal(await h.tryParkRetainedSession(h.session,105),false);assert.equal(h.counts.validation,0);
    }
});
test('only one parked producer fits and a completed transfer frees the retention slot',async t=>{
    const h=harness();t.after(h.stop);await h.tryParkRetainedSession(h.session,105);
    const second={...h.session,status:'ready'};
    assert.equal(await h.transfer.park(second,'binding2',105),false);
    await h.tryResumeRetainedSession(h.request());
    assert.equal(await h.tryParkRetainedSession(h.session,105),true);
});
test('request binding is private, revision/track/config exact, order stable and disabled by default',async t=>{
    const h=harness();t.after(h.stop);const body={sourceUrl:'http://synthetic.invalid/movie',ownerKey:owner,
        playbackIdentity:{sourceId:'fixture',sourceRevision:'generation1',vodIdentityKey:'b'.repeat(64)},
        codecProfile:{audioCodec:'aac',tracks:[{index:1}]},seekOffset:10,playbackSessionId:'one',
        playbackHint:{seekOffset:10,container:'mkv'}};
    const binding=h.retainedSessionRequestBinding(body,owner);assert.match(binding,/^[a-f0-9]{64}$/);
    assert.equal(binding,h.retainedSessionRequestBinding({...body,seekOffset:99,playbackSessionId:'two',
        playbackHint:{container:'mkv',seekOffset:99}},owner));
    for(const changed of [{...body,audioStreamIndex:2},{...body,sourceUrl:'http://synthetic.invalid/other'},
        {...body,playbackIdentity:{...body.playbackIdentity,sourceRevision:'generation2'}},
        {...body,codecProfile:{audioCodec:'ac3'}}]) assert.notEqual(binding,h.retainedSessionRequestBinding(changed,owner));
    assert.equal(h.retainedSessionRequestBinding(body,'d'.repeat(64)),null);
    const disabled=harness({gate:false});t.after(disabled.stop);
    assert.equal(disabled.retainedSessionRequestBinding(body,owner),null);
});
