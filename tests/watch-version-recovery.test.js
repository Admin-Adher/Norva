'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const read = path => fs.readFileSync(path, 'utf8');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const plain = value => JSON.parse(JSON.stringify(value));
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function fixture({ one = false, tv = false } = {}) {
    const events = [], ids = new Map();
    let panel, section, focused;
    class Element {
        constructor() { this.nodes = []; this.listeners = {}; this.dataset = {}; this.classList = { add(){}, remove(){}, toggle(){}, contains(){return false;} }; }
        set innerHTML(value) {
            this.html = value; this.nodes = [];
            for (const match of value.matchAll(/<(button|p)\b([^>]*)>/g)) {
                const child = new Element(); child.tagName = match[1];
                child.id = /\bid="([^"]+)"/.exec(match[2])?.[1];
                child.action = /data-recovery-action="([^"]+)"/.exec(match[2])?.[1];
                child.dataset.index = /data-index="([^"]+)"/.exec(match[2])?.[1];
                child.role = /role="([^"]+)"/.exec(match[2])?.[1];
                if (child.id) ids.set(child.id, child);
                this.nodes.push(child);
            }
        }
        get innerHTML() { return this.html || ''; }
        setAttribute() {} addEventListener(type, fn) { this.listeners[type] = fn; }
        click() { return this.disabled ? undefined : this.listeners.click?.(); }
        focus() { focused = this; } scrollIntoView() {} closest() { return section; }
        remove() { if (panel.recovery === this) panel.recovery = null; }
        insertAdjacentElement(_, node) { panel.recovery = node; }
        querySelectorAll(selector) {
            if (selector.includes('.movie-version-recovery')) return panel.recovery?.nodes.filter(n => n.tagName === 'button') || [];
            return this.nodes.filter(n => selector.includes('movie-version-item') ? n.dataset.index !== undefined : n.tagName === 'button');
        }
        querySelector(selector) {
            if (selector === '.movie-version-recovery') return this.recovery || null;
            if (selector.includes('.movie-version-recovery')) return this.recovery?.querySelector(selector.replace('.movie-version-recovery ', ''));
            if (selector.includes('role="status"')) return this.nodes.find(n => n.role === 'status');
            const action = /data-recovery-action="([^"]+)"/.exec(selector)?.[1];
            return action ? this.nodes.find(n => n.action === action) : this.nodes.find(n => n.tagName === 'button');
        }
    }
    panel = new Element(); section = new Element();
    const error = new Element(); ids.set('watch-error', error);
    const scope = {};
    const app = { currentUser: {id:'owner'}, currentPage:'watch', pages:{}, player:{async stop(){events.push('player-stop');}},
        navigateTo(page) { events.push('navigate'); this.currentPage = page; movies.beginFicheIntent(); } };
    const media = {
        escapeHtml:escape, orderVersionsByPreference:items => [...items],
        groupItems:items => [{key:'same-work',items,representative:items[0]}],
        versionDescriptor:item => ({headline:item.audio, meta:item.meta, accessibleHeadline:item.audio, tier:{cls:'preferred',label:'Recommended'}}),
        playbackHintFromItem:item => ({durationSeconds:item.durationSeconds}),
    };
    const refused = {capture:() => scope, markRefused(){events.push('mark');}, clear(){events.push('clear');}, has:item => item.stream_id === 'original', order:items=>items};
    const original = {sourceId:'source-A',stream_id:'original',name:'A film',audio:'English',meta:'Subtitles: French · Source A · MKV',container_extension:'mkv',durationSeconds:1000};
    const alternate = {sourceId:'source-B',stream_id:'alternate',name:'A film',audio:'Spanish',meta:'Subtitles: English · Source B · MP4',container_extension:'mp4',durationSeconds:900};
    const items = one ? [original] : [original,alternate];
    const api = {media:{async page(query){ events.push(['catalogue',plain(query)]); return {items}; }}, proxy:{xtream:{async getStreamUrl(...args){events.push(['resolve',plain(args.slice(0,5))]);return {url:'fixture-stream'};}}}};
    const sandbox = {window:{MediaUtils:media,NorvaPlaybackRefusals:refused}, MediaUtils:media, API:api, console:{log(){},warn(){},error(){}},
        document:{createElement:()=>new Element(),getElementById:id=>ids.get(id),querySelector:()=>section,documentElement:{classList:{contains:()=>tv}}},
        NorvaI18n:{t:(key,args)=>args.defaultValue.replace('{{position}}',args.position || '')},
        setTimeout:()=>0, clearTimeout, requestAnimationFrame:fn=>fn(), Date, Set, Promise};
    vm.runInNewContext(read('public/js/pages/WatchPage.js'),sandbox);
    vm.runInNewContext(read('public/js/pages/MoviesPage.js'),sandbox);
    const watch = Object.create(sandbox.window.WatchPage.prototype);
    const movies = Object.create(sandbox.window.MoviesPage.prototype);
    app.pages={watch,movies};
    Object.assign(watch,{app,content:{sourceId:'source-A',id:'original',type:'movie'},_playbackAttemptId:1,_fileRefusalScope:scope,
        clearPlaybackErrorRefreshTimer(){},getResumeSnapshotPosition:()=>123,
        async releasePlaybackPipelineForRetry(options){events.push(['drain',options?.strict]);},async waitForProviderSlotRelease(){events.push('cooldown');}});
    Object.assign(movies,{app,detailsPanel:panel,versionsList:new Element(),versionSummary:new Element(),serverSettings:{},
        _selectInProgressVersion:()=>null,getMovieWatchState:()=>({status:'unwatched',data:{}}),getSourceName:()=> 'Source',displayLanguageStatus:value=>value,
        showMovieDetails(group,selected,options) {
            if (!this.isFicheIntentCurrent(options.intentToken)) return false;
            this.currentMovieGroup=group;this.currentMovie=selected;this.currentMovieVersions=options.versions;
            events.push(['details',selected.stream_id,options.focusVersions]);this.renderMovieVersions(selected);return true;
        }, async playMovie(movie,options) {events.push(['play',movie,options]);},_loadPanelExtras(){}});
    return {app,watch,movies,sandbox,events,api,items,original,alternate,error,ids,panel,section,scope,get focused(){return focused;}};
}

