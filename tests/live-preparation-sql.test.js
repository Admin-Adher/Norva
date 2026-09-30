const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
let PGlite;try{({PGlite}=require('@electric-sql/pglite'));}catch(error){if(process.env.NORVA_REQUIRE_PREPARATION_SQL==='1')throw error;}
const root=path.resolve(__dirname,'..');
const migration=fs.readFileSync(path.join(root,'supabase/migrations/20260930173000_live_playback_preparations.sql'),'utf8');
const old=fs.readFileSync(path.join(root,'supabase/migrations/20260831032956_provider_lid_viewer_preemption_quarantine_v1.sql'),'utf8');
const claim=old.slice(old.indexOf('create or replace function public.claim_cloud_playback_session('),old.indexOf('\nrevoke all on function public.claim_cloud_playback_session('));
const U='00000000-0000-4000-8000-000000000001',V='00000000-0000-4000-8000-000000000002',S='00000000-0000-4000-8000-000000000003',D='00000000-0000-4000-8000-000000000004',E='00000000-0000-4000-8000-000000000005';
async function fixture(){const db=new PGlite();await db.exec(`
create role anon;create role authenticated;create role service_role;
create schema auth;create table auth.users(id uuid primary key);
create table cloud_sources(id uuid primary key,user_id uuid);
create table cloud_devices(id uuid primary key,user_id uuid,revoked boolean default false);
create table cloud_playback_sessions(id uuid primary key,user_id uuid,source_id uuid,device_id uuid,item_type text,item_id text,mode text,status text,target_url_hash text,provider_account_hash text,stream_mime text,playback_hint jsonb,expires_at timestamptz,created_at timestamptz default clock_timestamp(),updated_at timestamptz,superseded_at timestamptz);
create table provider_account_language_validation_leases(provider_account_hash text,lease_owner text,expires_at timestamptz);
create function norva_assert_source_catalog_visible_locked(s uuid,u uuid) returns void language plpgsql as $$begin if not exists(select 1 from public.cloud_sources where id=s and user_id=u) then raise exception 'not visible'; end if;end$$;
insert into auth.users values('${U}'),('${V}');insert into cloud_sources values('${S}','${U}');insert into cloud_devices values('${D}','${U}',false),('${E}','${U}',false);
${claim}
${migration}`);return db;}
async function one(db,sql,args=[]){return(await db.query(sql,args)).rows[0];}
const prepare=(db,device=D)=>one(db,'select * from norva_prepare_live_playback($1,$2,$3,$4,$5,$6)',[U,S,device,'985192','auto',{['d'.repeat(64)]:U}]);
const begin=(db,p,device=D)=>one(db,'select * from norva_begin_live_preparation($1,$2,$3,$4,$5,$6)',[p.id,U,device,S,'985192','auto']);
const cancel=(db,p,user=U,device=D)=>one(db,'select * from norva_cancel_live_preparation($1,$2,$3)',[p.id,user,device]);
const start=(db,p)=>one(db,`select * from claim_prepared_cloud_playback_session($1,$2,$3,$4,$5,'live','985192','transcode','pending',$6,$7,'video/mp2t','{}',clock_timestamp()+interval '1 minute')`,[p.id,p.playback_session_id,U,S,D,'c'.repeat(64),'a'.repeat(64)]);
test('real preparation SQL: monotone cancellation, exact identity and atomic existing provider claim',{skip:!PGlite},async t=>{
const db=await fixture();try{
await t.test('reserve has no playback/provider side effect and TTL is bounded',async()=>{
const p=await prepare(db);assert.equal(p.state,'prepared');assert.notEqual(p.id,p.playback_session_id);
assert.equal((await one(db,'select count(*)::int n from cloud_playback_sessions')).n,0);
const ttl=new Date(p.expires_at)-new Date(p.created_at);assert.ok(ttl>179000&&ttl<=180001);
});
await t.test('cancel before begin cannot be restarted or claimed',async()=>{
const p=await prepare(db);assert.equal((await cancel(db,p)).state,'cancel_requested');
await assert.rejects(begin(db,p),{code:'55000'});await assert.rejects(start(db,p),{code:'55000'});
assert.equal((await cancel(db,p)).state,'cancel_requested');
});
await t.test('begin followed by cancel cannot supersede a later live session',async()=>{
const p=await prepare(db);await begin(db,p);await cancel(db,p);
const n=await prepare(db);await begin(db,n);await start(db,n);
await assert.rejects(start(db,p),{code:'55000'});
assert.equal((await one(db,'select status from cloud_playback_sessions where id=$1',[n.playback_session_id])).status,'pending');
});
await t.test('claim then cancellation affects only its reserved UUID; duplicate claim is rejected',async()=>{
const p=await prepare(db);await begin(db,p);const claimed=await start(db,p);assert.equal(claimed.new_session_id,p.playback_session_id);
await assert.rejects(start(db,p),{code:'55000'});
const cancelled=await cancel(db,p);assert.equal(cancelled.playback_session_id,p.playback_session_id);
await db.query("update live_playback_preparations set state='cancelled' where id=$1",[p.id]);
assert.equal((await cancel(db,p)).state,'cancelled');await assert.rejects(begin(db,p),{code:'55000'});
});
await t.test('owner and device cannot substitute an existing receipt',async()=>{
const p=await prepare(db);await assert.rejects(cancel(db,p,V),{code:'42501'});await assert.rejects(cancel(db,p,U,E),{code:'42501'});
await assert.rejects(begin(db,p,E),{code:'42501'});await assert.rejects(one(db,'select * from norva_begin_live_preparation($1,$2,$3,$4,$5,$6)',[p.id,U,D,S,'other-channel','auto']),{code:'42501'});
await assert.rejects(one(db,'select * from norva_cancel_live_preparation($1,NULL,$2)',[p.id,D]),{code:'42501'});
assert.equal((await one(db,'select state from live_playback_preparations where id=$1',[p.id])).state,'prepared');
});
await t.test('expired receipt still cancels but can never begin',async()=>{
const p=await prepare(db);await db.query("update live_playback_preparations set expires_at=clock_timestamp()-interval '1 second' where id=$1",[p.id]);
await assert.rejects(begin(db,p),{code:'55000'});assert.equal((await cancel(db,p)).state,'cancel_requested');
});
await t.test('browser roles cannot access the ledger or invoke privileged RPCs',async()=>{
await db.exec('set role authenticated');await assert.rejects(db.query('select * from live_playback_preparations'),{code:'42501'});
await assert.rejects(prepare(db),{code:'42501'});await db.exec('reset role');
});
await t.test('revoked device cannot reserve new work',async()=>{
await db.query('update cloud_devices set revoked=true where id=$1',[E]);await assert.rejects(prepare(db,E),{code:'42501'});
});
await t.test('bounded owner admission rejects excess rather than deleting active preparations',async()=>{
await db.exec("update live_playback_preparations set state='cancelled'");
for(let i=0;i<16;i++)await prepare(db);await assert.rejects(prepare(db),{code:'54000'});
assert.equal((await one(db,"select count(*)::int n from live_playback_preparations where state='prepared'")).n,16);
});
}finally{await db.close();}});
