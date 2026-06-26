-- Harden the notification triggers: wrap the whole body in an exception guard so an
-- email-side failure can NEVER block the core operation (a password change, an email
-- change, a device registration, or a billing-status update). Belt-and-suspenders on
-- top of the helper's own guard, because these sit on auth.users + billing.

create or replace function public.norva_notify_password_changed()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  begin
    perform public.norva_send_branded_email(
      new.email, 'Your Norva password was changed', 'Password changed',
      'The password on your Norva account was just changed. If this was you, no further action is needed.',
      'Go to my account', 'https://norva.tv/account.html',
      'If you did NOT change your password, reset it from the app immediately and review your account.');
  exception when others then null; end;
  return new;
end; $$;

create or replace function public.norva_notify_email_changed()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  begin
    perform public.norva_send_branded_email(
      old.email, 'Your Norva email was changed', 'Email address changed',
      'The email on your Norva account was changed to <strong style="color:#cdd9ff">' || public.norva_html_escape(new.email) || '</strong>. If this was you, no action is needed.',
      null, null,
      'If you did NOT request this change, contact support immediately — your account may be compromised.');
  exception when others then null; end;
  return new;
end; $$;

create or replace function public.norva_notify_new_device()
returns trigger language plpgsql security definer set search_path = public as $$
declare user_email text; dev text;
begin
  begin
    select email into user_email from auth.users where id = new.user_id;
    if user_email is not null then
      dev := public.norva_html_escape(coalesce(nullif(new.device_name,''), new.device_type, 'a device'))
             || case when coalesce(new.platform,'') <> '' then ' (' || public.norva_html_escape(new.platform) || ')' else '' end;
      perform public.norva_send_branded_email(
        user_email, 'New device connected to Norva', 'New device connected',
        'A new device just connected to your Norva account: <strong style="color:#cdd9ff">' || dev || '</strong>.',
        null, null,
        'If this wasn''t you, change your password and remove the device from Settings.');
    end if;
  exception when others then null; end;
  return new;
end; $$;

create or replace function public.norva_notify_payment_failed()
returns trigger language plpgsql security definer set search_path = public as $$
declare user_email text;
begin
  begin
    if new.status = 'past_due' and not (tg_op = 'UPDATE' and old.status is not distinct from 'past_due') then
      select email into user_email from auth.users where id = new.user_id;
      if user_email is not null then
        perform public.norva_send_branded_email(
          user_email, 'Action needed: your Norva payment failed', 'There was a problem with your payment',
          'We couldn''t process the payment for your Norva subscription. Your access stays active for a short grace period — please update your payment method to avoid any interruption.',
          'Update payment', 'https://norva.tv/app#settings',
          'Already fixed it? You can safely ignore this email.');
      end if;
    end if;
  exception when others then null; end;
  return new;
end; $$;