test('error offers only explicit choices, marks exact file and preserves the selected copy on retry', async()=>{
    const f=fixture(); let retries=0;
    f.watch.retryPlaybackInPlace=()=>{retries++;};
    f.watch.showRefusedVersionRecovery(f.error,f.section);
    assert.match(f.error.innerHTML,/This version is unavailable/);
    assert.equal(f.focused,f.ids.get('watch-error-versions-btn'));
    assert.deepEqual(f.events,['mark']);
    f.ids.get('watch-error-refresh-btn').click();
    assert.equal(retries,1);assert.equal(f.watch.content.id,'original');
    assert.equal(f.events.filter(x=>Array.isArray(x)&&x[0]==='resolve').length,0);
});

test('Other versions drains first, exact lookup survives a navigation fiche intent, and does not play',async()=>{
    const f=fixture();
    assert.equal(await f.watch.openRefusedVersionDetails(true),true);
    assert.deepEqual(f.events.slice(0,3),[['drain',true],'cooldown',['catalogue',{type:'movie',sourceId:'source-A',externalId:'original',limit:1}]]);
    assert.equal(f.movies.currentMovie.stream_id,'original');
    assert.equal(f.movies.currentMovieVersions[1].stream_id,'alternate');
    assert.ok(f.events.some(e=>Array.isArray(e)&&e[0]==='details'&&e[2]===true));
    assert.equal(f.events.some(e=>Array.isArray(e)&&['play','resolve'].includes(e[0])),false);
    assert.match(f.movies.versionsList.innerHTML,/Subtitles: French/);
    assert.match(f.movies.versionsList.innerHTML,/Subtitles: English/);
    assert.match(f.movies.versionsList.innerHTML,/Refused during the last attempt/);
    f.movies._focusVersionsList();assert.equal(f.focused.dataset.index,'1');
});

