'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('public/js/pages/WatchPage.js','utf8');
const translations=require('../i18n/web-tail.json');
function fixture(locale='en') {
    let retryClick=null;const calls={scheduled:0,retried:0,switched:0};
    const errorEl={innerHTML:'',classList:{add(){},remove(){},contains(){return false;}},setAttribute(){}};
    const videoSection={appendChild(){},classList:{add(){},remove(){}}};
    const ctx={window:{},console,Promise,setTimeout:()=>0,clearTimeout,
        document:{documentElement:{lang:locale},querySelector:()=>videoSection,createElement:()=>errorEl,
            getElementById(id){return id==='watch-error'?errorEl:id==='watch-error-refresh-btn'?{
                addEventListener(type,fn){if(type==='click')retryClick=fn;}}:null;}},
        NorvaI18n:{language:locale,t(key,args={}){return translations[key]?.[locale]||args.defaultValue||key;}}};
    vm.runInNewContext(source,ctx);
    const page=Object.create(ctx.window.WatchPage.prototype);
    Object.assign(page,{hasCurrentMedia:()=>false,shouldDeferPlaybackError:()=>false,
        clearDeferredPlaybackError(){},hideLoading(){},updateTranscodeStatus(){},trackProduct(){},
        isCloudPlaybackMode:()=>true,_preferredExplicitCloudMode:'transcode',
        schedulePlaybackErrorRefresh(){calls.scheduled++;return true;},clearPlaybackErrorRefreshTimer(){},
        retryPlaybackInPlace(){calls.retried++;},switchVersion(){calls.switched++;},
        content:{id:'selected-file',sourceId:'source',type:'movie',rawTitle:'Selected [MULTI-SUB]'},
        versionIndex:2,resumeTime:187});
    return {page,calls,errorEl,clickRetry:()=>retryClick()};
}

test('structured file refusal stays specific, localized and manual without replacing the selected version',()=>{
    for(const {code} of require('../i18n/locales.json')) {
        const {page,calls,errorEl,clickRetry}=fixture(code);
        const error={status:502,message:'Selected media request was refused',payload:{
            error:'Unable to create playback session',details:{code:'PROVIDER_FILE_REFUSED'}}};
        const text=page.getErrorText(error);
        assert.match(text,/PROVIDER_FILE_REFUSED/);
        assert.equal(page.getFriendlyPlaybackError(text),translations.ui_web_542c160150e3[code],code);
        assert.equal(page.isTerminalPlaybackError(text),true);
        assert.equal(page.playbackCoordinationRetryDelayMs(error,0,0),null);
        const selected=JSON.stringify({content:page.content,versionIndex:page.versionIndex,resumeTime:page.resumeTime});
        // Even a later error callback without resolver options must not silently retry this file.
        page.showPlaybackError(text,{immediate:true});
        assert.equal(calls.scheduled,0,code);
        assert.equal(calls.retried,0);assert.equal(calls.switched,0);
        assert.equal(JSON.stringify({content:page.content,versionIndex:page.versionIndex,resumeTime:page.resumeTime}),selected);
        assert.ok(errorEl.innerHTML.includes(translations.ui_web_542c160150e3[code]));
        assert.doesNotMatch(errorEl.innerHTML,/PROVIDER_FILE_REFUSED|502|datacenter|blocking cloud playback|Convert and play/);
        clickRetry();
        assert.equal(calls.retried,1);assert.equal(calls.switched,0);
        assert.equal(JSON.stringify({content:page.content,versionIndex:page.versionIndex,resumeTime:page.resumeTime}),selected);
    }
});

test('file refusal takes precedence over numeric diagnostics and never exposes private request data',()=>{
    const {page,errorEl}=fixture();
    const error={code:'PROVIDER_FILE_REFUSED',message:'request 403 https://private.test/movie/USER/PASS/movie.mkv',
        payload:{details:{upstreamStatus:403}}};
    page.showPlaybackError(page.getErrorText(error),{immediate:true});
    assert.match(errorEl.innerHTML,/temporarily unavailable for this stream/);
    assert.doesNotMatch(errorEl.innerHTML,/private\.test|USER|PASS|403|datacenter|TV\/mobile app|local hub/);
});

test('legacy authorization refusal no longer claims cloud blocking or promises a working device route',()=>{
    const {page,errorEl,calls}=fixture();
    for(const status of [401,403]) {
        const message=page.getFriendlyPlaybackError(`UPSTREAM_FORBIDDEN ${status}`);
        assert.match(message,/refused the stream/);
        assert.doesNotMatch(message,/blocking cloud|datacenter|Norva app/);
        page.showPlaybackError(`UPSTREAM_FORBIDDEN ${status}`,{immediate:true});
        assert.doesNotMatch(errorEl.innerHTML,/local hub|datacenter|Watch this title from/);
        assert.equal(calls.scheduled,0);
    }
});
