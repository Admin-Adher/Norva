'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const translations = {...require('../i18n/web-dynamic.json'),...require('../i18n/web-extra.json'),...require('../i18n/reviewed.json')};
function fixture(locale='en') {
    const ctx={window:{},Intl,console,URL,setTimeout,clearTimeout,document:{documentElement:{lang:locale}},
        NorvaI18n:{language:locale,t(key,args={}) {return (translations[key]?.[locale] || args.defaultValue || key)
            .replace(/\{\{(\w+)\}\}/g,(_,k)=>args[k] ?? '');}}};
    vm.createContext(ctx);
    for(const file of ['utils/mediaUtils','pages/HomePage','pages/MoviesPage','pages/WatchPage']) {
        vm.runInContext(fs.readFileSync(`public/js/${file}.js`,'utf8'),ctx);
        ctx.MediaUtils=ctx.window.MediaUtils;
    }
    return ctx;
}
const human=(language='es',index=1)=>({humanAudioLanguages:[language],humanAudioLanguageStatus:'human_confirmed',
    humanAudioLanguageScope:'file',humanAudioTrackLanguages:[{index,language}]});
const plain=value=>JSON.parse(JSON.stringify(value));

test('human listening confirmation labels the exact movie in all ten locales without claiming a probe or provider declaration',()=>{
    for(const {code} of require('../i18n/locales.json')) {
        const {MediaUtils:M}=fixture(code);
        const item={item_type:'movie',raw_title:'EN| Innocent Voices [SUB]',audioLanguageValidationStatus:'pending',
            subtitleLanguages:['en'],audioTracksScope:'file',audioTracks:[{index:1,lang:'und'}],...human()};
        const before=JSON.stringify(item),score=JSON.stringify(M.analyzeLanguageCompatibility(item,{preferredAudioLanguage:'es'}));
        const badge=M.catalogLanguageInfo(item);
        assert.equal(badge.headline,M.languageDisplayFull('es'),code);
        assert.equal(badge.audioSource,'human-confirmed');
        assert.equal(badge.languageStatus,'');
        assert.equal(M.versionLanguageBadge(item),M.languageDisplayFull('es'));
        assert.equal(M.versionDescriptor(item,{providerLanguageHints:true}).headline,M.languageDisplayFull('es'));
        assert.equal(M.audioLanguageValidationStatus(item),'pending');
        assert.deepEqual(plain(M.providerAudioLanguages(item)),[]);
        assert.equal(JSON.stringify(M.analyzeLanguageCompatibility(item,{preferredAudioLanguage:'es'})),score);
        assert.equal(JSON.stringify(item),before);
        assert.doesNotMatch(M.languageBadgeHtml(badge),/human_confirmed|provider|verified|Whisper/);
    }
});

test('display requires explicit human provenance and file scope, never title union or a raw supplied language',()=>{
    const {MediaUtils:M}=fixture();
    for(const patch of [{humanAudioLanguageStatus:null},{humanAudioLanguageStatus:'verified'},
        {humanAudioLanguageScope:null},{humanAudioLanguageScope:'title'},
        {humanAudioLanguages:['und','xx','zz','<script>','EN']}]) {
        const item={...human(),...patch};
        assert.deepEqual(plain(M.humanAudioLanguages(item)),[]);
        assert.equal(M.catalogLanguageInfo(item).headline,'Language unidentified');
    }
    const snake={human_audio_languages:['en','en'],human_audio_language_status:'human_confirmed',
        human_audio_language_scope:'file',human_audio_track_languages:[{index:2,language:'en'},{index:3,language:'fr'},
            {index:'1',language:'en'},{index:-1,language:'en'}]};
    assert.deepEqual(plain(M.humanAudioMetadata(snake)),human('en',2));
});

test('accepted file audio and known-empty maps retain precedence over human presentation',()=>{
    const {MediaUtils:M}=fixture();
    for(const status of ['verified','probed']) {
        assert.equal(M.catalogLanguageInfo({...human(),audioLanguageValidationStatus:status,
            audioTracksScope:'file',audioTracks:[{index:1,lang:'fr'}]}).headline,'French');
    }
    assert.equal(M.catalogLanguageInfo({...human(),audioLanguageValidationStatus:'probed',
        audioTracksScope:'file',audioTracks:[],audioProbedAt:'2026-10-04T12:00:00Z'}).headline,'Audio unavailable');
});

