'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {createEnrichmentPilotAdmission:create}=require('../services/media-gateway/src/enrichment-pilot-admission');
const now=Date.parse('2026-09-11T22:00:00Z');
const config=()=>({protocol:1,createdAt:new Date(now).toISOString(),expiresAt:new Date(now+3600000).toISOString(),
    fileKeys:Array.from({length:20},(_,i)=>(i+1).toString(16).padStart(64,'0'))});

test('only the explicit immutable 20-file pilot or explicit fleet mode admits enrichment',()=>{
    assert.equal(create().allowsFile(config().fileKeys[0]),false);
    const gate=create(config(),{mode:'pilot',now:()=>now});
    for(const key of config().fileKeys) assert.equal(gate.allowsFile(key),true);
    for(const key of [undefined,'','provider:123','a'.repeat(64)]) {
        assert.equal(gate.allowsFile(key),false);
        assert.throws(()=>gate.assertFile(key),{code:'LANGUAGE_ENRICHMENT_CAPACITY_BUSY',status:429,providerDrained:true});
    }
    assert.equal(create(null,{mode:'fleet'}).allowsFile(null),true);
    assert.equal(gate.snapshot().files,20);assert.equal('fileKeys' in gate.snapshot(),false);
});

test('expired or malformed pilot never silently enables the whole fleet, including after restart',()=>{
    let at=now;const gate=create(config(),{mode:'pilot',now:()=>at});at+=3600000;
    assert.equal(gate.allowsFile(config().fileKeys[0]),false);assert.equal(gate.snapshot().expired,true);
    assert.equal(create(config(),{mode:'pilot',now:()=>at}).allowsFile(config().fileKeys[0]),false);
    for(const value of [null,{},'{', {...config(),fileKeys:[]},
        {...config(),fileKeys:[...config().fileKeys,'a'.repeat(64)]},
        {...config(),fileKeys:Array(20).fill('a'.repeat(64))},
        {...config(),expiresAt:new Date(now+25*3600000).toISOString()},
        {...config(),createdAt:new Date(now+6000).toISOString()}]) {
        assert.throws(()=>create(value,{mode:'pilot',now:()=>now}),{code:'ENRICHMENT_PILOT_CONFIG_INVALID'});
    }
    assert.throws(()=>create(config()),{code:'ENRICHMENT_PILOT_CONFIG_INVALID'});
});

test('an approved remaining subset admits no completed, failed or quarantined former sample',()=>{
    for (const size of [1,9,19,20]) {
        const all=config(), subset={...all,fileKeys:all.fileKeys.slice(0,size)};
        const gate=create(subset,{mode:'pilot',now:()=>now});
        assert.equal(gate.snapshot().files,size);
        for (const [index,key] of all.fileKeys.entries()) assert.equal(gate.allowsFile(key),index<size);
        subset.fileKeys.push('f'.repeat(64));
        assert.equal(gate.allowsFile('f'.repeat(64)),false);
        assert.equal(create({...all,fileKeys:all.fileKeys.slice(0,size)},
            {mode:'pilot',now:()=>now+3600000}).allowsFile(all.fileKeys[0]),false);
    }
});

test('runtime gates every new acquisition and local capture action, but never the foreground playback byte pump',()=>{
    const source=fs.readFileSync(path.join(__dirname,'../services/media-gateway/src/index.js'),'utf8');
    const gate=source.slice(source.indexOf('function claimLanguageEnrichmentNetwork('),source.indexOf('async function handleProbeAudioRequest('));
    assert.ok(gate.indexOf('enrichmentPilot.assertFile')<gate.indexOf('enrichmentNetworkAdmission.acquire'));
    assert.match(source,/options\.claimNetwork\?\.\(url, null, true, req\.body\?\.enrichmentFileKey\)/);
    assert.match(source,/options\.claimNetwork\?\.\(claims\.url, null, true, claims\.enrichmentFileKey\)/);
    assert.match(source,/claimLanguageEnrichmentNetwork\(context\.url, context\.selectionCapability, false, context\.enrichmentFileKey\)/);
    assert.match(source,/if \(!enrichmentPilot\.allowsFile\(claims\.enrichmentFileKey\)\)/);
    assert.match(source,/return enrichmentPilot\.allowsPassive\(\) && LANGUAGE_PASSIVE_CAPTURE_ENABLED/);
    assert.match(source,/if \(!enrichmentPilot\.allowsPassiveSource\(session\.ownerKey,sourceUrlHash,profileFingerprint\)\) return \[\]/);
    assert.equal((source.match(/enrichmentPilot\.assertFile/g)||[]).length,1);
    assert.match(source,/LANGUAGE_METADATA_LANE_ENABLED && enrichmentPilot\.mode === 'disabled'/);
});

