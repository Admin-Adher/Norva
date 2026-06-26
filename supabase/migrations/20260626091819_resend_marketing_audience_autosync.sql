-- Marketing auto-sync: add every new signup to the Resend marketing Audience so
-- broadcasts/newsletters reach all registered users automatically.
--
-- Fully decoupled from auth — it can never block or slow a signup:
--   * async via pg_net (queues the HTTP POST; does NOT call Resend inline)
--   * wrapped in an exception guard
--   * no-op until the `resend_api_key` Vault secret exists (set it once, then run
--     `select public.norva_backfill_resend_audience();` to sync existing users).
-- The Audience id is public (not a secret); the Resend API key is read from Vault.

create or replace function public.norva_sync_signup_to_resend()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  api_key text;
begin
  if new.email is null then return new; end if;
  select decrypted_secret into api_key
    from vault.decrypted_secrets where name = 'resend_api_key';
  if api_key is null then return new; end if;  -- dormant until the key is set

  begin
    perform net.http_post(
      url := 'https://api.resend.com/audiences/21da584c-1fa3-401f-8ee0-f209807ba280/contacts',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || api_key,
        'Content-Type', 'application/json'),
      body := jsonb_build_object(
        'email', new.email,
        'unsubscribed', false,
        'first_name', coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name')),
      timeout_milliseconds := 8000);
  exception when others then
    null;  -- a marketing-sync hiccup must never break a signup
  end;
  return new;
end;
$$;

revoke all on function public.norva_sync_signup_to_resend() from public, anon, authenticated;

drop trigger if exists norva_sync_signup_to_resend_trg on auth.users;
create trigger norva_sync_signup_to_resend_trg
  after insert on auth.users
  for each row execute function public.norva_sync_signup_to_resend();

-- One-shot backfill of existing users (run once, after the Vault secret is set).
create or replace function public.norva_backfill_resend_audience()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  api_key text;
  n int := 0;
  u record;
begin
  select decrypted_secret into api_key
    from vault.decrypted_secrets where name = 'resend_api_key';
  if api_key is null then
    raise exception 'resend_api_key Vault secret is not set — create it first';
  end if;
  for u in select email, raw_user_meta_data from auth.users where email is not null loop
    perform net.http_post(
      url := 'https://api.resend.com/audiences/21da584c-1fa3-401f-8ee0-f209807ba280/contacts',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || api_key,
        'Content-Type', 'application/json'),
      body := jsonb_build_object(
        'email', u.email,
        'unsubscribed', false,
        'first_name', coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name')),
      timeout_milliseconds := 8000);
    n := n + 1;
  end loop;
  return n;
end;
$$;

revoke all on function public.norva_backfill_resend_audience() from public, anon, authenticated;