test('home default and selected version never inherit a sibling listening confirmation',()=>{
    const ctx=fixture(),M=ctx.MediaUtils,home=Object.create(ctx.window.HomePage.prototype);
    const parent={title:'Film',sourceId:'source',item_type:'movie',...human('es'),data:human('es')};
    const absent={sourceId:'source',item_id:'second',title:'Film'};
    const selected=home.homeVariantToMediaItem(absent,parent,'movie');
    assert.equal(M.catalogLanguageInfo(selected).headline,'Language unidentified');
    assert.deepEqual(plain(M.humanAudioLanguages(selected)),[]);
    assert.equal(M.catalogLanguageInfo({...parent,defaultVariant:absent}).headline,'Language unidentified');
    const own=home.homeVariantToMediaItem({...absent,...human('en')},parent,'movie');
    assert.equal(M.catalogLanguageInfo(own).headline,'English');
    assert.equal(M.catalogLanguageInfo({...parent,defaultVariant:{...absent,...human('en')}}).headline,'English');
});

test('movie launch and resume preserve each file confirmation and retain its separate provenance',async()=>{
    const ctx=fixture(),movies=Object.create(ctx.window.MoviesPage.prototype),watch=Object.create(ctx.window.WatchPage.prototype);
    let content; movies.app={pages:{watch:{play:async value=>{content=value;}}}};
    movies.getSourceName=()=> 'Provider'; movies.getMovieDisplayTitle=item=>item.name; movies.getItemYear=()=>2024;
    const a={stream_id:'a',sourceId:9,name:'Film',...human('es')},b={stream_id:'b',sourceId:9,name:'Film',...human('en')};
    await movies.playMovie(a,{versions:[a,b]});
    assert.deepEqual(plain(ctx.MediaUtils.humanAudioMetadata(content)),human('es'));
    assert.deepEqual(plain(ctx.MediaUtils.humanAudioMetadata(content.versions[1])),human('en'));
    assert.equal(content.audioLanguages,null);
    const saved=watch.sanitizeResumeContent(content);
    assert.deepEqual(plain(ctx.MediaUtils.humanAudioMetadata(saved)),human('es'));
    assert.deepEqual(plain(ctx.MediaUtils.humanAudioMetadata(saved.versions[1])),human('en'));
    assert.equal(saved.audioLanguageValidationStatus,'not_analyzed');
});

test('player labels only the confirmed absolute audio stream and keeps switching metadata untouched',()=>{
    const ctx=fixture(),page=Object.create(ctx.window.WatchPage.prototype);
    page.content={type:'movie',id:'file',...human('es',1)};
    page.audioLanguageValidationStatus='pending';
    page.audioTracks=[{index:1,language:'und',codec:'aac',channels:6,channelLayout:'5.1'},{index:3,language:'und',codec:'aac',channels:2}];
    const before=JSON.stringify({content:page.content,tracks:page.audioTracks});
    let rows=page.getProbeAudioTracks();
    assert.equal(rows[0].label,'Spanish · AAC · 5.1');
    assert.equal(rows[1].label,'Audio track 2 · AAC · Stereo');
    assert.equal(rows[0].language,undefined);
    assert.equal(rows[0].streamIndex,1);
    assert.equal(page.playingAudioVersionLabel(),null);
    assert.equal(page.isAudioLanguageVerified(),false);
    assert.equal(JSON.stringify({content:page.content,tracks:page.audioTracks}),before);
    page.audioTracks=[{index:3,language:'und',codec:'aac',channels:2}];
    assert.equal(page.getProbeAudioTracks()[0].label,'Audio track · AAC · Stereo');
    page.audioTracks=[{index:1,language:'fr',codec:'aac',channels:2}]; page.audioLanguageValidationStatus='probed';
    assert.equal(page.getProbeAudioTracks()[0].label,'French · AAC · Stereo');
});

test('fresh server response can clear a revoked or changed-file confirmation held by resume storage',()=>{
    const ctx=fixture(),page=Object.create(ctx.window.WatchPage.prototype);
    page.content={...human('es'),human_audio_languages:['es'],human_audio_language_status:'human_confirmed',human_audio_language_scope:'file'};
    const absent=page.playbackMetadataFromResult({playback:{humanAudioLanguages:[],humanAudioLanguageStatus:null,
        humanAudioLanguageScope:null,humanAudioTrackLanguages:[]}});
    page.refreshHumanAudioMetadata(absent);
    assert.deepEqual(plain(ctx.MediaUtils.humanAudioLanguages(page.content)),[]);
    assert.equal(page.content.human_audio_language_status,undefined);
    page.refreshHumanAudioMetadata(page.playbackMetadataFromResult({playback:human('en')}));
    assert.deepEqual(plain(ctx.MediaUtils.humanAudioLanguages(page.content)),['en']);
    page.refreshHumanAudioMetadata({});
    assert.deepEqual(plain(ctx.MediaUtils.humanAudioLanguages(page.content)),['en'],'legacy responses do not invent withdrawals');
});
