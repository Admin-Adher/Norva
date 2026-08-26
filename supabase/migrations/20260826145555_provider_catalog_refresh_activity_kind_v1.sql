begin;

-- The activity ledger stores one current holder per provider account. A
-- catalogue page is weaker than playback and foreground validation: a later
-- reporter tick from the same refresh must never downgrade either holder.
create or replace function public.provider_account_touch_many(p_keys text[], p_kind text)
returns void
language sql
security definer
set search_path = ''
as $function$
  insert into public.provider_account_activity as activity (
    account_key,
    last_seen_at,
    kind
  )
  select distinct
    key,
    statement_timestamp(),
    pg_catalog.left(coalesce(p_kind, ''), 32)
  from pg_catalog.unnest(coalesce(p_keys, '{}'::text[])) as key
  where key is not null
    and key <> ''
    and pg_catalog.length(key) <= 300
  on conflict (account_key) do update
    set last_seen_at = excluded.last_seen_at,
        kind = excluded.kind
    where excluded.kind not in ('presence', 'catalog-refresh', 'language-validation')
       or activity.kind in ('presence', 'catalog-refresh')
       or (
         excluded.kind = 'language-validation'
         and activity.kind = 'language-validation'
       )
       or (
         excluded.kind = 'catalog-refresh'
         and activity.kind = 'catalog-refresh'
       )
       or activity.last_seen_at <= excluded.last_seen_at - interval '5 minutes';
$function$;

-- Catalogue metadata is a real provider connection and therefore remains
-- visible to every generic provider-account fence. It must not, however,
-- block the next page of the same resumable catalogue refresh after the
-- gateway has released that connection.
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
      and activity.kind is distinct from 'catalog-refresh'
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
revoke all on function public.provider_account_touch_many(text[], text)
  from public, anon, authenticated;
grant execute on function public.provider_account_busy_for_catalog_refresh(text)
  to service_role;
grant execute on function public.provider_account_touch_many(text[], text)
  to service_role;

comment on function public.provider_account_touch_many(text[], text) is
  'Touches provider activity with atomic priority: real holders outrank language validation, which outranks catalogue refresh, which outranks presence.';

comment on function public.provider_account_busy_for_catalog_refresh(text) is
  'Service-only catalogue refresh fence: ignores passive presence and the refresh own released metadata activity; blocks playback, validation, and unknown fresh provider activity.';

commit;