test('the production App navigation order cannot overwrite the recovered fiche with an older restore',async()=>{
    const f=fixture();
    const appSource=read('public/js/app.js');
    const methods=appSource.slice(appSource.indexOf('    navigateTo(pageName, replaceHistory = false) {'),appSource.indexOf('    async refreshProviderAccessRollout() {'));
    f.sandbox.history={replaceState(){},pushState(){}};
    f.sandbox.document.querySelectorAll=()=>[];
    f.sandbox.document.body={classList:{toggle(){}}};
    const Navigation=vm.runInNewContext(`class Navigation {${methods}}; Navigation`,f.sandbox);
    Object.assign(f.app,{navigateTo:Navigation.prototype.navigateTo,applyPage:Navigation.prototype.applyPage,
        guardCatalogPage:page=>page,beginTvRouteTransition(){},readOpenFiche:()=>null,getPageScrollElement:()=>null,
        restorePageScroll(){},endTvRouteTransition(){},restoreNativeGridScroll(){},persistNativeContinuity(){}});
    f.watch.hide=()=>{f.watch._playbackAttemptId++;};
    let restoreToken;
    f.movies.show=()=>{restoreToken=f.movies.beginFicheIntent();};
    assert.equal(await f.watch.openRefusedVersionDetails(),true);
    assert.equal(f.movies.isFicheIntentCurrent(restoreToken),false);
    assert.equal(f.movies.currentMovie.stream_id,'original');
    assert.equal(f.app.currentPage,'movies');
    assert.equal(f.events.some(e=>Array.isArray(e)&&e[0]==='play'),false);
});

test('no alternative produces an honest single-file fiche; failed lookup does not invent siblings',async()=>{
    const f=fixture({one:true});
    assert.equal(await f.watch.openRefusedVersionDetails(true),true);
    assert.match(f.panel.recovery.innerHTML,/No other version is offered in your catalogue/);
    assert.equal(f.movies.currentMovieVersions.length,1);
    const g=fixture();g.api.media.page=async()=>{throw new Error('private provider URL');};
    g.watch.showRefusedVersionRecovery(g.error,g.section);
    assert.equal(await g.watch.openRefusedVersionDetails(true),false);
    assert.equal(g.app.currentPage,'watch');
    assert.match(g.ids.get('watch-error-version-status').textContent,/could not be loaded/);
    assert.equal(g.events.some(e=>Array.isArray(e)&&e[0]==='play'),false);
});

test('double clicks, Back/new attempt and owner changes cancel before catalogue or playback',async()=>{
    for(const change of [f=>{f.app.currentPage='home';},f=>{f.watch._playbackAttemptId++;},f=>{f.app.currentUser={id:'other'};},f=>{f.app.currentUser.id='other';}]){
        const f=fixture(), gate=deferred();f.watch.releasePlaybackPipelineForRetry=()=>gate.promise;
        const running=f.watch.openRefusedVersionDetails(true);
        assert.equal(await f.watch.openRefusedVersionDetails(true),false);
        change(f);gate.resolve();assert.equal(await running,false);
        assert.equal(f.events.length,0);
    }
    const f=fixture(),gate=deferred(),entered=deferred();f.api.media.page=()=>{entered.resolve();return gate.promise;};
    const opening=f.watch.openRefusedVersionDetails();await entered.promise;
    f.movies.beginFicheIntent();gate.resolve({items:f.items});
    assert.equal(await opening,false);assert.equal(f.app.currentPage,'watch');
});

