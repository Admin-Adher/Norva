'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createSelectionEnrichmentPolicy } = require('../services/media-gateway/src/selection-enrichment-policy');
const { createEnrichmentNetworkAdmission } = require('../services/media-gateway/src/enrichment-network-admission');
const feedId = 'herbert-tested-vod';
const host = 'media.example.invalid';
const config = () => ({ version:1, feeds:[{ feedId, hosts:[{host,maxParallel:2}] }] });
const claims = (overrides={}) => ({ selectionEnrichmentProtocol:1,selectionFeedId:feedId,url:`https://${host}/file.mp4`,...overrides });
const finish = (lease, details={}) => {
    assert.ok(lease);assert.equal(lease.release({providerDrained:true}),true);
    assert.equal(lease.observe({ok:true,drained:true,durationMs:1000,...details}),true);
};

test('only explicit known-feed exact-host policy grants an exception; future imports default to mono',()=>{
    assert.equal(createSelectionEnrichmentPolicy().resolve(claims()),null);
    const policy = createSelectionEnrichmentPolicy(config());
    for (const change of [{selectionEnrichmentProtocol:undefined},{selectionFeedId:'new-provider'},
        {selectionFeedId:'Norva Selection'},{url:'https://other.invalid/file.mp4'},
        {url:`https://user:password@${host}/file.mp4`},{url:`file://${host}/file.mp4`}]) assert.equal(policy.resolve(claims(change)),null);
    const grant=policy.resolve(claims());assert.ok(grant);
    assert.equal(policy.describe({...grant}),null,'copied or unsigned request objects are not capabilities');
    assert.throws(()=>grant.assertTarget('https://elsewhere.invalid/file.mp4'),{code:'SELECTION_ENRICHMENT_TARGET_NOT_APPROVED'});
    assert.throws(()=>grant.assertTarget(`http://${host}/file.mp4`),{code:'SELECTION_ENRICHMENT_TARGET_NOT_APPROVED'});
    for (const bad of [{...config(),version:2},{version:1,feeds:[{feedId:'client-import',hosts:[{host,maxParallel:2}]}]},
        {version:1,feeds:[{feedId,hosts:[{host:'*.invalid',maxParallel:2}]}]},
        {version:1,feeds:[{feedId,hosts:[{host,maxParallel:100}]}]},
        {version:1,feeds:[{feedId,hosts:[{host:'host.invalid/path',maxParallel:2}]}]},
        {version:1,feeds:[config().feeds[0],config().feeds[0]]}]) assert.throws(()=>createSelectionEnrichmentPolicy(bad),{code:'SELECTION_ENRICHMENT_POLICY_INVALID'});
});

test('Selection grows slowly inside a hard host/server cap and distinct mono accounts remain independent',()=>{
    const policy=createSelectionEnrichmentPolicy(config());const grant=policy.resolve(claims());
    const gate=createEnrichmentNetworkAdmission({selectionPolicy:policy});
    const acquire=()=>gate.acquire({accountKey:host,hostKey:host,selection:grant});
    for(let i=0;i<8;i++) {
        const first=acquire();assert.ok(first);assert.equal(acquire(),null);finish(first);
    }
    const first=acquire(),second=acquire();assert.ok(first);assert.ok(second);assert.equal(acquire(),null);
    assert.equal(first.release({providerDrained:false}),false);assert.equal(gate.snapshot().active,2);
    finish(first);finish(second);
    const a=gate.acquire({accountKey:'mono-a',hostKey:'unknown-provider.invalid',selection:{...grant}});
    assert.ok(a);assert.equal(gate.acquire({accountKey:'mono-a',hostKey:'unknown-provider.invalid'}),null);
    const b=gate.acquire({accountKey:'mono-b',hostKey:'unknown-provider.invalid'});assert.ok(b);
    finish(a);finish(b);
});

test('a refusal or sustained latency drift reduces concurrency; late successes cannot cancel cooldown',()=>{
    let now=0;const policy=createSelectionEnrichmentPolicy(config());const grant=policy.resolve(claims());
    const gate=createEnrichmentNetworkAdmission({selectionPolicy:policy,now:()=>now});
    const acquire=()=>gate.acquire({accountKey:host,hostKey:host,selection:grant});
    for(let i=0;i<8;i++) finish(acquire());
    const failed=acquire(),late=acquire();finish(failed,{ok:false,retryAfterSeconds:300});finish(late);
    assert.equal(acquire(),null);now=299999;assert.equal(acquire(),null);now=300000;
    const single=acquire();assert.equal(acquire(),null);finish(single);
    for(let i=0;i<7;i++) finish(acquire());
    finish(acquire(),{durationMs:10000});assert.equal(acquire(),null,'latency drift inserts a quiet interval');
    now+=30000;const reduced=acquire();assert.equal(acquire(),null);finish(reduced,{neutral:true});
    const restarted=createEnrichmentNetworkAdmission({selectionPolicy:policy,now:()=>now});
    const fresh=restarted.acquire({accountKey:host,hostKey:host,selection:grant});assert.ok(fresh);
    assert.equal(restarted.acquire({accountKey:host,hostKey:host,selection:grant}),null,'restart begins conservatively');
});

