'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch (_) { /* opt-in actual PostgreSQL */ }
const root = path.resolve(__dirname, '..');
const migration = fs.readFileSync(path.join(root,'supabase/migrations/20260910102245_catalog_public_title_reuse.sql'),'utf8');
const onlineIndex = fs.readFileSync(path.join(root,'supabase/migrations/20260910102428_catalog_public_title_alias_index_online.sql'),'utf8');
const payload = (id=101,year=2023,title='The Squad: Home Run') => ({
  tmdb: { id,title,release_date: `${year}-01-01`,poster_path:'/test.jpg',genres:['Action'] },
  tmdbValidation:{valid:true,title,year:String(year),confidence:1},
  i18n:{fr:{title:'Antigang : La Relève',overview:'Un synopsis public.'},en:{title}},
  source_id:'PRIVATE',audio_tracks:[{lang:'DO-NOT-COPY'}],providerUrl:'https://private.invalid'
});

test('public title reuse SQL is bounded, index-backed and rejects ambiguous/unvalidated evidence', {skip:!PGlite}, async t => {
  const db=new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create schema auth; create function auth.jwt() returns jsonb language sql stable as $$select '{}'::jsonb$$;
      grant usage on schema auth to service_role;
      set request.jwt.claim.role='service_role';
      create table public.catalog_titles(item_type text,provider_tmdb_id text,title text,original_title text,release_year integer,
        poster_url text,backdrop_url text,metadata jsonb,updated_at timestamptz default now(),enriched_at timestamptz default now(),
        audio_languages text[],primary key(item_type,provider_tmdb_id));
      create function public.norva_credential_require_service_role() returns void language plpgsql as $$
        begin if current_setting('role',true) not in ('none','service_role') then raise exception 'service only' using errcode='42501'; end if; end $$;
      grant usage on schema public to anon,authenticated,service_role;
      grant select on public.catalog_titles to service_role;`);
    await db.exec(migration);
    // CONCURRENTLY is deployed separately on real PG17; exercise identical
    // expression/predicate/ACL semantics in the isolated WASM database.
    await db.exec(onlineIndex.replace('create index concurrently','create index'));
    await db.exec('create trigger keep_best before insert or update on public.catalog_titles for each row execute function public.catalog_titles_keep_best()');
    const insert=async(id=101,year=2023,data=payload(id,year),type='movie') => db.query(
      'insert into public.catalog_titles(item_type,provider_tmdb_id,title,release_year,metadata,audio_languages) values($1,$2,$3,$4,$5,$6)',
      [type,String(id),data.tmdb?.title||'Provider title',year,data,['untouched']]);
    await insert();
    const q={itemType:'movie',title:'The Squad Home Run',year:2023,posterPath:null};
    const lookup=async(queries=[q]) => (await db.query('select * from public.norva_public_catalog_title_candidates($1)',[JSON.stringify(queries)])).rows;
    const run=(name,fn)=>t.test(name,async()=>{await db.exec('begin');try{await fn();}finally{await db.exec('rollback');}});
    await run('exact public alias plus year returns only public editorial metadata',async()=>{
      await db.exec('set local role service_role');
      const rows=await lookup();assert.equal(rows.length,1);assert.equal(rows[0].provider_tmdb_id,'101');
      assert.deepEqual(Object.keys(rows[0].metadata).sort(),['i18n','tmdb','tmdbValidation']);
      assert.doesNotMatch(JSON.stringify(rows),/PRIVATE|DO-NOT-COPY|private.invalid|audio_tracks/);
    });
    await run('French translation, punctuation and case reuse the same validated entity',async()=>{
      assert.equal((await lookup([{...q,title:'ANTIGANG LA RELÈVE'}]))[0].provider_tmdb_id,'101');
    });
    await run('no year requires exact TMDB artwork; conflicting year remains vetoed',async()=>{
      assert.equal((await lookup([{...q,year:null}])).length,0);
      assert.equal((await lookup([{...q,year:null,posterPath:'/test.jpg'}])).length,1);
      assert.equal((await lookup([{...q,year:2003,posterPath:'/test.jpg'}])).length,0);
    });
    await run('two matching entities are ambiguous, even when one is listed first',async()=>{
      await insert(102);assert.equal((await lookup()).length,0);
    });
    await run('wrong year and movie/series namespaces cannot donate',async()=>{
      assert.equal((await lookup([{...q,year:1990}])).length,0);
      assert.equal((await lookup([{...q,itemType:'series'}])).length,0);
    });
    await run('unvalidated payload and conflicting TMDB payload ID are not candidates',async()=>{
      await db.exec('alter table public.catalog_titles disable trigger keep_best');
      await db.query('update public.catalog_titles set metadata=$1',[{...payload(),tmdbValidation:{valid:false}}]);
      assert.equal((await lookup()).length,0);
      await db.query('update public.catalog_titles set metadata=$1',[payload(999)]);
      assert.equal((await lookup()).length,0);
    });
    await run('batch indexes map to input positions and no table mutations occur',async()=>{
      const before=await db.query('select * from public.catalog_titles');
      assert.deepEqual((await lookup([{...q,title:'Unrelated'},q])).map(x=>x.query_index),[1]);
      assert.deepEqual(await db.query('select * from public.catalog_titles'),before);
    });
    for(const role of ['anon','authenticated']) await run(`${role} cannot call public cache RPC`,async()=>{
      await db.exec(`set local role ${role}`);await assert.rejects(lookup(),e=>e.code==='42501');
    });
    for(const [name,input] of [['empty',[]],['oversized',Array(51).fill(q)],['unknown type',[{...q,itemType:'episode'}]],['malformed year',[{...q,year:'bad'}]],['provider URL',[{...q,posterPath:'https://private.invalid/x.jpg'}]]]) {
      await run(`invalid ${name} input fails closed`,async()=>{await assert.rejects(lookup(input),e=>e.code==='22023');});
    }
    await run('failed filename validation cannot erase validated shared cache',async()=>{
      await db.query("update public.catalog_titles set title='Bad raw title',metadata=$1",[{...payload(),tmdbValidation:{valid:false}}]);
      const rows=await db.query('select title,metadata,audio_languages from public.catalog_titles');
      assert.equal(rows.rows[0].metadata.tmdbValidation.valid,true);
      assert.equal(rows.rows[0].title,'The Squad: Home Run');assert.deepEqual(rows.rows[0].audio_languages,['untouched']);
    });
    await run('fresh validated metadata keeps other existing translations',async()=>{
      await db.query('update public.catalog_titles set metadata=$1',[{...payload(),i18n:{de:{title:'German title'}}}]);
      const rows=await lookup();assert.ok(rows[0].metadata.i18n.fr);assert.ok(rows[0].metadata.i18n.de);
    });
    await run('raw refresh cannot regress public metadata freshness or audio',async()=>{
      await db.exec("update public.catalog_titles set title='Raw',metadata='{}',updated_at=now()-interval '1 day'");
      assert.equal((await lookup()).length,1);
      assert.deepEqual((await db.query('select audio_languages from public.catalog_titles')).rows[0].audio_languages,['untouched']);
    });
  } finally {await db.close();}
});
