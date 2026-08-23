-- Existing traffic table: one standalone concurrent selector index, never a
-- regular CREATE INDEX and never inside BEGIN.  It intentionally omits the
-- physical variant_count predicate: generation visibility is derived from the
-- active-head variant rollup and a stale physical rollup must not hide a title.
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
    raise exception 'title projection selector index requires all six rollout flags OFF'
      using errcode = '55000';
  end if;

  if to_regclass('public.idx_cloud_titles_projection_verified') is not null
     and not public.norva_catalog_title_projection_index_is_exact(
       'idx_cloud_titles_projection_verified',
       'public.cloud_titles',
       array['user_id','item_type','synced_at','updated_at','id'],
       array[0,0,3,3,0]::smallint[],
       '(match_status = ''provider_verified''::text)',
       true
     ) then
    if public.norva_catalog_title_projection_index_is_exact(
      'idx_cloud_titles_projection_verified',
      'public.cloud_titles',
      array['user_id','item_type','synced_at','updated_at','id'],
      array[0,0,3,3,0]::smallint[],
      '(match_status = ''provider_verified''::text)',
      false
    ) then
      raise exception 'exact title projection selector index is invalid; operator must REINDEX INDEX CONCURRENTLY then retry'
        using errcode = '55000';
    elsif public.norva_catalog_title_projection_index_is_exact(
      'idx_cloud_titles_projection_verified',
      'public.cloud_titles',
      array['user_id','item_type','synced_at','updated_at'],
      array[0,0,3,3]::smallint[],
      '(match_status = ''provider_verified''::text)',
      true
    ) then
      -- Preserve the historically deployed four-key selector.  It remains a
      -- valid prefix index for existing traffic, while the canonical name is
      -- released for the five-key ordering that prevents an unstable final
      -- tie.  A rename is metadata-only; the exact replacement is built
      -- concurrently below, outside this transaction block.
      if to_regclass(
        'public.idx_cloud_titles_projection_verified_legacy_without_id'
      ) is not null then
        raise exception 'title projection selector legacy index name is occupied'
          using errcode = '55000';
      end if;
      alter index public.idx_cloud_titles_projection_verified rename to
        idx_cloud_titles_projection_verified_legacy_without_id;
    else
      raise exception 'title projection selector index homonym has wrong shape'
        using errcode = '55000';
    end if;
  end if;
end
$preflight$;

create index concurrently if not exists idx_cloud_titles_projection_verified
  on public.cloud_titles(
    user_id, item_type, synced_at desc, updated_at desc, id
  )
  where match_status = 'provider_verified';

do $postcondition$
begin
  if not public.norva_catalog_title_projection_index_is_exact(
    'idx_cloud_titles_projection_verified',
    'public.cloud_titles',
    array['user_id','item_type','synced_at','updated_at','id'],
    array[0,0,3,3,0]::smallint[],
    '(match_status = ''provider_verified''::text)',
    true
  ) then
    raise exception 'title projection selector index postcondition failed'
      using errcode = '55000';
  end if;
end
$postcondition$;

reset lock_timeout;
reset statement_timeout;
