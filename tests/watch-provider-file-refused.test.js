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
        assert.ok(errorEl.innerHTML.includes(translations.ui_playback_version_unavailable_title[code]));
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
    assert.match(errorEl.innerHTML,/Access to this copy was refused/);
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

test('real Edge envelope and cloud client preserve file refusal through to the visible manual-retry error', async()=>{
    const {publicEdgeErrorPayload,bindCatalogVisibilityEpoch,finalizeCatalogVisibilityResponse}=await import('../supabase/functions/_shared/catalog-visibility-response.mjs');
    const gatewayBody={code:'PROVIDER_FILE_REFUSED',error:'This media file is currently unavailable.',
        upstreamStatus:403,url:'https://private.invalid/movie/SECRET/SECRET/file.mkv',diagnostic:'PRIVATE_DIAGNOSTIC'};
    // This is the same wrapping used by createGatewaySession before the handler catch.
    const wrapped=Object.assign(new Error('Media gateway refused the session'),{details:gatewayBody});
    let envelope=publicEdgeErrorPayload(wrapped,502,{unavailableMessage:'Norva Playback is temporarily unavailable'});
    assert.deepEqual(envelope,{error:'Norva Playback is temporarily unavailable',details:{code:'PROVIDER_FILE_REFUSED'}});
    // Authenticated dispatch sanitizes the error a second time after the catch.
    // Exercise that real boundary, with the exact epoch recheck still enforced.
    let epochReads=0;
    const db={async rpc(name){assert.equal(name,'norva_catalog_cache_epoch_v2');epochReads++;
        return {data:{contract:'catalog-cache-epoch-v2',globalEpoch:'1',userEpoch:'4',cacheEpoch:'v2.1.4'},error:null};}};
    const request=new Request('https://edge.test/norva-playback/session',{method:'POST'});
    await bindCatalogVisibilityEpoch(request,'fixture-owner-refusal',db);
    const finalized=await finalizeCatalogVisibilityResponse(request,new Response(JSON.stringify(envelope),{status:502}),db);
    assert.equal(finalized.status,502);assert.equal(epochReads,2);
    assert.equal(finalized.headers.get('cache-control'),'no-store');
    assert.equal(finalized.headers.get('x-norva-visibility-epoch'),'v2.1.4');
    envelope=await finalized.json();
    assert.deepEqual(envelope,{error:'Service temporarily unavailable',details:{code:'PROVIDER_FILE_REFUSED'}});
    const values=new Map([['norva-cloud-token','test-owner-token']]);
    const window={location:{origin:'https://norva.tv',search:''},NORVA_PLAYBACK_URL:'https://playback.test/functions/v1/norva-playback'};
    const requests=[];
    const context={window,localStorage:{getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,String(v)),removeItem:k=>values.delete(k)},
        navigator:{userAgent:'NorvaWeb',language:'fr-FR',languages:['fr-FR']},
        document:{readyState:'loading',addEventListener(){}},URL,URLSearchParams,AbortController,Intl,Date,Map,Set,WeakMap,Promise,
        console:{log(){},warn(){},debug(){},error(){}},performance:{now:()=>0},setTimeout,clearTimeout,
        fetch:async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return {status:502,ok:false,
            headers:{get:name=>name.toLowerCase()==='content-type'?'application/json':null},json:async()=>envelope,text:async()=>''};}};
    vm.runInNewContext(fs.readFileSync('public/js/cloudApi.js','utf8'),context);
    let error;
    try {await window.NorvaCloud.playback.createSession({sourceId:'owned-source',itemType:'movie',itemId:'selected-file',mode:'transcode'});}
    catch(value){error=value;}
    assert.ok(error);assert.equal(error.status,502);assert.equal(error.payload.details.code,'PROVIDER_FILE_REFUSED');
    assert.equal(requests.length,1,'the failed selected file creates no fallback or hidden retry');
    assert.equal(requests[0].body.itemId,'selected-file');
    const {page,errorEl,calls}=fixture('fr');
    page.showPlaybackError(page.getErrorText(error),{immediate:true,allowAutomaticRetry:false});
    assert.ok(errorEl.innerHTML.includes(translations.ui_playback_version_unavailable_title.fr));
    assert.doesNotMatch(errorEl.innerHTML,/SECRET|PRIVATE_DIAGNOSTIC|403|502|PROVIDER_FILE_REFUSED/);
    assert.equal(calls.scheduled,0);assert.equal(calls.switched,0);assert.equal(calls.retried,0);
});

test('public envelope still rejects neighbouring unapproved codes and provider details', async()=>{
    const {publicEdgeErrorPayload}=await import('../supabase/functions/_shared/catalog-visibility-response.mjs');
    for(const code of ['PROVIDER_FILE_REFUSED_PRIVATE','PRIVATE_PROVIDER_CODE']){
        const payload=publicEdgeErrorPayload(Object.assign(new Error('private'),{details:{code,upstreamStatus:403,password:'secret'}}),502);
        assert.deepEqual(payload,{error:'Service temporarily unavailable'});
    }
});
