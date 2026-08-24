-- Standalone one-index unit; never wrap CREATE INDEX CONCURRENTLY in BEGIN.
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
    ) then raise exception 'title GC index requires all six rollout flags OFF' using errcode='55000'; end if;
  if to_regclass('public.catalog_series_episode_memberships_parent_title_gc_idx') is not null
     and not public.norva_title_gc_index_is_exact(
       'catalog_series_episode_memberships_parent_title_gc_idx',
       'public.catalog_series_episode_memberships', array['parent_title_id'], true
     ) then
    if public.norva_title_gc_index_is_exact(
      'catalog_series_episode_memberships_parent_title_gc_idx',
      'public.catalog_series_episode_memberships', array['parent_title_id'], false
    ) then raise exception 'exact episode-membership title GC index is invalid; operator must REINDEX INDEX CONCURRENTLY then retry' using errcode='55000';
    else raise exception 'episode-membership title GC index homonym has wrong shape' using errcode='55000'; end if;
  end if;
end
$preflight$;
create index concurrently if not exists catalog_series_episode_memberships_parent_title_gc_idx
  on public.catalog_series_episode_memberships(parent_title_id);
do $postcondition$ begin
  if not public.norva_title_gc_index_is_exact(
    'catalog_series_episode_memberships_parent_title_gc_idx',
    'public.catalog_series_episode_memberships', array['parent_title_id'], true
  ) then raise exception 'episode-membership title GC index postcondition failed' using errcode='55000'; end if;
end $postcondition$;
reset lock_timeout;
reset statement_timeout;