test('TV OK selects a labelled copy, cancellation does not play, and resume is explicit',async()=>{
    const f=fixture({tv:true});await f.watch.openRefusedVersionDetails();
    const btn=f.movies.versionsList.querySelectorAll('.movie-version-item')[1];
    await btn.click();
    assert.match(f.panel.recovery.innerHTML,/Resume at 0:02:03/);
    assert.equal(f.events.some(e=>Array.isArray(e)&&e[0]==='play'),false);
    f.panel.recovery.querySelector('[data-recovery-action="cancel"]').click();
    assert.equal(f.events.some(e=>Array.isArray(e)&&e[0]==='play'),false);
    f.movies.renderPlaybackRecovery(f.alternate);
    const ownPrefs={audio:{streamIndex:2,language:'es'},subtitle:{source:'off'}};
    f.movies.getMovieWatchState=item=>({data:{playbackPreferences:item.stream_id==='alternate'?ownPrefs:{audio:{streamIndex:99}}}});
    await f.panel.recovery.querySelector('[data-recovery-action="resume"]').click();
    const played=f.events.find(e=>Array.isArray(e)&&e[0]==='play');
    assert.equal(played[1],f.movies.currentMovieVersions[1]);
    assert.equal(played[1].sourceId,'source-B');assert.equal(played[1].container_extension,'mp4');
    assert.equal(played[2].resumeTime,123);assert.equal(played[2].playbackPreferences,ownPrefs);
    assert.equal(played[2].versions[0],played[1]);
    assert.ok(f.events.findIndex(e=>Array.isArray(e)&&e[0]==='drain')<f.events.indexOf(played));
});

test('start over is zero; a target shorter than the previous position has no resume option',async()=>{
    const f=fixture();await f.watch.openRefusedVersionDetails();f.alternate.durationSeconds=100;f.movies.currentMovieVersions[1].durationSeconds=100;
    f.movies.renderPlaybackRecovery(f.alternate);
    assert.doesNotMatch(f.panel.recovery.innerHTML,/data-recovery-action="resume"/);
    assert.equal(await f.movies.playRecoveredVersion(f.alternate,123),false);
    await f.panel.recovery.querySelector('[data-recovery-action="start"]').click();
    assert.equal(f.events.find(e=>Array.isArray(e)&&e[0]==='play')[2].resumeTime,0);
});

test('malicious labels stay text, and a caller cannot substitute an unknown file',async()=>{
    const f=fixture();f.alternate.audio='<img src=x onerror=evil()>';f.alternate.meta='Subtitles "<script>evil()</script>';
    await f.watch.openRefusedVersionDetails();
    assert.doesNotMatch(f.movies.versionsList.innerHTML,/<script>|<img/);
    assert.match(f.movies.versionsList.innerHTML,/&lt;img/);
    assert.equal(await f.movies.playRecoveredVersion({sourceId:'foreign',stream_id:'alternate'},0),false);
    assert.equal(f.events.some(e=>Array.isArray(e)&&e[0]==='play'),false);
});

test('failed cleanup and navigation during cleanup cannot create another session',async()=>{
    const f=fixture();await f.watch.openRefusedVersionDetails();
    f.watch.releasePlaybackPipelineForRetry=async()=>{throw new Error('close failed');};
    assert.equal(await f.movies.playRecoveredVersion(f.alternate,0),false);
    assert.equal(f.events.some(e=>Array.isArray(e)&&e[0]==='play'),false);
    assert.match(f.panel.recovery.querySelector('[role="status"]').textContent,/could not be loaded/);
    const g=fixture();await g.watch.openRefusedVersionDetails();const gate=deferred();
    g.watch.releasePlaybackPipelineForRetry=()=>gate.promise;
    const playing=g.movies.playRecoveredVersion(g.alternate,0);
    assert.equal(await g.movies.playRecoveredVersion(g.alternate,0),false);
    g.app.currentPage='home';gate.resolve();assert.equal(await playing,false);
    assert.equal(g.events.some(e=>Array.isArray(e)&&e[0]==='play'),false);
});

