const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); }
catch (error) { if (process.env.NORVA_REQUIRE_SELECTION_SQL === '1') throw error; }
const read = name => fs.readFileSync(path.join(__dirname, '..', 'supabase/migrations', name), 'utf8');
function fn(source, name) {
  const start = source.search(new RegExp(`create (?:or replace )?function public\\.${name}\\(`, 'i'));
  assert.ok(start >= 0, name);
  const body = source.indexOf('$function$', start);
  return source.slice(start, source.indexOf('$function$;', body + 10) + 11);
}
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const user = id(1), source = id(2), generation = id(3), media = id(4), variant = id(5);
const external = 'norva-selection:movie:' + 'a'.repeat(64);
const url = 'https://example.invalid/fixture.mp4';
const digest = require('node:crypto').createHash('sha256').update(url).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const profile = { externalId:external, urlSha256:digest, fingerprint:'b'.repeat(64), probedAt:'2026-09-30T21:00:00.000Z',
  fileSizeBytes:123456, durationSeconds:600, probeSource:'gatewayprobe', windowCount:6,
  audioTracks:[{ index:1, lang:null, codec:'aac', channels:6 }], subtitleTracks:[] };
const result = { verified:true, audioTracks:[{ index:1, lang:'es', codec:'aac' }], subtitleTracks:[],
  verification:{ method:'selection-strict-lid-v1', status:'verified', urlSha256:digest, profileFingerprint:profile.fingerprint,
    tracks:[{ index:1, evidence:{ method:'whisper-strict-consensus-v4', status:'verified', profileFingerprint:profile.fingerprint,
      profileProbedAt:profile.probedAt, fileSizeBytes:profile.fileSizeBytes, streamIndex:1, language:'es' } }] } };

async function fixture() {
  const db = new PGlite();
  const generic = read('20260816105918_async_vod_language_validation_jobs.sql');
  await db.exec(`
    create role anon; create role authenticated;
    create table catalog_file_tracks(server_host text,item_type text,external_id text,
      audio_tracks jsonb,subtitle_tracks jsonb,audio_probed_at timestamptz,subtitle_probed_at timestamptz,
      audio_lang_verified_at timestamptz,audio_lang_retry_at timestamptz,audio_lang_verification jsonb,updated_at timestamptz,
      observed_profile_fingerprint text,observed_profile_probed_at timestamptz,observed_profile_snapshot jsonb,
      primary key(server_host,item_type,external_id));
    ${fn(generic,'vod_language_profile_file_size_bytes')}
    ${fn(generic,'vod_language_profile_audio_indices')}
    ${fn(read('20260719170000_variant_file_audio_crawler.sql'),'catalog_audio_track_indexes')}
    ${fn(read('20260910235557_observed_file_profile_invalidation_v1.sql'),'guard_catalog_observed_profile_certificate')}
    create trigger guard before insert or update on catalog_file_tracks for each row execute function guard_catalog_observed_profile_certificate();
    create table cloud_sources(id uuid,user_id uuid);
    create table cloud_source_catalog_heads(source_id uuid,user_id uuid);
    create table cloud_source_lifecycle(source_id uuid,user_id uuid);
    create table cloud_user_catalog_visibility_epochs(user_id uuid);
    create table cloud_media_items(id uuid,user_id uuid,source_id uuid,generation_id uuid,item_type text,available boolean,playback_hint jsonb);
    create table cloud_title_variants(id uuid,user_id uuid,source_id uuid,generation_id uuid,media_item_id uuid,title_id uuid,item_type text,external_id text,playback_hint jsonb);
    create view cloud_catalog_visible_title_variants as select * from cloud_title_variants;
    create table catalog_selection_audio_jobs(external_id text,url_sha256 text,profile jsonb,result jsonb,completed_at timestamptz,state text);
    create function norva_credential_require_service_role() returns void language sql as $$select$$;
    create function norva_selection_source_identity_valid(s uuid,u uuid) returns boolean language sql as $$
      select exists(select 1 from public.cloud_sources where id=s and user_id=u)$$;
    create function norva_get_catalog_write_snapshot(s uuid,u uuid) returns jsonb language sql as $$
      select jsonb_build_object('generationId','${generation}','headRevision',1,'configRevision',1,
        'sourceVisibilityEpoch',1,'userVisibilityEpoch',1,'isCatalogVisible',true)$$;
    create function catalog_source_file_cache_key(s uuid,u uuid) returns text language sql as $$select 'source:'||s::text$$;
    create function cloud_file_track_languages(t jsonb) returns text[] language sql as $$select array_agg(x->>'lang') from jsonb_array_elements(t) x$$;
    create function selection_audio_tracks_complete(t jsonb) returns boolean language sql as $$select true$$;
    -- Downstream projection is outside this test: the actual hydration SQL,
    -- profile binding and observed-profile trigger above execute unchanged.
    create function hydrate_cloud_title_file_languages(uuid,uuid,uuid,bigint,bigint,bigint,bigint,text,text,text[])
      returns integer language sql as $$select 1$$;
  `);
  await db.exec(read('20261001003000_selection_hydration_observed_profile.sql'));
  await db.query('insert into cloud_sources values($1,$2)',[source,user]);
  for (const table of ['cloud_source_catalog_heads','cloud_source_lifecycle']) await db.query(`insert into ${table} values($1,$2)`,[source,user]);
  await db.query('insert into cloud_user_catalog_visibility_epochs values($1)',[user]);
  await db.query("insert into cloud_media_items values($1,$2,$3,$4,'movie',true,$5)",[media,user,source,generation,{targetUrl:url}]);
  await db.query("insert into cloud_title_variants values($1,$2,$3,$4,$5,$6,'movie',$7,$8)",[variant,user,source,generation,media,id(6),external,{targetUrl:url}]);
  await db.query("insert into catalog_selection_audio_jobs values($1,$2,$3,$4,now(),'completed')",[external,digest,profile,result]);
  return db;
}

