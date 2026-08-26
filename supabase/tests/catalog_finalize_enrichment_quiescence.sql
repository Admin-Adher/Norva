begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
set local lock_timeout = '2s';
set local statement_timeout = '30s';
set local "request.jwt.claim.role" = 'service_role';

select plan(18);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '94600000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'finalize-quiescence@invalid.test', '', now(),
  '{}'::jsonb, '{}'::jsonb, now(), now()
);

insert into public.cloud_sources (
  id, user_id, source_type, display_name, config_ciphertext, config_hint,
  sync_status, catalog_version, enabled, last_synced_at
) values (
  '94600000-0000-4000-8000-000000000101',
  '94600000-0000-4000-8000-000000000001',
  'xtream', 'Finalize quiescence source', 'cipher-proof', '{}'::jsonb,
  'ready', 1, true, now()
);

do $fixture$
declare
  v_generation uuid;
begin
  select head.active_generation_id into strict v_generation
  from public.cloud_source_catalog_heads head
  where head.source_id = '94600000-0000-4000-8000-000000000101'
    and head.user_id = '94600000-0000-4000-8000-000000000001';

  insert into public.cloud_titles (
    id, user_id, item_type, identity_key, identity_source, provider_tmdb_id,
    match_status, title, metadata, genre_buckets, updated_at
  ) values (
    '94600000-0000-4000-8000-000000000701',
    '94600000-0000-4000-8000-000000000001',
    'movie', 'provider_tmdb:946', 'provider_tmdb', '946',
    'provider_unverified', 'Unverified title', '{}'::jsonb,
    array['autres'], clock_timestamp()
  );

  insert into public.cloud_title_variants (
    id, user_id, title_id, source_id, item_type, external_id, raw_title,
    generation_id
  ) values (
    '94600000-0000-4000-8000-000000000801',
    '94600000-0000-4000-8000-000000000001',
    '94600000-0000-4000-8000-000000000701',
    '94600000-0000-4000-8000-000000000101',
    'movie', '946', 'Unverified title', v_generation
  );
end
$fixture$;

insert into public.catalog_titles (
  item_type, provider_tmdb_id, title, metadata
) values (
  'movie', '946', 'Verified title',
  jsonb_build_object(
    'tmdb', jsonb_build_object('id', 946),
    'i18n', jsonb_build_object('fr', jsonb_build_object('title', 'Titre verifie')),
    'tmdbValidation', jsonb_build_object('valid', true)
  )
);

select is(
  public.cloud_enrich_titles_from_catalog(10),
  1,
  'legacy enrichment writes normally without a finalizer lease'
);
select is(
  (select title from public.cloud_titles
   where id = '94600000-0000-4000-8000-000000000701'),
  'Verified title',
  'legacy enrichment applied the authoritative catalogue payload'
);

update public.cloud_titles
set title = 'Unverified title',
    match_status = 'provider_unverified',
    metadata = '{}'::jsonb,
    updated_at = clock_timestamp()
where id = '94600000-0000-4000-8000-000000000701';

insert into public.catalog_enrichment_dispatch_leases(
  lease_key, claim_token, expires_at, updated_at
) values (
  'user:94600000-0000-4000-8000-000000000001',
  '94600000-0000-4000-8000-000000000901',
  statement_timestamp() + interval '2 minutes', statement_timestamp()
);

select is(
  public.norva_claim_source_finalize_lease(
    '94600000-0000-4000-8000-000000000101',
    '94600000-0000-4000-8000-000000000001',
    '94600000-0000-4000-8000-000000000902',
    120
  ),
  false,
  'finalizer waits for an active dynamic enrichment dispatch lease'
);

delete from public.catalog_enrichment_dispatch_leases
where lease_key = 'user:94600000-0000-4000-8000-000000000001';

select is(
  public.norva_claim_source_finalize_lease(
    '94600000-0000-4000-8000-000000000101',
    '94600000-0000-4000-8000-000000000001',
    '94600000-0000-4000-8000-000000000902',
    120
  ),
  true,
  'finalizer claims the account after older enrichment work drains'
);
select is(
  public.norva_renew_source_finalize_lease(
    '94600000-0000-4000-8000-000000000101',
    '94600000-0000-4000-8000-000000000001',
    '94600000-0000-4000-8000-000000000902',
    120
  ),
  true,
  'a live finalizer lease renews under the epoch mutex'
);
select is(
  public.cloud_enrich_titles_from_catalog(10),
  0,
  'legacy enrichment skips the account while finalization is active'
);
select is(
  (select match_status from public.cloud_titles
   where id = '94600000-0000-4000-8000-000000000701'),
  'provider_unverified',
  'skipped legacy enrichment performs no payload write'
);
select is(
  (select count(*)::integer
   from public.claim_catalog_enrichment_sources(8, 60)
   where source_id = '94600000-0000-4000-8000-000000000101'),
  0,
  'dynamic enrichment cannot claim a source for the finalizing account'
);

