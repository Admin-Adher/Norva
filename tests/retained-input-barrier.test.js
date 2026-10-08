'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { RetainedInputBarrier } = require('../services/media-gateway/src/retained-input-barrier');
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
function setup(ttlMs = 1000) {
    const scope = {}, closed = [];
    let now = 1000, timer;
    const gate = new RetainedInputBarrier({ scope, ttlMs, now: () => now,
        setTimer: fn => { timer = fn; return 1; }, clearTimer: () => {}, onClose: r => closed.push(r) });
    return { gate, scope, closed, advance: n => { now += n; }, expire: () => timer() };
}
test('a drained capability waits for the in-flight window and transport disposal', async () => {
    const { gate, scope } = setup(), transport = deferred(); let drains = 0, settled = false;
    const release = gate.enter();
    const parked = gate.park(scope, () => { drains++; return transport.promise; }).then(x => { settled = true; return x; });
    await Promise.resolve(); assert.equal(drains, 0); assert.equal(gate.enter(), null);
    release(); release(); await Promise.resolve(); assert.equal(drains, 1); assert.equal(settled, false);
    transport.resolve(); assert.ok(await parked); assert.equal(gate.status().activeWindows, 0); gate.close();
});
test('queued input stays closed through fresh validation and transport restart', async () => {
    const { gate, scope } = setup(), validation = deferred();
    const token = await gate.park(scope, async () => {}); let read = false, opened = 0;
    const waiting = gate.wait().then(() => { read = true; });
    const resume = gate.resume(token, scope, () => validation.promise, () => { opened++; return true; });
    await Promise.resolve(); assert.equal(read, false); assert.equal(opened, 0);
    validation.resolve(true); assert.equal(await resume, true); await waiting;
    assert.equal(read, true); assert.equal(opened, 1); gate.close();
});
test('scope and capability identity cannot be forged or replayed', async () => {
    const { gate, scope } = setup(); const token = await gate.park(scope, async () => {});
    for (const [t,s] of [[{},scope],[token,{}],[null,scope]]) assert.equal(await gate.resume(t,s,()=>true,()=>true), false);
    assert.equal(await gate.resume(token,scope,()=>true,()=>true),true);
    assert.equal(await gate.resume(token,scope,()=>true,()=>true),false); gate.close();
});
test('concurrent resumes run only one validation', async () => {
    const { gate, scope } = setup(), validation = deferred(); let validations = 0;
    const token = await gate.park(scope, async () => {});
    const one = gate.resume(token,scope,()=>{validations++;return validation.promise;},()=>true);
    assert.equal(await gate.resume(token,scope,()=>{validations++;return true;},()=>true),false);
    validation.resolve(true); assert.equal(await one,true); assert.equal(validations,1); gate.close();
});
test('refused and failed source checks never reopen input', async () => {
    for (const validate of [()=>false,()=>({valid:true}),()=>{throw Error('changed');}]) {
        const {gate,scope,closed}=setup();let opens=0;const token=await gate.park(scope,async()=>{});
        assert.equal(await gate.resume(token,scope,validate,()=>{opens++;return true;}),false);
        assert.equal(opens,0);assert.deepEqual(closed,['validation-failed']);
    }
});
test('transport disposal failure gives no drained capability', async () => {
    const {gate,scope,closed}=setup();assert.equal(await gate.park(scope,async()=>{throw Error('socket alive');}),null);
    assert.deepEqual(closed,['drain-failed']);await assert.rejects(gate.wait(),/CLOSED/);
});
test('expiry during draining cannot release a capability', async () => {
    const {gate,scope,expire}=setup(),drain=deferred();const p=gate.park(scope,()=>drain.promise);
    expire();drain.resolve();assert.equal(await p,null);assert.equal(gate.status().state,'closed');
});
test('expiry is checked even when timer callback has not run', async () => {
    const {gate,scope,advance,closed}=setup();const token=await gate.park(scope,async()=>{});advance(1001);
    assert.equal(await gate.resume(token,scope,()=>true,()=>true),false);assert.deepEqual(closed,['expired']);
});
test('clock rollback rejects retained state', async () => {
    const {gate,scope,advance}=setup();const token=await gate.park(scope,async()=>{});advance(-1);
    assert.equal(await gate.resume(token,scope,()=>true,()=>true),false);
});
test('revocation aborts fresh validation and never restarts transport', async () => {
    const {gate,scope}=setup();const token=await gate.park(scope,async()=>{});let signal,opens=0;
    const check=deferred(),p=gate.resume(token,scope,s=>{signal=s;return check.promise;},()=>{opens++;return true;});
    gate.close('revoked');assert.equal(signal.aborted,true);check.resolve(true);
    assert.equal(await p,false);assert.equal(opens,0);
});
test('close wakes both draining and queued input without renewing the TTL', async () => {
    const {gate,scope,closed}=setup();const release=gate.enter();const p=gate.park(scope,async()=>assert.fail());
    const waiting=assert.rejects(gate.wait(),/CLOSED/);assert.equal(await gate.park(scope,async()=>{}),null);
    gate.close('revoked');gate.close('again');release();await waiting;assert.equal(await p,null);
    assert.deepEqual(closed,['revoked']);assert.equal(gate.status().waiting,0);
});
test('a cancelled waiting request never enters the provider mutex', async () => {
    const {gate,scope}=setup();await gate.park(scope,async()=>{});const c=new AbortController();
    const p=assert.rejects(gate.wait(c.signal),/CLOSED/);c.abort();await p;assert.equal(gate.status().waiting,0);gate.close();
});
test('restart failure closes the retained state', async () => {
    const {gate,scope,closed}=setup();const token=await gate.park(scope,async()=>{});
    assert.equal(await gate.resume(token,scope,()=>true,()=>false),false);assert.deepEqual(closed,['restart-failed']);
});
test('unbounded retention and missing ownership rejected', () => {
    for(const args of [{scope:null},{scope:'text'},{scope:{},ttlMs:0},{scope:{},ttlMs:10001}]) {
        assert.throws(()=>new RetainedInputBarrier({...args,onClose:()=>{}}));
    }
});
