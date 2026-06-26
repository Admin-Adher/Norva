-- Welcome email: sent ONCE, the moment a user's email is freshly confirmed (account
-- becomes active). Direct pg_net -> Resend /emails, like the marketing audience sync —
-- reuses the `resend_api_key` Vault secret and is DORMANT until that secret is set.
-- Best-effort + exception-guarded so it can never block confirmation or login. A static
-- greeting (no raw user-supplied name) avoids any HTML injection into the email.
--
-- Note: fires on UPDATE of email_confirmed_at (null -> set), i.e. the email/password
-- confirmation flow. Users created already-confirmed (e.g. OAuth) would need an
-- additional INSERT path — add if/when those sign-up methods are enabled.

create or replace function public.norva_send_welcome_email()
returns trigger
language plpgsql
security definer
set search_path = public
as $func$
declare
  api_key text;
  html text;
begin
  if new.email is null then return new; end if;
  select decrypted_secret into api_key from vault.decrypted_secrets where name = 'resend_api_key';
  if api_key is null then return new; end if;  -- dormant until the key is set

  html := $html$<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0c11">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0a0c11"><tr><td align="center" style="padding:32px 16px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#11151d;border:1px solid #1f2733;border-radius:16px;overflow:hidden">
      <tr><td style="padding:32px 32px 8px;text-align:center">
        <img src="https://norva.tv/img/norva-app-icon.png" width="48" height="48" alt="Norva" style="border-radius:12px">
        <div style="color:#ffffff;font-family:'Century Gothic',Arial,sans-serif;font-size:22px;font-weight:600;margin-top:10px">Norva</div>
      </td></tr>
      <tr><td style="padding:18px 32px 6px;text-align:center"><h1 style="margin:0;color:#f8fafc;font-family:Arial,sans-serif;font-size:21px;font-weight:800">Welcome to Norva!</h1></td></tr>
      <tr><td style="padding:10px 32px 22px;text-align:center;color:#9aa6bd;font-family:Arial,sans-serif;font-size:15px;line-height:1.6">Your account is ready. Add your provider, build your catalogue, and start watching across the web, your phone and your TV.</td></tr>
      <tr><td align="center" style="padding:8px 0 28px"><a href="https://norva.tv/app" style="display:inline-block;background:#5b7cfa;color:#ffffff;font-weight:700;font-size:15px;text-decoration:none;padding:14px 30px;border-radius:10px">Open Norva</a></td></tr>
      <tr><td style="padding:18px 32px 28px;border-top:1px solid #1f2733;color:#5f6b85;font-family:Arial,sans-serif;font-size:12px;line-height:1.6;text-align:center">Need help getting started? Just reply to this email.</td></tr>
    </table>
    <div style="color:#3b4254;font-family:Arial,sans-serif;font-size:11px;margin-top:16px">© Norva</div>
  </td></tr></table>
</body></html>$html$;

  begin
    perform net.http_post(
      url := 'https://api.resend.com/emails',
      headers := jsonb_build_object('Authorization','Bearer '||api_key, 'Content-Type','application/json'),
      body := jsonb_build_object(
        'from','Norva <noreply@norva.tv>',
        'to', jsonb_build_array(new.email),
        'subject','Welcome to Norva',
        'html', html),
      timeout_milliseconds := 8000);
  exception when others then
    null;  -- a welcome-email hiccup must never block confirmation/login
  end;
  return new;
end;
$func$;

revoke all on function public.norva_send_welcome_email() from public, anon, authenticated;

drop trigger if exists norva_send_welcome_email_trg on auth.users;
create trigger norva_send_welcome_email_trg
  after update of email_confirmed_at on auth.users
  for each row
  when (old.email_confirmed_at is null and new.email_confirmed_at is not null)
  execute function public.norva_send_welcome_email();
