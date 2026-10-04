begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

-- Automatic maintenance is independent of billing entitlement. This is only
-- discovery, never permission to bypass source, account, file or playback leases.
create function public.list_catalog_language_campaign_sources(p_after uuid default null,p_limit integer default 128)
returns table(id uuid,"userId" uuid,xtream boolean)
language plpgsql stable security definer set search_path='' as $f$
begin
 perform public.norva_credential_require_service_role();
 return query
 select s.id,s.user_id,s.source_type='xtream'
 from public.cloud_catalog_visible_sources s
 join auth.users u on u.id=s.user_id and u.deleted_at is null and (u.banned_until is null or u.banned_until<=now())
 left join public.cloud_entitlement_projection e on e.user_id=s.user_id
 where s.enabled and s.deleted_at is null and s.sync_status='ready'
  and (p_after is null or s.id>p_after)
  and (e.user_id is null or lower(btrim(e.status)) in ('trialing','active','grace','past_due','cancelled_at_period_end','expired','unknown'))
  and exists(select 1 from public.admin_feature_flags where key='automatic_vod_language_fleet_enabled' and enabled)
  and not exists(select 1 from public.admin_feature_flags where key='enrichment_paused' and enabled)
 order by s.id limit greatest(1,least(coalesce(p_limit,128),128));
end $f$;
revoke all on function public.list_catalog_language_campaign_sources(uuid,integer) from public,anon,authenticated;
grant execute on function public.list_catalog_language_campaign_sources(uuid,integer) to service_role;
notify pgrst,'reload schema';
commit;
