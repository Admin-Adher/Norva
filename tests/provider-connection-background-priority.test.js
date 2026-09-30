'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../supabase/functions/norva-playback/index.ts'),'utf8');
const start=source.indexOf('async function runPregenGate(');
const code=source.slice(start,source.indexOf('// Exhausted-dimension',start)).trim().replace('req: Request, db: SupabaseClient','req, db');
function harness({queued=false,unavailable=false,live=false,tick=false}={}){
 const queries=[];let table;
 const chain={select:()=>chain,eq:(k,v)=>{queries.push([k,v]);return chain;},in:(k,v)=>{queries.push([k,Array.from(v)]);return chain;},gt:()=>chain,
 limit:async()=>({data:(table==='cloud_source_credential_transition_jobs'?queued:tick)?[{id:'fixture'}]:[],error:table==='cloud_source_credential_transition_jobs'&&unavailable?{}:null})};
 const db={from:t=>{table=t;queries.push(['table',t]);return chain;},
 rpc:async(name,args)=>{queries.push(['rpc',name,args]);return {data:queued,error:unavailable?{}:null};}};
 const gate=vm.runInNewContext(`(${code})`,{getRuntimeConfig:async()=>({mediaGatewayToken:'fixture-token'}),recordOrEmpty:v=>v||{},stringOr:(v,d)=>typeof v==='string'?v:d,
 userHasLiveSession:async()=>live,Date,ENRICH_TICK_DEFER_MS:150000,HttpError:class extends Error{constructor(c){super(String(c));}}});
 return {queries,run:()=>gate({headers:{get:()=> 'Bearer fixture-token'},json:async()=>({userId:'owner'})},db)};
}
test('pending connection work outranks background provider reads with owner-scoped nonterminal jobs only',async()=>{
 const h=harness({queued:true});assert.equal((await h.run()).reason,'connection-check');
 assert.equal(h.queries[0][1],'norva_credential_work_pending_for_owner');
 assert.equal(h.queries[0][2].p_user_id,'owner');
 const sql=fs.readFileSync(require.resolve('../supabase/migrations/20260930070000_credential_background_priority_gate.sql'),'utf8');
 assert.match(sql,/job.user_id=p_user_id/);
 assert.match(sql,/job.state in \('pending','processing'\)/);
 assert.match(sql,/norva_credential_require_service_role/);
 assert.match(sql,/from public,anon,authenticated/);
});
test('completed or decision-waiting transitions release background work',async()=>{
 assert.equal((await harness().run()).defer,false);
});
test('unavailable connection queue conservatively defers background work',async()=>{
 assert.equal((await harness({unavailable:true}).run()).reason,'connection-check-unavailable');
});
test('viewer and enrichment priority are preserved',async()=>{
 const h=harness({live:true,queued:true});assert.equal((await h.run()).reason,'live-session');assert.equal(h.queries.length,0);
 assert.equal((await harness({tick:true}).run()).reason,'enrichment-tick');
});