test('two feeds and different redirect origins share the same final-host budget',()=>{
    const secondFeed='klysmgt-tested-vod',origin='origin.example.invalid';
    const cfg=config();cfg.feeds.push({feedId:secondFeed,hosts:[{host:origin,maxParallel:2},{host,maxParallel:2}]});
    const policy=createSelectionEnrichmentPolicy(cfg);const gate=createEnrichmentNetworkAdmission({selectionPolicy:policy});
    const a=policy.resolve(claims()),b=policy.resolve(claims({selectionFeedId:secondFeed,url:`https://${origin}/file.mp4`}));
    assert.ok(b);const one=gate.acquire({accountKey:host,hostKey:host,selection:a});assert.ok(one);
    assert.equal(gate.acquire({accountKey:origin,hostKey:origin,selection:b}),null);
    finish(one);const two=gate.acquire({accountKey:origin,hostKey:origin,selection:b});assert.ok(two);
    assert.equal(gate.acquire({accountKey:host,hostKey:host,selection:a}),null);finish(two);
});

test('actual provider transport refuses an unauthorized redirect BEFORE requesting its target',async()=>{
    const source=fs.readFileSync(path.join(__dirname,'../services/media-gateway/src/index.js'),'utf8');
    const start=source.indexOf('async function strictLidProviderRequest('),end=source.indexOf('\nfunction markStrictLidTerminal',start);
    assert.ok(start>=0&&end>start);
    const policy=createSelectionEnrichmentPolicy(config());const grant=policy.resolve(claims());
    const requests=[];let drained=0;
    const request=vm.runInNewContext(`(${source.slice(start,end)})`,{
        URL,setImmediate,undiciRequest:async url=>{requests.push(url);return{statusCode:302,headers:{location:'https://not-approved.invalid/secret'},
            body:{dump:async()=>{drained++;}}};},
    });
    await assert.rejects(request(claims().url,{assertProviderTarget:grant.assertTarget}),{code:'SELECTION_ENRICHMENT_TARGET_NOT_APPROVED'});
    assert.deepEqual(requests,[claims().url]);assert.equal(drained,1);
    requests.length=0;await assert.rejects(request('https://not-approved.invalid/secret',{assertProviderTarget:grant.assertTarget}));
    assert.equal(requests.length,0);
});

test('optional ordinary-host feedback warms independent accounts but NEVER lifts the mono-account ceiling',()=>{
    let now=0;const gate=createEnrichmentNetworkAdmission({adaptiveHosts:true,now:()=>now});
    const acquire=account=>gate.acquire({accountKey:account,hostKey:host});
    for(let i=0;i<8;i++) {const a=acquire('a');assert.ok(a);assert.equal(acquire('b'),null);finish(a);}
    const a=acquire('a');assert.equal(acquire('a'),null);const b=acquire('b');assert.ok(b);
    finish(a,{ok:false,retryAfterSeconds:600});finish(b);
    assert.equal(acquire('different-authorized-account'),null,'another account cannot bypass the host cooldown');
    now=600000;const next=acquire('b');assert.ok(next);assert.equal(acquire('a'),null);finish(next,{neutral:true});
});

test('host feedback memory is bounded and live cooldowns are not evicted by new imports',()=>{
    const gate=createEnrichmentNetworkAdmission({adaptiveHosts:true,now:()=>0});
    for(let i=0;i<128;i++) finish(gate.acquire({accountKey:`a${i}`,hostKey:`host-${i}.invalid`}),{ok:false,retryAfterSeconds:300});
    assert.equal(gate.policySnapshot().configuredHosts,128);
    assert.equal(gate.acquire({accountKey:'new',hostKey:'new.invalid'}),null);
    assert.equal(gate.policySnapshot().configuredHosts,128);
});

test('an opaque metadata redirect cannot bypass final-host limits by overlapping another acquisition',()=>{
    const gate=createEnrichmentNetworkAdmission();
    const opaque=gate.acquire({accountKey:'a',hostKey:'origin.invalid',opaqueTarget:true});assert.ok(opaque);
    assert.deepEqual(gate.snapshot(),{maximum:1,active:1});
    assert.equal(gate.acquire({accountKey:'b',hostKey:'target.invalid'}),null);finish(opaque);
    const direct=gate.acquire({accountKey:'b',hostKey:'target.invalid'});assert.ok(direct);
    assert.equal(gate.acquire({accountKey:'a',hostKey:'origin.invalid',opaqueTarget:true}),null);finish(direct);
    assert.deepEqual(gate.snapshot(),{maximum:2,active:0});
});

