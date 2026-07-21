const NORVA_SITE = "https://norva.tv";
const SUPPORT_EMAIL = "support@norva.tv";

export interface SubtitleReadyEmail {
  subject: string;
  html: string;
  text: string;
  tags: Array<{ name: "app" | "category" | "flow"; value: string }>;
}

function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char] as string));
}

function cleanText(value: unknown, fallback: string): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 180) || fallback;
}

function safeHttpUrl(value: unknown, fallback: string): string {
  try {
    const url = new URL(String(value ?? ""));
    if (url.protocol === "https:") return url.toString();
  } catch (_) { /* use the trusted fallback */ }
  return fallback;
}

export function renderSubtitleReadyEmail(options: {
  titleLabel?: string | null;
  siteUrl?: string | null;
  ctaUrl?: string | null;
}): SubtitleReadyEmail {
  const title = cleanText(options.titleLabel, "your title");
  const siteUrl = safeHttpUrl(options.siteUrl, NORVA_SITE);
  const ctaUrl = safeHttpUrl(options.ctaUrl, siteUrl);
  const hasDeepLink = ctaUrl !== siteUrl;
  const subject = `Your AI subtitles for “${title}” are ready — Norva`;
  const ctaLabel = hasDeepLink ? "Open with AI subtitles" : "Open Norva";
  const preheader = `AI subtitles for ${title} are ready and cached for your next watch.`;
  const text = `Your AI subtitles are ready

Norva finished transcribing ${title}. Open the title and choose “AI subtitles” in the captions menu.

${ctaLabel}: ${ctaUrl}

You are receiving this because you asked Norva to notify you when these subtitles were ready. They are cached and will load immediately next time.

Questions? ${SUPPORT_EMAIL}
Norva is a media player and includes no content.
© Norva`;

  return {
    subject,
    text,
    tags: [
      { name: "app", value: "norva" },
      { name: "category", value: "transactional" },
      { name: "flow", value: "subtitle_ready" },
    ],
    html: `<!doctype html>
<html lang="en" dir="ltr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <meta name="color-scheme" content="dark">
  <meta name="supported-color-schemes" content="dark">
  <title>${esc(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#0a0c11;color:#f8fafc;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">
  <div data-preheader="true" style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;max-height:0;max-width:0;overflow:hidden;mso-hide:all">${esc(preheader)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
  <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" bgcolor="#0a0c11" style="width:100%;background:#0a0c11;border-collapse:collapse">
    <tr><td align="center" style="padding:32px 16px">
      <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" bgcolor="#11151d" style="width:100%;max-width:500px;background:#11151d;border:1px solid #283143;border-radius:16px;border-collapse:separate">
        <tr><td align="center" style="padding:32px 32px 8px">
          <img src="${NORVA_SITE}/img/norva-app-icon.png" width="48" height="48" alt="" aria-hidden="true" style="display:block;width:48px;height:48px;border:0;border-radius:12px;outline:none;text-decoration:none">
          <p style="margin:10px 0 0;color:#ffffff;font-family:'Century Gothic',Arial,Helvetica,sans-serif;font-size:22px;font-weight:600;letter-spacing:-.02em;line-height:1.25">Norva</p>
        </td></tr>
        <tr><td align="center" style="padding:18px 32px 6px">
          <h1 style="margin:0;color:#f8fafc;font-family:Arial,Helvetica,sans-serif;font-size:22px;font-weight:700;line-height:1.3">Your AI subtitles are ready</h1>
        </td></tr>
        <tr><td style="padding:12px 32px 20px;color:#bcc5d6;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.65;text-align:left">
          <p style="margin:0">Norva finished transcribing <strong style="color:#e3e8f2">${esc(title)}</strong>. Open the title and choose <strong style="color:#e3e8f2">AI subtitles</strong> in the captions menu.</p>
        </td></tr>
        <tr><td align="center" style="padding:8px 32px 30px">
          <table role="presentation" border="0" cellpadding="0" cellspacing="0"><tr>
            <td align="center" bgcolor="#5b7cfa" style="background:#5b7cfa;border-radius:10px;mso-padding-alt:14px 30px">
              <a href="${esc(ctaUrl)}" style="display:inline-block;padding:14px 30px;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;line-height:1;text-decoration:none">${esc(ctaLabel)}</a>
            </td>
          </tr></table>
        </td></tr>
        <tr><td style="padding:20px 32px 28px;border-top:1px solid #283143;color:#9ba6ba;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.6;text-align:center">
          You are receiving this because you asked Norva to notify you when these subtitles were ready. They are cached and will load immediately next time.<br><br>
          Questions? <a href="mailto:${SUPPORT_EMAIL}" style="color:#b8c8f2;text-decoration:underline">${SUPPORT_EMAIL}</a>. Norva is a media player and includes no content.
        </td></tr>
      </table>
      <p style="margin:16px 0 0;color:#8994a8;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.5">&copy; Norva</p>
    </td></tr>
  </table>
</body>
</html>`,
  };
}
