begin;

-- Catalogue refresh is background provider I/O, so real gateway/session/event
-- activity must continue to win the mono-account lane. A passive app-presence
-- intent is different: it exists precisely while the user is looking at the
-- catalogue/settings and must not make the manual Sync action reject itself.
create or replace function public.provider_account_busy_for_catalog_refresh(p_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce((
    select bool_or(
      activity.last_seen_at > statement_timestamp() - interval '5 minutes'
        and activity.kind is distinct from 'presence'
    )
    from public.provider_account_activity activity
    where activity.account_key in (
      p_key,
      encode(extensions.digest(p_key, 'sha256'), 'hex')
    )
  ), false)
$function$;

revoke all on function public.provider_account_busy_for_catalog_refresh(text)
  from public, anon, authenticated;
grant execute on function public.provider_account_busy_for_catalog_refresh(text)
  to service_role;

comment on function public.provider_account_busy_for_catalog_refresh(text) is
  'Service-only mono-account fence for catalogue refresh. Ignores passive presence but blocks every real provider activity kind.';

commit;
