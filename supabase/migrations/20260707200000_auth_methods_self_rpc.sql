-- Self-serve auth-state for the signed-in user, so the account UI (Settings ->
-- sign-in methods) can adapt in real time to HOW they signed up: Google / magic
-- link / password / linked combinations.
--
-- Why an RPC: whether a user has a USABLE password lives only in
-- auth.users.encrypted_password. It is NOT on auth.identities and NOT exposed by
-- /auth/v1/user, so the client cannot distinguish a magic-link/OTP user (email
-- identity, no password) from a real password account — the old
-- identities-has-'email' heuristic mislabels both a passwordless user ("Change
-- password" for a password they don't have) and a Google-then-set-password user
-- ("Add a password" when they have one). This reads the authoritative signal
-- server-side and returns only booleans + non-secret fields (never the hash).
create or replace function public.auth_methods_self()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  uid uuid := auth.uid();
  v jsonb;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'has_password',    (u.encrypted_password is not null and u.encrypted_password <> ''),
    'email_confirmed', (u.email_confirmed_at is not null),
    'email',           u.email,
    'providers',       coalesce((select jsonb_agg(distinct i.provider)
                                 from auth.identities i where i.user_id = uid), '[]'::jsonb),
    'google_email',    (select i.identity_data->>'email'
                        from auth.identities i
                        where i.user_id = uid and i.provider = 'google'
                        limit 1)
  ) into v
  from auth.users u
  where u.id = uid;
  return v;
end;
$$;

revoke all on function public.auth_methods_self() from public;
revoke execute on function public.auth_methods_self() from anon;
grant execute on function public.auth_methods_self() to authenticated;