test('Selection publication executes with the real observed-profile guard', { skip:!PGlite }, async t => {
  const db = await fixture();
  const hydrate = (u=user,g=generation) => db.query('select hydrate_selection_audio_results($1,$2,$3,1,1,1,1,$4) value',[u,source,g,[external]]);
  const cache = async () => (await db.query('select * from catalog_file_tracks')).rows[0];
  const seedObserved = async (at, fingerprint='c'.repeat(64)) => {
    await db.exec('truncate catalog_file_tracks');
    await db.query(`insert into catalog_file_tracks(server_host,item_type,external_id,audio_tracks,subtitle_tracks,
      audio_lang_verification,observed_profile_fingerprint,observed_profile_probed_at,observed_profile_snapshot)
      values($1,'movie',$2,$3,'[]','{}',$4,$5,$6)`,['source:'+source,external,profile.audioTracks,fingerprint,at,
        {...profile,probedAt:at,container:'mp4'}]);
  };
  try {
    await t.test('legacy top-level fields are derived only from the exact durable profile', async () => {
      await seedObserved('2026-09-20T00:00:00.000Z');
      assert.equal((await hydrate()).rows[0].value,1);
      const c = await cache();
      assert.equal(c.audio_lang_verification.profileProbedAt,profile.probedAt);
      assert.equal(c.audio_lang_verification.fileSizeBytes,profile.fileSizeBytes);
      assert.equal(c.observed_profile_fingerprint,profile.fingerprint);
      assert.equal(c.observed_profile_snapshot.container,undefined,'must not borrow an old container');
      assert.equal(c.audio_tracks[0].lang,'es');
      assert.ok(c.audio_lang_verified_at);
      await hydrate(); // idempotent with the exact same snapshot.
    });
    await t.test('newer observations are preserved; equal-time contradictions are rejected', async () => {
      await seedObserved('2026-10-01T00:00:00.000Z');
      const before = await cache(); await hydrate();
      assert.deepEqual(await cache(),before);
      await seedObserved(profile.probedAt);
      await assert.rejects(hydrate(), /moved backwards or is ambiguous/);
      assert.equal((await cache()).observed_profile_fingerprint,'c'.repeat(64));
    });
    await t.test('a mismatched certificate or track cannot publish, including legacy certificates', async () => {
      const mutations = [r=>r.verification.tracks[0].evidence.fileSizeBytes++,
        r=>r.verification.tracks[0].evidence.profileProbedAt='2026-09-01T00:00:00Z',
        r=>r.verification.tracks[0].evidence.profileFingerprint='d'.repeat(64),
        r=>r.verification.profileProbedAt='2026-09-01T00:00:00Z',
        r=>r.verification.fileSizeBytes=1,r=>r.verification.urlSha256='e'.repeat(64),
        r=>r.verification.tracks.push(clone(r.verification.tracks[0])),r=>r.audioTracks[0].index=2];
      for (const mutate of mutations) {
        const bad=clone(result); mutate(bad);
        await assert.rejects(db.query('select selection_audio_publication_binding($1,$2,$3,$4)',[profile,bad,external,digest]));
      }
    });
    await t.test('ownership, generation and URL fences still prevent publication', async () => {
      await db.exec('truncate catalog_file_tracks');
      await assert.rejects(hydrate(id(99)), /ownership/);
      await assert.rejects(hydrate(user,id(99)), /snapshot changed/);
      await db.query("update cloud_media_items set playback_hint=$1",[{targetUrl:url+'-changed'}]);
      assert.equal((await hydrate()).rows[0].value,0);
      assert.equal((await db.query('select count(*)::int n from catalog_file_tracks')).rows[0].n,0);
    });
  } finally { await db.close(); }
});

