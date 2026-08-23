-- Existing traffic table: the projection-aware recent rail needs an order-only
-- index without the legacy physical variant_count predicate.  Candidate shells
-- intentionally keep variant_count=0 until terminal promotion, while their
-- active-head variants are already visible.
set lock_timeout = '2s';
set statement_timeout = '30min';

do $preflight$
begin
  if (select count(*) from public.admin_feature_flags where key in (
      'provider_access_v1_enabled','provider_access_auto_detection_v1_enabled',
      'provider_access_notifications_v1_enabled','provider_access_visibility_v1_enabled',
      'provider_credential_transition_v1_enabled','provider_replacement_v1_enabled'
    )) <> 6 or exists (
      select 1 from public.admin_feature_flags where key in (
        'provider_access_v1_enabled','provider_access_auto_detection_v1_enabled',
        'provider_access_notifications_v1_enabled','provider_access_visibility_v1_enabled',
        'provider_credential_transition_v1_enabled','provider_replacement_v1_enabled'
      ) and enabled
    ) then
    raise exception 'title projection recent index requires all six rollout flags OFF'
      using errcode = '55000';
  end if;

  if to_regclass('public.idx_cloud_titles_projection_recent') is not null
     and not public.norva_catalog_title_projection_index_is_exact(
       'idx_cloud_titles_projection_recent',
       'public.cloud_titles',
       array['user_id','item_type','created_at','synced_at','id'],
       array[0,0,3,3,0]::smallint[],
       null,
       true
     ) then
    if public.norva_catalog_title_projection_index_is_exact(
      'idx_cloud_titles_projection_recent',
      'public.cloud_titles',
      array['user_id','item_type','created_at','synced_at','id'],
      array[0,0,3,3,0]::smallint[],
      null,
      false
    ) then
      raise exception 'exact title projection recent index is invalid; operator must REINDEX INDEX CONCURRENTLY then retry'
        using errcode = '55000';
    else
      raise exception 'title projection recent index homonym has wrong shape'
        using errcode = '55000';
    end if;
  end if;
end
$preflight$;

create index concurrently if not exists idx_cloud_titles_projection_recent
  on public.cloud_titles(
    user_id, item_type, created_at desc, synced_at desc, id
  );

do $postcondition$
begin
  if not public.norva_catalog_title_projection_index_is_exact(
    'idx_cloud_titles_projection_recent',
    'public.cloud_titles',
    array['user_id','item_type','created_at','synced_at','id'],
    array[0,0,3,3,0]::smallint[],
    null,
    true
  ) then
    raise exception 'title projection recent index postcondition failed'
      using errcode = '55000';
  end if;
end
$postcondition$;

reset lock_timeout;
reset statement_timeout;
