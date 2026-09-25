begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

-- Reconcile the production metadata activity policy with the rebuildable schema.
-- Metadata transport admission remains in the Gateway. This durable ledger is
-- a recent-viewer fence, not a five-minute mutex for each completed JSON page.
create or replace function public.provider_account_busy_for_catalog_refresh(p_key text)
returns boolean language sql stable security definer set search_path = ''
as $function$
  select coalesce((
    select bool_or(
      activity.last_seen_at > statement_timestamp() - interval '5 minutes'
      and activity.kind is distinct from 'presence'
      and activity.kind is distinct from 'catalog-refresh'
      and activity.kind is distinct from 'catalog-metadata'
    )
    from public.provider_account_activity activity
    where activity.account_key in (
      p_key, encode(extensions.digest(p_key, 'sha256'), 'hex')
    )
  ), false)
$function$;

-- A weaker metadata/presence report must never downgrade recent playback.
create or replace function public.provider_account_touch_many(p_keys text[], p_kind text)
returns void language sql security definer set search_path = ''
as $function$
  with normalized as (
    select distinct
      case when key ~ '^[0-9A-Fa-f]{64}$' then pg_catalog.lower(key)
        else encode(extensions.digest(key, 'sha256'), 'hex') end as account_key,
      statement_timestamp() as last_seen_at,
      pg_catalog.left(coalesce(p_kind, ''), 32) as kind
    from pg_catalog.unnest(coalesce(p_keys, '{}'::text[])) as inputs(key)
    where key is not null and key <> '' and pg_catalog.length(key) <= 300
  )
  insert into public.provider_account_activity as activity(account_key,last_seen_at,kind)
  select account_key,last_seen_at,kind from normalized
  on conflict (account_key) do update
    set last_seen_at = greatest(activity.last_seen_at, excluded.last_seen_at),
        kind = excluded.kind
    where activity.last_seen_at <= excluded.last_seen_at - interval '5 minutes'
       or (case excluded.kind when 'presence' then 0 when 'catalog-metadata' then 1
            when 'catalog-refresh' then 2 when 'language-validation' then 3 else 4 end)
       >= (case activity.kind when 'presence' then 0 when 'catalog-metadata' then 1
            when 'catalog-refresh' then 2 when 'language-validation' then 3 else 4 end);
$function$;

revoke all on function public.provider_account_busy_for_catalog_refresh(text),
  public.provider_account_touch_many(text[],text) from public,anon,authenticated;
grant execute on function public.provider_account_busy_for_catalog_refresh(text),
  public.provider_account_touch_many(text[],text) to service_role;
commit;
