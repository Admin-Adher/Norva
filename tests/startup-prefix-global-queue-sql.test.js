const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
let PGlite;try{({PGlite}=require('@electric-sql/pglite'));}catch(error){if(process.env.NORVA_REQUIRE_STARTUP_SQL==='1')throw error;}
const migration=fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261011203000_startup_prefix_global_queue.sql'),'utf8');
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
async function fixture(t){const db=new PGlite();t.after(()=>db.close());await db.exec(`
 create role anon;create role authenticated;create role service_role;
 create schema auth;create table auth.users(id uuid primary key);
 create table cloud_sources(id uuid primary key,user_id uuid);
 create table cloud_source_lifecycle(source_id uuid,user_id uuid,config_revision bigint,visibility_epoch bigint,visible boolean);
`);
await db.exec(`create view cloud_catalog_visible_sources as select s.* from cloud_sources s join cloud_source_lifecycle l
 on l.source_id=s.id and l.user_id=s.user_id where l.visible;
 create table cloud_source_catalog_heads(source_id uuid,user_id uuid,active_generation_id uuid);
 create table cloud_user_catalog_visibility_epochs(user_id uuid,visibility_epoch bigint);
 create table cloud_media_items(id uuid,user_id uuid,source_id uuid,item_type text,external_id text,parent_external_id text,
  release_year integer,metadata jsonb default '{}',available boolean default true,generation_id uuid);
 create view cloud_catalog_visible_media_items as select i.* from cloud_media_items i
  join cloud_catalog_visible_sources s on s.id=i.source_id and s.user_id=i.user_id
  left join cloud_source_catalog_heads h on h.source_id=i.source_id and h.user_id=i.user_id
  where i.generation_id is null or i.generation_id=h.active_generation_id;
 create function norva_credential_require_service_role() returns void language plpgsql as $$begin
  if current_setting('request.jwt.claim.role',true) is distinct from 'service_role' then raise exception 'service only' using errcode='42501';end if;end$$;
 select set_config('request.jwt.claim.role','service_role',false);
 ${migration}
`);
const addSource=async(s,u)=>db.exec(`insert into auth.users values('${id(u)}') on conflict do nothing;
 insert into cloud_sources values('${id(s)}','${id(u)}');
 insert into cloud_source_lifecycle values('${id(s)}','${id(u)}',1,1,true);
 insert into cloud_source_catalog_heads values('${id(s)}','${id(u)}','${id(900+s)}');`);
const add=async(s,u,n,{year=new Date().getUTCFullYear(),metadata={},type='movie',parent=null,generation=900+s,available=true}={})=>db.query(
 'insert into cloud_media_items values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[id(10000+n),id(u),id(s),type,String(n),parent,year,metadata,available,id(generation)]);
const claim=async()=>(await db.query('select claim_startup_prefix_queue() job')).rows[0].job;
const ack=async(job,prepared=true,drained=true,retry=60)=>(await db.query('select ack_startup_prefix_queue($1,$2,$3,$4) ok',[job.leaseId,prepared,drained,retry])).rows[0].ok;
return {db,addSource,add,claim,ack};}
test('global queue runs the actual migration and persists bounded fair catalogue scanning',{skip:!PGlite},async t=>{
 const h=await fixture(t),year=new Date().getUTCFullYear();await h.addSource(10,1);await h.addSource(20,2);
 await h.add(10,1,1);await h.add(10,1,2);await h.add(20,2,3);
 await t.test('a claimed account is not claimed again; another owner is selected',async()=>{
  const one=await h.claim();assert.equal(one.target.userId,id(1));
  const two=await h.claim();assert.equal(two.target.userId,id(2));assert.notEqual(one.leaseId,two.leaseId);
  assert.equal(await h.claim(),null);assert.equal(await h.ack(one),true);assert.equal(await h.ack(two),true);
 });
 await t.test('completed jobs leave the bounded work set and duplicated acknowledgments fail',async()=>{
  const job=await h.claim();assert.equal(job.target.itemId,'2');assert.equal(await h.ack(job),true);assert.equal(await h.ack(job),false);
  assert.equal((await h.db.query('select count(*)::int n from startup_prefix_queue')).rows[0].n,0);
 });
 await t.test('uncertain drain retains lease; definite deferral is delayed and can be reclaimed after expiry',async()=>{
  await h.add(10,1,4);await h.db.exec("update startup_prefix_scan_cursors set positions='{}',next_scan_at='-infinity',turns=0");
  const job=await h.claim();assert.ok(job);assert.equal(await h.ack(job,true,false),false);
  const row=(await h.db.query('select * from startup_prefix_queue where lease_id=$1',[job.leaseId])).rows[0];assert.ok(row.lease_id);
  assert.equal(await h.ack(job,false,true,3600),true);
  const delayed=(await h.db.query('select next_at-clock_timestamp() delay from startup_prefix_queue where source_id=$1 and external_id=$2',[job.target.sourceId,job.target.itemId])).rows[0];assert.ok(delayed.delay);
 });
 await t.test('source visibility and revision changes prevent stale acknowledgment',async()=>{
  await h.db.exec("update startup_prefix_queue set next_at='-infinity'; update startup_prefix_scan_cursors set next_scan_at='infinity'");
  const job=await h.claim();assert.ok(job);
  await h.db.query('update cloud_source_lifecycle set visible=false,visibility_epoch=visibility_epoch+1 where source_id=$1',[job.target.sourceId]);
  assert.equal(await h.ack(job),false);
  const next=await h.claim();if(next){assert.notEqual(next.target.sourceId,job.target.sourceId);await h.ack(next);}
 });
 await t.test('only service role can read jobs or invoke claim/ack',async()=>{
  await h.db.exec('set role anon');await assert.rejects(h.db.query('select * from startup_prefix_queue'),{code:'42501'});
  await assert.rejects(h.db.query('select claim_startup_prefix_queue()'),{code:'42501'});await h.db.exec('reset role');
  await h.db.exec("select set_config('request.jwt.claim.role','authenticated',false)");await assert.rejects(h.claim(),{code:'42501'});
 });
});
test('recency is release date authority; parents, imports and hidden generations are excluded',{skip:!PGlite},async t=>{
 const h=await fixture(t),year=new Date().getUTCFullYear();await h.addSource(10,1);
 await h.add(10,1,1,{year:null,metadata:{year:String(year)}});
 await h.add(10,1,2,{year:2001,metadata:{year:String(year)}});
 await h.add(10,1,3,{type:'series',parent:null});
 await h.add(10,1,4,{type:'series',parent:'parent'});
 await h.add(10,1,5,{type:'episode',parent:'parent'});
 await h.add(10,1,6,{generation:999});await h.add(10,1,7,{available:false});
 const seen=[];
 for(let i=0;i<12;i++){const job=await h.claim();if(job){seen.push(job.target.itemId);await h.ack(job);}}
 assert.ok(seen.includes('1'));assert.ok(seen.includes('4'));assert.ok(seen.includes('5'));assert.ok(seen.includes('2'));
 for(const n of ['3','6','7'])assert.equal(seen.includes(n),false);
 const priority=(await h.db.query('select positions from startup_prefix_scan_cursors')).rows[0].positions;assert.ok(priority);
});
test('pagination continues past one page instead of retaining completed jobs forever',{skip:!PGlite},async t=>{
 const h=await fixture(t);await h.addSource(10,1);for(let i=0;i<70;i++)await h.add(10,1,i);
 const first=await h.claim();assert.ok(first);
 assert.ok((await h.db.query('select count(*)::int n from startup_prefix_queue')).rows[0].n<=64);
 const firstPosition=(await h.db.query('select positions from startup_prefix_scan_cursors')).rows[0].positions;
 await h.ack(first);const second=await h.claim();assert.ok(second);await h.ack(second);
 const nextPosition=(await h.db.query('select positions from startup_prefix_scan_cursors')).rows[0].positions;
 assert.notDeepEqual(firstPosition,nextPosition);assert.equal((await h.db.query('select count(*)::int n from startup_prefix_queue')).rows[0].n,68);
});

test('lease expiry, source revision and generation fence stale queue results',{skip:!PGlite},async t=>{
 const h=await fixture(t);await h.addSource(10,1);await h.add(10,1,1);
 const old=await h.claim();await h.db.exec("update startup_prefix_queue set lease_until=clock_timestamp()-interval '1 second'");
 const next=await h.claim();assert.equal(next.target.itemId,old.target.itemId);assert.notEqual(next.leaseId,old.leaseId);
 assert.equal(await h.ack(old),false);
 await h.db.exec('update cloud_source_lifecycle set config_revision=config_revision+1');assert.equal(await h.ack(next),false);
 await h.db.exec("update startup_prefix_scan_cursors set next_scan_at='-infinity'");
 const revised=await h.claim();assert.ok(revised);
 await h.db.exec(`update cloud_source_catalog_heads set active_generation_id='${id(999)}'`);
 assert.equal(await h.ack(revised),false);assert.equal(await h.claim(),null);
 await h.add(10,1,2,{generation:999});await h.db.exec("update startup_prefix_scan_cursors set next_scan_at='-infinity',positions='{}',turns=0");
 const current=await h.claim();assert.equal(current.target.itemId,'2');await h.ack(current);
 await h.db.exec('delete from cloud_sources');assert.equal((await h.db.query('select count(*)::int n from startup_prefix_queue')).rows[0].n,0);
 assert.equal((await h.db.query('select count(*)::int n from startup_prefix_scan_cursors')).rows[0].n,0);
});
