-- Bring the database-rendered security/trial messages to the same conservative
-- email-client envelope as the Edge-rendered Norva messages. This is deliberately
-- an English document: the active copy set is English-only, so declaring another
-- locale from browser metadata would be misleading until complete translations
-- exist for every subject, preheader, CTA, body and plain-text alternative.

create or replace function public.norva_branded_email_html(
  p_heading text,
  p_intro text,
  p_cta_label text default null,
  p_cta_url text default null,
  p_footer text default 'If you didn''t request this, please review your account security.'
)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $function$
  select
    '<!doctype html><html lang="en" dir="ltr"><head><meta charset="utf-8">' ||
    '<meta name="viewport" content="width=device-width,initial-scale=1">' ||
    '<meta name="x-apple-disable-message-reformatting">' ||
    '<meta name="format-detection" content="telephone=no,date=no,address=no,email=no,url=no">' ||
    '<meta name="color-scheme" content="dark">' ||
    '<meta name="supported-color-schemes" content="dark">' ||
    '<title>' || public.norva_html_escape(p_heading) || '</title></head>' ||
    '<body style="margin:0;padding:0;background:#0a0c11;color:#f8fafc;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">' ||
    '<div data-preheader="true" style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;max-height:0;max-width:0;overflow:hidden;mso-hide:all">' ||
      public.norva_html_escape(p_heading) || '&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>' ||
    '<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" bgcolor="#0a0c11" style="width:100%;background:#0a0c11;border-collapse:collapse">' ||
    '<tr><td align="center" style="padding:32px 16px">' ||
    '<table role="presentation" width="480" border="0" cellpadding="0" cellspacing="0" bgcolor="#11151d" ' ||
      'style="width:100%;max-width:480px;background:#11151d;border:1px solid #1f2733;border-radius:16px;border-collapse:separate">' ||
    '<tr><td style="padding:32px 32px 8px;text-align:center">' ||
      '<img src="https://norva.tv/img/norva-app-icon.png" width="48" height="48" alt="" aria-hidden="true" style="display:block;width:48px;height:48px;margin:0 auto;border:0;border-radius:12px;outline:none;text-decoration:none">' ||
      '<div style="color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:22px;font-weight:700;line-height:1.25;margin-top:10px">Norva</div>' ||
    '</td></tr>' ||
    '<tr><td style="padding:18px 32px 6px;text-align:center">' ||
      '<h1 style="margin:0;color:#f8fafc;font-family:Arial,Helvetica,sans-serif;font-size:21px;font-weight:800;line-height:1.3">' ||
        public.norva_html_escape(p_heading) || '</h1></td></tr>' ||
    '<tr><td style="padding:10px 32px 22px;text-align:center;color:#aeb9cc;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6">' ||
      coalesce(p_intro, '') || '</td></tr>' ||
    case
      when nullif(btrim(p_cta_label), '') is not null
       and nullif(btrim(p_cta_url), '') is not null then
        '<tr><td align="center" style="padding:8px 32px 28px">' ||
        '<table role="presentation" border="0" cellpadding="0" cellspacing="0"><tr>' ||
        '<td align="center" bgcolor="#5b7cfa" style="background:#5b7cfa;border-radius:10px;mso-padding-alt:14px 30px">' ||
        '<a href="' || public.norva_html_escape(p_cta_url) || '" ' ||
          'style="display:inline-block;padding:14px 30px;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-weight:700;font-size:15px;line-height:1;text-decoration:none">' ||
          public.norva_html_escape(p_cta_label) || '</a></td></tr></table></td></tr>'
      else ''
    end ||
    '<tr><td style="padding:18px 32px 28px;border-top:1px solid #1f2733;color:#8490a6;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.6;text-align:center">' ||
      public.norva_html_escape(p_footer) || '</td></tr>' ||
    '</table><div style="color:#667085;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.5;margin-top:16px">&copy; Norva</div>' ||
    '</td></tr></table></body></html>'
$function$;

comment on function public.norva_branded_email_html(text,text,text,text,text) is
  'English-only, escaped Norva database email renderer with a table/inline-CSS envelope for major email clients.';
