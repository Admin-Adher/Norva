-- Tier-1/2 security emails, all via the shared norva_send_branded_email helper
-- (dark-theme Norva template, Vault-keyed, dormant until resend_api_key is set).

-- 1) Password changed (reset or settings change) — confirm to the user.
create or replace function public.norva_notify_password_changed()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.norva_send_branded_email(
    new.email,
    'Your Norva password was changed',
    'Password changed',
    'The password on your Norva account was just changed. If this was you, no further action is needed.',
    'Go to my account', 'https://norva.tv/account.html',
    'If you did NOT change your password, reset it from the app immediately and review your account.');
  return new;
end; $$;
revoke all on function public.norva_notify_password_changed() from public, anon, authenticated;

drop trigger if exists norva_password_changed_trg on auth.users;
create trigger norva_password_changed_trg
  after update of encrypted_password on auth.users
  for each row
  when (old.encrypted_password is distinct from new.encrypted_password)
  execute function public.norva_notify_password_changed();

-- 2) Email changed — notify the OLD address (detect account takeover).
create or replace function public.norva_notify_email_changed()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.norva_send_branded_email(
    old.email,
    'Your Norva email was changed',
    'Email address changed',
    'The email on your Norva account was changed to <strong style="color:#cdd9ff">' || public.norva_html_escape(new.email) || '</strong>. If this was you, no action is needed.',
    null, null,
    'If you did NOT request this change, contact support immediately — your account may be compromised.');
  return new;
end; $$;
revoke all on function public.norva_notify_email_changed() from public, anon, authenticated;

drop trigger if exists norva_email_changed_trg on auth.users;
create trigger norva_email_changed_trg
  after update of email on auth.users
  for each row
  when (old.email is distinct from new.email and old.email is not null)
  execute function public.norva_notify_email_changed();

-- 3) New device connected — security alert.
create or replace function public.norva_notify_new_device()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  user_email text;
  dev text;
begin
  select email into user_email from auth.users where id = new.user_id;
  if user_email is null then return new; end if;
  dev := public.norva_html_escape(coalesce(nullif(new.device_name,''), new.device_type, 'a device'))
         || case when coalesce(new.platform,'') <> '' then ' (' || public.norva_html_escape(new.platform) || ')' else '' end;
  perform public.norva_send_branded_email(
    user_email,
    'New device connected to Norva',
    'New device connected',
    'A new device just connected to your Norva account: <strong style="color:#cdd9ff">' || dev || '</strong>.',
    null, null,
    'If this wasn''t you, change your password and remove the device from Settings.');
  return new;
end; $$;
revoke all on function public.norva_notify_new_device() from public, anon, authenticated;

drop trigger if exists norva_new_device_trg on public.cloud_devices;
create trigger norva_new_device_trg
  after insert on public.cloud_devices
  for each row execute function public.norva_notify_new_device();