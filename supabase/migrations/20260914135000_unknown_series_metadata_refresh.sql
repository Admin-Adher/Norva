-- Reuse the existing bounded series-inventory worker and provider backoff.
-- A successful old inventory can be refreshed ONCE to collect missing owned
-- declarations. Failed inventories and provider cooldowns never get bypassed.
begin;
set local lock_timeout='3s';
set local statement_timeout='30s';
create or replace function public.catalog_series_inventory_candidates(p_user uuid,p_source uuid,p_limit integer default 4)
returns table(parent_series_id text) language sql stable security definer set search_path='' as $f$
  with unknowns as materialized (
    select variant_id from public.cloud_catalog_unidentified_audio_variants(p_user,'series',p_source)
  )
  select v.external_id
  from public.cloud_catalog_visible_title_variants v
  join public.cloud_titles t on t.id=v.title_id and t.user_id=v.user_id and t.item_type=v.item_type
  join public.cloud_sources s on s.id=v.source_id and s.user_id=v.user_id
    and s.enabled and s.deleted_at is null and s.source_type='xtream' and s.sync_status='ready'
  join public.cloud_source_catalog_heads h on h.source_id=v.source_id and h.user_id=v.user_id
    and h.active_generation_id=v.generation_id
  join public.catalog_source_provider_identities i on i.source_id=v.source_id and i.user_id=v.user_id
    and i.verified_at is not null
  join public.cloud_source_lifecycle l on l.source_id=v.source_id and l.user_id=v.user_id
  left join unknowns u on u.variant_id=v.id
  left join public.catalog_series_inventory_state inv on inv.user_id=v.user_id and inv.source_id=v.source_id
    and inv.generation_id=v.generation_id
    and inv.parent_variant_id=v.id and inv.parent_series_id=v.external_id and inv.provider_identity_id=i.identity_id
  left join public.catalog_provider_inventory_backoff b on b.source_id=s.id and b.provider_identity_id=i.identity_id
  where v.user_id=p_user and v.source_id=p_source and v.item_type='series' and btrim(v.external_id)<>''
    and (b.provider_identity_id is null or b.next_retry_at<=now())
    and (inv.source_id is null or inv.next_retry_at<=now()
      or (exists(select 1 from public.admin_feature_flags where key='owned_provider_language_metadata_enabled' and enabled)
        and u.variant_id is not null and inv.consecutive_failures=0
        and inv.last_succeeded_at<now()-interval '6 hours'
        and not exists(select 1 from public.catalog_owned_language_declarations d
          where d.variant_id=v.id and d.user_id=v.user_id and d.source_id=v.source_id
            and d.generation_id=v.generation_id and d.provider_identity_id=i.identity_id
            and d.config_revision=l.config_revision and d.source_visibility_epoch=l.visibility_epoch)))
  order by (u.variant_id is null), (inv.source_id is not null),
    inv.next_retry_at nulls first,t.release_year desc nulls last,v.external_id,v.id
  limit greatest(1,least(100,coalesce(p_limit,4)))
$f$;
revoke all on function public.catalog_series_inventory_candidates(uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.catalog_series_inventory_candidates(uuid,uuid,integer) to service_role;
notify pgrst,'reload schema';
commit;
