'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { NativePlayerController,playbackRequest } = require('../desktop/native-player-controller');
const request={sessionId:'12345678-1234-4234-8234-123456789abc',url:'https://example.test/movie/file.mkv',title:'Film',resumeSeconds:42,sourceId:'owned',itemId:'file',itemType:'movie'};
function fixture(){
    const child=new EventEmitter(); for(const key of ['stdin','stdout','stderr'])child[key]=new PassThrough();
    const writes=[]; child.stdin.on('data',c=>writes.push(JSON.parse(c.toString()))); child.kill=()=>child.emit('exit',1);
    const calls=[],controller=new NativePlayerController('native-player.exe',{spawnProcess:(...args)=>{calls.push(args);return child;},stopTimeoutMs:10,
        openInput:async()=>({url:'http://127.0.0.1:1/private-token',stop:async()=>{}})});
    const events=[];controller.on('event',e=>events.push(e));
    return{controller,child,writes,calls,events,event:e=>child.stdout.write(JSON.stringify(e)+'\n')};
}
for(const url of ['file:///c:/private','javascript:run()','\\\\server\\file','http://example.test/video\n:option','https://example.test/file#option'])test(`reject native input ${url.split(':')[0]}`,()=>{
    assert.throws(()=>playbackRequest({...request,url}),/INVALID_NATIVE_URL/);
});
test('native decoder launch contains no URL on the process command line and accepts no arbitrary libVLC options',async()=>{
    const h=fixture();await h.controller.open({...request,options:[':sout=file'],fallbackUrl:'https://other.test'});
    assert.deepEqual(h.calls[0][1],[]);assert.equal(h.calls[0][2].shell,false);assert.equal(h.writes.length,0);
    h.event({type:'ready',protocol:1});assert.equal(h.writes.length,1);assert.equal(h.writes[0].options,undefined);assert.equal(h.writes[0].fallbackUrl,undefined);
    h.child.emit('exit',0);
});
test('replacement requires native transport exit and then exact cloud acknowledgement',async()=>{
    const h=fixture();await h.controller.open(request);h.event({type:'ready',protocol:1});
    await assert.rejects(h.controller.open(request),/PREVIOUS_SESSION/);
    const pending=h.controller.stop();assert.equal(h.events.length,0);
    h.event({type:'closed',sessionId:request.sessionId});assert.equal(h.events.length,0,'decoder closed event alone is not OS drain');
    h.child.emit('exit',0);await pending;
    await assert.rejects(h.controller.open(request),/PREVIOUS_SESSION/);
    h.controller.acknowledge('wrong');await assert.rejects(h.controller.open(request),/PREVIOUS_SESSION/);
    h.controller.acknowledge(request.sessionId);assert.equal(h.controller.unacknowledged.size,0);
});
test('only the owned session receives authorization; diagnostics never cross the bridge',async()=>{
    const h=fixture();await h.controller.open(request);h.event({type:'ready',protocol:1});
    h.controller.authorize('other');assert.equal(h.writes.length,1);
    h.controller.authorize(request.sessionId);assert.equal(h.writes.length,2);
    h.event({type:'progress',sessionId:'other',positionSeconds:2,durationSeconds:100});
    h.child.stderr.write('secret source diagnostics');assert.equal(h.events.length,0);
    h.event({type:'progress',sessionId:request.sessionId,positionSeconds:43,durationSeconds:100,url:'secret'});
    assert.equal(h.events[0].positionSeconds,43);assert.equal(h.events[0].url,undefined);h.child.emit('exit',0);
});
for(const patch of [{sessionId:'not-a-uuid'},{resumeSeconds:-1},{resumeSeconds:Infinity},{mediaCache:{token:'private'}},{itemType:'live'}])test('invalid session/position/private cache payload fails before spawning',()=>{
    assert.throws(()=>playbackRequest({...request,...patch}));
});

test('closing the catalogue while an input opens cannot spawn a late decoder',async()=>{
    let release,stopped=0,spawned=0;
    const input=new Promise(resolve=>{release=resolve;});
    const controller=new NativePlayerController('native-player.exe',{
        openInput:()=>input,spawnProcess:()=>{spawned++;throw Error('unexpected spawn');}
    });
    const opened=controller.open(request);await controller.stop();
    release({url:'http://127.0.0.1:1/fixture',stop:async()=>{stopped++;}});
    await assert.rejects(opened,/NATIVE_OPEN_CANCELLED/);
    assert.equal(spawned,0);assert.equal(stopped,1);assert.equal(controller.pending,false);
});

test('closed is withheld until the byte transport has drained',async()=>{
    const h=fixture();let release;
    h.controller.openInput=async()=>({url:'http://127.0.0.1:1/fixture',stop:()=>new Promise(resolve=>{release=resolve;})});
    await h.controller.open(request);h.child.emit('exit',0);
    assert.equal(h.events.length,0);assert.ok(h.controller.active);
    release();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(h.events[0].type,'closed');assert.equal(h.controller.active,null);
});
