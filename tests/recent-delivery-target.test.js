'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { retainRecentDeliveryTarget: retain, consumeRecentDeliveryTarget: consume } = require('../services/media-gateway/src/recent-delivery-target');
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
