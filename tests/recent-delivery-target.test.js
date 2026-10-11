'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { retainRecentDeliveryTarget: retain, consumeRecentDeliveryTarget: consume, forkRecentDeliveryTarget: fork,
    noteRecentDeliveryTargetFailure: failHint } = require('../services/media-gateway/src/recent-delivery-target');
const { RECENT_TTL_MS } = require('../services/media-gateway/src/recent-resume-samples');
const targetUrl = 'https://delivery.invalid/private-token';
const facts = { ownerKey:'a'.repeat(64), sourceUrl:'https://provider.invalid/movie', userAgent:'Norva/Test',
    fileSizeBytes:1024*1024, routeKey:'http:1:connect', targetUrl,
    targetHash:crypto.createHash('sha256').update(targetUrl).digest('hex'), targetIdentity:'b'.repeat(64), now:100 };
test('delivery hint is opaque and single-use, including a failed attempt',()=>{
    const token=retain(facts);assert.ok(token);assert.equal(JSON.stringify(token),'{}');
    assert.equal(consume({},facts),null);assert.equal(consume(token,facts).targetUrl,targetUrl);
    assert.equal(consume(token,facts),null);
    const other=retain(facts);assert.equal(consume(other,{...facts,ownerKey:'c'.repeat(64)}),null);
    assert.equal(consume(other,facts),null);
});
for(const key of ['ownerKey','sourceUrl','userAgent','fileSizeBytes','routeKey']) test(`delivery hint rejects changed ${key}`,()=>{
    const token=retain(facts);assert.equal(consume(token,{...facts,[key]:key==='fileSizeBytes'?facts[key]+1:'changed'}),null);
});
test('delivery hint expires at the existing ten-minute limit and rejects backwards time',()=>{
    assert.ok(consume(retain(facts),{...facts,now:100+RECENT_TTL_MS-1}));
    for(const now of [99,100+RECENT_TTL_MS,NaN]) assert.equal(consume(retain(facts),{...facts,now}),null);
});
test('invalid or forged target facts cannot become a routing hint',()=>{
    for(const alter of [{targetHash:'c'.repeat(64)},{targetUrl:'file:///private'},{targetUrl:'https://user:secret@invalid/a'},
        {routeKey:null},{fileSizeBytes:undefined},{ownerKey:undefined},{sourceUrl:'not-url'}])
        assert.equal(retain({...facts,...alter}),null);
});

test('prefix routing forks preserve expiry, isolation and one-use consumption', () => {
    const root = retain(facts);
    assert.equal(fork(root, { ...facts, ownerKey: 'c'.repeat(64) }), null);
    for (const now of [99, 100 + RECENT_TTL_MS, NaN]) assert.equal(fork(root, { ...facts, now }), null);
    assert.equal(fork({}, facts), null);
    for (const key of ['ownerKey', 'sourceUrl', 'userAgent', 'fileSizeBytes', 'routeKey']) {
        const hint = fork(root, facts);
        assert.ok(hint); assert.equal(JSON.stringify(hint), '{}');
        assert.equal(fork(hint, facts), null);
        assert.equal(consume(hint, { ...facts, [key]: key === 'fileSizeBytes' ? facts[key] + 1 : 'changed' }), null);
        assert.equal(consume(hint, facts), null);
    }
    const last = fork(root, { ...facts, now: 100 + RECENT_TTL_MS - 1 });
    assert.equal(consume(last, { ...facts, now: 100 + RECENT_TTL_MS }), null);
    assert.ok(consume(fork(root, facts), facts));
    assert.ok(consume(root, facts));
    assert.equal(fork(root, facts), null);
});

test('a genuine 509 hint refusal defers only that bound routing shortcut for the existing recent TTL',()=>{
    const data={...facts,sourceUrl:facts.sourceUrl+'/509'};
    const resolved=consume(retain(data),data);
    assert.equal(failHint(resolved,{upstreamStatus:509,now:200}),true);
    assert.equal(failHint(resolved,{upstreamStatus:509,now:201}),false);
    assert.equal(consume(retain({...data,now:201}),{...data,now:201}),null);
    for(const key of ['ownerKey','sourceUrl','userAgent','fileSizeBytes','routeKey','targetIdentity']) {
        const other={...data,now:202,[key]:key==='fileSizeBytes'?data[key]+1:key==='ownerKey'||key==='targetIdentity'?'c'.repeat(64):'other'};
        if(key==='sourceUrl')other[key]='https://other.invalid/source';
        assert.ok(consume(retain(other),other),key);
    }
    const rotated={...data,now:202,targetUrl:targetUrl+'?sign=fresh'};
    rotated.targetHash=crypto.createHash('sha256').update(rotated.targetUrl).digest('hex');
    assert.equal(consume(retain(rotated),rotated),null,'a changed signature does not bypass a refusal of the same delivery identity');
    const after={...data,now:200+RECENT_TTL_MS};
    assert.ok(consume(retain(after),after));
});

test('arbitrary failures and forged hints cannot suppress the routing shortcut',()=>{
    for(const status of [200,407,458,500,'509',null]) {
        const data={...facts,sourceUrl:facts.sourceUrl+'/status-'+status};
        const resolved=consume(retain(data),data);
        assert.equal(failHint(resolved,{upstreamStatus:status,now:200}),false);
        assert.ok(consume(retain(data),data));
    }
    assert.equal(failHint({targetUrl},{upstreamStatus:509,now:200}),false);
    assert.equal(failHint(consume(retain(facts),facts),{upstreamStatus:509,now:99}),false);
});
