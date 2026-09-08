// Norva email presentation. Inline fallbacks survive clients that strip CSS,
// gradients, shadows or blur. No remote fonts, scripts or image-based text.
// Tokens map to public/css/main.css; email clients cannot resolve CSS variables.
const COLOR = {
  page: '#080B12', surface: '#12121a', raised: '#1a1a25',
  text: '#F8FAFC', secondary: '#94A3B8', accent: '#3B82F6',
  action: '#2563EB', actionHover: '#1D4ED8', highlight: '#60A5FA', violet: '#8B5CF6',
};
const FONT = "Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,Helvetica,sans-serif";
const DISPLAY = "Outfit,Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,Helvetica,sans-serif";

export function escapeEmail(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

export type EmailArtwork = 'welcome' | 'security' | 'catalog' | 'billing' | 'action' | 'support';
export interface EmailFrame {
  title: string;
  heading: string;
  preheader: string;
  bodyHtml: string;
  cta?: { label: string; url: string };
  noteHtml?: string;
  footerHtml?: string;
  code?: string;
  fallbackUrl?: string;
  lang?: 'en' | 'fr';
  artwork?: EmailArtwork | false;
}

export function renderEmailFrame(o: EmailFrame): string {
  const artwork = o.artwork ?? 'security';
  const visual = artwork === false ? '' : `<tr><td class="nv-pad" style="padding:32px 40px 0"><img src="https://norva.tv/img/email/${artwork}-v1.jpg" width="518" height="${artwork === 'catalog' ? 174 : 173}" alt="" aria-hidden="true" style="display:block;width:100%;max-width:518px;height:auto;border:0;border-radius:10px;outline:none;text-decoration:none"></td></tr>`;
  const cta = o.cta ? `<tr><td class="nv-pad" style="padding:8px 40px 32px">
    <table role="presentation" border="0" cellpadding="0" cellspacing="0"><tr><td bgcolor="${COLOR.action}" style="background-color:${COLOR.action};background-image:linear-gradient(135deg,${COLOR.action},${COLOR.actionHover});border:1px solid ${COLOR.highlight};border-radius:10px;box-shadow:0 8px 24px rgba(37,99,235,.24);mso-padding-alt:16px 24px">
    <a href="${escapeEmail(o.cta.url)}" style="display:inline-block;padding:16px 24px;color:#ffffff;font-family:${FONT};font-size:16px;font-weight:600;line-height:24px;text-decoration:none;text-align:center">${escapeEmail(o.cta.label)}</a>
    </td></tr></table></td></tr>` : '';
  const code = o.code ? `<tr><td class="nv-pad" style="padding:8px 40px 32px"><table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" bgcolor="${COLOR.page}" style="width:100%;background-color:${COLOR.page};background-image:linear-gradient(120deg,rgba(59,130,246,.12),rgba(139,92,246,.06));border:1px solid #3f3f46;border-radius:10px"><tr><td align="center" style="padding:24px 16px;color:${COLOR.text};font-family:'SFMono-Regular',Consolas,'Liberation Mono',monospace;font-size:32px;font-weight:600;line-height:40px;letter-spacing:6px">${escapeEmail(o.code)}</td></tr></table></td></tr>` : '';
  const fallback = o.fallbackUrl ? `<tr><td class="nv-pad" style="padding:0 40px 32px;color:${COLOR.secondary};font-family:${FONT};font-size:14px;line-height:22px;word-break:break-all;overflow-wrap:anywhere">If the button doesn't work, copy and paste this link:<br><a href="${escapeEmail(o.fallbackUrl)}" style="color:${COLOR.highlight};text-decoration:underline;word-break:break-all;overflow-wrap:anywhere">${escapeEmail(o.fallbackUrl)}</a></td></tr>` : '';
  const note = o.noteHtml ? `<tr><td class="nv-pad" style="padding:24px 40px 32px;border-top:1px solid #27272a;color:${COLOR.secondary};font-family:${FONT};font-size:14px;line-height:23px">${o.noteHtml}</td></tr>` : '';
  return `<!doctype html>
<html lang="${o.lang === 'fr' ? 'fr' : 'en'}" dir="ltr"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting"><meta name="format-detection" content="telephone=no,date=no,address=no,email=no,url=no">
<meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark">
<title>${escapeEmail(o.title)}</title>
<style>body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}table,td{mso-table-lspace:0pt;mso-table-rspace:0pt}a:focus-visible{outline:2px solid ${COLOR.highlight};outline-offset:4px}a:hover{filter:brightness(1.08)}@media only screen and (max-width:620px){.nv-wrap{padding:24px 12px!important}.nv-pad{padding-left:24px!important;padding-right:24px!important}.nv-title{font-size:28px!important;line-height:35px!important}.nv-brand{padding:0 12px 24px!important}}</style>
</head><body style="margin:0;padding:0;background-color:${COLOR.page};color:${COLOR.text}">
<div data-preheader="true" style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;max-height:0;max-width:0;overflow:hidden;mso-hide:all">${escapeEmail(o.preheader)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" bgcolor="${COLOR.page}" style="width:100%;background-color:${COLOR.page};background-image:radial-gradient(ellipse at 18% 0%,rgba(59,130,246,.13),transparent 52%),radial-gradient(ellipse at 100% 70%,rgba(139,92,246,.09),transparent 50%);border-collapse:collapse">
<tr><td class="nv-wrap" align="center" style="padding:48px 24px">
<!--[if mso]><table role="presentation" width="600" align="center" border="0" cellpadding="0" cellspacing="0"><tr><td><![endif]-->
<table role="presentation" width="600" border="0" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;border-collapse:separate">
<tr><td class="nv-brand" style="padding:0 8px 32px"><table role="presentation" border="0" cellpadding="0" cellspacing="0"><tr>
<td width="40" style="width:40px"><img src="https://norva.tv/img/norva-app-icon.png" width="40" height="40" alt="" aria-hidden="true" style="display:block;width:40px;height:40px;border:0;border-radius:10px;outline:none;text-decoration:none"></td>
<td style="padding-left:12px;color:${COLOR.text};font-family:${DISPLAY};font-size:26px;font-weight:600;line-height:32px;letter-spacing:-.6px">Norva</td>
</tr></table></td></tr>
<tr><td bgcolor="${COLOR.surface}" style="background-color:${COLOR.surface};background-image:linear-gradient(135deg,rgba(96,165,250,.14) 0%,rgba(18,18,26,.8) 43%,rgba(139,92,246,.08) 100%);border:1px solid #3f3f46;border-top-color:#64748b;border-radius:16px;box-shadow:inset 0 1px 0 rgba(255,255,255,.13),0 24px 64px rgba(0,0,0,.3);backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px)">
<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" style="width:100%;table-layout:fixed;border-collapse:separate">
${visual}
<tr><td class="nv-pad" style="padding:40px 40px 16px"><h1 class="nv-title" style="margin:0;color:${COLOR.text};font-family:${DISPLAY};font-size:34px;font-weight:600;line-height:41px;letter-spacing:-1px;overflow-wrap:break-word">${escapeEmail(o.heading)}</h1></td></tr>
<tr><td class="nv-pad" style="padding:8px 40px 24px;color:#cbd5e1;font-family:${FONT};font-size:16px;line-height:27px;overflow-wrap:break-word">${o.bodyHtml}</td></tr>
${code}${cta}${fallback}${note}
</table></td></tr>
<tr><td class="nv-pad" style="padding:24px 8px 0;color:${COLOR.secondary};font-family:${FONT};font-size:13px;line-height:22px">${o.footerHtml ? o.footerHtml + '<br>' : ''}&copy; Norva</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table></body></html>`;
}
