-- Synthetic, networkless PostgreSQL only. No production data.
create role anon; create role authenticated; create role service_role;
create table public.cloud_titles (
 id uuid primary key,user_id uuid,item_type text,provider_tmdb_id text,match_status text,
 title text,original_title text,release_year integer,poster_url text,backdrop_url text,
 metadata jsonb,updated_at timestamptz,year_backfill_attempted_at timestamptz,
 revalidate_attempted_at timestamptz,search_match_attempted_at timestamptz);
create table public.cloud_title_variants (
 id uuid primary key,user_id uuid,title_id uuid,source_id uuid,generation_id uuid);
create table public.cloud_catalog_background_owner_snapshots (
 id uuid primary key,user_id uuid,state text,row_count bigint default 0,updated_at timestamptz);
create table public.cloud_catalog_background_owner_snapshot_sources (
 snapshot_id uuid,user_id uuid,source_id uuid,generation_id uuid);
create table public.cloud_source_catalog_generation_candidate_titles (
 title_id uuid,user_id uuid,generation_id uuid,item_type text,provider_tmdb_id text,
 match_status text,title text,original_title text,release_year integer,poster_url text,
 backdrop_url text,catalog_metadata jsonb,updated_at timestamptz,
 year_backfill_attempted_at timestamptz,revalidate_attempted_at timestamptz,
 search_match_attempted_at timestamptz);
create table public.cloud_catalog_background_owner_snapshot_rows (
 snapshot_id uuid,user_id uuid,title_id uuid,is_present boolean,owner_source_id uuid,
 owner_generation_id uuid,storage_kind text,item_type text,provider_tmdb_id text,
 match_status text,title text,original_title text,release_year integer,poster_url text,
 backdrop_url text,catalog_metadata jsonb,payload_updated_at timestamptz,
 year_backfill_attempted_at timestamptz,revalidate_attempted_at timestamptz,
 search_match_attempted_at timestamptz,updated_at timestamptz,
 primary key(snapshot_id,title_id));
-- Epoch implementation is not under test; keep an advisory fence in this fixture.
create function public.norva_lock_catalog_background_owner_epoch(uuid) returns void
language sql as $$select pg_advisory_xact_lock(hashtextextended($1::text,0))$$;
create function public.test_assert(ok boolean, description text) returns void
language plpgsql as $$begin if ok is distinct from true then raise exception '%',description; end if; end$$;

insert into public.cloud_titles values
 ('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','movie','123','matched','Test',null,2026,'poster','backdrop',
 (select jsonb_build_object('overview',string_agg(md5(i::text),'')) from generate_series(1,4096) i),
 '2026-10-01Z',null,null,null);
insert into public.cloud_titles select '10000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000002',item_type,provider_tmdb_id,match_status,'Other owner',original_title,release_year,poster_url,backdrop_url,metadata,updated_at,year_backfill_attempted_at,revalidate_attempted_at,search_match_attempted_at from public.cloud_titles;
insert into public.cloud_title_variants values
 ('30000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001'),
 ('30000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000002','40000000-0000-0000-0000-000000000002','50000000-0000-0000-0000-000000000002');
insert into public.cloud_catalog_background_owner_snapshots values
 ('60000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','active',0,now()),
 ('60000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000002','active',0,now()),
 ('60000000-0000-0000-0000-000000000003','20000000-0000-0000-0000-000000000001','retained',0,now());
insert into public.cloud_catalog_background_owner_snapshot_sources
 select s.id,s.user_id,v.source_id,v.generation_id from public.cloud_catalog_background_owner_snapshots s
 join public.cloud_title_variants v on v.user_id=s.user_id;
