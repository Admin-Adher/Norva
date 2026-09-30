'use strict';
// Actual PostgreSQL/WASM execution. For an isolated local run, install
// @electric-sql/pglite@0.5.8 in a scratch prefix and expose it through NODE_PATH.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); }
catch (error) {
  if (process.env.NORVA_REQUIRE_SELECTION_SQL === '1') throw error;
  // Optional in the general suite; the mandatory Build SQL step requires it.
}
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8').replace(/\r\n/g, '\n');
const migration = read('supabase/migrations/20260930160000_selection_capture_independent_admission.sql');
const queue = read('supabase/migrations/20260909190753_selection_audio_analysis_queue.sql');
function sqlFunction(source, name, delimiter = '$function$') {
  const start = source.search(new RegExp(`create (?:or replace )?function public\\.${name}\\(`, 'i'));
  assert.notEqual(start, -1, name);
  const body = source.indexOf(delimiter, start);
  const end = source.indexOf(delimiter + ';', body + delimiter.length);
  assert.ok(body > start && end > body, name);
  return source.slice(start, end + delimiter.length + 1);
}

async function fixture() {
  const db = new PGlite();
  // Only visibility's dependency tables/view are reduced. The source-identity,
  // owner lookup, claim, capture checkpoint and migration execute verbatim SQL.
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create function auth.jwt() returns jsonb language sql stable as $$select '{}'::jsonb$$;
    create table public.admin_feature_flags(key text primary key, enabled boolean not null);
    insert into public.admin_feature_flags values('language_capture_pipeline_enabled',false);
    create table public.cloud_sources(id uuid primary key,user_id uuid,enabled boolean,sync_status text,source_type text,deleted_at timestamptz);
    create table public.cloud_source_catalog_heads(source_id uuid primary key,user_id uuid,active_generation_id uuid);
    create table public.cloud_media_items(id uuid primary key,user_id uuid,source_id uuid,generation_id uuid,item_type text,available boolean,playback_hint jsonb);
    create table public.cloud_title_variants(id uuid primary key,user_id uuid,source_id uuid,generation_id uuid,media_item_id uuid,item_type text,external_id text,playback_hint jsonb);
    create view public.cloud_catalog_visible_title_variants as
      select v.* from public.cloud_title_variants v join public.cloud_sources s on s.id=v.source_id and s.user_id=v.user_id
      join public.cloud_source_catalog_heads h on h.source_id=s.id and h.user_id=s.user_id and h.active_generation_id=v.generation_id
      where s.enabled and s.deleted_at is null and s.sync_status='ready';
    create table public.metadata_proof_checks(label text primary key);
    create function public.metadata_assert(ok boolean,label text) returns void language plpgsql as $$
      begin if ok is distinct from true then raise exception 'metadata_fixture_%',label; end if;
      insert into public.metadata_proof_checks values(label); end $$;
    ${sqlFunction(read('supabase/migrations/20260823120000_provider_credential_transition_v1.sql'), 'norva_credential_require_service_role')}
    ${sqlFunction(read('supabase/migrations/20260909095957_selection_reenrollment_identity.sql'), 'norva_selection_source_identity_valid')}
    ${sqlFunction(read('supabase/migrations/20260911191032_strict_lid_capture_handoff.sql'), 'catalog_language_capture_pipeline_enabled', '$f$')}
    ${queue.slice(queue.indexOf('create table public.catalog_selection_audio_jobs'), queue.indexOf('create or replace function public.selection_audio_tracks_complete'))}
    ${sqlFunction(queue, 'selection_audio_job_owners')}
    ${sqlFunction(read('supabase/migrations/20260909194054_selection_audio_claim_bounded_candidates.sql'), 'claim_selection_audio_job')}
    revoke all on function public.claim_selection_audio_job() from public,anon,authenticated;
    grant execute on function public.claim_selection_audio_job() to service_role;
  `);
  await db.exec(read('supabase/migrations/20260911200200_selection_audio_capture_handoff.sql'));
  await db.exec(read('supabase/migrations/20260911204152_selection_parallel_capture_admission.sql'));
  return db;
}

test('Selection admission is independent, exact-file scoped and keeps private SQL controls', { skip: !PGlite }, async t => {
  const db = await fixture();
  const value = async sql => (await db.query(sql)).rows[0].value;
  const attributes = () => value(`select jsonb_build_object('oid',oid,'owner',proowner,'acl',proacl,'definer',prosecdef,
    'volatility',provolatile,'config',proconfig,'language',prolang) value from pg_proc
    where oid='public.selection_audio_capture_pipeline_enabled()'::regprocedure`);
  try {
    const before = await attributes();
    const flags = await value('select jsonb_object_agg(key,enabled) value from public.admin_feature_flags');
    const unchangedFunctions = () => value(`select jsonb_object_agg(proname,pg_get_functiondef(oid)) value
      from pg_proc where oid in ('public.claim_selection_audio_job()'::regprocedure,
        'public.selection_audio_job_owners(text,text)'::regprocedure,
        'public.checkpoint_selection_audio_capture(text,text,uuid,integer,integer,text,text,timestamptz)'::regprocedure,
        'public.defer_selection_audio_capture(text,text,uuid)'::regprocedure,
        'public.selection_audio_parallel_capture_enabled()'::regprocedure,
        'public.catalog_language_capture_pipeline_enabled()'::regprocedure)`);
    const controls = await unchangedFunctions();
    await db.exec("begin; update public.admin_feature_flags set enabled=true where key='selection_capture_pipeline_enabled'");
    assert.equal(await value('select public.selection_audio_capture_pipeline_enabled() value'), false, 'reproduces the legacy coupling before migration');
    await db.exec('rollback');
    await db.exec(migration);
    assert.deepEqual(await attributes(), before);
    assert.deepEqual(await unchangedFunctions(), controls);
    assert.deepEqual(await value('select jsonb_object_agg(key,enabled) value from public.admin_feature_flags'), flags);
    assert.equal(await value('select public.selection_audio_capture_pipeline_enabled() value'), false);
    assert.equal(await value("select has_function_privilege('anon','public.selection_audio_capture_pipeline_enabled()','EXECUTE') or has_function_privilege('authenticated','public.selection_audio_capture_pipeline_enabled()','EXECUTE') value"), false);

    await t.test('legacy alone never admits Selection; missing flag also fails closed', async () => {
      await db.exec("begin; update public.admin_feature_flags set enabled=true where key='language_capture_pipeline_enabled'");
      assert.equal(await value('select public.selection_audio_capture_pipeline_enabled() value'), false);
      await db.exec("delete from public.admin_feature_flags where key='selection_capture_pipeline_enabled'");
      assert.equal(await value('select public.selection_audio_capture_pipeline_enabled() value'), false);
      await db.exec('rollback');
    });
    await t.test('real checkpoint, owner, URL, lease, generation and terminal tests run with legacy OFF', async () => {
      await db.exec(read('tests/sql/selection-audio-capture-handoff.sql'));
      assert.equal(await value('select public.catalog_language_capture_pipeline_enabled() value'), false);
      assert.equal(await value('select public.selection_audio_capture_pipeline_enabled() value'), true);
      assert.equal(await value("select count(*)::int value from public.metadata_proof_checks where label='selection_capture_committed'"), 1);
      // The historical networkless runner uses an unfiltered visibility view.
      // Keep these stronger visibility checks in this scoped fixture, whose
      // view actually enforces enabled/deleted and active-generation state.
      await db.exec(`do $$ declare token uuid:=gen_random_uuid(); job uuid; begin
        perform set_config('request.jwt.claim.role','service_role',true);
        insert into public.catalog_selection_audio_jobs(external_id,url_sha256,state,attempt_count,lease_token,lease_until,profile,progress)
          values('norva-selection:movie:'||repeat('4',64),encode(sha256(convert_to('https://fixture.invalid/a.mkv','UTF8')),'hex'),
            'running',1,token,clock_timestamp()+interval '5 minutes',
            jsonb_build_object('fingerprint',repeat('c',64),'externalId','norva-selection:movie:'||repeat('4',64),
              'urlSha256',encode(sha256(convert_to('https://fixture.invalid/a.mkv','UTF8')),'hex'),
              'durationSeconds',600,'audioTracks',jsonb_build_array(jsonb_build_object('index',1))),
            '{"trackPosition":0,"receipts":[],"tracks":[],"evidence":[]}') returning id into job;
        if public.selection_capture_fixture(token) is null then raise exception 'visible checkpoint prerequisite missing'; end if;
        update public.cloud_sources set enabled=false;
        perform public.metadata_assert(public.selection_capture_fixture(token) is null,'selection_capture_disabled_source');
        update public.cloud_sources set enabled=true,deleted_at=clock_timestamp();
        perform public.metadata_assert(public.selection_capture_fixture(token) is null,'selection_capture_deleted_source');
        update public.cloud_sources set deleted_at=null;
        delete from public.catalog_selection_audio_jobs where id=job;
      end $$;`);
    });
    await t.test('parallel remains separately enabled and bounded to two work leases', async () => {
      await db.exec(read('tests/sql/selection-parallel-capture-admission.sql'));
      assert.equal(await value('select public.catalog_language_capture_pipeline_enabled() value'), false);
      assert.equal(await value("select count(*)::int value from public.metadata_proof_checks where label in ('selection_parallel_disabled_one_work_lease','selection_parallel_hard_two_work_leases','selection_parallel_old_failures_untouched')"), 3);
    });
    await t.test('migration refuses a changed admission expression instead of weakening it', async () => {
      // It must not silently apply a second time or accept an unfamiliar body.
      await assert.rejects(db.exec(migration), error => error.code === '55000');
      await db.exec('rollback');
      assert.deepEqual(await attributes(), before);
    });
    t.diagnostic(`${await value('select count(*)::int value from public.metadata_proof_checks')} SQL assertions executed; no provider requests`);
  } finally { await db.close(); }
});

test('operator recovery archives exhausted history and uses the canonical current-file seeder', { skip: !PGlite }, async t => {
  const db = await fixture();
  const revision = 'a'.repeat(40);
  try {
    await db.exec(migration);
    await db.exec(read('tests/sql/selection-audio-capture-handoff.sql'));
    await db.exec(`
      alter table public.cloud_media_items add column metadata jsonb default '{}'::jsonb;
      create table public.catalog_file_tracks(server_host text,item_type text,external_id text,
        audio_probed_at timestamptz,audio_lang_verification jsonb,audio_tracks jsonb);
      ${sqlFunction(read('supabase/migrations/20260719170000_variant_file_audio_crawler.sql'), 'catalog_audio_track_indexes')}
      ${sqlFunction(read('supabase/migrations/20260910184900_catalog_observed_language_aliases.sql'), 'norva_canonical_language_code')}
      ${sqlFunction(queue, 'selection_audio_tracks_complete')}
      ${sqlFunction(read('supabase/migrations/20260909194054_selection_audio_claim_bounded_candidates.sql'), 'seed_selection_audio_jobs')}
      select set_config('request.jwt.claim.role','service_role',false);
      insert into public.catalog_selection_audio_jobs(external_id,url_sha256,state,attempt_count,completed_at,error_code,profile,progress)
        values('norva-selection:movie:'||repeat('4',64),encode(sha256(convert_to('https://fixture.invalid/a.mkv','UTF8')),'hex'),
        'failed',8,'2026-01-01T00:00:00Z','SELECTION_AUDIO_GATEWAY_REJECTED',
        '{"fingerprint":"old"}','{"receipts":["old-private-receipt"]}');
      insert into public.catalog_selection_audio_captures(job_id,stream_index,window_ordinal,profile_fingerprint,audio_sha256,expires_at)
        select id,1,1,repeat('c',64),repeat('d',64),'2026-01-01T00:00:00Z' from public.catalog_selection_audio_jobs;
    `);
    await db.exec(read('supabase/migrations/20260930220000_selection_audio_audited_recovery.sql'));
    await db.exec(read('supabase/migrations/20260930223000_selection_seed_skip_existing_jobs.sql'));
    const old = (await db.query('select id,completed_at::text ended from public.catalog_selection_audio_jobs')).rows[0];
    const recover = (id=old.id, ended=old.ended, rev=revision) => db.query(
      'select public.recover_selection_audio_job($1,$2,$3) id',[id,ended,rev]);
    const count = async table => Number((await db.query(`select count(*) n from public.${table}`)).rows[0].n);
    const seed = async priority => (await db.query(`select public.seed_selection_audio_jobs(jsonb_build_array(
      jsonb_build_object('externalId',external_id,'urlSha256',url_sha256,'priority',$1::integer))) n
      from catalog_selection_audio_jobs where id=$2`,[priority,old.id])).rows[0].n;
    await t.test('known terminal jobs are skipped even for a higher priority',async()=>{
      assert.equal(await seed(1000),0);
      assert.equal((await db.query('select state from catalog_selection_audio_jobs')).rows[0].state,'failed');
    });
    await t.test('unchanged queued jobs skip reseeding, priority increases still validate the owner',async()=>{
      await db.exec("begin; update catalog_selection_audio_jobs set state='queued',completed_at=null,attempt_count=0,error_code=null");
      assert.equal(await seed(0),0);
      assert.equal(await seed(1000),1);
      assert.equal(await seed(1000),0);
      await db.exec('rollback');
      await db.exec("begin; update catalog_selection_audio_jobs set state='queued',completed_at=null,attempt_count=0,error_code=null; update cloud_sources set enabled=false");
      assert.equal(await seed(1000),0);
      await db.exec('rollback');
    });
    await t.test('orphan jobs revive only with a current eligible owner',async()=>{
      await db.exec("begin; update catalog_selection_audio_jobs set state='retry_wait',completed_at=null,attempt_count=1,error_code='NO_ACTIVE_OWNER'");
      assert.equal(await seed(0),1);
      assert.deepEqual((await db.query('select state,error_code,attempt_count from catalog_selection_audio_jobs')).rows[0],
        {state:'queued',error_code:null,attempt_count:1});
      await db.exec('rollback');
      await db.exec("begin; update catalog_selection_audio_jobs set state='retry_wait',completed_at=null,attempt_count=1,error_code='NO_ACTIVE_OWNER'; update cloud_sources set enabled=false");
      assert.equal(await seed(0),0);
      await db.exec('rollback');
    });
    await t.test('private history and service-only execution', async () => {
      const r = (await db.query(`select
        has_function_privilege('authenticated','public.recover_selection_audio_job(uuid,timestamptz,text)','EXECUTE') client,
        has_table_privilege('service_role','public.catalog_selection_audio_recoveries','UPDATE') writable,
        (select relrowsecurity and relforcerowsecurity from pg_class where oid='public.catalog_selection_audio_recoveries'::regclass) rls`)).rows[0];
      assert.deepEqual(r,{client:false,writable:false,rls:true});
    });
    for (const [label,change] of [
      ['client role',"select set_config('request.jwt.claim.role','authenticated',true)"],
      ['capture off',"update admin_feature_flags set enabled=false where key='selection_capture_pipeline_enabled'"],
      ['completed work',"update catalog_selection_audio_jobs set state='completed'"],
      ['budget not exhausted',"update catalog_selection_audio_jobs set attempt_count=7"],
      ['wrong terminal cause',"update catalog_selection_audio_jobs set error_code='SELECTION_AUDIO_FILE_CHANGED'"],
      ['disabled source',"update cloud_sources set enabled=false"],
      ['deleted source',"update cloud_sources set deleted_at=clock_timestamp()"],
      ['retired generation',"update cloud_source_catalog_heads set active_generation_id=gen_random_uuid()"],
      ['changed media URL',`update cloud_media_items set playback_hint='{"targetUrl":"https://fixture.invalid/other.mkv"}'`],
      ['already complete audio',`insert into catalog_file_tracks
        select 'source:'||source_id::text,'movie',external_id,clock_timestamp(),
          jsonb_build_object('urlSha256',encode(sha256(convert_to('https://fixture.invalid/a.mkv','UTF8')),'hex')),
          '[{"index":1,"lang":"fr"}]'::jsonb from cloud_title_variants`],
    ]) await t.test(label,async()=>{
      await db.exec('begin');
      await db.exec(change);
      await assert.rejects(recover());
      await db.exec('rollback');
      assert.equal(await count('catalog_selection_audio_jobs'),1);
      assert.equal(await count('catalog_selection_audio_captures'),1);
      assert.equal(await count('catalog_selection_audio_recoveries'),0);
    });
    await t.test('stale completion and malformed repair references fail',async()=>{
      await assert.rejects(recover(old.id,'2026-01-02',revision));
      await assert.rejects(recover(old.id,old.ended,'untrusted-ref'));
    });
    await t.test('recent terminal failures cannot receive an immediate new budget',async()=>{
      await db.exec('begin');
      const ended=(await db.query('update catalog_selection_audio_jobs set completed_at=clock_timestamp() returning completed_at::text ended')).rows[0].ended;
      await assert.rejects(recover(old.id,ended));
      await db.exec('rollback');
    });
    const replacement=(await recover()).rows[0].id;
    await t.test('history and expired captures preserved, new identity contains no stale evidence',async()=>{
      assert.notEqual(replacement,old.id);
      const fresh=(await db.query('select state,attempt_count,profile,progress from catalog_selection_audio_jobs')).rows[0];
      assert.deepEqual(fresh,{state:'queued',attempt_count:0,profile:{},progress:{}});
      const archive=(await db.query('select original_job,original_captures from catalog_selection_audio_recoveries')).rows[0];
      assert.equal(archive.original_job.id,old.id);
      assert.equal(archive.original_job.attempt_count,8);
      assert.deepEqual(archive.original_job.progress.receipts,['old-private-receipt']);
      assert.equal(archive.original_captures.length,1);
      assert.equal(await count('catalog_selection_audio_captures'),0);
      assert.equal((await recover()).rows[0].id,replacement);
      assert.equal(await count('catalog_selection_audio_jobs'),1);
      await assert.rejects(recover(old.id,old.ended,'b'.repeat(40)));
    });
    await t.test('replacement follows normal claim and can never be recovered a second time',async()=>{
      const claimed=(await db.query('select public.claim_selection_audio_job() job')).rows[0].job;
      assert.equal(claimed.id,replacement);
      assert.equal(claimed.attempt_count,1);
      await db.exec(`update catalog_selection_audio_jobs set state='failed',attempt_count=8,
        completed_at='2026-01-01',lease_token=null,lease_until=null,error_code='SELECTION_AUDIO_GATEWAY_REJECTED'`);
      await assert.rejects(recover(replacement,old.ended));
      assert.equal(await count('catalog_selection_audio_recoveries'),1);
    });
  } finally { await db.close(); }
});
