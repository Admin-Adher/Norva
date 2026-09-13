'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const vm=require('node:vm');
const {createEnrichmentPilotAdmission:create}=require('../services/media-gateway/src/enrichment-pilot-admission');
const passive=require('../services/media-gateway/src/passive-lid-capture');
const source=fs.readFileSync(path.join(__dirname,'../services/media-gateway/src/index.js'),'utf8').replace(/\r\n/g,'\n');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
function section(start,end) {
    const a=source.indexOf(start),b=source.indexOf(end,a+start.length);
    assert.ok(a>=0&&b>a);return source.slice(a,b);
}
function fixture() {
    let now=Date.now();const fileKey=hash('one-approved-file'),url='https://example.invalid/private/one.mkv';
    const target={fileKey,ownerHash:hash('test-owner'),sourceUrlHash:hash(url)};
    const config={protocol:1,createdAt:new Date(now).toISOString(),expiresAt:new Date(now+3600000).toISOString(),
        fileKeys:[fileKey],passiveTargets:[target]};
    const gate=create(config,{mode:'pilot',now:()=>now});
    const profile={metadataComplete:true,probeSource:'gateway_inband',probedAt:new Date(now).toISOString(),
        container:'mkv',durationSeconds:120,fileSizeBytes:1000000,audioTracks:[{index:1,codec:'aac',channels:2,default:true,language:'und'}]};
    const root=path.resolve(os.tmpdir(),'norva-passive-live-test');
    const session={id:'00000000-0000-4000-8000-000000000001',status:'ready',seekOffset:0,actualStartOffset:0,
        sourceTimestamps:false,ownerKey:target.ownerHash,sourceUrl:url,outputDir:path.join(root,'session'),
        codecProfile:profile,actualMappedAudioStreamIndex:1,
        targets:[{kind:'single',streamIndex:1,playlistName:'playlist.m3u8'}]};
    const sessions=new Map([[session.id,session]]);
    const context={path,sessions,OUTPUT_DIR:root,enrichmentPilot:gate,LANGUAGE_PASSIVE_CAPTURE_ENABLED:true,
        LANGUAGE_CAPTURE_PIPELINE_ENABLED:true,strictLidCaptureStore:{},passiveLidCapture:{},
        capturePipelineError:code=>Object.assign(new Error(code),{code}),
        sha256Hex:hash,isLiveSession:s=>s.live===true,isWithin:(parent,child)=>path.dirname(child)===parent,
        controlledLocalPlaylistName:name=>name==='playlist.m3u8',hlsMediaPlaylistTargetsForSession:s=>s.targets,
        ...passive};
    const authorize=vm.runInNewContext(`(${section('function authorizePassiveCanarySession(', '\n// Only origin-started')})`,context);
    const body=()=>({...target,sessionId:session.id,profileFingerprint:passive.passiveProfileFingerprint(session.codecProfile)});
    return {gate,target,config,session,sessions,context,authorize,body,expire:()=>{now+=3600000}};
}

test('immutable passive target alone grants no collection; current full observation is required',()=>{
    const f=fixture();assert.equal(f.gate.allowsPassive(),false);assert.equal(f.gate.snapshot().passiveSources,0);
    const body=f.body();const r=f.authorize(body);
    assert.equal(r.authorized,true);assert.equal(r.alreadyGranted,false);
    assert.equal(f.gate.allowsPassiveSource(body.ownerHash,body.sourceUrlHash,body.profileFingerprint),true);
    assert.equal(f.gate.allowsFile(hash('other-file')),false);
    assert.equal(f.authorize(body).alreadyGranted,true);assert.equal(f.gate.snapshot().passiveSources,1);
});

test('fresh in-band probedAt needs a fresh observed grant, not a weakened fingerprint',()=>{
    const f=fixture();const old=f.body();f.authorize(old);
    f.session.codecProfile={...f.session.codecProfile,probedAt:new Date(Date.now()+1000).toISOString()};
    const fresh=f.body();assert.notEqual(old.profileFingerprint,fresh.profileFingerprint);
    assert.equal(f.gate.allowsPassiveSource(fresh.ownerHash,fresh.sourceUrlHash,fresh.profileFingerprint),false);
    assert.throws(()=>f.authorize(old),{code:'PASSIVE_CANARY_NOT_ADMISSIBLE'});
    assert.equal(f.authorize(fresh).authorized,true);assert.equal(f.gate.snapshot().passiveSources,2);
    f.expire();assert.equal(f.gate.allowsPassive(),false);
    assert.throws(()=>f.authorize(fresh),{code:'ENRICHMENT_PILOT_CONFIG_INVALID'});
});

test('cannot widen exact account, URL or file, mutate configuration or extend expiry',()=>{
    for(const key of ['ownerHash','sourceUrlHash','fileKey']) {
        const f=fixture();const original=f.gate.snapshot().expiresAt;
        assert.throws(()=>f.authorize({...f.body(),[key]:hash('other')}));
        assert.equal(f.gate.snapshot().passiveSources,0);assert.equal(f.gate.snapshot().expiresAt,original);
    }
    const f=fixture();f.config.passiveTargets[0].fileKey=hash('other');f.config.fileKeys.push(hash('other'));
    assert.throws(()=>f.gate.authorizeObservedPassiveSource({...f.body(),sessionId:undefined}));
    assert.equal(f.gate.allowsFile(hash('other')),false);
});