test('passive canary is exact-account, URL, profile and deadline bound without admitting other background files',()=>{
    let at=now;const data=config();
    const source={ownerHash:'a'.repeat(64),sourceUrlHash:'b'.repeat(64),profileFingerprint:'c'.repeat(64),fileKey:data.fileKeys[0]};
    data.passiveSources=[source];const gate=create(data,{mode:'pilot',now:()=>at});
    assert.equal(gate.allowsPassive(),true);
    assert.equal(gate.allowsPassiveSource(source.ownerHash,source.sourceUrlHash,source.profileFingerprint),true);
    for(const args of [['f'.repeat(64),source.sourceUrlHash,source.profileFingerprint],
        [source.ownerHash,'f'.repeat(64),source.profileFingerprint],[source.ownerHash,source.sourceUrlHash,'f'.repeat(64)],
        [null,source.sourceUrlHash,source.profileFingerprint]])assert.equal(gate.allowsPassiveSource(...args),false);
    assert.equal(gate.allowsFile('f'.repeat(64)),false);
    assert.equal(gate.snapshot().passiveSources,1);
    assert.equal(JSON.stringify(gate.snapshot()).includes(source.ownerHash),false,'health exposes counts, not account/URL hashes');
    source.ownerHash='d'.repeat(64);data.passiveSources.push({...source});
    assert.equal(gate.allowsPassiveSource(source.ownerHash,source.sourceUrlHash,source.profileFingerprint),false);
    at=now+3600000;assert.equal(gate.allowsPassive(),false);
    assert.equal(gate.allowsPassiveSource('a'.repeat(64),'b'.repeat(64),'c'.repeat(64)),false);
});

test('passive permissions are absent by default and malformed or detached grants fail closed',()=>{
    const base=config(), source={ownerHash:'a'.repeat(64),sourceUrlHash:'b'.repeat(64),profileFingerprint:'c'.repeat(64),fileKey:base.fileKeys[0]};
    assert.equal(create().allowsPassive(),false);
    assert.equal(create(base,{mode:'pilot',now:()=>now}).allowsPassive(),false);
    assert.equal(create(null,{mode:'fleet'}).allowsPassiveSource(source.ownerHash,source.sourceUrlHash,source.profileFingerprint),true);
    for(const passiveSources of [{},[source,source],Array.from({length:21},()=>source),
        [{...source,fileKey:'f'.repeat(64)}],[{...source,ownerHash:''}], [{...source,extra:true}],
        [{fileKey:source.fileKey,ownerHash:source.ownerHash,sourceUrlHash:source.sourceUrlHash}]]) {
        assert.throws(()=>create({...base,passiveSources},{mode:'pilot',now:()=>now}),{code:'ENRICHMENT_PILOT_CONFIG_INVALID'});
    }
});

test('capture runtime keeps a 32 MiB encrypted ceiling in fleet and pilot, with 16 MiB passive snapshots',()=>{
    const source=fs.readFileSync(path.join(__dirname,'../services/media-gateway/src/index.js'),'utf8');
    const start=source.indexOf('strictLidCaptureStore = new StrictLidCaptureStore(');
    const block=source.slice(start,source.indexOf('await strictLidCaptureStore.open()',start));
    assert.match(block,/maxBytes:32\*1024\*1024,maxEntries:16/);
    assert.doesNotMatch(block,/enrichmentPilot\.mode/);
    const passive=fs.readFileSync(path.join(__dirname,'../services/media-gateway/src/passive-lid-capture.js'),'utf8');
    assert.match(passive,/const MAX_MEDIA_BYTES = 16 \* 1024 \* 1024/);
    const store=fs.readFileSync(path.join(__dirname,'../services/media-gateway/src/strict-lid-capture-store.js'),'utf8');
    assert.match(store,/this\.computations\.size >= 2/);
    assert.ok(32+16+3+4*3<=64);
});
