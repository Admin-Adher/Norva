-- Admin client account controls.
--
-- Banning a Supabase Auth user prevents new authentication, but an existing
-- refresh token can otherwise remain usable. Keep session invalidation behind
-- a service-role-only RPC so the browser never receives direct access to the
-- auth schema and the Edge action can be safely retried.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

create or replace function public.admin_revoke_user_sessions(
  p_user_id uuid
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_refresh_tokens integer := 0;
  v_sessions integer := 0;
begin
  perform public.norva_credential_require_service_role();
  if p_user_id is null then
    raise exception 'account is required' using errcode = '22004';
  end if;

  -- Delete refresh tokens first because installations may retain an explicit
  -- refresh_tokens.session_id foreign key without ON DELETE CASCADE.
  delete from auth.refresh_tokens token
  where token.user_id = p_user_id::text;
  get diagnostics v_refresh_tokens = row_count;

  delete from auth.sessions session
  where session.user_id = p_user_id;
  get diagnostics v_sessions = row_count;

  return jsonb_build_object(
    'contract', 'admin-session-revocation-v1',
    'refreshTokensRevoked', v_refresh_tokens,
    'sessionsRevoked', v_sessions
  );
end
$function$;

revoke all on function public.admin_revoke_user_sessions(uuid)
from public, anon, authenticated;
grant execute on function public.admin_revoke_user_sessions(uuid)
to service_role;

commit;
