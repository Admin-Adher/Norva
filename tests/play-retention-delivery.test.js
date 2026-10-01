const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {transformSync}=require('esbuild');
const source=fs.readFileSync(path.join(__dirname,'../supabase/functions/norva-lifecycle/index.ts'),'utf8');
const code=transformSync(source.slice(source.indexOf('async function runPlayRetention('),source.indexOf('async function runWinback(')),{loader:'ts',target:'node18'}).code;
function fixture(rows,allowed=true){
 const calls=[],sent=[],copies=[];
 const query={select(){return this;},eq(){return this;},update(){return this;},delete(){return this;},maybeSingle:async()=>({data:{locale:'pt-BR'}})};
 const db={from:()=>query,auth:{admin:{getUserById:async()=>({data:{user:{user_metadata:{language:'en'}}}})}},
  rpc:async(name,args)=>{calls.push({name,args});return {data:name==='norva_play_retention_deliveries'?rows:allowed?{token:'synthetic-token',user_id:'owner'}:null};}};
 const run=new Function('fcmConfigured','queueUserEmail','renderPlayRetention','playRetentionCopy','sendFcmPush','PLAY_RETENTION_LINK',
  code+'\nreturn runPlayRetention;')(()=>true,async(_db,user,render,opts)=>{sent.push({channel:'email',user,opts});render('',{locale:'fr'});return {durable:true,created:true};},
  ()=>({}),(_period,locale)=>{copies.push(locale);return {title:'title',terms:'terms'};},
  async(_token,opts)=>{sent.push({channel:'push',opts});return {ok:true};},'https://norva.tv/app.html?mobile=1#settings/account');
 return {run:()=>run(db),calls,sent,copies};
}
test('disabled or empty mobile policy causes no email or push side effect',async()=>{
 const f=fixture([]);assert.equal(await f.run(),0);assert.deepEqual(f.sent,[]);
 assert.equal(f.calls[0].name,'norva_play_retention_deliveries');
});
test('revoked consent at final push claim suppresses delivery without falling back to email',async()=>{
 const f=fixture([{channel:'push',deliveryId:'delivery'}],false);
 assert.equal(await f.run(),0);assert.deepEqual(f.sent,[]);
});
test('mobile email preserves the dedicated flow and per-stage delivery identity',async()=>{
 const f=fixture([{channel:'email',user_id:'owner',deliveryId:'delivery',period:'monthly'}]);
 assert.equal(await f.run(),1);
 assert.equal(f.sent[0].opts.dedupeKey,'lifecycle:play-retention:delivery');
 assert.equal(f.sent[0].opts.markerKind,'play_retention');assert.equal(f.sent[0].opts.marketing,true);
});
test('push uses the account locale and points only to the mobile offer',async()=>{
 const f=fixture([{channel:'push',deliveryId:'delivery',period:'monthly',stage:'pre',expiresAt:'2099-01-01'}]);
 assert.equal(await f.run(),1);assert.deepEqual(f.copies,['pt-BR']);
 assert.equal(f.sent[0].opts.data.kind,'play_retention');
 assert.match(f.sent[0].opts.data.deepLink,/mobile=1#settings\/account/);
 assert.equal(f.sent[0].opts.collapseKey,'play-retention-pre');
});
