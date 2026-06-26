-- Shared branded-email plumbing for app-level transactional emails (security +
-- lifecycle). One dark-theme Norva template, reused by every trigger/cron sender, so
-- the HTML lives in ONE place. Sends via pg_net -> Resend using the `resend_api_key`
-- Vault secret (DORMANT until set, like welcome + marketing). Best-effort by design.

create or replace function public.norva_html_escape(s text)
returns text language sql immutable as $$
  select replace(replace(replace(replace(replace(coalesce(s,''),
    '&','&amp;'), '<','&lt;'), '>','&gt;'), '"','&quot;'), '''','&#39;')
$$;

create or replace function public.norva_branded_email_html(
  p_heading text, p_intro text,
  p_cta_label text default null, p_cta_url text default null,
  p_footer text default 'If you didn''t request this, please review your account security.'
)
returns text language sql immutable as $$
  select
    $h$<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0c11"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0a0c11"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#11151d;border:1px solid #1f2733;border-radius:16px;overflow:hidden">
<tr><td style="padding:32px 32px 8px;text-align:center"><img src="https://norva.tv/img/norva-app-icon.png" width="48" height="48" alt="Norva" style="border-radius:12px"><div style="color:#fff;font-family:'Century Gothic',Arial,sans-serif;font-size:22px;font-weight:600;margin-top:10px">Norva</div></td></tr>
<tr><td style="padding:18px 32px 6px;text-align:center"><h1 style="margin:0;color:#f8fafc;font-family:Arial,sans-serif;font-size:21px;font-weight:800">$h$ || p_heading ||
    $h$</h1></td></tr><tr><td style="padding:10px 32px 22px;text-align:center;color:#9aa6bd;font-family:Arial,sans-serif;font-size:15px;line-height:1.6">$h$ || p_intro || $h$</td></tr>$h$ ||
    case when p_cta_label is not null and p_cta_url is not null
      then $h$<tr><td align="center" style="padding:8px 0 28px"><a href="$h$ || p_cta_url || $h$" style="display:inline-block;background:#5b7cfa;color:#fff;font-weight:700;font-size:15px;text-decoration:none;padding:14px 30px;border-radius:10px">$h$ || p_cta_label || $h$</a></td></tr>$h$
      else '' end ||
    $h$<tr><td style="padding:18px 32px 28px;border-top:1px solid #1f2733;color:#5f6b85;font-family:Arial,sans-serif;font-size:12px;line-height:1.6;text-align:center">$h$ || p_footer ||
    $h$</td></tr></table><div style="color:#3b4254;font-family:Arial,sans-serif;font-size:11px;margin-top:16px">© Norva</div></td></tr></table></body></html>$h$
$$;

create or replace function public.norva_send_branded_email(
  p_to text, p_subject text, p_heading text, p_intro text,
  p_cta_label text default null, p_cta_url text default null,
  p_footer text default 'If you didn''t request this, please review your account security.'
)
returns void language plpgsql security definer set search_path = public as $func$
declare
  api_key text;
begin
  if coalesce(p_to,'') = '' then return; end if;
  select decrypted_secret into api_key from vault.decrypted_secrets where name = 'resend_api_key';
  if api_key is null then return; end if;  -- dormant until the key is set
  begin
    perform net.http_post(
      url := 'https://api.resend.com/emails',
      headers := jsonb_build_object('Authorization','Bearer '||api_key,'Content-Type','application/json'),
      body := jsonb_build_object('from','Norva <noreply@norva.tv>','to',jsonb_build_array(p_to),
        'subject',p_subject,'html',public.norva_branded_email_html(p_heading,p_intro,p_cta_label,p_cta_url,p_footer)),
      timeout_milliseconds := 8000);
  exception when others then null;  -- never let an email failure break the caller
  end;
end;
$func$;

revoke all on function public.norva_send_branded_email(text,text,text,text,text,text,text) from public, anon, authenticated;
grant execute on function public.norva_send_branded_email(text,text,text,text,text,text,text) to service_role;