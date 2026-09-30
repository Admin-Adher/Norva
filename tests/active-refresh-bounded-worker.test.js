'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../supabase/functions/norva-provider-access/index.ts'),'utf8');
const start=source.indexOf('async function runBoundedActivePostSwitchRefresh(');
const body=source.slice(start,source.indexOf('\nasync function runActivePostSwitchRefresh(',start));
function harness({duration=1,lease=300000,pendingAt=Infinity,failAt=Infinity}={}){
 let time=0,calls=0;const decisions=[];
 const run=vm.runInNewContext(`(${body})`,{WORKER_MIN_START_LEASE_MS:10000,
  runActivePostSwitchRefresh:async(_j,_w,_r,_c,canContinue)=>{
   calls++;time+=duration;if(calls===failAt)throw new Error('lease lost');
   if(calls===pendingAt)return {complete:false};
   const continueLease=canContinue();decisions.push(continueLease);return {complete:false,continueLease};
  }});
 return {run:()=>run({leaseUntilMs:lease},'worker',{}, {},()=>time),calls:()=>calls,decisions};
}
test('refresh batches at most sixteen separately checkpointed pages and releases the last lease',async()=>{
 const h=harness();await h.run();assert.equal(h.calls(),16);assert.equal(h.decisions.at(-1),false);
});
test('elapsed time and remaining lease each bound a refresh batch',async()=>{
 const timed=harness({duration:11000});await timed.run();assert.equal(timed.calls(),4);
 const leased=harness({duration:1000,lease:12000});await leased.run();assert.equal(leased.calls(),3);
});
test('pending provider work yields immediately instead of spinning',async()=>{
 const h=harness({pendingAt:2});await h.run();assert.equal(h.calls(),2);
});
test('a failed checkpoint propagates without replaying another page under the same lease',async()=>{
 const h=harness({failAt:2});await assert.rejects(h.run(),/lease lost/);assert.equal(h.calls(),2);
});