test('adaptive feedback compares metadata and capture separately, not a tiny header with a long audio window',()=>{
    const gate=createEnrichmentNetworkAdmission({adaptiveHosts:true});
    const acquire=()=>gate.acquire({accountKey:'a',hostKey:host});
    for(let i=0;i<8;i++) finish(acquire(),{lane:'metadata',durationMs:100});
    finish(acquire(),{lane:'capture',durationMs:60000});
    assert.equal(gate.policySnapshot().coolingHosts,0);
    const first=acquire(),second=gate.acquire({accountKey:'b',hostKey:host});assert.ok(first);assert.ok(second);
    finish(first);finish(second);
});

test('ordinary redirect aliases reserve their actual target without bypassing a shared host cooldown or ceiling',()=>{
    const gate=createEnrichmentNetworkAdmission({adaptiveHosts:true,now:()=>0});
    const a=gate.acquire({accountKey:'a',hostKey:'origin-a.invalid'});
    const b=gate.acquire({accountKey:'b',hostKey:'origin-b.invalid'});assert.ok(a);assert.ok(b);
    assert.equal(a.reserveTarget('shared.invalid'),true);
    assert.equal(b.reserveTarget('shared.invalid'),false,'second alias must stop BEFORE contacting the occupied target');
    finish(b,{neutral:true});finish(a,{ok:false,retryAfterSeconds:300});
    const c=gate.acquire({accountKey:'c',hostKey:'origin-c.invalid'});assert.ok(c);
    assert.equal(c.reserveTarget('shared.invalid'),false,'new account/alias cannot evade the target cooldown');
    finish(c,{neutral:true});assert.equal(c.reserveTarget('fresh.invalid'),false,'released permits cannot reserve new hosts');
});

test('configured Selection ceilings also constrain ordinary jobs before any Selection exception is acquired',()=>{
    const cfg=config();cfg.feeds[0].hosts[0].maxParallel=1;
    const policy=createSelectionEnrichmentPolicy(cfg),gate=createEnrichmentNetworkAdmission({selectionPolicy:policy});
    const ordinary=gate.acquire({accountKey:'ordinary',hostKey:host});assert.ok(ordinary);
    assert.equal(gate.acquire({accountKey:'other',hostKey:host}),null);
    assert.equal(gate.acquire({accountKey:'selection',hostKey:host,selection:policy.resolve(claims())}),null);
    finish(ordinary);
    const alias=gate.acquire({accountKey:'alias',hostKey:'alias.invalid'});assert.ok(alias);
    assert.equal(alias.reserveTarget(host),true);
    assert.equal(gate.acquire({accountKey:'selection',hostKey:host,selection:policy.resolve(claims())}),null);
    finish(alias);
});

test('actual ordinary provider redirect checks the reserved destination BEFORE starting its request',async()=>{
    const source=fs.readFileSync(path.join(__dirname,'../services/media-gateway/src/index.js'),'utf8');
    const start=source.indexOf('async function strictLidProviderRequest('),end=source.indexOf('\nfunction markStrictLidTerminal',start);
    const gate=createEnrichmentNetworkAdmission({adaptiveHosts:true});
    const occupied=gate.acquire({accountKey:'occupied',hostKey:'shared.invalid'});
    const other=gate.acquire({accountKey:'other',hostKey:'origin.invalid'});assert.ok(occupied);assert.ok(other);
    const requests=[];
    const request=vm.runInNewContext(`(${source.slice(start,end)})`,{
        URL,setImmediate,undiciRequest:async url=>{requests.push(url);return{statusCode:302,
            headers:{location:'https://shared.invalid/file'},body:{dump:async()=>{}}};},
    });
    await assert.rejects(request('https://origin.invalid/file',{assertProviderTarget:target=>{
        if(!other.reserveTarget(new URL(target).host)) throw Object.assign(Error('busy'),{code:'LANGUAGE_ENRICHMENT_CAPACITY_BUSY'});
    }}),{code:'LANGUAGE_ENRICHMENT_CAPACITY_BUSY'});
    assert.deepEqual(requests,['https://origin.invalid/file']);finish(other,{neutral:true});finish(occupied);
    assert.match(source,/openBroker: \(context, signal, network\)[\s\S]*?network\.reserveTarget\(new URL\(target\)\.host\.toLowerCase\(\)\)/);
    const pipeline=fs.readFileSync(path.join(__dirname,'../services/media-gateway/src/strict-lid-capture-pipeline.js'),'utf8');
    assert.match(pipeline,/broker = await openBroker\(context, signal, network\)/);
});