test('strict cloud close retains only failed sessions, retries them only on explicit cleanup, default stays best effort',async()=>{
    const f=fixture();let fail=true;const closed=[];
    Object.assign(f.watch,{activeCloudPlaybackSessionIds:new Set(['ok','bad']),currentCloudPlaybackSessionId:'bad',stopCloudPlaybackHeartbeat(){}});
    f.sandbox.window.NorvaCloud={token:'fixture',playback:{async expireSession(id,options){closed.push(id);assert.deepEqual(plain(options),{});if(id==='bad'&&fail)throw new Error('close refused');return {session:{id,status:'expired'},gatewayErrors:0};}}};
    await assert.rejects(f.watch.stopCloudPlaybackSessions({strict:true}),/could not be closed/);
    assert.deepEqual([...f.watch.activeCloudPlaybackSessionIds],['bad']);assert.equal(f.watch.currentCloudPlaybackSessionId,null);
    fail=false;await f.watch.stopCloudPlaybackSessions({strict:true});
    assert.deepEqual(closed,['ok','bad','bad']);assert.equal(f.watch.activeCloudPlaybackSessionIds.size,0);
    f.watch.activeCloudPlaybackSessionIds.add('bad');fail=true;
    await f.watch.stopCloudPlaybackSessions();assert.equal(f.watch.activeCloudPlaybackSessionIds.size,0);
    await assert.rejects(f.watch.stopCloudPlaybackSessions({strict:true}),/could not be closed/);
    assert.deepEqual([...f.watch.activeCloudPlaybackSessionIds],['bad']);
});

test('strict expiry rejects incomplete 200 responses, but exact 404 is an idempotent close',async()=>{
    for(const reply of [undefined,{}, {session:{id:'different',status:'expired'},gatewayErrors:0},
        {session:{id:'bad',status:'active'},gatewayErrors:0}, {session:{id:'bad',status:'expired'},gatewayErrors:1},
        {session:{id:'bad',status:'expired'},gatewayErrors:null}]) {
        const f=fixture();Object.assign(f.watch,{activeCloudPlaybackSessionIds:new Set(['bad']),stopCloudPlaybackHeartbeat(){}});
        f.sandbox.window.NorvaCloud={token:'fixture',playback:{expireSession:async()=>reply}};
        await assert.rejects(f.watch.stopCloudPlaybackSessions({strict:true}),/could not be closed/);
        assert.deepEqual([...f.watch.activeCloudPlaybackSessionIds],['bad']);
    }
    const f=fixture();Object.assign(f.watch,{activeCloudPlaybackSessionIds:new Set(['gone']),stopCloudPlaybackHeartbeat(){}});
    f.sandbox.window.NorvaCloud={token:'fixture',playback:{expireSession:async()=>{throw Object.assign(new Error('gone'),{status:404});}}};
    await f.watch.stopCloudPlaybackSessions({strict:true});assert.equal(f.watch.activeCloudPlaybackSessionIds.size,0);
});

test('strict close preserves keepalive and the exact abort signal without mutating caller options',async()=>{
    const f=fixture();const signal={aborted:false};const options={strict:true,keepalive:true,signal};
    Object.assign(f.watch,{activeCloudPlaybackSessionIds:new Set(['owned-session']),stopCloudPlaybackHeartbeat(){}});
    f.sandbox.window.NorvaCloud={token:'fixture',playback:{async expireSession(id,forwarded){
        assert.equal(id,'owned-session');assert.equal(forwarded.keepalive,true);assert.equal(forwarded.signal,signal);
        assert.equal(Object.hasOwn(forwarded,'strict'),false);
        return {session:{id,status:'expired'},gatewayErrors:0};
    }}};
    await f.watch.stopCloudPlaybackSessions(options);
    assert.equal(options.strict,true);assert.equal(options.signal,signal);assert.equal(options.keepalive,true);
});

test('strict transcode close settles every stop and retains only failed identifiers',async()=>{
    const f=fixture();const closed=[];
    Object.assign(f.watch,{activeSessionIds:new Set(['ok','bad']),currentSessionId:'bad'});
    f.sandbox.fetch=async url=>{closed.push(url);return {ok:url.endsWith('/ok'),status:500};};
    await assert.rejects(f.watch.stopTranscodeSession({strict:true}),/could not be closed/);
    assert.equal(closed.length,2);assert.deepEqual([...f.watch.activeSessionIds],['bad']);
});
