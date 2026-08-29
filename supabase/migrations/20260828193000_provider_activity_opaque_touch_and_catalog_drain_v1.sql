begin;

-- Gateway and Edge callers intentionally report the canonical provider-account
-- key (host + logical username). The activity table stores only its opaque
-- SHA-256 affinity. A later activity-kind migration accidentally wrote the raw
-- key again, which violated the table's 64-hex guard and made every real
-- account-activity touch fail before it could protect a single-slot provider.
-- Keep accepting already-opaque keys for bounded rollout/repair callers.
create or replace function public.provider_account_touch_many(p_keys text[], p_kind text)
returns void
language sql
security definer
set search_path = ''
as $function$
  with normalized as (
    select distinct
      case
        when key ~ '^[0-9A-Fa-f]{64}$' then pg_catalog.lower(key)
        else encode(extensions.digest(key, 'sha256'), 'hex')
      end as account_key,
      statement_timestamp() as last_seen_at,
      pg_catalog.left(coalesce(p_kind, ''), 32) as kind
    from pg_catalog.unnest(coalesce(p_keys, '{}'::text[])) as inputs(key)
    where key is not null
      and key <> ''
      and pg_catalog.length(key) <= 300
  )
  insert into public.provider_account_activity as activity (
    account_key,
    last_seen_at,
    kind
  )
  select account_key, last_seen_at, kind
  from normalized
  on conflict (account_key) do update
    set last_seen_at = excluded.last_seen_at,
        kind = excluded.kind
    where activity.last_seen_at <= excluded.last_seen_at - interval '5 minutes'
       or (
         case excluded.kind
           when 'presence' then 0
           when 'catalog-refresh' then 1
           when 'language-validation' then 2
           else 3
         end
       ) >= (
         case activity.kind
           when 'presence' then 0
           when 'catalog-refresh' then 1
           when 'language-validation' then 2
           else 3
         end
       );
$function$;

revoke all on function public.provider_account_touch_many(text[], text)
  from public, anon, authenticated;
grant execute on function public.provider_account_touch_many(text[], text)
  to service_role;

comment on function public.provider_account_touch_many(text[], text) is
  'Service-only opaque provider activity writer. Canonical raw keys are SHA-256 normalized; existing 64-hex affinities remain compatible. Priority is real holder > language validation > catalogue refresh > presence.';

notify pgrst, 'reload schema';

commit;
