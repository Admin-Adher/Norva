-- The Clients workspace is live, but its summary previously reused the heavy
-- dashboard snapshot (refreshed every ten minutes). After an account deletion
-- this produced a split-brain UI: the paginated list was current while the
-- headline total still included deleted Auth users. Keep the catalogue-wide
-- dashboard cache, and expose only the small client counters as a live,
-- admin-gated RPC.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

create or replace function public.admin_clients_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'users_total', (
      select count(*) from auth.users
    ),
    'users_active_7d', (
      select count(*)
      from auth.users account
      where account.last_sign_in_at > statement_timestamp() - interval '7 days'
    ),
    'billing_active', (
      select count(*)
      from public.cloud_entitlement_projection projection
      where projection.status = 'active'
        and projection.provider <> 'system'
        and not exists (
          select 1 from public.admin_internal_accounts internal_account
          where internal_account.user_id = projection.user_id
        )
    ),
    'billing_trialing', (
      select count(*)
      from public.cloud_entitlement_projection projection
      where projection.status = 'trialing'
        and not exists (
          select 1 from public.admin_internal_accounts internal_account
          where internal_account.user_id = projection.user_id
        )
    ),
    'billing_past_due', (
      select count(*)
      from public.cloud_entitlement_projection projection
      where projection.status in ('past_due', 'grace')
        and not exists (
          select 1 from public.admin_internal_accounts internal_account
          where internal_account.user_id = projection.user_id
        )
    ),
    'billing_cancel_pending', (
      select count(*)
      from public.cloud_entitlement_projection projection
      where projection.status = 'cancelled_at_period_end'
        and not exists (
          select 1 from public.admin_internal_accounts internal_account
          where internal_account.user_id = projection.user_id
        )
    ),
    'refreshed_at', statement_timestamp()
  );
end
$function$;

revoke all on function public.admin_clients_summary()
from public, anon, authenticated;
grant execute on function public.admin_clients_summary()
to authenticated;

commit;
