-- Strict foreground language validation is real provider activity: autonomous
-- probes must keep yielding while it owns the mono-account slot.  Its own
-- durable worker, however, must be able to advance to the next audio track
-- after the previous provider socket has drained.  Preserve both properties by
-- giving real activity priority in the single-row ledger and teaching only the
-- foreground-validation reader to ignore this self-owned activity kind.

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
    where excluded.kind is distinct from 'language-validation'
       or activity.kind in ('presence', 'language-validation')
       or activity.last_seen_at <= excluded.last_seen_at - interval '5 minutes';
$function$;

create or replace function public.provider_account_busy_for_foreground_validation(p_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(
    (select activity.last_seen_at > statement_timestamp() - interval '5 minutes'
            and activity.kind is distinct from 'presence'
            and activity.kind is distinct from 'language-validation'
     from public.provider_account_activity as activity
     where activity.account_key = p_key),
    false);
$function$;

revoke all on function public.provider_account_touch_many(text[], text)
  from public, anon, authenticated;
revoke all on function public.provider_account_busy_for_foreground_validation(text)
  from public, anon, authenticated;
grant execute on function public.provider_account_touch_many(text[], text)
  to service_role;
grant execute on function public.provider_account_busy_for_foreground_validation(text)
  to service_role;

comment on function public.provider_account_touch_many(text[], text) is
  'Touches provider activity; fresh real activity atomically outranks language-validation.';
comment on function public.provider_account_busy_for_foreground_validation(text) is
  'True for fresh provider activity except presence and language-validation; generic background gates remain fail-closed.';

notify pgrst, 'reload schema';