select throws_ok(
  $sql$
    select public.norva_apply_catalog_title_background_result(
      'search_pending',
      '94600000-0000-4000-8000-000000000001',
      '94600000-0000-4000-8000-000000000701',
      'global',
      (select visibility_epoch
       from public.cloud_user_catalog_visibility_epochs
       where user_id = '94600000-0000-4000-8000-000000000001'),
      (select updated_at from public.cloud_titles
       where id = '94600000-0000-4000-8000-000000000701'),
      null,
      '{"matched":false}'::jsonb
    )
  $sql$,
  '40001',
  'catalog background write deferred during source finalization',
  'an already-selected background outcome is stale under the finalizer fence'
);

select is(
  public.norva_release_source_finalize_lease(
    '94600000-0000-4000-8000-000000000101',
    '94600000-0000-4000-8000-000000000001',
    '94600000-0000-4000-8000-000000000902'
  ),
  true,
  'the owning finalizer can release its durable lease'
);

insert into public.cloud_catalog_facet_summary (
  user_id, item_type, genre_bucket_counts, refreshed_at,
  genre_rail_candidates, genre_rail_visibility_epoch,
  genre_rail_refreshed_at
)
select
  '94600000-0000-4000-8000-000000000001', item_type,
  '{"action":1}'::jsonb, '2026-01-01 00:00:00+00'::timestamptz,
  '{}'::jsonb, epoch.visibility_epoch,
  '2026-01-01 00:00:00+00'::timestamptz
from (values ('movie'::text), ('series'::text)) media(item_type)
cross join public.cloud_user_catalog_visibility_epochs epoch
where epoch.user_id = '94600000-0000-4000-8000-000000000001';

create temporary table finalize_quiescence_writer_result(payload jsonb)
on commit drop;
insert into finalize_quiescence_writer_result(payload)
select public.norva_apply_catalog_title_background_result(
  'year_pending',
  '94600000-0000-4000-8000-000000000001',
  '94600000-0000-4000-8000-000000000701',
  'global',
  (select visibility_epoch
   from public.cloud_user_catalog_visibility_epochs
   where user_id = '94600000-0000-4000-8000-000000000001'),
  (select updated_at from public.cloud_titles
   where id = '94600000-0000-4000-8000-000000000701'),
  (select active_generation_id
   from public.cloud_source_catalog_heads
   where source_id = '94600000-0000-4000-8000-000000000101'),
  '{"releaseYear":2024}'::jsonb
);

select is(
  (select (payload ->> 'visibleChanged')::boolean
   from finalize_quiescence_writer_result),
  true,
  'a changed background payload keeps the proven visibility CAS contract'
);
select is(
  (select count(*)::integer
   from public.cloud_catalog_facet_summary
   where user_id = '94600000-0000-4000-8000-000000000001'),
  2,
  'background enrichment retains both complete facet read-model rows'
);
select ok(
  not exists (
    select 1
    from public.cloud_catalog_facet_summary summary
    join public.cloud_user_catalog_visibility_epochs epoch
      on epoch.user_id = summary.user_id
    where summary.user_id = '94600000-0000-4000-8000-000000000001'
      and (
        summary.genre_rail_visibility_epoch is distinct from epoch.visibility_epoch
        or summary.refreshed_at is distinct from
           '2026-01-01 00:00:00+00'::timestamptz
      )
  ),
  'retained read models bind the new epoch without claiming a fresh facet scan'
);

select public.cloud_refresh_facet_summary(
  '94600000-0000-4000-8000-000000000001', 'movie'
);
select is(
  (select genre_bucket_counts ->> 'autres'
   from public.cloud_catalog_facet_summary
   where user_id = '94600000-0000-4000-8000-000000000001'
     and item_type = 'movie'),
  '1',
  'the tiny facet summary materializes the Other bucket'
);

select is(
  public.cloud_enrich_titles_from_catalog(10),
  1,
  'legacy enrichment resumes after finalization releases the account'
);

insert into public.cloud_source_finalize_leases(
  source_id, user_id, lease_token, lease_until, updated_at
) values (
  '94600000-0000-4000-8000-000000000101',
  '94600000-0000-4000-8000-000000000001',
  '94600000-0000-4000-8000-000000000903',
  statement_timestamp() - interval '1 minute',
  statement_timestamp() - interval '2 minutes'
);
select is(
  public.norva_renew_source_finalize_lease(
    '94600000-0000-4000-8000-000000000101',
    '94600000-0000-4000-8000-000000000001',
    '94600000-0000-4000-8000-000000000903',
    120
  ),
  false,
  'an expired finalizer lease cannot be resurrected by renewal'
);

delete from public.cloud_source_finalize_leases
where source_id = '94600000-0000-4000-8000-000000000101';
update public.catalog_enrichment_source_schedule
set next_run_at = statement_timestamp() - interval '1 minute',
    lease_until = null,
    claim_token = null
where source_id = '94600000-0000-4000-8000-000000000101';

select is(
  (select count(*)::integer
   from public.claim_catalog_enrichment_sources(1, 60)
   where source_id = '94600000-0000-4000-8000-000000000101'),
  1,
  'dynamic enrichment resumes once no active finalizer lease exists'
);

select ok(
  to_regclass('public.cloud_source_finalize_leases_user_until_idx') is not null,
  'the account-wide finalizer lookup index exists'
);

select * from finish();
rollback;
