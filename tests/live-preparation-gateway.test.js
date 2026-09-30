const test = require('node:test');
const assert = require('node:assert/strict');
const { createPlaybackPreparationCancellation: registry } = require('../services/media-gateway/src/playback-preparation-cancel');
const owner = 'a'.repeat(64), other = 'b'.repeat(64);
const id = '00000000-0000-4000-8000-000000000001', next = '00000000-0000-4000-8000-000000000002';
const tick = () => new Promise(resolve => setImmediate(resolve));
test('cancel before POST is an exact synchronous fence, other attempts and owners stay available', async () => {
  const ledger = registry(); const closed = [];
  const result = await ledger.cancel(owner, id, async (...args) => closed.push(args));
  assert.equal(result.drained, true);
  assert.throws(() => ledger.begin(owner, id, () => {}), { code: 'PLAYBACK_PREPARATION_CANCELLED' });
  ledger.begin(owner, next, () => {})(); ledger.begin(other, id, () => {})();
  assert.deepEqual(closed, [[owner,id],[owner,id]]);
});
test('active cancellation waits for the POST finally and the exact child exit', async () => {
  const ledger = registry({ drainTimeoutMs: 20 }); let aborted = 0, exited = false;
  const finish = ledger.begin(owner,id,()=>aborted++);
  const result = ledger.cancel(owner,id,async()=>{});
  await tick(); assert.equal(aborted,1);
  finish(async()=>exited);
  assert.equal((await result).drained,false);
  assert.equal((await ledger.cancel(owner,id,async()=>{})).drained,false);
  exited = true;
  assert.equal((await ledger.cancel(owner,id,async()=>{})).drained,true);
  assert.equal(ledger.snapshot().pending,0);
});
test('bounded timeout is non-final, subsequent poll confirms the same attempt only', async () => {
  const ledger = registry({ drainTimeoutMs: 10 });
  const finish = ledger.begin(owner,id,()=>{});
  assert.equal((await ledger.cancel(owner,id,async()=>{})).drained,false);
  finish();
  assert.equal((await ledger.cancel(owner,id,async()=>{})).drained,true);
});
test('stop failure is never acknowledged and retry can later prove drainage', async () => {
  const ledger = registry();
  assert.equal((await ledger.cancel(owner,id,async()=>{ throw new Error('kill failed'); })).drained,false);
  assert.throws(()=>ledger.begin(owner,id,()=>{}),{code:'PLAYBACK_PREPARATION_CANCELLED'});
  assert.equal((await ledger.cancel(owner,id,async()=>{})).drained,true);
});
test('ledger pressure rejects a new cancellation rather than evicting an active fence', async () => {
  const ledger = registry({ maximum: 1 });
  await ledger.cancel(owner,id,async()=>{});
  await assert.rejects(ledger.cancel(owner,next,async()=>{}),{code:'PREPARATION_CANCEL_CAPACITY'});
  assert.throws(()=>ledger.begin(owner,id,()=>{}),{code:'PLAYBACK_PREPARATION_CANCELLED'});
});
test('duplicate startup rejected and pending ledger bounded',()=>{
  const ledger=registry({maximum:1}); const finish=ledger.begin(owner,id,()=>{});
  assert.throws(()=>ledger.begin(owner,id,()=>{}),{code:'PLAYBACK_PREPARATION_DUPLICATE'});
  assert.throws(()=>ledger.begin(owner,next,()=>{}),{code:'PREPARATION_CANCEL_CAPACITY'});
  finish(); ledger.begin(owner,next,()=>{})();
});
test('tombstone cannot expire while its POST remains unsettled',async()=>{
  let now=0; const ledger=registry({now:()=>now,ttlMs:10,drainTimeoutMs:1});
  const finish=ledger.begin(owner,id,()=>{});
  await ledger.cancel(owner,id,async()=>{}); now=20;
  assert.throws(()=>ledger.begin(owner,id,()=>{}),{code:'PLAYBACK_PREPARATION_CANCELLED'});
  finish(); assert.equal((await ledger.cancel(owner,id,async()=>{})).drained,true);
});
