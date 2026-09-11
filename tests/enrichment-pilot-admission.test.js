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
    for(const value of [null,{},'{', {...config(),fileKeys:config().fileKeys.slice(1)},
        {...config(),fileKeys:[...config().fileKeys,'a'.repeat(64)]},
        {...config(),fileKeys:Array(20).fill('a'.repeat(64))},
        {...config(),expiresAt:new Date(now+25*3600000).toISOString()},
        {...config(),createdAt:new Date(now+6000).toISOString()}]) {
        assert.throws(()=>create(value,{mode:'pilot',now:()=>now}),{code:'ENRICHMENT_PILOT_CONFIG_INVALID'});
    }
    assert.throws(()=>create(config()),{code:'ENRICHMENT_PILOT_CONFIG_INVALID'});
});

test('runtime gates every new acquisition and local capture action, but never the foreground playback byte pump',()=>{
    const source=fs.readFileSync(path.join(__dirname,'../services/media-gateway/src/index.js'),'utf8');
    const gate=source.slice(source.indexOf('function claimLanguageEnrichmentNetwork('),source.indexOf('async function handleProbeAudioRequest('));
    assert.ok(gate.indexOf('enrichmentPilot.assertFile')<gate.indexOf('enrichmentNetworkAdmission.acquire'));
    assert.match(source,/options\.claimNetwork\?\.\(url, null, true, req\.body\?\.enrichmentFileKey\)/);
    assert.match(source,/options\.claimNetwork\?\.\(claims\.url, null, true, claims\.enrichmentFileKey\)/);
    assert.match(source,/claimLanguageEnrichmentNetwork\(context\.url, context\.selectionCapability, false, context\.enrichmentFileKey\)/);
    assert.match(source,/if \(!enrichmentPilot\.allowsFile\(claims\.enrichmentFileKey\)\)/);
    assert.match(source,/return enrichmentPilot\.mode === 'fleet' && LANGUAGE_PASSIVE_CAPTURE_ENABLED/);
    assert.equal((source.match(/enrichmentPilot\.assertFile/g)||[]).length,1);
    assert.match(source,/LANGUAGE_METADATA_LANE_ENABLED && enrichmentPilot\.mode === 'disabled'/);
});
