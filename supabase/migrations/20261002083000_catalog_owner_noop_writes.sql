-- Avoid redundant owner payload rewrites while preserving locks and ownership fences.
begin;
set local lock_timeout = '5s';

create or replace function public.norva_sync_catalog_background_owner_title(
  p_user_id uuid,
  p_title_id uuid
) returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if p_user_id is null or p_title_id is null then
    raise exception 'catalog background owner sync identity is required'
      using errcode = '22004';
  end if;
  -- Direct callers receive the same fence as statement triggers.  The lock is
  -- re-entrant when the statement trigger already acquired it for this user.
  perform public.norva_lock_catalog_background_owner_epoch(p_user_id);
  -- Candidate staging is intentionally off-head.  Do no per-title work until
  -- this logical title already belongs to a live snapshot or one of its
  -- surviving variants belongs to a generation mapped by that snapshot.
  -- This keeps a 1M-row candidate import from manufacturing 1M baseline
  -- tombstones before the candidate owner snapshot has even been created.
  if not exists (
    select 1
    from public.cloud_catalog_background_owner_snapshots snapshot
    join public.cloud_catalog_background_owner_snapshot_rows owner_row
      on owner_row.snapshot_id = snapshot.id
     and owner_row.title_id = p_title_id
    where snapshot.user_id = p_user_id
      and snapshot.state in ('building','ready','active','retained')
  ) and not exists (
    select 1
    from public.cloud_title_variants variant
    join public.cloud_catalog_background_owner_snapshot_sources source_map
      on source_map.source_id = variant.source_id
     and source_map.generation_id = variant.generation_id
    join public.cloud_catalog_background_owner_snapshots snapshot
      on snapshot.id = source_map.snapshot_id
     and snapshot.user_id = variant.user_id
     and snapshot.state in ('building','ready','active','retained')
    where variant.user_id = p_user_id and variant.title_id = p_title_id
  ) then
    return;
  end if;
  -- Serialize only mutations of this logical title.  Every trigger acquires
  -- title keys in ascending order, so two multi-title statements cannot form
  -- a user-wide lock cycle.  The builder never takes this lock and is
  -- insert-only; a concurrent trigger row/tombstone always wins the PK race.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'catalog-background-owner-title:' || p_user_id::text || ':' ||
      p_title_id::text, 0
    )
  );

  with target_snapshots as materialized (
    select snapshot.id
    from public.cloud_catalog_background_owner_snapshots snapshot
    where snapshot.user_id = p_user_id
      and snapshot.state in ('building','ready','active','retained')
  ), owners as materialized (
    select distinct on (target.id)
      target.id as snapshot_id,
      variant.source_id,
      variant.generation_id
    from target_snapshots target
    join public.cloud_catalog_background_owner_snapshot_sources source_map
      on source_map.snapshot_id = target.id
    join public.cloud_title_variants variant
      on variant.user_id = p_user_id
     and variant.title_id = p_title_id
     and variant.source_id = source_map.source_id
     and variant.generation_id = source_map.generation_id
    order by target.id, variant.source_id,
      variant.generation_id, variant.id
  ), effective as materialized (
    select
      owner.snapshot_id,
      owner.source_id,
      owner.generation_id,
      projection.title_id is not null as has_projection,
      coalesce(projection.item_type, title.item_type) as item_type,
      case when projection.title_id is not null
        then projection.provider_tmdb_id else title.provider_tmdb_id end
        as provider_tmdb_id,
      coalesce(projection.match_status, title.match_status) as match_status,
      coalesce(projection.title, title.title) as title,
      case when projection.title_id is not null
        then projection.original_title else title.original_title end
        as original_title,
      case when projection.title_id is not null
        then projection.release_year else title.release_year end as release_year,
      case when projection.title_id is not null
        then projection.poster_url else title.poster_url end as poster_url,
      case when projection.title_id is not null
        then projection.backdrop_url else title.backdrop_url end as backdrop_url,
      case when projection.title_id is not null
        then projection.catalog_metadata else title.metadata end as catalog_metadata,
      case when projection.title_id is not null
        then projection.updated_at else title.updated_at end as payload_updated_at,
      case when projection.title_id is not null
        then projection.year_backfill_attempted_at
        else title.year_backfill_attempted_at end as year_attempted_at,
      case when projection.title_id is not null
        then projection.revalidate_attempted_at
        else title.revalidate_attempted_at end as revalidate_attempted_at,
      case when projection.title_id is not null
        then projection.search_match_attempted_at
        else title.search_match_attempted_at end as search_attempted_at
    from owners owner
    join public.cloud_titles title
      on title.id = p_title_id and title.user_id = p_user_id
    left join public.cloud_source_catalog_generation_candidate_titles projection
      on projection.user_id = p_user_id
     and projection.title_id = p_title_id
     and projection.generation_id = owner.generation_id
  )
  insert into public.cloud_catalog_background_owner_snapshot_rows (
    snapshot_id, user_id, title_id, is_present,
    owner_source_id, owner_generation_id, storage_kind,
    item_type, provider_tmdb_id, match_status,
    title, original_title, release_year, poster_url, backdrop_url,
    catalog_metadata, payload_updated_at,
    year_backfill_attempted_at, revalidate_attempted_at,
    search_match_attempted_at, updated_at
  )
  select
    effective.snapshot_id, p_user_id, p_title_id, true,
    effective.source_id, effective.generation_id,
    case when effective.has_projection then 'projection' else 'global' end,
    effective.item_type, effective.provider_tmdb_id, effective.match_status,
    effective.title, effective.original_title, effective.release_year,
    effective.poster_url, effective.backdrop_url,
    effective.catalog_metadata, effective.payload_updated_at,
    effective.year_attempted_at, effective.revalidate_attempted_at,
    effective.search_attempted_at, now()
  from effective
  on conflict (snapshot_id, title_id) do update set
    is_present = true,
    owner_source_id = excluded.owner_source_id,
    owner_generation_id = excluded.owner_generation_id,
    storage_kind = excluded.storage_kind,
    item_type = excluded.item_type,
    provider_tmdb_id = excluded.provider_tmdb_id,
    match_status = excluded.match_status,
    title = excluded.title,
    original_title = excluded.original_title,
    release_year = excluded.release_year,
    poster_url = excluded.poster_url,
    backdrop_url = excluded.backdrop_url,
    catalog_metadata = excluded.catalog_metadata,
    payload_updated_at = excluded.payload_updated_at,
    year_backfill_attempted_at = excluded.year_backfill_attempted_at,
    revalidate_attempted_at = excluded.revalidate_attempted_at,
    search_match_attempted_at = excluded.search_match_attempted_at,
    updated_at = now()
  -- Do not rewrite identical payloads (including TOAST) on unrelated variant changes.
  -- Keep timestamp/attempt changes: background workers consume those fields.
  where (cloud_catalog_background_owner_snapshot_rows.is_present,
         cloud_catalog_background_owner_snapshot_rows.owner_source_id,
         cloud_catalog_background_owner_snapshot_rows.owner_generation_id,
         cloud_catalog_background_owner_snapshot_rows.storage_kind,
         cloud_catalog_background_owner_snapshot_rows.item_type,
         cloud_catalog_background_owner_snapshot_rows.provider_tmdb_id,
         cloud_catalog_background_owner_snapshot_rows.match_status,
         cloud_catalog_background_owner_snapshot_rows.title,
         cloud_catalog_background_owner_snapshot_rows.original_title,
         cloud_catalog_background_owner_snapshot_rows.release_year,
         cloud_catalog_background_owner_snapshot_rows.poster_url,
         cloud_catalog_background_owner_snapshot_rows.backdrop_url,
         cloud_catalog_background_owner_snapshot_rows.catalog_metadata,
         cloud_catalog_background_owner_snapshot_rows.payload_updated_at,
         cloud_catalog_background_owner_snapshot_rows.year_backfill_attempted_at,
         cloud_catalog_background_owner_snapshot_rows.revalidate_attempted_at,
         cloud_catalog_background_owner_snapshot_rows.search_match_attempted_at)
    is distinct from
        (excluded.is_present,
         excluded.owner_source_id,
         excluded.owner_generation_id,
         excluded.storage_kind,
         excluded.item_type,
         excluded.provider_tmdb_id,
         excluded.match_status,
         excluded.title,
         excluded.original_title,
         excluded.release_year,
         excluded.poster_url,
         excluded.backdrop_url,
         excluded.catalog_metadata,
         excluded.payload_updated_at,
         excluded.year_backfill_attempted_at,
         excluded.revalidate_attempted_at,
         excluded.search_match_attempted_at);

  -- Never physically delete a build key here.  A false row is an absence
  -- tombstone that wins against an insert-only builder statement which may
  -- still hold a pre-delete MVCC snapshot.
  insert into public.cloud_catalog_background_owner_snapshot_rows (
    snapshot_id,user_id,title_id,is_present,
    owner_source_id,owner_generation_id,storage_kind,
    item_type,provider_tmdb_id,match_status,title,original_title,
    release_year,poster_url,backdrop_url,catalog_metadata,
    payload_updated_at,year_backfill_attempted_at,
    revalidate_attempted_at,search_match_attempted_at,updated_at
  )
  select snapshot.id,p_user_id,p_title_id,false,
    fallback.source_id,fallback.generation_id,'global',
    title.item_type,title.provider_tmdb_id,title.match_status,title.title,
    title.original_title,title.release_year,title.poster_url,title.backdrop_url,
    title.metadata,title.updated_at,title.year_backfill_attempted_at,
    title.revalidate_attempted_at,title.search_match_attempted_at,now()
  from public.cloud_catalog_background_owner_snapshots snapshot
  join lateral (
    select source_map.source_id,source_map.generation_id
    from public.cloud_catalog_background_owner_snapshot_sources source_map
    where source_map.snapshot_id = snapshot.id
    order by source_map.source_id,source_map.generation_id
    limit 1
  ) fallback on true
  join public.cloud_titles title
    on title.id = p_title_id and title.user_id = p_user_id
  where snapshot.user_id = p_user_id
    and snapshot.state in ('building','ready','active','retained')
    and not exists (
      select 1
      from public.cloud_title_variants variant
      join public.cloud_catalog_background_owner_snapshot_sources source_map
        on source_map.snapshot_id = snapshot.id
       and source_map.source_id = variant.source_id
       and source_map.generation_id = variant.generation_id
      where variant.user_id = p_user_id
        and variant.title_id = p_title_id
    )
  on conflict (snapshot_id,title_id) do update set
    is_present = false,updated_at = now()
  where cloud_catalog_background_owner_snapshot_rows.is_present is distinct from false;
end
$function$;

commit;