test('no late authorization in disabled/fleet modes or without ready private capture runtime',()=>{
    for(const field of ['LANGUAGE_PASSIVE_CAPTURE_ENABLED','LANGUAGE_CAPTURE_PIPELINE_ENABLED','strictLidCaptureStore','passiveLidCapture']) {
        const f=fixture();f.context[field]=false;
        assert.throws(()=>f.authorize(f.body()),{code:'PASSIVE_CANARY_NOT_ADMISSIBLE'});
    }
    for(const mode of ['disabled','fleet']) {
        const f=fixture();f.context.enrichmentPilot=create(null,{mode});
        assert.throws(()=>f.authorize(f.body()),{code:'PASSIVE_CANARY_NOT_ADMISSIBLE'});
        const {sessionId,...grant}=f.body();assert.throws(()=>f.context.enrichmentPilot.authorizeObservedPassiveSource(grant));
    }
});

test('actual route function rejects foreign/missing/starting/live/seeking or unobserved sessions',()=>{
    for(const change of [{status:'starting'},{live:true},{seekOffset:60},{actualStartOffset:60},{sourceTimestamps:true},
        {ownerKey:hash('foreign')},{sourceUrl:'https://example.invalid/other.mkv'},{outputDir:path.resolve(os.tmpdir())},
        {codecProfile:{probeSource:'provider',audioTracks:[]}},{actualMappedAudioStreamIndex:null},{targets:[]}]) {
        const f=fixture();const body=f.body();Object.assign(f.session,change);
        assert.throws(()=>f.authorize(body),{code:'PASSIVE_CANARY_NOT_ADMISSIBLE'});
        assert.equal(f.gate.snapshot().passiveSources,0);
    }
    const f=fixture();const body=f.body();f.sessions.clear();assert.throws(()=>f.authorize(body));
});

test('known audio, malformed body and uncertain mapping never gain a grant',()=>{
    const cases=[null,[],{}, {...fixture().body(),extra:true}];
    for(const body of cases)assert.throws(()=>fixture().authorize(body));
    const f=fixture();f.session.codecProfile.audioTracks[0].language='eng';
    assert.throws(()=>f.authorize(f.body()));
    for(const streamIndex of [-1,129,1.2,null]) {
        const g=fixture();g.session.targets[0].streamIndex=streamIndex;
        assert.throws(()=>g.authorize(g.body()));
    }
});

test('runtime source grant count is bounded and cannot be replenished by caller object mutation',()=>{
    const f=fixture();const {sessionId,...grant}=f.body();
    for(let i=0;i<20;i++)f.gate.authorizeObservedPassiveSource({...grant,profileFingerprint:hash('profile-'+i)});
    assert.equal(f.gate.snapshot().passiveSources,20);
    assert.throws(()=>f.gate.authorizeObservedPassiveSource({...grant,profileFingerprint:hash('overflow')}));
    grant.ownerHash=hash('changed');assert.throws(()=>f.gate.authorizeObservedPassiveSource(grant));
    assert.equal(JSON.stringify(f.gate.snapshot()).includes(f.target.sourceUrlHash),false);
});

test('target config rejects missing, duplicate, foreign, oversized or unexpected fields',()=>{
    const base=fixture();
    for(const passiveTargets of [{},[base.target,base.target],Array(21).fill(base.target),
        [{...base.target,fileKey:hash('other')}],[{...base.target,profileFingerprint:hash('not-a-target-field')}],
        [{fileKey:base.target.fileKey,ownerHash:base.target.ownerHash}]]) {
        assert.throws(()=>create({...base.config,passiveTargets},{mode:'pilot'}),{code:'ENRICHMENT_PILOT_CONFIG_INVALID'});
    }
});

test('new route uses actual bearer auth and safe errors before it can bind a source',()=>{
    const routes=[];let calls=0;
    const context={GATEWAY_TOKEN:'service-test-token',timingSafeEqual:(a,b)=>a===b,
        authorizePassiveCanarySession:()=>{calls++;throw Error('private-url-must-not-leak')},
        app:{post:(...args)=>routes.push(args)}};
    vm.runInNewContext(section('function requireGatewayAuth(', '\nfunction requirePlaybackToken(')+'\n'+
        section("app.post('/language-enrichment/passive-canary'",'\n// Service-only import/playback hook.'),context);
    assert.equal(routes.length,1);const [route,auth,handler]=routes[0];assert.equal(route,'/language-enrichment/passive-canary');
    const res={statusCode:200,body:null,status(code){this.statusCode=code;return this},json(body){this.body=body;return this},setHeader(){}};
    for(const headers of [{},{authorization:'Bearer playback-token'}])auth({headers,query:{token:'service-test-token'}},res,()=>handler({},res));
    assert.equal(calls,0);assert.equal(res.statusCode,401);
    auth({headers:{authorization:'Bearer service-test-token'}},res,()=>handler({body:{}},res));
    assert.equal(calls,1);assert.equal(res.statusCode,409);assert.equal(JSON.stringify(res.body).includes('private-url'),false);
    const functionBody=section('function authorizePassiveCanarySession(', '\n// Only origin-started');
    assert.doesNotMatch(functionBody,/\b(?:fetch|spawn|stopSession|startSession|runWhisper|capture)\s*\(/);
});
