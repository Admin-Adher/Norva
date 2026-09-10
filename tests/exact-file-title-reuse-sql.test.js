'use strict';
// Executable PostgreSQL/WASM integration coverage, not a mocked RPC. Dependency
// is optional for the general Node suite: install @electric-sql/pglite@0.5.8 in
// a scratch prefix and add that node_modules directory to NODE_PATH to run it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch (_) { /* opt-in SQL runtime */ }
const root = path.resolve(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20260910084106_exact_file_validated_title_reuse.sql'), 'utf8');
const foundation = fs.readFileSync(path.join(root, 'supabase/migrations/20260823120000_provider_credential_transition_v1.sql'), 'utf8');
const snapshotStart = foundation.indexOf('create or replace function public.norva_get_catalog_write_snapshot(');
const snapshotEnd = foundation.indexOf('$function$;', snapshotStart) + '$function$;'.length;
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const params = [uuid(1), uuid(11), uuid(21), '1', '2', '3', '4', 'movie', ['file-1']];
const callSql = 'select * from public.norva_exact_file_title_candidates($1,$2,$3,$4,$5,$6,$7,$8,$9)';
const metadata = (id = 101) => ({
  tmdbValidation: { valid: true, title: 'Example Film', year: '2020', confidence: 1 },
  tmdb: { id, title: 'Example Film', release_date: '2020-01-01', genres: [{ id: 12, name: 'Adventure' }] },
  i18n: { fr: { title: 'Film exemple', overview: 'Synopsis public.' } },
  accountSecret: 'must-not-escape', providerUrl: 'https://private.invalid',
});

test('exact-file reuse runs against PostgreSQL with active-generation, conflict and ACL guards', { skip: !PGlite }, async (t) => {
  const db = new PGlite();
  try {
    // Minimal dependency contracts. The function under test and the snapshot
    // function are loaded verbatim from migrations. The visibility predicate
    // models visible/hidden state; this is not a full Supabase-stack rehearsal.
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table public.cloud_source_catalog_heads(source_id uuid primary key,user_id uuid,active_generation_id uuid,head_revision bigint);
      create table public.cloud_source_lifecycle(source_id uuid primary key,user_id uuid,config_revision bigint,visibility_epoch bigint,visible boolean);
      create table public.cloud_user_catalog_visibility_epochs(user_id uuid primary key,visibility_epoch bigint);
      create table public.cloud_source_catalog_generations(id uuid primary key,source_id uuid,user_id uuid,state text);
      create table public.catalog_source_provider_identities(source_id uuid primary key,user_id uuid,identity_id uuid,verification_method text);
      create table public.provider_identities(id uuid primary key,status text);
      insert into public.provider_identities values('${uuid(99)}','active');
      create index on public.catalog_source_provider_identities(identity_id,source_id);
      create table public.cloud_media_items(id uuid primary key,source_id uuid,user_id uuid,generation_id uuid,item_type text,external_id text,available boolean);
      create unique index on public.cloud_media_items(source_id,generation_id,item_type,external_id);
      create table public.cloud_title_variants(source_id uuid,user_id uuid,generation_id uuid,item_type text,external_id text,media_item_id uuid,title_id uuid);
      create unique index on public.cloud_title_variants(source_id,generation_id,item_type,external_id);
      create table public.cloud_titles(id uuid primary key,user_id uuid,item_type text,provider_tmdb_id text,match_status text,metadata jsonb);
      create table public.cloud_source_catalog_generation_candidate_titles(generation_id uuid,title_id uuid,user_id uuid,source_id uuid,item_type text,provider_tmdb_id text,match_status text,catalog_metadata jsonb,primary key(generation_id,title_id));
      create table public.catalog_titles(item_type text,provider_tmdb_id text,metadata jsonb,primary key(item_type,provider_tmdb_id));
      create function public.norva_credential_require_service_role() returns void language plpgsql as $$
      begin if current_setting('role',true) not in ('none','service_role') then raise exception 'service only' using errcode='42501'; end if; end $$;
      create function public.norva_source_catalog_visible_internal(source uuid,owner_id uuid) returns boolean
      language sql stable as $$ select coalesce((select visible from public.cloud_source_lifecycle where source_id=source and user_id=owner_id),false) $$;
      ${foundation.slice(snapshotStart, snapshotEnd)}
      revoke all on all tables in schema public from public,anon,authenticated;
      grant usage on schema public to service_role,anon,authenticated;
      grant select on all tables in schema public to service_role;
      revoke all on public.cloud_source_catalog_generation_candidate_titles from service_role;
      revoke all on function public.norva_credential_require_service_role() from public,anon,authenticated,service_role;
    `);
    await db.exec(migration);
    for (const n of [1, 2, 3]) {
      await db.query('insert into public.cloud_source_catalog_heads values($1,$2,$3,1)', [uuid(n + 10), uuid(n), uuid(n + 20)]);
      await db.query('insert into public.cloud_source_lifecycle values($1,$2,2,3,true)', [uuid(n + 10), uuid(n)]);
      await db.query('insert into public.cloud_user_catalog_visibility_epochs values($1,4)', [uuid(n)]);
      await db.query("insert into public.cloud_source_catalog_generations values($1,$2,$3,'active')", [uuid(n + 20), uuid(n + 10), uuid(n)]);
      await db.query("insert into public.catalog_source_provider_identities values($1,$2,$3,'automatic')", [uuid(n + 10), uuid(n), uuid(99)]);
      await db.query("insert into public.cloud_media_items values($1,$2,$3,$4,'movie','file-1',true)", [uuid(n + 30), uuid(n + 10), uuid(n), uuid(n + 20)]);
    }
    await db.query("insert into public.cloud_titles values($1,$2,'movie','101','provider_verified',$3)", [uuid(42), uuid(2), metadata()]);
    await db.query("insert into public.cloud_title_variants values($1,$2,$3,'movie','file-1',$4,$5)", [uuid(12), uuid(2), uuid(22), uuid(32), uuid(42)]);
    const run = async (name, fn) => t.test(name, async () => {
      await db.exec('begin');
      try { await fn(); } finally { await db.exec('rollback'); }
    });
    const lookup = async (overrides = {}) => (await db.query(callSql, Object.assign([...params], overrides))).rows;
    await run('validated peer without any file-track cache returns only public metadata', async () => {
      await db.exec('set local role service_role');
      const result = await lookup();
      assert.equal(result.length, 1);
      assert.equal(result[0].provider_tmdb_id, '101');
      assert.deepEqual(Object.keys(result[0]).sort(), ['external_id','metadata','provider_tmdb_id']);
      assert.deepEqual(Object.keys(result[0].metadata).sort(), ['i18n','tmdb','tmdbValidation']);
      assert.doesNotMatch(JSON.stringify(result), /must-not-escape|private.invalid|user_id|source_id/);
    });
    await run('no mutation and deterministic repeated lookup', async () => {
      const before = await db.query('select count(*) n from public.cloud_titles');
      assert.deepEqual(await lookup(), await lookup());
      assert.deepEqual(await db.query('select count(*) n from public.cloud_titles'), before);
    });
    for (const role of ['anon', 'authenticated']) await run(`${role} cannot execute the endpoint`, async () => {
      await db.exec(`set local role ${role}`);
      await assert.rejects(lookup(), (error) => error.code === '42501');
    });
    await run('service-role raw access to private generation payloads stays revoked', async () => {
      await db.exec('set local role service_role');
      await assert.rejects(db.query('select * from public.cloud_source_catalog_generation_candidate_titles'), (error) => error.code === '42501');
    });
    await run('wrong owner is rejected', async () => {
      await assert.rejects(lookup({ 0: uuid(3) }), (error) => error.code === 'P0002');
    });
    for (const index of [2,3,4,5,6]) await run(`stale generation fence field ${index} is rejected`, async () => {
      await assert.rejects(lookup({ [index]: index === 2 ? uuid(77) : '99' }), (error) => error.code === 'PT409');
    });
    await run('hidden target is rejected', async () => {
      await db.query('update public.cloud_source_lifecycle set visible=false where source_id=$1', [uuid(11)]);
      await assert.rejects(lookup(), (error) => error.code === 'PT409');
    });
    await run('unrequested or unavailable target file yields no peer metadata', async () => {
      assert.deepEqual(await lookup({ 8: ['absent'] }), []);
      await db.query('update public.cloud_media_items set available=false where id=$1', [uuid(31)]);
      assert.deepEqual(await lookup(), []);
    });
    await run('movie and series identifiers are isolated', async () => {
      assert.deepEqual(await lookup({ 7: 'series' }), []);
    });
    for (const source of [11,12]) await run(`source-local attestation ${source} cannot share metadata`, async () => {
      await db.query("update public.catalog_source_provider_identities set verification_method='admin_attested_source_local' where source_id=$1", [uuid(source)]);
      assert.deepEqual(await lookup(), []);
    });
    await run('unrecognized or different provider stays isolated', async () => {
      await db.query('update public.catalog_source_provider_identities set identity_id=$1 where source_id=$2', [uuid(98),uuid(12)]);
      assert.deepEqual(await lookup(), []);
      await db.query('delete from public.catalog_source_provider_identities where source_id=$1', [uuid(11)]);
      assert.deepEqual(await lookup(), []);
    });
    await run('inactive provider identity is not shared', async () => {
      await db.query("update public.provider_identities set status='retired'");
      assert.deepEqual(await lookup(), []);
    });
    await run('hidden, stale or unavailable peer file cannot contribute', async () => {
      await db.query('update public.cloud_source_lifecycle set visible=false where source_id=$1', [uuid(12)]);
      assert.deepEqual(await lookup(), []);
      await db.query('update public.cloud_source_lifecycle set visible=true where source_id=$1', [uuid(12)]);
      await db.query("update public.cloud_source_catalog_generations set state='retired' where id=$1", [uuid(22)]);
      assert.deepEqual(await lookup(), []);
      await db.query("update public.cloud_source_catalog_generations set state='active' where id=$1", [uuid(22)]);
      await db.query('update public.cloud_media_items set available=false where id=$1', [uuid(32)]);
      assert.deepEqual(await lookup(), []);
    });
    await run('a different exact file cannot lend a title', async () => {
      await db.query("update public.cloud_title_variants set external_id='other-file'");
      assert.deepEqual(await lookup(), []);
    });
    await run('manual, weak or unvalidated metadata is not shareable', async () => {
      for (const status of ['manual','weak','provider_unverified','unmatched']) {
        await db.query('update public.cloud_titles set match_status=$1', [status]);
        assert.deepEqual(await lookup(), []);
      }
      await db.query("update public.cloud_titles set match_status='provider_verified',metadata=jsonb_set(metadata,'{tmdbValidation,valid}','false')");
      assert.deepEqual(await lookup(), []);
    });
    await run('contradictory IDs, including a manual peer, are vetoed', async () => {
      await db.query("insert into public.cloud_titles values($1,$2,'movie','202','manual',$3)", [uuid(43),uuid(3),metadata(202)]);
      await db.query("insert into public.cloud_title_variants values($1,$2,$3,'movie','file-1',$4,$5)", [uuid(13),uuid(3),uuid(23),uuid(33),uuid(43)]);
      assert.deepEqual(await lookup(), []);
    });
    await run('active projection payload replaces the shared shell, never falls back through an invalid projection', async () => {
      await db.query("insert into public.cloud_source_catalog_generation_candidate_titles values($1,$2,$3,$4,'movie','202','provider_verified',$5)", [uuid(22),uuid(42),uuid(2),uuid(12),metadata(202)]);
      assert.equal((await lookup())[0].provider_tmdb_id, '202');
      await db.query("update public.cloud_source_catalog_generation_candidate_titles set match_status='unmatched',catalog_metadata='{}'");
      assert.deepEqual(await lookup(), []);
    });
    await run('public catalog can supply rich payload for a thin but validated peer', async () => {
      await db.query("update public.cloud_titles set metadata='{}'");
      assert.deepEqual(await lookup(), []);
      await db.query("insert into public.catalog_titles values('movie','101',$1)", [metadata()]);
      assert.equal((await lookup())[0].metadata.tmdb.id, 101);
      await db.query("update public.cloud_titles set metadata='{\"tmdbValidation\":{\"valid\":false}}'");
      assert.deepEqual(await lookup(), [], 'an explicit invalidation cannot be undone by the global payload');
    });
    await run('bound, null and invalid inputs are rejected', async () => {
      for (const override of [{ 8: Array(201).fill('file-1') }, { 8: [null] }, { 8: [''] }, { 8: ['a'.repeat(256)] }, { 7: 'live' }]) {
        await db.exec('savepoint bad_input');
        await assert.rejects(lookup(override), (error) => error.code === '22023');
        await db.exec('rollback to savepoint bad_input');
      }
      assert.deepEqual(await lookup({ 8: [] }), []);
    });
    await run('query uses existing exact-key indexes with a sizeable unrelated catalogue', async () => {
      await db.exec(`insert into public.cloud_media_items
        select md5('media-'||i)::uuid,'${uuid(12)}','${uuid(2)}','${uuid(22)}','movie','unrelated-'||i,true from generate_series(1,20000) i;
        insert into public.cloud_title_variants
        select '${uuid(12)}','${uuid(2)}','${uuid(22)}','movie','unrelated-'||i,md5('media-'||i)::uuid,'${uuid(42)}' from generate_series(1,20000) i;
        analyze public.cloud_media_items; analyze public.cloud_title_variants;`);
      const start = performance.now();
      assert.equal((await lookup()).length, 1);
      const elapsedMs = Math.round(performance.now() - start);
      t.diagnostic(`Exact lookup with 20,000 unrelated variants: ${elapsedMs} ms (local WASM, not production latency).`);
      const plan = await db.query(`explain (format json) select * from public.cloud_title_variants
        where source_id=$1 and generation_id=$2 and item_type='movie' and external_id='file-1'`, [uuid(12),uuid(22)]);
      assert.match(JSON.stringify(plan.rows), /Index Scan/);
    });
  } finally { await db.close(); }
});
