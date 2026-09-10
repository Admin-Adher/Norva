begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';

-- A verified catalogue identity is not a file -> TMDB mapping. Search-matched
-- titles can predate catalog_file_tracks.ids_resolved_at (or have no such row).
-- Recover only an unambiguous mapping from an active, visible exact-file peer.
-- Read-only: never copy account state, provider URLs, or audio observations.
create or replace function public.norva_exact_file_title_candidates(
  p_user_id uuid,
  p_source_id uuid,
  p_generation_id uuid,
  p_head_revision bigint,
  p_config_revision bigint,
  p_source_visibility_epoch bigint,
  p_user_visibility_epoch bigint,
  p_item_type text,
  p_external_ids text[]
) returns table (external_id text, provider_tmdb_id text, metadata jsonb)
-- Generation payloads are a private control table with no service-role SELECT.
-- This narrow definer endpoint is their read boundary; do not broaden table
-- grants. Its service-role check and full target snapshot precede every read.
language plpgsql stable security definer set search_path = ''
set statement_timeout = '10s'
as $function$
declare
  v_snapshot jsonb;
begin
  perform public.norva_credential_require_service_role();
  if p_item_type is null or p_item_type not in ('movie','series')
    or p_external_ids is null or cardinality(p_external_ids) > 200
    or exists (select 1 from unnest(p_external_ids) id
      where id is null or btrim(id) = '' or length(id) > 255) then
    raise exception 'A bounded exact-file batch is required' using errcode = '22023';
  end if;
  v_snapshot := public.norva_get_catalog_write_snapshot(p_source_id,p_user_id);
  if (v_snapshot->>'generationId')::uuid is distinct from p_generation_id
    or (v_snapshot->>'headRevision')::bigint is distinct from p_head_revision
    or (v_snapshot->>'configRevision')::bigint is distinct from p_config_revision
    or (v_snapshot->>'sourceVisibilityEpoch')::bigint is distinct from p_source_visibility_epoch
    or (v_snapshot->>'userVisibilityEpoch')::bigint is distinct from p_user_visibility_epoch
    or (v_snapshot->>'isCatalogVisible')::boolean is distinct from true then
    raise exception 'Exact-file catalogue snapshot changed' using errcode = 'PT409';
  end if;

  return query
  with target as materialized (
    select link.identity_id
    from public.catalog_source_provider_identities link
    join public.provider_identities identity on identity.id = link.identity_id and identity.status = 'active'
    where link.source_id = p_source_id and link.user_id = p_user_id
      and link.verification_method = 'automatic'
  ), requested as materialized (
    -- A request must name files really imported into this exact active head.
    select item.external_id
    from public.cloud_media_items item
    where item.source_id = p_source_id and item.user_id = p_user_id
      and item.generation_id = p_generation_id and item.item_type = p_item_type
      and item.external_id = any(p_external_ids) and item.available
  ), peers as materialized (
    select link.source_id,link.user_id,head.active_generation_id
    from target
    join public.catalog_source_provider_identities link on link.identity_id = target.identity_id
    join public.cloud_source_catalog_heads head
      on head.source_id = link.source_id and head.user_id = link.user_id
    join public.cloud_source_catalog_generations generation
      on generation.id = head.active_generation_id and generation.source_id = head.source_id
      and generation.user_id = head.user_id and generation.state = 'active'
    where link.verification_method = 'automatic'
      and public.norva_source_catalog_visible_internal(link.source_id,link.user_id)
  ), evidence as materialized (
    select requested.external_id,
      case when projection.title_id is not null then projection.provider_tmdb_id
        else title.provider_tmdb_id end as tmdb_id,
      case when projection.title_id is not null then projection.match_status
        else title.match_status end as match_status,
      case when projection.title_id is not null then projection.catalog_metadata
        else title.metadata end as title_metadata
    from requested cross join peers
    join public.cloud_title_variants variant
      on variant.source_id = peers.source_id and variant.user_id = peers.user_id
      and variant.generation_id = peers.active_generation_id
      and variant.item_type = p_item_type and variant.external_id = requested.external_id
    join public.cloud_media_items item
      on item.id = variant.media_item_id and item.user_id = variant.user_id
      and item.source_id = variant.source_id and item.generation_id = variant.generation_id
      and item.item_type = variant.item_type and item.external_id = variant.external_id and item.available
    join public.cloud_titles title on title.id = variant.title_id
      and title.user_id = variant.user_id and title.item_type = variant.item_type
    left join public.cloud_source_catalog_generation_candidate_titles projection
      on projection.generation_id = variant.generation_id and projection.title_id = variant.title_id
      and projection.user_id = variant.user_id and projection.source_id = variant.source_id
      and projection.item_type = variant.item_type
  ), agreed as materialized (
    -- Include contradictory/manual IDs in the veto, never in the accepted set.
    select evidence.external_id, min(evidence.tmdb_id) tmdb_id
    from evidence
    where evidence.tmdb_id ~ '^[1-9][0-9]*$'
    group by evidence.external_id
    having count(distinct evidence.tmdb_id) = 1
      and bool_or(evidence.match_status in ('provider_verified','matched')
        -- Legacy mirror self-thins cloud_titles.metadata to {}. Its validated
        -- match_status remains the file-link proof; the public payload below
        -- must independently carry a real validation and matching TMDB id.
        and (evidence.title_metadata #> '{tmdbValidation,valid}' is null
          or evidence.title_metadata #> '{tmdbValidation,valid}' = 'true'::jsonb))
  ), payloads as (
    select agreed.external_id,agreed.tmdb_id,
      case when catalog.metadata #> '{tmdbValidation,valid}' = 'true'::jsonb
        and catalog.metadata #>> '{tmdb,id}' = agreed.tmdb_id
        then catalog.metadata else evidence.title_metadata end as payload
    from agreed
    join evidence on evidence.external_id = agreed.external_id and evidence.tmdb_id = agreed.tmdb_id
      and evidence.match_status in ('provider_verified','matched')
      and (evidence.title_metadata #> '{tmdbValidation,valid}' is null
        or evidence.title_metadata #> '{tmdbValidation,valid}' = 'true'::jsonb)
    left join public.catalog_titles catalog
      on catalog.item_type = p_item_type and catalog.provider_tmdb_id = agreed.tmdb_id
  )
  select distinct on (payloads.external_id) payloads.external_id,payloads.tmdb_id,
    jsonb_build_object('tmdb',payloads.payload->'tmdb','i18n',payloads.payload->'i18n',
      'tmdbValidation',payloads.payload->'tmdbValidation')
  from payloads
  where payloads.payload #> '{tmdbValidation,valid}' = 'true'::jsonb
    and payloads.payload #>> '{tmdb,id}' = payloads.tmdb_id
  order by payloads.external_id, payloads.payload::text;
end
$function$;

revoke all on function public.norva_exact_file_title_candidates(uuid,uuid,uuid,bigint,bigint,bigint,bigint,text,text[])
  from public,anon,authenticated;
grant execute on function public.norva_exact_file_title_candidates(uuid,uuid,uuid,bigint,bigint,bigint,bigint,text,text[])
  to service_role;
comment on function public.norva_exact_file_title_candidates(uuid,uuid,uuid,bigint,bigint,bigint,bigint,text,text[]) is
  'Service-only, generation-fenced, exact-file validated title reuse. No credentials, peer identifiers, audio or writes.';
commit;
